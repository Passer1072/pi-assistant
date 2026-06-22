import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionRuntime,
	SessionManager,
	SessionStartEvent,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { DesktopAutomationHost } from "../desktop/automation-host.ts";
import type {
	AutomationRiskLevel,
	ChatMessageView,
	ConversationContextUsageView,
	ConversationHistoryLoadSource,
	ConversationHistoryWindow,
	ConversationThinkingState,
	DesktopAssistantEvent,
	DesktopAssistantSettings,
	DesktopAssistantSnapshot,
	DesktopToolResult,
	GlobalMemoryEntry,
	MessageTokenUsageView,
	PendingConfirmation,
	PendingPromptAttachment,
	PersonalSkillFileView,
	SessionNotificationKind,
	SessionRunStatus,
	SkillFileView,
	TimelineItem,
	VoiceOverlayState,
} from "../shared/types.ts";
import { DEFAULT_DESKTOP_ASSISTANT_SETTINGS } from "../shared/types.ts";
import { buildAttachmentPromptBlock } from "./attachment-extractor.ts";
import type { BrowserSnapshotStore } from "./browser-snapshot-store.ts";
import type {
	AiReadableConversationArchive,
	ConversationArchiveCoordinator,
	ConversationArchiveRecord,
	ConversationArchiveWriter,
} from "./conversation-archive.ts";
import { buildMemoryContextBlock, type MemoryStore } from "./memory-store.ts";
import { buildPersonalSkillRoutedPrompt } from "./personal-skill-repository.ts";
import { eventToTimelineItem } from "./timeline.ts";
import {
	compactTokenSavingMessages,
	type TokenSavingFrozenForms,
	type TokenSavingTelemetry,
} from "./token-saving-context.ts";
import {
	estimateBrowserToolHistoryChars,
	evaluateTokenSavingCompactionOutcome,
	TokenSavingTurnCompactionController,
	type TokenSavingTurnCompactionDecision,
} from "./token-saving-turn-compaction.ts";

export const VOICE_INPUT_SKILL_NAME = "voice-input";
export const HISTORY_INITIAL_MESSAGE_LIMIT = 30;
export const HISTORY_INITIAL_TIMELINE_LIMIT = 20;
export const HISTORY_PAGE_LIMIT = 30;
const TOKEN_SAVING_FROZEN_FORMS_MAX = 64;
const REDACTED_THINKING_PLACEHOLDER = "(thinking content was filtered for safety)";

interface PendingTokenSavingCompactionReview {
	baselinePromptTokens?: number;
	baselineCacheHitRatio?: number;
	score: number;
	reasons: string[];
}

// SessionRunStatus now lives in shared/types.ts (it crosses the IPC boundary in
// SessionSummary). Imported above for status()'s return type and re-exported here
// so existing agent-layer importers keep working.
export type { SessionRunStatus };

/** Per-conversation slice of the full DesktopAssistantSnapshot. */
export interface ContextSnapshotFragment {
	sessionId: string;
	isRunning: boolean;
	streamingText: string;
	streamingThinking: string;
	messages: ChatMessageView[];
	timeline: TimelineItem[];
	pendingConfirmations: PendingConfirmation[];
	conversationThinking: ConversationThinkingState;
	historyWindow?: ConversationHistoryWindow;
	lastInjectedMemoryCount: number;
	contextUsage?: ConversationContextUsageView;
}

/**
 * Shared facilities a ConversationContext needs from the host service.
 * Everything here is intentionally cross-session (settings, memory, MCP-backed
 * tools, event fan-out); all per-session state lives on the context itself.
 */
export interface ConversationContextDeps {
	cwd: string;
	host: DesktopAutomationHost;
	coordinator: ConversationArchiveCoordinator;
	memoryStore: MemoryStore;
	getSettings(): DesktopAssistantSettings;
	/** Shared browser snapshot store backing token-saving context compaction. */
	browserSnapshotStore: BrowserSnapshotStore;
	/** Emit an event to renderer listeners; archives archivable events to the given writer. */
	emit(event: DesktopAssistantEvent, archive: ConversationArchiveWriter): void;
	/** Build the full snapshot (global fields + this context's fragment). */
	snapshot(): DesktopAssistantSnapshot;
	/** Emit the lightweight live session roster (used when a background context updates). */
	emitSessionStatus(archive: ConversationArchiveWriter): void;
	/** Fire a cross-session toast/dot signal for a background session transition. */
	emitSessionNotification(sessionId: string, kind: SessionNotificationKind): void;
	updateVoiceOverlay(update: Partial<VoiceOverlayState>): void;
	selectSkillForPrompt(message: string): Promise<SkillFileView | undefined>;
	selectPersonalSkillForPrompt(message: string): Promise<PersonalSkillFileView | undefined>;
	generateConversationTitle(input: {
		userMessage: string;
		assistantMessage?: string;
		signal?: AbortSignal;
		onDiagnostic?: (diagnostic: {
			level: "debug" | "info" | "warn" | "error";
			title: string;
			details?: Record<string, unknown>;
		}) => void;
	}): Promise<string | undefined>;
	createRuntime(
		sessionManager: SessionManager,
		options: {
			thinkingLevel: DesktopAssistantSettings["thinkingLevel"];
			sessionStartEvent?: SessionStartEvent;
			profile?: ConversationRuntimeProfile;
		},
	): Promise<AgentSessionRuntime>;
}

export interface ConversationRuntimeProfile {
	customTools?: ToolDefinition[];
	activeToolNames?: string[];
	appendSystemPrompt?: string[];
	skipSkillRouting?: boolean;
	skipPersonalSkillRouting?: boolean;
	skipMemory?: boolean;
	kind?: string;
	agentSource?: "interactive" | "rpc" | "extension";
}

/**
 * Owns the complete state of one conversation: its AgentSession (and runtime),
 * chat messages, timeline, streaming text, pending confirmations, thinking
 * state, and archive writer. A context is bound to a single sessionId for its
 * lifetime — new conversations and history resumes construct a new context
 * instead of mutating an existing one, so multiple contexts can run agent
 * loops concurrently without sharing any mutable state.
 */
export class ConversationContext {
	private readonly deps: ConversationContextDeps;
	readonly sessionManager: SessionManager;
	archive: ConversationArchiveWriter;
	private runtime: AgentSessionRuntime | undefined;
	session: AgentSession | undefined;
	private sessionUnsubscribe: (() => void) | undefined;

	messages: ChatMessageView[] = [];
	timeline: TimelineItem[] = [];
	pendingConfirmations: PendingConfirmation[] = [];
	private completedApprovalResults: Array<{
		confirmation: PendingConfirmation;
		commandResult: { stdout: string; stderr: string };
	}> = [];
	private confirmationAborted = false;
	isBusy = false;
	streamingText = "";
	streamingThinking = "";
	private nextDisplayOrder = 1;
	private streamingTextTimer: ReturnType<typeof setTimeout> | undefined;
	private streamingThinkingTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingAssistantRunError:
		| {
				errorMessage?: string;
				stopReason: "error" | "aborted";
		  }
		| undefined;
	historyWindow: ConversationHistoryWindow | undefined;
	conversationThinking: ConversationThinkingState;
	lastInjectedMemoryCount = 0;
	lastActivityAt = Date.now();
	lastError: string | undefined;
	/** Whether this context is the one whose detail the UI is currently showing. */
	isFocused = false;
	/** A background run finished while unfocused; drives the blue dot until viewed. */
	unreadCompletion = false;
	private runningTokenSavingCompaction = false;
	private lastTokenSavingCompactionBrowserChars = 0;
	private recentIneffectiveTokenSavingCompactions = 0;
	private pendingTokenSavingCompactionReview: PendingTokenSavingCompactionReview | undefined;
	private latestTokenSavingTelemetry: TokenSavingTelemetry | undefined;
	// Freeze-once memo shared by both compaction call sites so a browser result's
	// compacted bytes never change after it leaves the recent window — keeps the
	// sent prefix stable for DeepSeek's server-side prefix cache.
	private readonly tokenSavingFrozenForms: TokenSavingFrozenForms = new Map();
	// Running totals for the session-level prompt-cache hit ratio shown in the UI.
	private cumulativeCacheReadTokens = 0;
	private cumulativePromptTokens = 0;
	private readonly tokenSavingTurnCompaction = new TokenSavingTurnCompactionController();
	private titleGenerationStarted = false;
	private disposed = false;
	private readonly profile: ConversationRuntimeProfile | undefined;
	private static readonly STREAMING_THROTTLE_MS = 50;

	constructor(
		deps: ConversationContextDeps,
		sessionManager: SessionManager,
		options?: { archiveSessionId?: string; profile?: ConversationRuntimeProfile },
	) {
		this.deps = deps;
		this.sessionManager = sessionManager;
		this.profile = options?.profile;
		this.archive = deps.coordinator.createWriter(
			options?.archiveSessionId ?? sessionManager.getSessionId(),
			sessionManager.getSessionFile(),
		);
		this.conversationThinking = createConversationThinkingFromDefault(deps.getSettings().thinkingLevel, true);
		this.archive.setConversationThinkingState(this.conversationThinking);
	}

	get sessionId(): string {
		return this.session?.sessionId ?? this.sessionManager.getSessionId();
	}

	get hasRuntime(): boolean {
		return this.runtime !== undefined;
	}

	get profileKind(): string | undefined {
		return this.profile?.kind;
	}

	get resourceLoader(): AgentSessionRuntime["services"]["resourceLoader"] | undefined {
		return this.runtime?.services.resourceLoader;
	}

	status(): SessionRunStatus {
		if (this.pendingConfirmations.length > 0) return "awaiting_confirmation";
		if (this.isBusy) return "running";
		if (this.lastError) return "error";
		return "idle";
	}

	async initializeRuntime(options?: {
		skipBindArchiveWrite?: boolean;
		sessionStartEvent?: SessionStartEvent;
	}): Promise<void> {
		if (this.runtime) return;
		const runtime = await this.deps.createRuntime(this.sessionManager, {
			thinkingLevel: this.getSessionBootstrapThinkingLevel(),
			sessionStartEvent: options?.sessionStartEvent,
			profile: this.profile,
		});
		this.runtime = runtime;
		runtime.setRebindSession(async (session) => {
			this.bindSession(session);
		});
		this.bindSession(runtime.session, { skipArchiveWrite: options?.skipBindArchiveWrite });
		if (!options?.skipBindArchiveWrite) {
			this.archive.write("runtime_initialized", {
				sessionId: runtime.session.sessionId,
				sessionFile: runtime.session.sessionFile,
			});
			// Await initial archive flush so callers see all files on disk immediately.
			await this.archive.flushSnapshots();
		}
	}

	/**
	 * Construct a context for an archived conversation: opens its session file,
	 * creates the runtime, and rebuilds messages/timeline/confirmations from the
	 * archive. Replaces the old runtime.switchSession flow.
	 */
	static async resume(
		deps: ConversationContextDeps,
		sessionId: string,
		sessionFile: string,
		openSessionManager: (sessionFile: string) => SessionManager,
		options?: { sessionStartEvent?: SessionStartEvent },
	): Promise<ConversationContext> {
		const sessionManager = openSessionManager(sessionFile);
		const context = new ConversationContext(deps, sessionManager, { archiveSessionId: sessionId });
		await context.initializeRuntime({
			skipBindArchiveWrite: true,
			sessionStartEvent: options?.sessionStartEvent,
		});
		await context.rebuildStateFromArchive(sessionId);
		return context;
	}

	bindSession(session: AgentSession, options?: { skipArchiveWrite?: boolean }): void {
		this.sessionUnsubscribe?.();
		this.session = session;
		this.applyTokenSavingContextTransform(session);
		if (session.sessionId !== this.archive.sessionId) {
			// Runtime-internal rebind switched the underlying session (e.g. fork):
			// move archiving to a writer bound to the new sessionId.
			this.archive.detach();
			this.archive = this.deps.coordinator.createWriter(session.sessionId, session.sessionFile);
			this.titleGenerationStarted = false;
		}
		this.conversationThinking = this.normalizeConversationThinkingState(this.conversationThinking);
		this.archive.setConversationThinkingState(this.conversationThinking);
		this.applyConversationThinkingToSession();
		if (!options?.skipArchiveWrite) {
			this.archive.write("session_bound", {
				sessionId: session.sessionId,
				sessionFile: session.sessionFile,
				sessionName: session.sessionName,
			});
			this.archive.syncSessionFileMirror();
		}
		this.sessionUnsubscribe = session.subscribe((event) => this.handleSessionEvent(event));
	}

	private applyTokenSavingContextTransform(session: AgentSession): void {
		if (!session.agent) return;
		const baseTransform = session.agent.transformContext;
		session.agent.transformContext = async (messages, signal) => {
			const transformed = baseTransform ? await baseTransform(messages, signal) : messages;
			if (!this.deps.getSettings().tokenSaving.enabled) return transformed;
			const compacted = compactTokenSavingMessages(transformed, {
				snapshotStore: this.deps.browserSnapshotStore,
				frozenForms: this.tokenSavingFrozenForms,
				onTelemetry: (telemetry) => this.logTokenSavingTelemetry(telemetry),
				onAutoCompactionNeeded: (reason) => this.logTokenSavingCompactionCandidate(reason, transformed),
			});
			this.trimTokenSavingFrozenForms();
			return compacted;
		};
		const basePrepareNextTurn = session.agent.prepareNextTurn;
		session.agent.prepareNextTurn = async (context, signal) => {
			const nextTurnSnapshot = basePrepareNextTurn ? await basePrepareNextTurn(context, signal) : undefined;
			const nextContext = nextTurnSnapshot?.context ?? context.context;
			const decision = await this.maybeCompactAfterTokenSavingTurn({
				...context,
				context: nextContext,
			});
			return decision
				? {
						...nextTurnSnapshot,
						context: this.session?.agent.state
							? {
									...nextContext,
									messages: this.session.agent.state.messages.slice(),
									tools: nextContext.tools,
								}
							: nextContext,
					}
				: nextTurnSnapshot;
		};
	}

	private logTokenSavingTelemetry(telemetry: TokenSavingTelemetry): void {
		this.latestTokenSavingTelemetry = telemetry;
		this.archive.write("token_saving_context_telemetry", {
			...telemetry,
			estimatedSavedChars: Math.max(0, telemetry.originalChars - telemetry.compactedChars),
			snapshotCount: this.deps.browserSnapshotStore.getSnapshotCount(),
		});
	}

	private logTokenSavingCompactionCandidate(reason: string, messages: unknown[]): void {
		if (!this.deps.getSettings().tokenSaving.enabled) return;
		this.archive.write("token_saving_compaction_candidate", {
			reason,
			browserChars: estimateBrowserToolHistoryChars(messages),
			lastCompactionBrowserChars: this.lastTokenSavingCompactionBrowserChars,
		});
	}

	/**
	 * Phase 0 telemetry: record per-request prompt-cache effectiveness so the
	 * impact of token-saving compaction on DeepSeek's prefix cache can be
	 * measured (a falling cacheHitRatio mid-conversation indicates the sent
	 * prefix is churning and busting the server-side cache).
	 */
	private logTokenUsageTelemetry(message: Extract<AgentSessionEvent, { type: "message_end" }>["message"]): void {
		const usage = tokenUsageFromAssistantMessage(message);
		if (!usage) return;
		const promptTokens = promptTokensFromUsage(usage);
		this.cumulativeCacheReadTokens += usage.cacheRead;
		this.cumulativePromptTokens += promptTokens;
		this.archive.write("token_usage_telemetry", {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			total: usage.total,
			promptTokens,
			cacheHitRatio: cacheHitRatioFromUsage(usage),
			sessionCacheHitRatio: this.sessionCacheHitRatio(),
			tokenSavingEnabled: this.deps.getSettings().tokenSaving.enabled,
			contextPercent: this.contextUsage()?.percent ?? null,
		});
	}

	/** Cumulative session prompt-cache hit ratio, or null before any usage. */
	private sessionCacheHitRatio(): number | null {
		return this.cumulativePromptTokens > 0 ? this.cumulativeCacheReadTokens / this.cumulativePromptTokens : null;
	}

	private async maybeCompactAfterTokenSavingTurn(context: {
		message: Parameters<NonNullable<AgentSession["agent"]["prepareNextTurn"]>>[0]["message"];
		toolResults: Parameters<NonNullable<AgentSession["agent"]["prepareNextTurn"]>>[0]["toolResults"];
		context: Parameters<NonNullable<AgentSession["agent"]["prepareNextTurn"]>>[0]["context"];
		newMessages: Parameters<NonNullable<AgentSession["agent"]["prepareNextTurn"]>>[0]["newMessages"];
	}): Promise<TokenSavingTurnCompactionDecision | undefined> {
		if (!this.session || !this.deps.getSettings().tokenSaving.enabled) return undefined;
		if (this.runningTokenSavingCompaction) return undefined;
		if (context.message.role !== "assistant") return undefined;
		if (context.toolResults.length === 0) return undefined;

		let telemetry: TokenSavingTelemetry | undefined;
		compactTokenSavingMessages(context.context.messages.slice(), {
			snapshotStore: this.deps.browserSnapshotStore,
			frozenForms: this.tokenSavingFrozenForms,
			onTelemetry: (item) => {
				telemetry = item;
				this.latestTokenSavingTelemetry = item;
			},
		});
		this.trimTokenSavingFrozenForms();
		const decision = this.tokenSavingTurnCompaction.evaluate({
			enabled: true,
			messages: context.context.messages,
			assistantMessage: context.message,
			toolResults: context.toolResults,
			lastCompactionBrowserChars: this.lastTokenSavingCompactionBrowserChars,
			telemetry: telemetry ?? this.latestTokenSavingTelemetry,
			contextPercent: this.contextUsage()?.percent,
			recentIneffectiveCompactions: this.recentIneffectiveTokenSavingCompactions,
		});
		this.archive.write("token_saving_turn_compaction_decision", {
			...decision,
			snapshotCount: this.deps.browserSnapshotStore.getSnapshotCount(),
		});
		if (!decision.shouldCompact) return undefined;

		this.runningTokenSavingCompaction = true;
		try {
			const baselineUsage = tokenUsageFromAssistantMessage(context.message);
			const didCompact = await this.session.compactForTokenSaving(buildTokenSavingCompactionInstructions(decision));
			if (!didCompact) {
				return undefined;
			}
			this.lastTokenSavingCompactionBrowserChars = estimateBrowserToolHistoryChars(
				this.session.sessionManager.buildSessionContext().messages,
			);
			this.pendingTokenSavingCompactionReview = {
				baselinePromptTokens: baselineUsage ? promptTokensFromUsage(baselineUsage) : undefined,
				baselineCacheHitRatio: baselineUsage ? cacheHitRatioFromUsage(baselineUsage) : undefined,
				score: decision.score,
				reasons: decision.reasons,
			};
			this.session.agent.steer(this.tokenSavingTurnCompaction.buildContinuationMessage(decision));
			this.archive.write("token_saving_compaction_continuation_queued", {
				score: decision.score,
				reasons: decision.reasons,
				baselinePromptTokens: this.pendingTokenSavingCompactionReview.baselinePromptTokens,
				baselineCacheHitRatio: this.pendingTokenSavingCompactionReview.baselineCacheHitRatio,
			});
			return decision;
		} catch (error) {
			this.archive.write("token_saving_compaction_failed", {
				reason: decision.reasons.join("; "),
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		} finally {
			this.runningTokenSavingCompaction = false;
		}
	}

	private trimTokenSavingFrozenForms(): void {
		while (this.tokenSavingFrozenForms.size > TOKEN_SAVING_FROZEN_FORMS_MAX) {
			const oldest = this.tokenSavingFrozenForms.keys().next().value;
			if (oldest === undefined) return;
			this.tokenSavingFrozenForms.delete(oldest);
		}
	}

	handleSessionEvent(event: AgentSessionEvent): void {
		const isStreamingDelta =
			event.type === "message_update" &&
			(event.assistantMessageEvent.type === "text_delta" || event.assistantMessageEvent.type === "thinking_delta");
		if (!isStreamingDelta) {
			this.archive.write("agent_event", event);
		} else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
			// Archive thinking content directly via agent_event (archive reader handles this at
			// conversation-archive.ts:507). Bypasses pushTimeline to avoid IPC flooding.
			this.archive.write("agent_event", event);
		}
		this.emit({ type: "agent_event", agentEvent: event });
		const timelineItem = eventToTimelineItem(event);
		// thinking_summary items are filtered out of the UI (TimelineStrip excludes them)
		// and are emitted at full token speed — skip to prevent IPC flooding.
		if (timelineItem && timelineItem.kind !== "thinking_summary") {
			this.pushTimeline(timelineItem);
		}
		if (event.type === "tool_execution_start") {
			this.streamingText = "";
			// The reasoning that led to this tool call was already committed as its own
			// thinking box at the preceding message_end, so nothing to carry over here.
			this.emitSnapshot();
		}
		if (event.type === "tool_execution_end") {
			const wasBlocked = this.capturePendingConfirmation(event.result);
			if (wasBlocked && !this.confirmationAborted) {
				this.confirmationAborted = true;
				this.session?.abort();
			}
		}
		if (event.type === "message_update") {
			const assistantEvent = event.assistantMessageEvent;
			if (assistantEvent.type === "text_delta") {
				this.streamingText += assistantEvent.delta;
				this.scheduleStreamingTextEmit();
			}
			if (assistantEvent.type === "thinking_delta") {
				this.streamingThinking += assistantEvent.delta;
				this.scheduleStreamingThinkingEmit();
			}
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			this.reviewPendingTokenSavingCompaction(event.message);
			this.logTokenUsageTelemetry(event.message);
			this.flushStreamingText();
			// Commit this step's reasoning as its own ordered thinking box — placed before
			// the step's answer text and the tool calls that follow — then reset the live
			// buffer so the next step (after a tool runs) starts a brand-new box instead of
			// accumulating into one continuous block.
			this.commitThinkingSegment(extractThinkingFromAssistantMessage(event.message));
			const text = event.message.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("");
			this.streamingText = "";
			if (text) {
				this.pendingAssistantRunError = undefined;
				this.pushMessage("assistant", text, {
					tokenUsage: tokenUsageFromAssistantMessage(event.message),
				});
			} else if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
				this.pendingAssistantRunError = {
					errorMessage: event.message.errorMessage,
					stopReason: event.message.stopReason,
				};
			}
		}
		if (event.type === "agent_end") {
			this.flushStreamingText();
			// Safety net: commit any reasoning not already closed by a message_end (e.g. an
			// errored/aborted turn) so it still shows as its own box.
			this.commitThinkingSegment();
			const text = extractLatestAssistantTextFromAgentMessages(event.messages);
			const turnTokenUsage = tokenUsageFromAgentMessages(event.messages);
			this.streamingText = "";
			if (text && !this.hasRecentAssistantMessage(text)) {
				this.pendingAssistantRunError = undefined;
				this.pushMessage("assistant", text, {
					tokenUsage: latestAssistantTokenUsageFromAgentMessages(event.messages),
					turnTokenUsage,
				});
			} else if (!event.willRetry) {
				this.updateLatestAssistantTurnTokenUsage(turnTokenUsage);
				const pendingError = this.pendingAssistantRunError ?? extractLatestAssistantRunError(event.messages);
				if (pendingError) {
					this.pushAssistantRunError(pendingError.errorMessage, pendingError.stopReason);
					this.pendingAssistantRunError = undefined;
				}
			}
			if (!event.willRetry) {
				this.extractMemoriesFromLatestTurn();
				void this.maybeGenerateConversationTitle();
				// A background run just finished — flag it for the blue dot until the
				// user focuses this session, and fire a global "completed" toast.
				if (!this.isFocused) {
					this.unreadCompletion = true;
					this.deps.emitSessionNotification(this.sessionId, "completed");
				}
			}
		}
		if (event.type === "message_end" || event.type === "agent_end" || event.type === "tool_execution_end") {
			this.archive.syncSessionFileMirror();
		}
		if (event.type === "agent_end") {
			void this.archive.flushSnapshots();
		}
	}

	private setBusy(isBusy: boolean): void {
		if (this.isBusy === isBusy) return;
		this.isBusy = isBusy;
		this.lastActivityAt = Date.now();
		this.archive.write("busy_state_changed", { isBusy });
		if (!isBusy) {
			void this.archive.flushSnapshots();
		}
		this.emitSnapshot();
	}

	async prompt(
		message: string,
		source: "text" | "voice" | "automation" = "text",
		attachments: PendingPromptAttachment[] = [],
	): Promise<void> {
		if (!this.session) {
			throw new Error("Conversation session is not initialized.");
		}
		this.lastError = undefined;
		this.setBusy(true);
		if (source === "voice") {
			this.deps.updateVoiceOverlay({ visible: true, state: "transcribing", transcript: message });
		}
		this.confirmationAborted = false;
		this.completedApprovalResults = [];

		// Push the user's original message immediately so the chat bubble shows
		// clean text. The session receives the skill-routed prompt internally but
		// we never show that injected XML to the user.
		this.pushMessage("user", message);

		try {
			const attachmentBlock = await buildAttachmentPromptBlock(attachments, this.deps.host);
			const messageForModel = buildPromptWithAttachments(message, attachmentBlock);
			const injectedMemories = this.profile?.skipMemory ? [] : this.getPromptMemories(messageForModel);
			const selectedSkill = this.profile?.skipSkillRouting
				? undefined
				: await this.deps.selectSkillForPrompt(messageForModel);
			const selectedPersonalSkill = this.profile?.skipPersonalSkillRouting
				? undefined
				: await this.deps.selectPersonalSkillForPrompt(messageForModel);
			const routedPrompt = buildVoiceInputPrompt(
				buildPersonalSkillRoutedPrompt(
					buildSkillRoutedPrompt(messageForModel, selectedSkill),
					selectedPersonalSkill,
				),
				source === "voice" ? resolveVoiceInputSkillFile(this.deps.cwd) : undefined,
			);
			const promptWithMemory = buildMemoryAugmentedPrompt(routedPrompt, injectedMemories);
			this.archive.write("user_prompt_received", {
				message,
				source,
				attachments,
				conversationThinking: this.conversationThinking,
				selectedSkill,
				selectedPersonalSkill,
				routedPrompt: promptWithMemory,
				injectedMemoryIds: injectedMemories.map((memory) => memory.id),
			});
			if (selectedSkill) {
				this.pushTimeline({
					id: `skill-${selectedSkill.capabilityId}`,
					kind: "agent",
					title: `Skill: ${selectedSkill.skillName}`,
					status: "succeeded",
					timestamp: Date.now(),
				});
			}
			if (selectedPersonalSkill) {
				this.pushTimeline({
					id: `personal-skill-${selectedPersonalSkill.id}`,
					kind: "agent",
					title: `Personal skill: ${selectedPersonalSkill.title}`,
					status: "succeeded",
					timestamp: Date.now(),
				});
			}
			await this.session.prompt(promptWithMemory, { source: this.profile?.agentSource ?? "interactive" });
			this.archive.syncSessionFileMirror();
		} finally {
			this.setBusy(false);
			// Await archive flush so tests and callers that await prompt() see up-to-date files.
			await this.archive.flushSnapshots();
		}
	}

	abort(): void {
		this.flushStreamingText();
		this.streamingText = "";
		// Preserve the interrupted reasoning as its own box rather than dropping it.
		this.commitThinkingSegment();
		this.setBusy(false);
		this.session?.abort();
		this.archive.write("abort_requested", {
			sessionId: this.session?.sessionId,
			sessionFile: this.session?.sessionFile,
		});
		this.pushTimeline({
			id: randomUUID(),
			kind: "agent",
			title: "已停止执行",
			status: "blocked",
			timestamp: Date.now(),
		});
	}

	async approveConfirmation(id: string): Promise<void> {
		const confirmation = this.pendingConfirmations.find((item) => item.id === id);
		if (!confirmation) {
			return;
		}
		this.setBusy(true);
		this.pendingConfirmations = this.pendingConfirmations.filter((item) => item.id !== id);
		this.confirmationAborted = false;
		this.archive.write("confirmation_approved", {
			confirmation,
			remainingPendingConfirmations: this.pendingConfirmations,
		});
		this.pushTimeline({
			id,
			kind: "confirmation",
			title: `已批准：${confirmation.intent}`,
			detail: `${confirmation.action} ${confirmation.target}`,
			status: "running",
			timestamp: Date.now(),
		});
		try {
			const commandResult = await this.deps.host.runDesktopAction(confirmation.action, confirmation.target);
			this.archive.write("approved_action_result", {
				confirmation,
				commandResult,
			});
			this.pushTimeline({
				id,
				kind: "confirmation",
				title: `已执行：${confirmation.intent}`,
				detail: commandResult.stdout || commandResult.stderr || `${confirmation.action} ${confirmation.target}`,
				status: commandResult.stderr ? "failed" : "succeeded",
				timestamp: Date.now(),
			});
			this.completedApprovalResults.push({ confirmation, commandResult });
			this.emitSnapshot();
			if (this.pendingConfirmations.length === 0) {
				const results = this.completedApprovalResults.splice(0);
				await this.continueAfterApprovals(results);
			}
			this.emitSnapshot();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.archive.write("approved_action_error", {
				confirmation,
				detail,
				error,
			});
			this.pushTimeline({
				id,
				kind: "confirmation",
				title: `执行失败：${confirmation.intent}`,
				detail,
				status: "failed",
				timestamp: Date.now(),
			});
			this.completedApprovalResults.push({ confirmation, commandResult: { stdout: "", stderr: detail } });
			this.emitSnapshot();
		} finally {
			this.setBusy(false);
		}
	}

	async rejectConfirmation(id: string): Promise<void> {
		const confirmation = this.pendingConfirmations.find((item) => item.id === id);
		this.pendingConfirmations = this.pendingConfirmations.filter((item) => item.id !== id);
		this.archive.write("confirmation_rejected", {
			confirmation,
			remainingPendingConfirmations: this.pendingConfirmations,
		});
		if (confirmation) {
			this.pushTimeline({
				id,
				kind: "confirmation",
				title: `已拒绝：${confirmation.intent}`,
				detail: `${confirmation.action} ${confirmation.target}`,
				status: "blocked",
				timestamp: Date.now(),
			});
			if (this.session && this.pendingConfirmations.length === 0) {
				this.setBusy(true);
				try {
					await this.session.prompt(
						[
							"<desktop_action_rejected>",
							`intent: ${confirmation.intent}`,
							`action: ${confirmation.action}`,
							`target: ${confirmation.target}`,
							"用户已拒绝此操作。请告知用户该操作已被取消，不要尝试使用其他命令来完成同样的目的。",
							"</desktop_action_rejected>",
						].join("\n"),
						{ source: "interactive" },
					);
				} finally {
					this.setBusy(false);
				}
			}
		}
		this.emitSnapshot();
	}

	async updateConversationThinking(enabled: boolean): Promise<void> {
		this.conversationThinking = this.normalizeConversationThinkingState({
			enabled,
			effectiveLevel: enabled ? "high" : "off",
			supported: this.sessionSupportsThinking(this.conversationThinking.supported),
		});
		this.applyConversationThinkingToSession();
		this.archive.setConversationThinkingState(this.conversationThinking);
		this.archive.write("conversation_thinking_updated", {
			enabled,
			conversationThinking: this.conversationThinking,
			sessionId: this.session?.sessionId,
		});
		await this.archive.flushSnapshots();
	}

	/** Re-normalize thinking after a settings change and apply it to the session. */
	refreshConversationThinkingFromSettings(): void {
		this.conversationThinking = this.normalizeConversationThinkingState(this.conversationThinking);
		this.archive.setConversationThinkingState(this.conversationThinking);
		this.applyConversationThinkingToSession();
	}

	async applyModel(model: Parameters<AgentSession["setModel"]>[0]): Promise<void> {
		await this.session?.setModel(model);
	}

	refreshTools(customTools: Parameters<AgentSession["setCustomTools"]>[0], activeNames: string[]): void {
		if (!this.session) return;
		try {
			this.session.setCustomTools(customTools);
			this.session.setActiveToolsByName(activeNames);
		} catch {
			// Ignore if session not ready.
		}
	}

	reportError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.lastError = message;
		this.archive.write("service_error", { error, message });
		this.pushMessage("system", `桌面助手启动失败：${message}`);
		this.pushTimeline({
			id: randomUUID(),
			kind: "error",
			title: "启动失败",
			detail: message,
			status: "failed",
			timestamp: Date.now(),
		});
		this.emit({ type: "error", error: message });
	}

	snapshotFragment(): ContextSnapshotFragment {
		return {
			sessionId: this.session?.sessionId ?? "bootstrap",
			isRunning: this.isBusy,
			streamingText: this.streamingText,
			streamingThinking: this.streamingThinking,
			messages: this.messages,
			timeline: this.timeline,
			pendingConfirmations: this.pendingConfirmations,
			conversationThinking: this.conversationThinking,
			historyWindow: this.historyWindow,
			lastInjectedMemoryCount: this.lastInjectedMemoryCount,
			contextUsage: this.contextUsage(),
		};
	}

	contextUsage(): ConversationContextUsageView | undefined {
		if (!this.session || typeof this.session.getContextUsage !== "function") return undefined;
		const usage = this.session.getContextUsage();
		if (!usage) return undefined;
		return {
			tokens: usage.tokens,
			contextWindow: usage.contextWindow,
			percent: usage.percent,
			cacheHitRatio: this.sessionCacheHitRatio(),
		};
	}

	/**
	 * Tear down the runtime and finalize the archive.
	 * archiveMode "flush" regenerates snapshots before teardown (background
	 * eviction); "detach" only drains buffered event lines, leaving snapshot
	 * freshness untouched (switching away — matches single-writer behavior).
	 */
	async dispose(options?: { archiveMode?: "flush" | "detach" }): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.sessionUnsubscribe?.();
		this.sessionUnsubscribe = undefined;
		if (this.streamingTextTimer) {
			clearTimeout(this.streamingTextTimer);
			this.streamingTextTimer = undefined;
		}
		if (this.streamingThinkingTimer) {
			clearTimeout(this.streamingThinkingTimer);
			this.streamingThinkingTimer = undefined;
		}
		try {
			await this.runtime?.dispose();
		} catch {
			// Session teardown must never block context disposal.
		}
		if ((options?.archiveMode ?? "flush") === "flush") {
			await this.archive.dispose();
		} else {
			this.archive.detach();
		}
	}

	// ── Confirmation / continuation internals ─────────────────────────────────

	private capturePendingConfirmation(result: unknown): boolean {
		const details = parseDesktopToolResult(result);
		if (!details?.requiresConfirmation || details.status !== "blocked") return false;
		const isDuplicate = this.pendingConfirmations.some(
			(item) => item.action === details.action && item.target === details.target,
		);
		if (isDuplicate) return true;
		const pending: PendingConfirmation = {
			id: details.stepId,
			intent: details.intent,
			action: details.action,
			target: details.target,
			riskLevel: details.riskLevel,
			createdAt: Date.now(),
		};
		this.pendingConfirmations = [
			pending,
			...this.pendingConfirmations.filter((item) => item.id !== pending.id),
		].slice(0, 20);
		this.pushTimeline({
			id: pending.id,
			kind: "confirmation",
			title: `等待批准：${pending.intent}`,
			detail: `${pending.action} ${pending.target}`,
			status: "blocked",
			timestamp: pending.createdAt,
		});
		// A background session is asking for approval — fire a global "awaiting"
		// toast (yellow dot). The confirmation card itself stays inside this
		// session's chat view so session A's request never shows up in session B.
		if (!this.isFocused) {
			this.deps.emitSessionNotification(this.sessionId, "awaiting");
		}
		return true;
	}

	private async continueAfterApprovals(
		results: Array<{ confirmation: PendingConfirmation; commandResult: { stdout: string; stderr: string } }>,
	): Promise<void> {
		if (!this.session || results.length === 0) return;
		const resultBlocks = results.map(({ confirmation, commandResult }) =>
			[
				"<desktop_action_approved_result>",
				`intent: ${confirmation.intent}`,
				`action: ${confirmation.action}`,
				`target: ${confirmation.target}`,
				`stdout: ${commandResult.stdout || "(empty)"}`,
				`stderr: ${commandResult.stderr || "(empty)"}`,
				"</desktop_action_approved_result>",
			].join("\n"),
		);
		const continuationPrompt = [
			...resultBlocks,
			[
				"以上是用户批准并执行的所有命令结果。",
				"继续完成当前用户请求。",
				"不要把这条系统续跑提示当成用户新消息。",
				"请基于上面的执行结果直接告诉用户实际结果；如果有失败，说明原因和下一步建议。",
			].join(" "),
		].join("\n");
		this.archive.write("approval_continuation_prompt", {
			results,
			continuationPrompt,
		});
		await this.session.prompt(continuationPrompt, { source: "interactive" });
	}

	// ── History rebuild ────────────────────────────────────────────────────────

	async rebuildStateFromArchive(sessionId: string): Promise<void> {
		const source = readHistoryDisplaySource(this.deps.coordinator, sessionId);
		const page = sliceHistoryDisplayItems(source, {
			messageLimit: HISTORY_INITIAL_MESSAGE_LIMIT,
			timelineLimit: HISTORY_INITIAL_TIMELINE_LIMIT,
		});
		this.messages = page.messages;
		this.timeline = page.timeline;
		this.pendingConfirmations = source.pendingConfirmations;
		this.historyWindow = {
			sessionId,
			hasMoreBefore: page.hasMoreBefore,
			oldestOrder: page.oldestOrder,
			loadedFrom: source.loadedFrom,
		};
		this.completedApprovalResults = [];
		this.streamingText = "";
		this.streamingThinking = "";
		this.confirmationAborted = false;
		this.nextDisplayOrder = source.nextDisplayOrder;
		this.conversationThinking = this.restoreConversationThinkingState(sessionId);
		this.archive.setConversationThinkingState(this.conversationThinking);
		this.applyConversationThinkingToSession();
		this.setBusy(false);
		this.lastTokenSavingCompactionBrowserChars = this.session
			? estimateBrowserToolHistoryChars(this.session.sessionManager.buildSessionContext().messages)
			: 0;
	}

	// ── Memory ────────────────────────────────────────────────────────────────

	private getPromptMemories(message: string): GlobalMemoryEntry[] {
		const settings = this.deps.getSettings();
		if (!settings.memory.enabled) {
			this.lastInjectedMemoryCount = 0;
			return [];
		}
		const limit = normalizeMemoryLimit(settings.memory.maxInjected);
		const memories = this.deps.memoryStore.search(message, limit).map((result) => result.memory);
		this.lastInjectedMemoryCount = memories.length;
		this.deps.memoryStore.markUsed(memories.map((memory) => memory.id));
		return memories;
	}

	private extractMemoriesFromLatestTurn(): void {
		const settings = this.deps.getSettings();
		if (!settings.memory.enabled || !settings.memory.autoExtract) return;
		const latestUserMessage = findLatestMessageText(this.messages, "user");
		if (!latestUserMessage) return;
		const latestAssistantMessage = findLatestMessageText(this.messages, "assistant");
		const candidates = this.deps.memoryStore.extractFromTurn({
			userMessage: latestUserMessage,
			assistantMessage: latestAssistantMessage,
			sourceSessionId: this.session?.sessionId,
		});
		for (const candidate of candidates) {
			this.deps.memoryStore.upsert({
				...candidate,
				sourceSessionId: this.session?.sessionId,
			});
		}
	}

	// ── Conversation thinking ─────────────────────────────────────────────────

	private async maybeGenerateConversationTitle(): Promise<void> {
		if (this.titleGenerationStarted) {
			this.emitTitleDiagnostic("debug", "skipped because generation already started");
			return;
		}
		if (this.archive.hasTitle()) {
			this.titleGenerationStarted = true;
			this.emitTitleDiagnostic("debug", "skipped because title already exists", {
				title: this.archive.getTitle(),
			});
			return;
		}
		const userMessage = findFirstMessageText(this.messages, "user");
		if (!userMessage) {
			this.emitTitleDiagnostic("warn", "skipped because first user message is missing", {
				messageCount: this.messages.length,
			});
			return;
		}
		const assistantMessage = findLatestMessageText(this.messages, "assistant");
		this.titleGenerationStarted = true;
		this.emitTitleDiagnostic("info", "generation triggered", {
			userMessageChars: Array.from(userMessage).length,
			assistantMessageChars: assistantMessage ? Array.from(assistantMessage).length : 0,
			hasAssistantMessage: Boolean(assistantMessage),
		});
		try {
			const title = await this.deps.generateConversationTitle({
				userMessage,
				assistantMessage,
				onDiagnostic: (diagnostic) => {
					this.emitTitleDiagnostic(diagnostic.level, diagnostic.title, diagnostic.details);
				},
			});
			if (!title) {
				this.titleGenerationStarted = false;
				this.emitTitleDiagnostic("warn", "generation finished without title");
				return;
			}
			await this.archive.setTitle(title, "auto");
			this.emitTitleDiagnostic("info", "title saved", { title });
			if (this.isFocused) {
				this.emitSnapshot();
			} else {
				this.deps.emitSessionStatus(this.archive);
			}
		} catch (error) {
			this.titleGenerationStarted = false;
			this.emitTitleDiagnostic("error", "generation failed", {
				error: describeUnknownError(error),
			});
		}
	}

	private emitTitleDiagnostic(
		level: "debug" | "info" | "warn" | "error",
		title: string,
		details?: Record<string, unknown>,
	): void {
		this.emit({
			type: "diagnostic",
			diagnostic: {
				source: "conversation_title",
				level,
				title,
				details: {
					sessionId: this.sessionId,
					...details,
				},
			},
		});
	}

	private createConversationThinkingFromSettingsDefault(): ConversationThinkingState {
		const supported = this.sessionSupportsThinking();
		return this.normalizeConversationThinkingState(
			createConversationThinkingFromDefault(this.deps.getSettings().thinkingLevel, supported),
		);
	}

	private normalizeConversationThinkingState(state: ConversationThinkingState): ConversationThinkingState {
		const supported = this.sessionSupportsThinking(state.supported);
		if (!supported) {
			return {
				enabled: false,
				effectiveLevel: "off",
				supported: false,
			};
		}
		if (!state.enabled || state.effectiveLevel === "off") {
			return {
				enabled: false,
				effectiveLevel: "off",
				supported: true,
			};
		}
		return {
			enabled: true,
			effectiveLevel: state.effectiveLevel,
			supported: true,
		};
	}

	private sessionSupportsThinking(fallback = true): boolean {
		const supportsThinking = this.session?.supportsThinking;
		return typeof supportsThinking === "function" ? supportsThinking.call(this.session) : fallback;
	}

	getSessionBootstrapThinkingLevel(): DesktopAssistantSettings["thinkingLevel"] {
		if (!this.conversationThinking.supported) return "off";
		return this.conversationThinking.enabled ? this.conversationThinking.effectiveLevel : "off";
	}

	private applyConversationThinkingToSession(): void {
		if (!this.session) return;
		const setThinkingLevel = this.session.setThinkingLevel;
		if (typeof setThinkingLevel !== "function") return;
		try {
			setThinkingLevel.call(this.session, this.getSessionBootstrapThinkingLevel());
		} catch (error) {
			console.warn("Failed to apply conversation thinking state:", error);
		}
	}

	private restoreConversationThinkingState(sessionId: string): ConversationThinkingState {
		const metadata = this.deps.coordinator.getConversationMetadata(sessionId);
		if (metadata?.conversationThinking) {
			return this.normalizeConversationThinkingState(metadata.conversationThinking);
		}
		return this.createConversationThinkingFromSettingsDefault();
	}

	// ── Display & event helpers ───────────────────────────────────────────────

	pushMessage(
		role: ChatMessageView["role"],
		text: string,
		options: { tokenUsage?: MessageTokenUsageView; turnTokenUsage?: MessageTokenUsageView; thinking?: string } = {},
	): void {
		const timestamp = Date.now();
		this.lastActivityAt = timestamp;
		if (role === "system") {
			this.archive.write("desktop_message", {
				role,
				text,
				timestamp,
			});
		}
		this.messages = [
			...this.messages,
			{
				id: randomUUID(),
				role,
				text,
				thinking: options.thinking,
				timestamp,
				order: this.consumeDisplayOrder(),
				tokenUsage: options.tokenUsage,
				turnTokenUsage: options.turnTokenUsage,
			},
		];
		this.emitSnapshot();
	}

	private updateLatestAssistantTurnTokenUsage(turnTokenUsage: MessageTokenUsageView | undefined): void {
		if (!turnTokenUsage) return;
		for (let index = this.messages.length - 1; index >= 0; index -= 1) {
			const message = this.messages[index];
			if (message.role !== "assistant") continue;
			this.messages = this.messages.map((item, itemIndex) =>
				itemIndex === index ? { ...item, turnTokenUsage } : item,
			);
			this.emitSnapshot();
			return;
		}
	}

	private reviewPendingTokenSavingCompaction(
		message: Extract<AgentSessionEvent, { type: "message_end" }>["message"],
	): void {
		const review = this.pendingTokenSavingCompactionReview;
		if (!review || message.role !== "assistant") return;
		const usage = tokenUsageFromAssistantMessage(message);
		if (!usage) return;
		const outcome = evaluateTokenSavingCompactionOutcome({
			baselinePromptTokens: review.baselinePromptTokens,
			baselineCacheHitRatio: review.baselineCacheHitRatio,
			observedPromptTokens: promptTokensFromUsage(usage),
			observedCacheReadTokens: usage.cacheRead,
		});
		this.pendingTokenSavingCompactionReview = undefined;
		this.recentIneffectiveTokenSavingCompactions = outcome.effective
			? 0
			: Math.min(3, this.recentIneffectiveTokenSavingCompactions + 1);
		this.archive.write("token_saving_compaction_outcome", {
			...outcome,
			score: review.score,
			triggerReasons: review.reasons,
			recentIneffectiveCompactions: this.recentIneffectiveTokenSavingCompactions,
		});
	}

	pushTimeline(item: Omit<TimelineItem, "order"> & { order?: number }): void {
		const normalizedItem: TimelineItem = {
			...item,
			order: this.consumeDisplayOrder(item.order && item.order > 0 ? item.order : undefined),
		};
		this.lastActivityAt = Date.now();
		this.timeline = [...this.timeline.filter((existing) => existing.id !== normalizedItem.id), normalizedItem].slice(
			-200,
		);
		this.emit({ type: "timeline", timelineItem: normalizedItem });
		this.emitSnapshot();
	}

	private pushAssistantRunError(errorMessage: string | undefined, stopReason: "error" | "aborted"): void {
		const detail = errorMessage?.trim();
		const message =
			stopReason === "aborted"
				? "本轮回复已中断。如果这不是你主动停止的，可以直接重新发送。"
				: `模型在工具调用后没有返回可展示内容${detail ? `：${detail}` : "。"}`;
		if (stopReason === "error") {
			this.lastError = detail || "模型响应失败";
		}
		this.pushTimeline({
			id: randomUUID(),
			kind: "error",
			title: stopReason === "aborted" ? "回复已中断" : "模型响应失败",
			detail,
			status: "failed",
			timestamp: Date.now(),
		});
		this.pushMessage("system", message);
	}

	private hasRecentAssistantMessage(text: string): boolean {
		for (let index = this.messages.length - 1; index >= 0; index -= 1) {
			const message = this.messages[index];
			if (message.role !== "assistant") continue;
			return message.text === text;
		}
		return false;
	}

	private consumeDisplayOrder(explicitOrder?: number): number {
		if (explicitOrder !== undefined) {
			this.nextDisplayOrder = Math.max(this.nextDisplayOrder, explicitOrder + 1);
			return explicitOrder;
		}
		const order = this.nextDisplayOrder;
		this.nextDisplayOrder += 1;
		return order;
	}

	private emit(event: DesktopAssistantEvent): void {
		// Tag every event with its originating session so the renderer can route it
		// (e.g. ignore a background session's streaming_text while another is focused).
		this.deps.emit({ ...event, sessionId: event.sessionId ?? this.sessionId }, this.archive);
	}

	private emitSnapshot(): void {
		// Only the focused conversation pushes full detail. Background conversations
		// emit just the lightweight roster so their activity never overwrites the
		// focused chat's messages/streaming text in the UI.
		if (this.isFocused) {
			this.deps.emit({ type: "snapshot", snapshot: this.deps.snapshot() }, this.archive);
		} else {
			this.deps.emitSessionStatus(this.archive);
		}
	}

	private scheduleStreamingTextEmit(): void {
		if (this.streamingTextTimer) return;
		this.streamingTextTimer = setTimeout(() => {
			this.streamingTextTimer = undefined;
			if (this.streamingText) {
				this.emit({ type: "streaming_text", streamingText: this.streamingText });
			}
		}, ConversationContext.STREAMING_THROTTLE_MS);
	}

	private flushStreamingText(): void {
		if (this.streamingTextTimer) {
			clearTimeout(this.streamingTextTimer);
			this.streamingTextTimer = undefined;
		}
		if (this.streamingText) {
			this.emit({ type: "streaming_text", streamingText: this.streamingText });
		}
	}

	private scheduleStreamingThinkingEmit(): void {
		if (this.streamingThinkingTimer) return;
		this.streamingThinkingTimer = setTimeout(() => {
			this.streamingThinkingTimer = undefined;
			if (this.streamingThinking) {
				this.emit({ type: "streaming_thinking", streamingThinking: this.streamingThinking });
			}
		}, ConversationContext.STREAMING_THROTTLE_MS);
	}

	/**
	 * Close the current reasoning segment: push it as its own ordered "thinking"
	 * timeline item (so it interleaves correctly with the tool calls and answer that
	 * follow) and reset the live buffer so the next segment opens a fresh box.
	 *
	 * @param text Authoritative thinking text (e.g. from the finished assistant
	 *   message). Falls back to the live streaming buffer when omitted.
	 */
	private commitThinkingSegment(text?: string): void {
		if (this.streamingThinkingTimer) {
			clearTimeout(this.streamingThinkingTimer);
			this.streamingThinkingTimer = undefined;
		}
		const hadLiveBuffer = this.streamingThinking.length > 0;
		const thinking = (text ?? this.streamingThinking).trim();
		this.streamingThinking = "";
		if (!thinking) {
			// Nothing to commit; only refresh if there was a live box that needs clearing.
			if (hadLiveBuffer) this.emitSnapshot();
			return;
		}
		this.pushTimeline({
			id: `thinking-${randomUUID()}`,
			kind: "thinking",
			title: "已深度思考",
			detail: thinking,
			status: "succeeded",
			timestamp: Date.now(),
		});
	}
}

// ── Prompt building helpers ───────────────────────────────────────────────────

export function resolveVoiceInputSkillFile(cwd: string): string | undefined {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolve(moduleDir, "..", "..", "skills", VOICE_INPUT_SKILL_NAME, "SKILL.md"),
		resolve(moduleDir, "..", "..", "..", "skills", VOICE_INPUT_SKILL_NAME, "SKILL.md"),
		resolve(cwd, "skills", VOICE_INPUT_SKILL_NAME, "SKILL.md"),
		resolve(cwd, "packages", "desktop-assistant", "skills", VOICE_INPUT_SKILL_NAME, "SKILL.md"),
	];
	return candidates.find((candidate) => existsSync(candidate));
}

export function buildSkillRoutedPrompt(message: string, skillFile: SkillFileView | undefined): string {
	if (!skillFile) return message;
	return [
		`<selected_desktop_skill capability="${skillFile.capabilityId}" name="${skillFile.skillName}" location="${skillFile.path}">`,
		skillFile.content,
		"</selected_desktop_skill>",
		"<desktop_skill_routing_instruction>",
		"The desktop assistant selected this skill before handling the user request. Follow this skill for the rest of the operation. If the selected capability has no concrete automation tool for the requested change, say so instead of pretending the operation was completed.",
		"</desktop_skill_routing_instruction>",
		"",
		message,
	].join("\n");
}

export function buildPromptWithAttachments(message: string, attachmentBlock: string): string {
	if (!attachmentBlock.trim()) return message;
	return [
		message,
		"",
		"<desktop_attachment_instruction>",
		"The user attached local files. The following attachment snapshots were extracted by the desktop app before sending the prompt. Use the Markdown view for readability and the structured JSON for layout, formatting, table, and spreadsheet details. If an attachment reports an extraction error, say what is unavailable instead of guessing its contents.",
		"</desktop_attachment_instruction>",
		attachmentBlock,
	].join("\n");
}

export function buildVoiceInputPrompt(message: string, skillFilePath: string | undefined): string {
	if (!skillFilePath) return message;
	const content = readFileSync(skillFilePath, "utf-8");
	return [
		`<voice_input_skill name="${VOICE_INPUT_SKILL_NAME}" location="${skillFilePath}">`,
		content,
		"</voice_input_skill>",
		"<voice_input_context>",
		"The user input below came from speech recognition and may contain homophones, word-boundary errors, or transcription mistakes. Infer the user's likely intent from context, naturally correct minor recognition errors, and ask for clarification only when ambiguity materially changes the requested action.",
		"</voice_input_context>",
		"",
		message,
	].join("\n");
}

export function buildMemoryAugmentedPrompt(message: string, memories: GlobalMemoryEntry[]): string {
	if (memories.length === 0) return message;
	return `${buildMemoryContextBlock(memories)}${message}`;
}

function buildTokenSavingCompactionInstructions(decision: TokenSavingTurnCompactionDecision): string {
	return [
		"Token saving mode: summarize old browser/MCP automation results.",
		"Keep user goals, decisions, current page state, relevant snapshot ids, errors, and pending next steps.",
		"Prefer change summaries and snapshot ids over repeated page text. Preserve exact values only when needed for continuing the task.",
		`Trigger score: ${decision.score}. Reasons: ${decision.reasons.join("; ") || "browser MCP noise"}.`,
	].join(" ");
}

export function normalizeMemoryLimit(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_DESKTOP_ASSISTANT_SETTINGS.memory.maxInjected;
	}
	return Math.min(20, Math.max(0, Math.floor(value)));
}

export function createConversationThinkingFromDefault(
	level: DesktopAssistantSettings["thinkingLevel"],
	supported: boolean,
): ConversationThinkingState {
	if (!supported || level === "off") {
		return {
			enabled: false,
			effectiveLevel: "off",
			supported,
		};
	}
	return {
		enabled: true,
		effectiveLevel: level,
		supported: true,
	};
}

function findLatestMessageText(messages: ChatMessageView[], role: ChatMessageView["role"]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== role) continue;
		const text = message.text.trim();
		if (text) return text;
	}
	return undefined;
}

function findFirstMessageText(messages: ChatMessageView[], role: ChatMessageView["role"]): string | undefined {
	for (const message of messages) {
		if (message.role !== role) continue;
		const text = message.text.trim();
		if (text) return text;
	}
	return undefined;
}

// ── Desktop tool result parsing ───────────────────────────────────────────────

export function parseDesktopToolResult(result: unknown): DesktopToolResult | undefined {
	if (isDesktopToolResult(result)) return result;
	if (typeof result !== "object" || result === null) return undefined;
	const maybeDetails = (result as { details?: unknown }).details;
	if (isDesktopToolResult(maybeDetails)) return maybeDetails;
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	for (const item of content) {
		if (typeof item !== "object" || item === null) continue;
		const text = (item as { text?: unknown }).text;
		if (typeof text !== "string") continue;
		try {
			const parsed = JSON.parse(text) as unknown;
			if (isDesktopToolResult(parsed)) return parsed;
		} catch {
			// Ignore non-JSON tool text.
		}
	}
	return undefined;
}

function isDesktopToolResult(value: unknown): value is DesktopToolResult {
	if (typeof value !== "object" || value === null) return false;
	const item = value as Partial<DesktopToolResult>;
	return (
		typeof item.stepId === "string" &&
		typeof item.intent === "string" &&
		typeof item.action === "string" &&
		typeof item.target === "string" &&
		typeof item.status === "string" &&
		typeof item.riskLevel === "string" &&
		typeof item.requiresConfirmation === "boolean"
	);
}

function safeStringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function describeUnknownError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
		};
	}
	return { message: String(error) };
}

function extractLatestAssistantTextFromAgentMessages(
	messages: Extract<AgentSessionEvent, { type: "agent_end" }>["messages"],
): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("")
			.trim();
		if (text) return text;
	}
	return undefined;
}

function extractThinkingFromAssistantMessage(
	message: Extract<AgentSessionEvent, { type: "message_end" }>["message"],
): string | undefined {
	if (message.role !== "assistant") return undefined;
	const thinking = message.content
		.filter((content) => content.type === "thinking")
		.map((content) => (content.redacted ? REDACTED_THINKING_PLACEHOLDER : content.thinking))
		.join("")
		.trim();
	return thinking || undefined;
}

function extractLatestAssistantRunError(
	messages: Extract<AgentSessionEvent, { type: "agent_end" }>["messages"],
): { errorMessage?: string; stopReason: "error" | "aborted" } | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return {
				errorMessage: message.errorMessage,
				stopReason: message.stopReason,
			};
		}
	}
	return undefined;
}

function tokenUsageFromAssistantMessage(
	message: Extract<AgentSessionEvent, { type: "message_end" }>["message"],
): MessageTokenUsageView | undefined {
	if (message.role !== "assistant") return undefined;
	if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;
	return {
		input: message.usage.input,
		output: message.usage.output,
		cacheRead: message.usage.cacheRead,
		cacheWrite: message.usage.cacheWrite,
		total:
			message.usage.totalTokens ||
			message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite,
	};
}

function tokenUsageFromAgentMessages(
	messages: Extract<AgentSessionEvent, { type: "agent_end" }>["messages"],
): MessageTokenUsageView | undefined {
	let totalUsage: MessageTokenUsageView | undefined;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const usage = tokenUsageFromAssistantMessage(message);
		if (!usage) continue;
		totalUsage = addTokenUsage(totalUsage, usage);
	}
	return totalUsage;
}

function promptTokensFromUsage(usage: MessageTokenUsageView): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

function cacheHitRatioFromUsage(usage: MessageTokenUsageView): number {
	const promptTokens = promptTokensFromUsage(usage);
	return promptTokens > 0 ? usage.cacheRead / promptTokens : 0;
}

function latestAssistantTokenUsageFromAgentMessages(
	messages: Extract<AgentSessionEvent, { type: "agent_end" }>["messages"],
): MessageTokenUsageView | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const usage = tokenUsageFromAssistantMessage(message);
		if (usage) return usage;
	}
	return undefined;
}

function addTokenUsage(left: MessageTokenUsageView | undefined, right: MessageTokenUsageView): MessageTokenUsageView {
	if (!left) return right;
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		total: left.total + right.total,
	};
}

// ── History display reconstruction ────────────────────────────────────────────

export interface HistoryDisplaySource {
	messages: ChatMessageView[];
	timeline: TimelineItem[];
	pendingConfirmations: PendingConfirmation[];
	nextDisplayOrder: number;
	loadedFrom: ConversationHistoryLoadSource;
}

export interface HistoryDisplayPage {
	messages: ChatMessageView[];
	timeline: TimelineItem[];
	hasMoreBefore: boolean;
	oldestOrder?: number;
}

interface RestoredThinkingDelta {
	sequence: number;
	contentIndex?: number;
	delta: string;
}

export function normalizeHistoryLimit(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(100, Math.max(1, Math.floor(value)));
}

export function sliceHistoryDisplayItems(
	source: HistoryDisplaySource,
	options: { beforeOrder?: number; messageLimit: number; timelineLimit: number },
): HistoryDisplayPage {
	const beforeOrder =
		typeof options.beforeOrder === "number" && Number.isFinite(options.beforeOrder) ? options.beforeOrder : undefined;
	const eligibleMessages =
		beforeOrder === undefined ? source.messages : source.messages.filter((message) => message.order < beforeOrder);
	const messagePage = eligibleMessages.slice(-options.messageLimit);
	const eligibleTimeline =
		beforeOrder === undefined ? source.timeline : source.timeline.filter((item) => item.order < beforeOrder);
	const timelinePage = eligibleTimeline.slice(-options.timelineLimit);
	const oldestOrder = minPositiveOrder([...messagePage, ...timelinePage]);
	return {
		messages: messagePage,
		timeline: timelinePage,
		oldestOrder,
		hasMoreBefore:
			(source.messages.length > 0 && messagePage[0] !== source.messages[0]) ||
			(source.timeline.length > 0 && timelinePage[0] !== source.timeline[0]),
	};
}

function minPositiveOrder(items: Array<{ order: number }>): number | undefined {
	let lowest: number | undefined;
	for (const item of items) {
		if (item.order <= 0) continue;
		lowest = lowest === undefined ? item.order : Math.min(lowest, item.order);
	}
	return lowest;
}

export function readHistoryDisplaySource(
	coordinator: ConversationArchiveCoordinator,
	sessionId: string,
): HistoryDisplaySource {
	const metadata = coordinator.getConversationMetadata(sessionId);
	const conversationFile = metadata?.conversationFile;
	if (conversationFile && existsSync(conversationFile) && isConversationSnapshotFresh(metadata)) {
		const archive = readAiReadableConversationArchive(conversationFile);
		if (archive) {
			return buildHistoryDisplaySourceFromArchive(archive, sessionId, "conversation");
		}
	}
	const rawEventsFile = metadata?.rawEventsFile;
	if (rawEventsFile && existsSync(rawEventsFile)) {
		const records = readConversationArchiveRecords(rawEventsFile);
		if (records.length > 0) {
			return buildHistoryDisplaySourceFromRecords(records, sessionId);
		}
	}
	if (conversationFile && existsSync(conversationFile)) {
		const archive = readAiReadableConversationArchive(conversationFile);
		if (archive) {
			return buildHistoryDisplaySourceFromArchive(archive, sessionId, "conversation");
		}
	}
	return {
		messages: [],
		timeline: [],
		pendingConfirmations: [],
		nextDisplayOrder: 1,
		loadedFrom: "conversation",
	};
}

export function readAiReadableConversationArchive(filePath: string): AiReadableConversationArchive | undefined {
	try {
		return JSON.parse(readFileSync(filePath, "utf-8")) as AiReadableConversationArchive;
	} catch {
		return undefined;
	}
}

function isConversationSnapshotFresh(
	metadata: ReturnType<ConversationArchiveCoordinator["getConversationMetadata"]>,
): boolean {
	if (!metadata?.conversationFile || !existsSync(metadata.conversationFile)) return false;
	const archive = readAiReadableConversationArchive(metadata.conversationFile);
	if (!archive) return false;
	if (metadata.recordsWritten > archive.stats.recordCount) return false;
	if (metadata.rawEventsFile && existsSync(metadata.rawEventsFile)) {
		try {
			const rawEventsStat = statSync(metadata.rawEventsFile);
			if (rawEventsStat.size > 0 && archive.stats.recordCount === 0) return false;
			if (rawEventsStat.size > 0 && archive.messages.length === 0) return false;
			const conversationMtime = statSync(metadata.conversationFile).mtimeMs;
			const rawEventsMtime = rawEventsStat.mtimeMs;
			if (rawEventsMtime > conversationMtime + 1000) return false;
		} catch {
			return false;
		}
	}
	return true;
}

function buildHistoryDisplaySourceFromArchive(
	archive: AiReadableConversationArchive,
	sessionId: string,
	loadedFrom: ConversationHistoryLoadSource,
): HistoryDisplaySource {
	const messages: ChatMessageView[] = dedupeArchiveMessages(archive.messages)
		.map((message, index) => ({
			id: `${sessionId}-msg-${message.sequence}-${index}`,
			role: message.role,
			text: message.text,
			tokenUsage: message.tokenUsage,
			turnTokenUsage: message.turnTokenUsage,
			timestamp:
				message.timestamp ??
				(message.recordedAt ? Date.parse(message.recordedAt) : undefined) ??
				Date.parse(archive.updatedAt) ??
				Date.now(),
			order: message.sequence,
		}))
		.sort((left, right) => left.order - right.order);
	// Reasoning deltas become their own ordered thinking boxes, interleaved with tools.
	const timeline: TimelineItem[] = buildThinkingTimelineItems(
		archive.thinking,
		sessionId,
		Date.parse(archive.updatedAt) || Date.now(),
	);
	for (const [index, tool] of archive.tools.entries()) {
		upsertRestoredTimelineItem(timeline, {
			id: tool.toolCallId ?? `${tool.toolName}-${index}`,
			kind: "tool",
			title: `Tool ${tool.phase === "start" ? "started" : tool.phase === "end" ? "finished" : "running"}: ${tool.toolName}`,
			detail: JSON.stringify(
				tool.phase === "end"
					? {
							details: {
								target: tool.toolName,
								stdout: safeStringify(tool.result),
								stderr: tool.isError ? "error" : "",
							},
						}
					: tool.phase === "update"
						? tool.result
						: (tool.args ?? {}),
			),
			status: tool.phase === "end" ? (tool.isError ? "failed" : "succeeded") : "running",
			timestamp: Date.parse(tool.recordedAt) || Date.now(),
			order: tool.sequence,
			toolCallId: tool.toolCallId,
		});
	}
	timeline.sort((left, right) => left.order - right.order);
	return {
		messages,
		timeline,
		pendingConfirmations: [],
		nextDisplayOrder:
			Math.max(0, ...messages.map((message) => message.order), ...timeline.map((item) => item.order)) + 1,
		loadedFrom,
	};
}

function dedupeArchiveMessages(
	archiveMessages: AiReadableConversationArchive["messages"],
): AiReadableConversationArchive["messages"] {
	const directMessageCounts = new Map<string, number>();
	for (const message of archiveMessages) {
		if (!isSnapshotArchiveMessage(message)) {
			const key = archiveMessageKey(message);
			directMessageCounts.set(key, (directMessageCounts.get(key) ?? 0) + 1);
		}
	}

	const seenSnapshotSystemMessages = new Set<string>();
	return archiveMessages.filter((message) => {
		if (!isSnapshotArchiveMessage(message)) return true;
		const key = archiveMessageKey(message);
		if ((message.role === "user" || message.role === "assistant") && (directMessageCounts.get(key) ?? 0) > 0) {
			return false;
		}
		if (message.role === "system") {
			if (seenSnapshotSystemMessages.has(key)) return false;
			seenSnapshotSystemMessages.add(key);
		}
		return true;
	});
}

function isSnapshotArchiveMessage(message: AiReadableConversationArchive["messages"][number]): boolean {
	return message.sourceKind.includes(":snapshot");
}

function archiveMessageKey(message: { role: "user" | "assistant" | "system"; text: string }): string {
	return `${message.role}\u0000${message.text}`;
}

/**
 * Group a flat list of reasoning deltas into per-segment "thinking" timeline items.
 * A segment is the run of thinking that precedes one tool call (or the final answer);
 * here it is detected by a gap in record sequence (other events sit between segments)
 * or a content-index reset (a new assistant step). Each item is ordered by its first
 * delta's sequence so it interleaves correctly with the tool items it precedes.
 */
function buildThinkingTimelineItems(
	thinking: RestoredThinkingDelta[],
	sessionId: string,
	defaultTimestamp: number,
): TimelineItem[] {
	const items: TimelineItem[] = [];
	let segment: { firstSequence: number; lastSequence: number; contentIndex?: number; parts: string[] } | undefined;
	const flush = (): void => {
		if (!segment) return;
		const text = segment.parts.join("").trim();
		if (text) {
			items.push({
				id: `${sessionId}-thinking-${segment.firstSequence}`,
				kind: "thinking",
				title: "已深度思考",
				detail: text,
				status: "succeeded",
				timestamp: defaultTimestamp,
				order: segment.firstSequence,
			});
		}
		segment = undefined;
	};
	const sorted = [...thinking].sort(
		(left, right) => left.sequence - right.sequence || (left.contentIndex ?? 0) - (right.contentIndex ?? 0),
	);
	for (const delta of sorted) {
		const startsNewSegment =
			!segment ||
			delta.sequence - segment.lastSequence > 1 ||
			(delta.contentIndex !== undefined &&
				segment.contentIndex !== undefined &&
				delta.contentIndex < segment.contentIndex);
		if (startsNewSegment) {
			flush();
			segment = {
				firstSequence: delta.sequence,
				lastSequence: delta.sequence,
				contentIndex: delta.contentIndex,
				parts: [],
			};
		}
		const active = segment;
		if (!active) continue;
		active.parts.push(delta.delta);
		active.lastSequence = delta.sequence;
		if (delta.contentIndex !== undefined) active.contentIndex = delta.contentIndex;
	}
	flush();
	return items;
}

function buildHistoryDisplaySourceFromRecords(
	records: ConversationArchiveRecord[],
	sessionId: string,
): HistoryDisplaySource {
	return {
		...rebuildArchiveStateFromRecords(records, sessionId),
		loadedFrom: "events",
	};
}

function upsertRestoredTimelineItem(timeline: TimelineItem[], item: TimelineItem): void {
	const next = [...timeline.filter((existing) => existing.id !== item.id), item];
	timeline.splice(0, timeline.length, ...next);
}

function readConversationArchiveRecords(filePath: string): ConversationArchiveRecord[] {
	try {
		return readFileSync(filePath, "utf-8")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ConversationArchiveRecord)
			.sort((left, right) => left.sequence - right.sequence);
	} catch {
		return [];
	}
}

function rebuildArchiveStateFromRecords(
	records: ConversationArchiveRecord[],
	sessionId: string,
): {
	messages: ChatMessageView[];
	timeline: TimelineItem[];
	pendingConfirmations: PendingConfirmation[];
	nextDisplayOrder: number;
} {
	const messages: ChatMessageView[] = [];
	const timeline: TimelineItem[] = [];
	// Reasoning is reconstructed one segment at a time (the run between two tool
	// calls), mirroring the live path. A segment opens on the first thinking delta
	// and is committed as its own ordered "thinking" timeline item when its step's
	// message_end arrives, so it interleaves correctly with the tool calls.
	let currentThinking: { firstSequence: number; parts: string[] } | undefined;
	let pendingConfirmations: PendingConfirmation[] = [];

	const commitThinkingSegment = (authoritativeText: string | undefined, fallbackOrder: number, ts: number): void => {
		const text = (authoritativeText ?? currentThinking?.parts.join("") ?? "").trim();
		const order = currentThinking?.firstSequence ?? fallbackOrder;
		currentThinking = undefined;
		if (!text) return;
		upsertRestoredTimelineItem(timeline, {
			id: `${sessionId}-thinking-${order}`,
			kind: "thinking",
			title: "已深度思考",
			detail: text,
			status: "succeeded",
			timestamp: ts,
			order,
		});
	};

	for (const record of records) {
		const timestamp = Date.parse(record.recordedAt) || Date.now();
		if (record.kind === "user_prompt_received") {
			const message = getStringFieldFromRecord(record.payload, "message");
			if (message) {
				messages.push({
					id: `${sessionId}-msg-${record.sequence}`,
					role: "user",
					text: message,
					timestamp,
					order: record.sequence,
				});
			}
			continue;
		}

		if (record.kind === "agent_event") {
			const eventType = getNestedStringFieldFromRecord(record.payload, ["type"]);
			if (eventType === "message_end") {
				const role = getNestedStringFieldFromRecord(record.payload, ["message", "role"]);
				if (role === "assistant") {
					const messagePayload = getNestedFieldFromRecord(record.payload, ["message"]);
					// Close this step's reasoning as its own box (ordered before the step's
					// text and tools) instead of folding it into the message bubble.
					commitThinkingSegment(extractThinkingFromRecordMessage(messagePayload), record.sequence, timestamp);
					const text = extractTextFromRecordMessage(messagePayload);
					if (text) {
						messages.push({
							id: `${sessionId}-msg-${record.sequence}`,
							role: "assistant",
							text,
							tokenUsage: parseTokenUsageFromRecordMessage(
								getNestedFieldFromRecord(record.payload, ["message"]),
							),
							timestamp,
							order: record.sequence,
						});
					}
				}
				continue;
			}
			if (eventType === "agent_end") {
				// Safety net for reasoning a missing message_end never closed.
				commitThinkingSegment(undefined, record.sequence, timestamp);
				const assistantText = extractLatestAssistantTextFromRecordMessages(
					getNestedFieldFromRecord(record.payload, ["messages"]),
				);
				const turnTokenUsage = parseTokenUsageFromRecordMessages(
					getNestedFieldFromRecord(record.payload, ["messages"]),
				);
				if (assistantText) {
					const existingIndex = findCurrentTurnAssistantMessageIndex(messages, assistantText);
					if (existingIndex >= 0) {
						if (turnTokenUsage) {
							messages[existingIndex] = {
								...messages[existingIndex],
								turnTokenUsage,
							};
						}
					} else {
						messages.push({
							id: `${sessionId}-msg-${record.sequence}`,
							role: "assistant",
							text: assistantText,
							tokenUsage: latestTokenUsageFromRecordMessages(
								getNestedFieldFromRecord(record.payload, ["messages"]),
							),
							turnTokenUsage,
							timestamp,
							order: record.sequence,
						});
					}
				}
				continue;
			}
			if (eventType === "message_update") {
				const assistantEventType = getNestedStringFieldFromRecord(record.payload, [
					"assistantMessageEvent",
					"type",
				]);
				if (assistantEventType === "thinking_delta") {
					const delta = getNestedStringFieldFromRecord(record.payload, ["assistantMessageEvent", "delta"]) ?? "";
					if (!currentThinking) {
						currentThinking = { firstSequence: record.sequence, parts: [] };
					}
					currentThinking.parts.push(delta);
				}
				continue;
			}
			if (
				eventType === "tool_execution_start" ||
				eventType === "tool_execution_update" ||
				eventType === "tool_execution_end"
			) {
				const toolName = getNestedStringFieldFromRecord(record.payload, ["toolName"]) ?? "unknown";
				const toolCallId = getNestedStringFieldFromRecord(record.payload, ["toolCallId"]);
				const isEnd = eventType === "tool_execution_end";
				const isUpdate = eventType === "tool_execution_update";
				const isError = getNestedBooleanFieldFromRecord(record.payload, ["isError"]) ?? false;
				const detail = JSON.stringify(
					isEnd
						? {
								details: {
									target: toolName,
									stdout: safeStringify(getNestedFieldFromRecord(record.payload, ["result"])),
									stderr: isError ? "error" : "",
								},
							}
						: isUpdate
							? getNestedFieldFromRecord(record.payload, ["partialResult"])
							: (getNestedFieldFromRecord(record.payload, ["args"]) ?? {}),
				);
				upsertRestoredTimelineItem(timeline, {
					id: toolCallId ?? `${toolName}-${record.sequence}`,
					kind: "tool",
					title: `Tool ${isEnd ? "finished" : isUpdate ? "running" : "started"}: ${toolName}`,
					detail,
					status: isEnd ? (isError ? "failed" : "succeeded") : "running",
					timestamp,
					order: record.sequence,
					toolCallId,
				});
				if (isEnd) {
					const details = parseDesktopToolResult(getNestedFieldFromRecord(record.payload, ["result"]));
					if (details?.requiresConfirmation && details.status === "blocked") {
						const pending: PendingConfirmation = {
							id: details.stepId,
							intent: details.intent,
							action: details.action,
							target: details.target,
							riskLevel: details.riskLevel,
							createdAt: timestamp,
						};
						pendingConfirmations = [
							pending,
							...pendingConfirmations.filter((item) => item.id !== pending.id),
						].slice(0, 20);
						upsertRestoredTimelineItem(timeline, {
							id: pending.id,
							kind: "confirmation",
							title: `等待批准：${pending.intent}`,
							detail: `${pending.action} ${pending.target}`,
							status: "blocked",
							timestamp,
							order: record.sequence,
						});
					}
				}
			}
			continue;
		}

		if (record.kind === "desktop_assistant_event") {
			const eventType = getNestedStringFieldFromRecord(record.payload, ["type"]);
			if (eventType === "timeline") {
				const item = parseTimelineItemFromRecord(getNestedFieldFromRecord(record.payload, ["timelineItem"]));
				if (item?.kind === "compaction") {
					upsertRestoredTimelineItem(timeline, { ...item, order: record.sequence });
				}
				// "thinking" timeline items are also archived here, but we rebuild them from
				// the thinking deltas above (ordered by their first delta's sequence so they
				// land before the step's answer), so restoring them here would duplicate.
			}
			continue;
		}

		if (record.kind === "confirmation_approved" || record.kind === "confirmation_rejected") {
			const confirmation = parseConfirmationFromRecord(record.payload, timestamp);
			if (!confirmation) {
				continue;
			}
			pendingConfirmations = pendingConfirmations.filter((item) => item.id !== confirmation.id);
			upsertRestoredTimelineItem(timeline, {
				id: confirmation.id,
				kind: "confirmation",
				title:
					record.kind === "confirmation_approved"
						? `已批准：${confirmation.intent}`
						: `已拒绝：${confirmation.intent}`,
				detail: `${confirmation.action} ${confirmation.target}`,
				status: record.kind === "confirmation_approved" ? "running" : "blocked",
				timestamp,
				order: record.sequence,
			});
			continue;
		}

		if (record.kind === "approved_action_result" || record.kind === "approved_action_error") {
			const confirmation = parseConfirmationFromRecord(
				getNestedFieldFromRecord(record.payload, ["confirmation"]) ?? record.payload,
				timestamp,
			);
			if (!confirmation) {
				continue;
			}
			const detail =
				record.kind === "approved_action_result"
					? safeStringify(getNestedFieldFromRecord(record.payload, ["commandResult"]))
					: (getNestedStringFieldFromRecord(record.payload, ["detail"]) ?? "");
			upsertRestoredTimelineItem(timeline, {
				id: confirmation.id,
				kind: "confirmation",
				title:
					record.kind === "approved_action_result"
						? `已执行：${confirmation.intent}`
						: `执行失败：${confirmation.intent}`,
				detail,
				status: record.kind === "approved_action_result" ? "succeeded" : "failed",
				timestamp,
				order: record.sequence,
			});
		}
	}

	const nextDisplayOrder =
		Math.max(0, ...messages.map((message) => message.order), ...timeline.map((item) => item.order)) + 1;
	return {
		messages,
		timeline,
		pendingConfirmations,
		nextDisplayOrder,
	};
}

function parseConfirmationFromRecord(payload: unknown, fallbackTimestamp: number): PendingConfirmation | undefined {
	const confirmation = getNestedFieldFromRecord(payload, ["confirmation"]);
	const source = confirmation && typeof confirmation === "object" ? confirmation : payload;
	if (typeof source !== "object" || source === null) {
		return undefined;
	}
	const item = source as Record<string, unknown>;
	const id = typeof item.id === "string" ? item.id : typeof item.stepId === "string" ? item.stepId : undefined;
	const intent = typeof item.intent === "string" ? item.intent : undefined;
	const action = typeof item.action === "string" ? item.action : undefined;
	const target = typeof item.target === "string" ? item.target : undefined;
	const riskLevel = parseAutomationRiskLevel(item.riskLevel);
	const createdAt = typeof item.createdAt === "number" ? item.createdAt : fallbackTimestamp;
	if (!id || !intent || !action || !target || !riskLevel) {
		return undefined;
	}
	return {
		id,
		intent,
		action,
		target,
		riskLevel,
		createdAt,
	};
}

function getNestedFieldFromRecord(value: unknown, path: string[]): unknown {
	let current: unknown = value;
	for (const segment of path) {
		if (typeof current !== "object" || current === null || !(segment in current)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function getNestedStringFieldFromRecord(value: unknown, path: string[]): string | undefined {
	const field = getNestedFieldFromRecord(value, path);
	return typeof field === "string" ? field : undefined;
}

function getNestedBooleanFieldFromRecord(value: unknown, path: string[]): boolean | undefined {
	const field = getNestedFieldFromRecord(value, path);
	return typeof field === "boolean" ? field : undefined;
}

// Reserved helper for upcoming numeric-field extraction; underscore-prefixed to
// satisfy the lint "no unused" rule until it's wired up.
function _getNestedNumberFieldFromRecord(value: unknown, path: string[]): number | undefined {
	const field = getNestedFieldFromRecord(value, path);
	return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function getStringFieldFromRecord(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "string" ? field : undefined;
}

function extractTextFromRecordMessage(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const content = (message as Record<string, unknown>).content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map((item) => {
			if (typeof item !== "object" || item === null) return "";
			const part = item as Record<string, unknown>;
			return part.type === "text" && typeof part.text === "string" ? part.text : "";
		})
		.join("")
		.trim();
	return text || undefined;
}

function extractThinkingFromRecordMessage(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const content = (message as Record<string, unknown>).content;
	if (!Array.isArray(content)) return undefined;
	const thinking = content
		.map((item) => {
			if (typeof item !== "object" || item === null) return "";
			const part = item as Record<string, unknown>;
			if (part.type !== "thinking") return "";
			if (part.redacted === true) return REDACTED_THINKING_PLACEHOLDER;
			return typeof part.thinking === "string" ? part.thinking : "";
		})
		.join("")
		.trim();
	return thinking || undefined;
}

function extractLatestAssistantTextFromRecordMessages(messages: unknown): string | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== "object" || message === null) continue;
		if ((message as Record<string, unknown>).role !== "assistant") continue;
		const text = extractTextFromRecordMessage(message);
		if (text) return text;
	}
	return undefined;
}

function findCurrentTurnAssistantMessageIndex(messages: ChatMessageView[], text: string): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "user") return -1;
		if (message.role === "assistant" && message.text === text) return index;
	}
	return -1;
}

function parseTokenUsageFromRecordMessage(message: unknown): MessageTokenUsageView | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const usage = getNestedFieldFromRecord(message, ["usage"]);
	if (typeof usage !== "object" || usage === null) return undefined;
	const record = usage as Record<string, unknown>;
	const input = finiteNumber(record.input);
	const output = finiteNumber(record.output);
	const cacheRead = finiteNumber(record.cacheRead);
	const cacheWrite = finiteNumber(record.cacheWrite);
	if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) {
		return undefined;
	}
	const total =
		finiteNumber(record.totalTokens) ?? finiteNumber(record.total) ?? input + output + cacheRead + cacheWrite;
	return { input, output, cacheRead, cacheWrite, total };
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseTokenUsageFromRecordMessages(messages: unknown): MessageTokenUsageView | undefined {
	if (!Array.isArray(messages)) return undefined;
	let totalUsage: MessageTokenUsageView | undefined;
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		if ((message as Record<string, unknown>).role !== "assistant") continue;
		const usage = parseTokenUsageFromRecordMessage(message);
		if (!usage) continue;
		totalUsage = addTokenUsage(totalUsage, usage);
	}
	return totalUsage;
}

function latestTokenUsageFromRecordMessages(messages: unknown): MessageTokenUsageView | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== "object" || message === null) continue;
		if ((message as Record<string, unknown>).role !== "assistant") continue;
		const usage = parseTokenUsageFromRecordMessage(message);
		if (usage) return usage;
	}
	return undefined;
}

function parseTimelineItemFromRecord(value: unknown): TimelineItem | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const item = value as Partial<TimelineItem>;
	if (
		typeof item.id !== "string" ||
		typeof item.kind !== "string" ||
		typeof item.title !== "string" ||
		typeof item.status !== "string" ||
		typeof item.timestamp !== "number" ||
		typeof item.order !== "number"
	) {
		return undefined;
	}
	if (!isTimelineKind(item.kind) || !isAutomationStatus(item.status)) return undefined;
	return {
		id: item.id,
		kind: item.kind,
		title: item.title,
		detail: typeof item.detail === "string" ? item.detail : undefined,
		status: item.status,
		timestamp: item.timestamp,
		order: item.order,
		toolCallId: typeof item.toolCallId === "string" ? item.toolCallId : undefined,
	};
}

function isTimelineKind(value: string): value is TimelineItem["kind"] {
	return (
		value === "agent" ||
		value === "assistant" ||
		value === "thinking_summary" ||
		value === "thinking" ||
		value === "tool" ||
		value === "confirmation" ||
		value === "voice" ||
		value === "retry" ||
		value === "error" ||
		value === "compaction"
	);
}

function isAutomationStatus(value: string): value is TimelineItem["status"] {
	return (
		value === "pending" ||
		value === "running" ||
		value === "succeeded" ||
		value === "blocked" ||
		value === "failed" ||
		value === "timeout"
	);
}

function parseAutomationRiskLevel(value: unknown): AutomationRiskLevel | undefined {
	return value === "low" || value === "medium" || value === "high" ? value : undefined;
}
