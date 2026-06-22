import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { completeSimple, type Message } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	AuthStorage,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	type SessionStartEvent,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	clearAppLaunchCache,
	deleteAppLaunchCacheEntry,
	getAppLaunchCachePath,
	readAppLaunchCache,
} from "../desktop/app-launch-memory.ts";
import type { DesktopAutomationHost } from "../desktop/automation-host.ts";
import { SandboxManager } from "../desktop/sandbox/sandbox-manager.ts";
import type { SandboxPathContext } from "../desktop/sandbox/sandbox-workspace.ts";
import { createDesktopToolDefinitions, getActiveDesktopToolNames } from "../desktop/tools.ts";
import { createWebTools, WEB_TOOL_NAMES } from "../desktop/tools-web.ts";
import { McpClientManager } from "../mcp/mcp-client-manager.ts";
import {
	normalizeMcpServerConfig,
	normalizeMcpSettings,
	redactMcpSettings,
	seedDefaultMcpServers,
} from "../mcp/mcp-config.ts";
import {
	listForgeExtensions as readForgeExtensions,
	deleteForgeExtension as removeForgeExtension,
	setForgeExtensionTrust as updateForgeExtensionTrust,
} from "../plugins/forge-registry.ts";
import { redactInstalledPlugin, SoftwarePluginManager } from "../plugins/software-plugin-manager.ts";
import {
	type DeepSeekApiConnection,
	normalizeApiConnectionMode,
	resolveDeepSeekApiConnection,
} from "../shared/deepseek-connection.ts";
import {
	type AiBrowserPreference,
	type ApiKeyValidationStatus,
	type AppLaunchCacheView,
	AUTOMATION_PERMISSION_MODES,
	type AutomationCancelRunRequest,
	type AutomationCreateRequest,
	type AutomationDeleteRequest,
	type AutomationDesignChatRequest,
	type AutomationDesignChatResponse,
	type AutomationDesignStateResponse,
	type AutomationDraft,
	type AutomationDraftApplyRequest,
	type AutomationDraftGetRequest,
	type AutomationDraftSaveRequest,
	type AutomationDraftSaveResponse,
	type AutomationFlow,
	type AutomationGetRequest,
	type AutomationListResponse,
	type AutomationOpenEditorRequest,
	type AutomationPermissionMode,
	type AutomationProgressEvent,
	type AutomationRunRecord,
	type AutomationRunRequest,
	type AutomationRunResponse,
	type AutomationSetEnabledRequest,
	type AutomationSummary,
	type AutomationUpdateRequest,
	type BrowserSettings,
	type BrowserShortcut,
	type BrowserTarget,
	type ClearConversationHistoryResponse,
	type ConversationHistoryEntry,
	DEFAULT_API_KEY_STATUS,
	DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
	DEFAULT_SANDBOX_SETTINGS,
	DEFAULT_VOICE_STT_MODEL_BY_PROVIDER,
	type DeleteConversationResponse,
	type DeleteForgeExtensionRequest,
	type DesktopAssistantEvent,
	type DesktopAssistantSettings,
	type DesktopAssistantSnapshot,
	type DesktopCapabilityId,
	type FlowEdge,
	type FlowNode,
	type ForgeExtensionMutationResponse,
	type GlobalMemoryEntry,
	type GlobalMemoryListResponse,
	type InstallSoftwarePluginRequest,
	type InstallSoftwarePluginResponse,
	type ListForgeExtensionsResponse,
	type ListSessionsResponse,
	type LoadConversationPageRequest,
	type LoadConversationPageResponse,
	type McpEnabledUpdateRequest,
	type McpServerActionRequest,
	type McpServerConfig,
	type McpServerDeleteRequest,
	type McpServerListResponse,
	type McpServerStatus,
	type McpServerUpsertRequest,
	type MemoCompleteRequest,
	type MemoCreateRequest,
	type MemoDeleteRequest,
	type MemoItem,
	type MemoListRequest,
	type MemoListResponse,
	type MemoSetReminderRequest,
	type MemoSnoozeRequest,
	type MemoSummary,
	type MemoUpdateRequest,
	type PendingConfirmation,
	type PendingPromptAttachment,
	type PersonalSkillArchiveRequest,
	type PersonalSkillFileView,
	type PersonalSkillListResponse,
	type PersonalSkillReadRequest,
	type PersonalSkillSaveRequest,
	type PersonalSkillSearchRequest,
	type SandboxCleanRequest,
	type SandboxCleanResponse,
	type SandboxSettings,
	type SandboxStatus,
	type SandboxToolGate,
	type SessionNotificationKind,
	type SessionSummary,
	type SetForgeExtensionTrustRequest,
	type SkillFileView,
	type SoftwarePluginListResponse,
	type SoftwarePluginOperationProgress,
	type SoftwarePluginTargetValidation,
	type TestSoftwarePluginBridgeRequest,
	type TestSoftwarePluginBridgeResponse,
	type UninstallSoftwarePluginRequest,
	type UninstallSoftwarePluginResponse,
	type ValidateSoftwarePluginTargetRequest,
	type VoiceOverlayState,
} from "../shared/types.ts";
import { VOICE_STT_AUTH_PROVIDER } from "../voice/stt-client.ts";
import { AutomationDraftSession } from "./automation-draft-session.ts";
import { AutomationRepositoryService } from "./automation-repository.ts";
import {
	AUTOMATION_RUN_TOOL_NAMES,
	type AutomationRunToolHost,
	createAutomationRunToolDefinitions,
} from "./automation-run-tools.ts";
import { AutomationRunner } from "./automation-runner.ts";
import { AutomationScheduler, computeNextRun } from "./automation-scheduler.ts";
import { BrowserSnapshotStore } from "./browser-snapshot-store.ts";
import { BROWSER_SNAPSHOT_READ_TOOL_NAMES, createBrowserSnapshotReadTools } from "./browser-snapshot-tool.ts";
import {
	BROWSER_TOOL_NAMES,
	type BrowserToolHost,
	buildBrowserRoutingAppendPrompt,
	createBrowserToolDefinitions,
} from "./browser-tools.ts";
import {
	type AiReadableConversationArchive,
	ConversationArchiveCoordinator,
	type ConversationArchiveSummary,
	type ConversationArchiveWriter,
} from "./conversation-archive.ts";
import {
	ConversationContext,
	type ConversationContextDeps,
	type ConversationRuntimeProfile,
	HISTORY_PAGE_LIMIT,
	normalizeHistoryLimit,
	normalizeMemoryLimit,
	readAiReadableConversationArchive,
	readHistoryDisplaySource,
	sliceHistoryDisplayItems,
} from "./conversation-context.ts";
import { generateConversationTitle } from "./conversation-title.ts";
import {
	configureDeepSeekDefaults,
	DEEPSEEK_FLASH_MODEL,
	DEEPSEEK_OFFICIAL_AUTH_PROVIDER,
	DEEPSEEK_PROVIDER,
	DEEPSEEK_RUNTIME_PROVIDER,
	getConfiguredDeepSeekModel,
	getDeepSeekAuthProvider,
	getDeepSeekAuthStatus,
	getDeepSeekRuntimeModelId,
	selectPreferredRelayModel,
	syncDeepSeekRuntimeAuth,
	validateDeepSeekApiKey,
} from "./deepseek.ts";
import { createFlowDesignToolDefinitions, FLOW_DESIGN_TOOL_NAMES } from "./flow-design-tools.ts";
import { MemoReminderScheduler } from "./memo-reminder-scheduler.ts";
import { MemoRepositoryService } from "./memo-repository.ts";
import { createMemoToolDefinitions, MEMO_TOOL_NAMES, type MemoToolHost } from "./memo-tools.ts";
import { MemoryStore } from "./memory-store.ts";
import { PersonalSkillRepositoryService, selectExplicitPersonalSkillId } from "./personal-skill-repository.ts";
import { createPersonalSkillToolDefinitions, PERSONAL_SKILL_TOOL_NAMES } from "./personal-skill-tools.ts";

// Per-conversation prompt/history helpers now live in conversation-context.ts.
// Re-exported here so existing importers (tests, tooling) keep working.
export {
	buildMemoryAugmentedPrompt,
	buildPromptWithAttachments,
	buildSkillRoutedPrompt,
	buildVoiceInputPrompt,
	resolveVoiceInputSkillFile,
} from "./conversation-context.ts";

export interface DesktopAgentServiceOptions {
	cwd: string;
	agentDir: string;
	/** Override the save directory for conversation archives. Defaults to {cwd}/save. */
	saveDir?: string;
	host: DesktopAutomationHost;
	settings?: Partial<DesktopAssistantSettings>;
	validateApiKey?: (
		apiKey: string,
		connection: DeepSeekApiConnection,
		signal?: AbortSignal,
	) => Promise<DesktopAssistantSettings["deepseekRelayModels"] | undefined>;
	openMcpManagerWindow?: () => Promise<void>;
	openPersonalSkillManagerWindow?: () => Promise<void>;
	classifySkill?: (
		message: string,
		enabledCapabilities: DesktopCapabilityId[],
	) => Promise<DesktopCapabilityId | undefined>;
	/** Default sandbox workspace root (main passes userData/sandbox). Defaults to agentDir/sandbox. */
	sandboxRoot?: string;
	/** Real OS path overrides used to resolve sandbox path tokens (main passes Documents/Desktop/…). */
	sandboxPaths?: Partial<SandboxPathContext>;
	/** Directory for the memo/to-do JSON store (main passes userData/memos). Defaults to agentDir/memos. */
	memoDir?: string;
	/** Directory for the automation JSON store (main passes userData/automations). Defaults to agentDir/automations. */
	automationDir?: string;
	openFlowEditorWindow?: (flowId?: string) => Promise<void>;
	browserHost?: BrowserToolHost;
}

type Listener = (event: DesktopAssistantEvent) => void;

const DESKTOP_CAPABILITY_IDS = ["system", "document", "ppt", "excel"] as const satisfies readonly DesktopCapabilityId[];
const DESKTOP_SKILL_DIRECTORY_BY_CAPABILITY = {
	system: "system-operation",
	document: "document-operation",
	ppt: "ppt-operation",
	excel: "excel-operation",
} as const satisfies Record<DesktopCapabilityId, string>;

/**
 * File-based Office MCP servers expose many tools (Excel ~10, PowerPoint ~34). Gate them behind
 * their matching desktop capability so they are not injected into every conversation when the user
 * has that capability disabled. Matched by the wrapped tool-name prefix (`mcp_<toolNamePrefix>_`).
 * Other MCP servers (music, browser, …) keep the default always-on behaviour.
 */
const OFFICE_MCP_TOOL_GATES: ReadonlyArray<{ prefix: string; capability: DesktopCapabilityId }> = [
	{ prefix: "mcp_xlsx_", capability: "excel" },
	{ prefix: "mcp_pptx_", capability: "ppt" },
];

export class DesktopAgentService {
	private settings: DesktopAssistantSettings;
	private authStorage: AuthStorage;
	private modelRegistry: ModelRegistry;
	private settingsManager: SettingsManager;
	private listeners = new Set<Listener>();
	private apiKeyStatus: ApiKeyValidationStatus = DEFAULT_API_KEY_STATUS;
	private voiceOverlay: VoiceOverlayState = { visible: false, state: "idle", transcript: "" };
	private options: DesktopAgentServiceOptions;
	private appLaunchCachePath: string;
	private mcpSettingsPath: string;
	private sandboxSettingsPath: string;
	private sandboxManager: SandboxManager;
	private coordinator: ConversationArchiveCoordinator;
	private memoryStore: MemoryStore;
	private memoRepository: MemoRepositoryService;
	private memoReminderScheduler: MemoReminderScheduler;
	private automationRepository: AutomationRepositoryService;
	private automationScheduler: AutomationScheduler;
	private automationDraftSession: AutomationDraftSession;
	private automationRunner: AutomationRunner;
	private automationDesignContext: ConversationContext | undefined;
	private personalSkillRepository: PersonalSkillRepositoryService;
	private mcpManager: McpClientManager;
	private softwarePluginManager: SoftwarePluginManager;
	private latestSoftwarePluginProgress: SoftwarePluginOperationProgress | undefined;
	private browserSnapshotStore = new BrowserSnapshotStore();
	private browserHost: BrowserToolHost | undefined;
	/**
	 * All live conversations, keyed by a stable internal id (NOT the sessionId,
	 * which can change on a mid-session fork). Each context owns its own session,
	 * archive writer, messages, timeline and confirmations — they run agent loops
	 * in parallel without sharing mutable state.
	 */
	private sessions = new Map<string, ConversationContext>();
	/** Internal key of the conversation whose detail the UI is currently showing. */
	private focusedKey = "";
	/** Guards the one-time empty-conversation prune on first initialize(). */
	private startupPruneDone = false;
	/** Max conversations kept live in memory before idle ones are evicted to disk. */
	private static readonly MAX_LIVE_SESSIONS = 6;

	/** The focused conversation. Most service methods operate on this by default. */
	private get context(): ConversationContext {
		const ctx = this.sessions.get(this.focusedKey);
		if (ctx) {
			return ctx;
		}
		const fallbackKey = this.mostRecentKey();
		if (fallbackKey) {
			this.setFocusedKey(fallbackKey);
			return this.sessions.get(fallbackKey)!;
		}
		// Focus handover can briefly orphan the registry during concurrent IPC calls.
		// Recreate a placeholder context so follow-up operations can recover instead of crashing.
		const placeholder = new ConversationContext(
			this.buildContextDeps(),
			SessionManager.create(this.options.cwd, this.coordinator.paths.sessionsDir),
		);
		this.registerContext(placeholder, { focus: true });
		return placeholder;
	}

	constructor(options: DesktopAgentServiceOptions) {
		this.options = options;
		this.browserHost = options.browserHost;
		this.mcpSettingsPath = join(options.agentDir, "mcp-settings.json");
		this.sandboxSettingsPath = join(options.agentDir, "sandbox.json");
		const initialSettings = normalizeSettings(options.settings);
		this.settings = normalizeSettings({
			...initialSettings,
			mcp: seedDefaultMcpServers(readPersistedMcpSettings(this.mcpSettingsPath) ?? initialSettings.mcp),
			// Sandbox policy must be trustworthy from startup, so it is persisted in the
			// main process (like MCP) and loaded here rather than pushed from the renderer.
			sandbox: readPersistedSandbox(this.sandboxSettingsPath) ?? initialSettings.sandbox,
		});
		this.authStorage = AuthStorage.create(join(options.agentDir, "auth.json"));
		this.modelRegistry = ModelRegistry.create(this.authStorage, join(options.agentDir, "models.json"));
		try {
			getConfiguredDeepSeekModel(this.modelRegistry, this.settings);
		} catch (error) {
			console.warn("Failed to configure DeepSeek connection:", error);
		}
		this.settingsManager = SettingsManager.inMemory({
			compaction: { enabled: true },
			retry: { enabled: true, maxRetries: 2 },
			defaultProvider: DEEPSEEK_RUNTIME_PROVIDER,
			defaultModel: this.settings.modelId,
			defaultThinkingLevel: this.settings.thinkingLevel,
			hideThinkingBlock: true,
		});
		this.coordinator = new ConversationArchiveCoordinator(options.cwd, options.saveDir);
		this.appLaunchCachePath = getAppLaunchCachePath(options.agentDir);
		this.sandboxManager = new SandboxManager({
			defaultRoot: options.sandboxRoot ?? join(options.agentDir, "sandbox"),
			pathOverrides: options.sandboxPaths,
			getSettings: () => this.settings.sandbox,
			runProbe: (script, opts) => this.options.host.runPowerShell(script, opts),
			onStatus: (status) => this.emit({ type: "sandbox_status", sandboxStatus: status }),
		});
		this.memoryStore = new MemoryStore(options.cwd, options.saveDir);
		this.memoRepository = new MemoRepositoryService(options.memoDir ?? join(options.agentDir, "memos"));
		this.memoReminderScheduler = new MemoReminderScheduler((memoId, missed) => this.onMemoReminder(memoId, missed));
		this.automationRepository = new AutomationRepositoryService(
			options.automationDir ?? join(options.agentDir, "automations"),
		);
		this.automationScheduler = new AutomationScheduler((flowId, missed) => this.onAutomationFire(flowId, missed));
		this.automationDraftSession = new AutomationDraftSession((draft) =>
			this.emit({ type: "automation_draft_changed", automationDraft: draft }),
		);
		this.automationRunner = new AutomationRunner({
			recordRunStart: (flowId, trigger, sessionId) =>
				this.automationRepository.recordRunStart(flowId, trigger, sessionId),
			recordRunFinish: (flowId, runId, status, update) =>
				this.automationRepository.recordRunFinish(flowId, runId, status, update),
			emitChanged: (flowId) => this.emitAutomationChanged(flowId),
			emitProgress: (flowId, runId, message) =>
				this.emitAutomationProgress({ flowId, runId, kind: "log", message, timestamp: new Date().toISOString() }),
			createBackgroundConversation: (flow, run) => this.createAutomationConversation(flow, run),
		});
		this.personalSkillRepository = new PersonalSkillRepositoryService(options.cwd);
		this.softwarePluginManager = new SoftwarePluginManager({
			agentDir: options.agentDir,
			progressReporter: (progress) => this.reportSoftwarePluginProgress(progress),
		});
		this.mcpManager = new McpClientManager({
			initialSettings: this.settings.mcp,
			getSettings: () => this.settings,
			updateSettings: (update) => this.updateSettings(update),
			requestRoute: async (route) => {
				if (route === "mcp" && this.options.openMcpManagerWindow) {
					await this.options.openMcpManagerWindow();
					return;
				}
				this.emit({ type: "route", route });
			},
			onStatusChanged: () => this.emit({ type: "mcp_status", mcp: this.mcpManager.list() }),
			personalSkills: this.personalSkillRepository,
			requestPersonalSkillManager: async () => {
				await this.options.openPersonalSkillManagerWindow?.();
			},
		});
		const initial = new ConversationContext(
			this.buildContextDeps(),
			SessionManager.create(options.cwd, this.coordinator.paths.sessionsDir),
		);
		this.registerContext(initial, { focus: true });
	}

	setBrowserHost(browserHost: BrowserToolHost): void {
		this.browserHost = browserHost;
		this.refreshAllTools();
	}

	/**
	 * Open a URL (or the default browser itself, when url is omitted) through the configured default
	 * browser. Used to redirect open_app browser/URL launches away from the native OS browser.
	 */
	private async openViaDefaultBrowser(url?: string): Promise<{ stdout: string; stderr: string }> {
		const host = this.browserHost;
		if (!host) throw new Error("Browser control is not available.");
		const target = this.settings.browser.defaultBrowser;
		const openUrl = url ?? this.settings.browser.homeUrl;
		await host.openUrl(target, openUrl);
		const label = target === "built_in" ? "内置浏览器" : target === "chrome" ? "Chrome" : "Edge";
		return { stdout: `已用默认浏览器（${label}）打开 ${openUrl}`, stderr: "" };
	}

	// ── Session registry / focus ────────────────────────────────────────────────

	/** Add a context to the live registry, optionally focusing it. */
	private registerContext(context: ConversationContext, options?: { focus?: boolean }): string {
		const key = randomUUID();
		this.sessions.set(key, context);
		if (options?.focus) this.setFocusedKey(key);
		return key;
	}

	/** Make `key` the focused context and update isFocused/unread flags across all. */
	private setFocusedKey(key: string): void {
		this.focusedKey = key;
		for (const [entryKey, context] of this.sessions) {
			const focused = entryKey === key;
			context.isFocused = focused;
			if (focused) context.unreadCompletion = false;
		}
	}

	/** Locate a live context (and its key) by its current sessionId. */
	private findContextEntry(sessionId: string): { key: string; context: ConversationContext } | undefined {
		for (const [key, context] of this.sessions) {
			if (context.sessionId === sessionId) return { key, context };
		}
		return undefined;
	}

	/** Key of the most-recently-active live context, used when focus is orphaned. */
	private mostRecentKey(): string | undefined {
		let bestKey: string | undefined;
		let bestAt = Number.NEGATIVE_INFINITY;
		for (const [key, context] of this.sessions) {
			// Never let an automation run/design background context become the default
			// focused conversation for normal chat.
			if (!this.isStandardContext(context)) continue;
			if (context.lastActivityAt >= bestAt) {
				bestAt = context.lastActivityAt;
				bestKey = key;
			}
		}
		return bestKey;
	}

	/** Resolve a target context by sessionId, defaulting to the focused one. */
	private contextFor(sessionId?: string): ConversationContext {
		if (!sessionId) return this.context;
		return this.findContextEntry(sessionId)?.context ?? this.context;
	}

	/**
	 * Create a brand-new conversation, register + focus it, and initialize its
	 * runtime. Shared by newConversation()/deleteConversation()/clear so the
	 * "fresh focused session" bootstrap is identical everywhere.
	 */
	private async createAndFocusNewConversation(previousSessionFile?: string): Promise<ConversationContext> {
		const next = new ConversationContext(
			this.buildContextDeps(),
			SessionManager.create(this.options.cwd, this.coordinator.paths.sessionsDir),
		);
		this.registerContext(next, { focus: true });
		await next.initializeRuntime({
			sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
		});
		next.archive.write("new_conversation_created", {
			previousSessionFile,
			sessionId: next.sessionId,
			sessionFile: next.session?.sessionFile,
			conversationThinking: next.conversationThinking,
		});
		await next.archive.flushSnapshots();
		await this.evictIdleSessionsIfNeeded();
		return next;
	}

	/**
	 * Cap how many conversations stay live in memory. Keeping every "new chat"
	 * alive forever would leak runtimes/timers over a long app session, so when we
	 * exceed the cap we evict the least-recently-active IDLE background contexts
	 * (not focused, not running, not awaiting approval). Their archives are flushed
	 * to disk first, so they reappear in history and resume on demand — eviction is
	 * invisible to the user.
	 */
	private async evictIdleSessionsIfNeeded(): Promise<void> {
		if (this.sessions.size <= DesktopAgentService.MAX_LIVE_SESSIONS) return;
		const evictable = [...this.sessions.entries()]
			.filter(
				([key, context]) =>
					key !== this.focusedKey &&
					// Automation run/design contexts manage their own lifecycle (the design
					// session is a reused singleton; run sessions self-dispose when finished),
					// so the capacity cap only evicts ordinary chat conversations.
					this.isStandardContext(context) &&
					!context.isBusy &&
					context.pendingConfirmations.length === 0,
			)
			.sort((left, right) => left[1].lastActivityAt - right[1].lastActivityAt);
		let overflow = this.sessions.size - DesktopAgentService.MAX_LIVE_SESSIONS;
		for (const [key, context] of evictable) {
			if (overflow <= 0) break;
			this.sessions.delete(key);
			await context.dispose({ archiveMode: "flush" });
			overflow -= 1;
		}
	}

	/** Build the live session roster for the snapshot. */
	private buildSessionSummaries(): SessionSummary[] {
		const summaries: SessionSummary[] = [];
		for (const context of this.sessions.values()) {
			// Hide the AI flow-design session — it's editor plumbing, not a chat. Automation
			// RUN sessions stay visible so the user can open one and watch its timeline.
			if (context.profileKind === "automation_design") continue;
			summaries.push({
				sessionId: context.sessionId,
				title: this.deriveSessionTitle(context),
				status: context.status(),
				isRunning: context.isBusy,
				lastActivityAt: context.lastActivityAt,
				pendingConfirmationCount: context.pendingConfirmations.length,
				unreadCompletion: context.unreadCompletion,
				contextUsage: context.contextUsage(),
			});
		}
		return summaries.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
	}

	private isStandardContext(context: ConversationContext): boolean {
		return context.profileKind === undefined;
	}

	private deriveSessionTitle(context: ConversationContext): string {
		const storedTitle =
			context.archive.getTitle() ?? this.coordinator.getConversationMetadata(context.sessionId)?.title;
		if (storedTitle?.trim()) return storedTitle.trim();
		for (let index = context.messages.length - 1; index >= 0; index -= 1) {
			const message = context.messages[index];
			if (message.role === "user" && message.text.trim()) {
				return message.text.trim().slice(0, 28);
			}
		}
		const metadata = this.coordinator.getConversationMetadata(context.sessionId);
		return metadata?.lastUserMessage?.trim().slice(0, 28) || "新对话";
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		listener({ type: "snapshot", snapshot: this.snapshot() });
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Test seam: the session manager backing the active conversation context. */
	get sessionManager(): SessionManager {
		return this.context.sessionManager;
	}

	/** Test seam: bind a (possibly fake) session to the active conversation context. */
	bindSession(session: AgentSession): void {
		this.context.bindSession(session);
	}

	/** Test seam: feed a session event into the active conversation context. */
	handleSessionEvent(event: AgentSessionEvent): void {
		this.context.handleSessionEvent(event);
	}

	/** Test seam: the active conversation's agent session. */
	get session(): AgentSession | undefined {
		return this.context.session;
	}

	set session(session: AgentSession | undefined) {
		this.context.session = session;
	}

	/** Test seam: the active conversation's pending confirmations. */
	get pendingConfirmations(): PendingConfirmation[] {
		return this.context.pendingConfirmations;
	}

	set pendingConfirmations(value: PendingConfirmation[]) {
		this.context.pendingConfirmations = value;
	}

	private buildContextDeps(): ConversationContextDeps {
		return {
			cwd: this.options.cwd,
			host: this.options.host,
			coordinator: this.coordinator,
			memoryStore: this.memoryStore,
			browserSnapshotStore: this.browserSnapshotStore,
			getSettings: () => this.settings,
			emit: (event, archive) => this.emit(event, archive),
			snapshot: () => this.snapshot(),
			emitSessionStatus: (archive) =>
				this.emit(
					{
						type: "session_status",
						sessions: this.buildSessionSummaries(),
						focusedSessionId: this.focusedSessionId(),
					},
					archive,
				),
			emitSessionNotification: (sessionId, kind) => this.emitSessionNotification(sessionId, kind),
			updateVoiceOverlay: (update) => this.updateVoiceOverlay(update),
			selectSkillForPrompt: (message) => this.selectSkillForPrompt(message),
			selectPersonalSkillForPrompt: (message) => this.selectPersonalSkillForPrompt(message),
			generateConversationTitle: (input) => this.generateConversationTitle(input),
			createRuntime: (sessionManager, options) => this.createSessionRuntime(sessionManager, options),
		};
	}

	/** AI browser control is on and the built-in browser host is wired. */
	private aiBrowserControlActive(): boolean {
		return this.settings.browser.allowAiControl && this.browserHost !== undefined;
	}

	/** Built-in browser_* tools are exposed (preference built_in or auto). */
	private builtInBrowserToolsActive(): boolean {
		return this.aiBrowserControlActive() && this.settings.browser.aiBrowserPreference !== "external";
	}

	/** The external browser-control MCP is suppressed (preference built_in only). */
	private externalBrowserMcpSuppressed(): boolean {
		return this.aiBrowserControlActive() && this.settings.browser.aiBrowserPreference === "built_in";
	}

	/** True unless this MCP tool is gated off (disabled Office capability, or a superseded browser MCP). */
	private isMcpToolEnabled(name: string): boolean {
		// With the "built_in" browser preference, suppress any external browser-control MCP (mcp_browser_*):
		// its extension is NOT connected to the assistant's built-in browser, so the model would otherwise
		// pick it (take_control/list_tabs/controlled_status) and fail. "external"/"auto" keep it available.
		if (this.externalBrowserMcpSuppressed() && isExternalBrowserControlToolName(name)) {
			return false;
		}
		for (const gate of OFFICE_MCP_TOOL_GATES) {
			if (name.startsWith(gate.prefix) && !this.settings.capabilities[gate.capability].enabled) {
				return false;
			}
		}
		return true;
	}

	/** Active MCP tool names, with Office MCP tools gated by their capability (see OFFICE_MCP_TOOL_GATES). */
	private activeMcpToolNames(): string[] {
		if (!this.settings.mcp.enabled) return [];
		return this.mcpManager.getActiveToolNames().filter((name) => this.isMcpToolEnabled(name));
	}

	private createCustomTools(options: { permissionMode?: AutomationPermissionMode } = {}) {
		const mcpTools = this.settings.mcp.enabled
			? this.mcpManager.getTools().filter((tool) => this.isMcpToolEnabled(tool.name))
			: [];
		const tokenSavingTools = this.settings.tokenSaving.enabled
			? createBrowserSnapshotReadTools(this.browserSnapshotStore)
			: [];
		const canRouteBrowser = this.builtInBrowserToolsActive();
		const desktopTools = createDesktopToolDefinitions({
			host: this.options.host,
			// Automation runs override the permission mode per their run policy; chat uses global settings.
			permissionMode: () => options.permissionMode ?? this.settings.permissionMode,
			systemCapability: () => this.settings.capabilities.system,
			appLaunchCachePath: this.appLaunchCachePath,
			activeMcpToolNames: () => this.activeMcpToolNames(),
			sandbox: () => this.settings.sandbox,
			sandboxManager: this.sandboxManager,
			// Route open_app browser/URL launches through the configured default browser so the model
			// can't sidestep it by opening the native OS browser.
			openInDefaultBrowser: canRouteBrowser ? (url) => this.openViaDefaultBrowser(url) : undefined,
		});
		const personalSkillTools = createPersonalSkillToolDefinitions({
			repository: this.personalSkillRepository,
			getSourceSessionId: () => this.context.session?.sessionId,
		});
		const memoTools = createMemoToolDefinitions(this.memoHost());
		const ws = this.settings.webSearch;
		const webTools = createWebTools({
			mode: ws?.mode ?? "auto",
			provider: ws?.provider ?? "duckduckgo",
			apiKey: ws?.apiKey,
			googleCx: ws?.googleCx,
			searxngUrl: ws?.searxngUrl,
			network: this.settings.sandbox.enabled ? this.settings.sandbox.network : undefined,
		});
		const browserTools =
			this.builtInBrowserToolsActive() && this.browserHost ? createBrowserToolDefinitions(this.browserHost) : [];
		return [
			...mcpTools,
			...tokenSavingTools,
			...browserTools,
			...desktopTools,
			...personalSkillTools,
			...webTools,
			...memoTools,
		];
	}

	private createActiveToolNames(): string[] {
		return [
			...this.activeMcpToolNames(),
			...(this.settings.tokenSaving.enabled ? [...BROWSER_SNAPSHOT_READ_TOOL_NAMES] : []),
			...(this.builtInBrowserToolsActive() ? [...BROWSER_TOOL_NAMES] : []),
			...getActiveDesktopToolNames(this.settings.capabilities),
			...PERSONAL_SKILL_TOOL_NAMES,
			...MEMO_TOOL_NAMES,
			...(this.settings.webSearch?.mode !== "off" ? WEB_TOOL_NAMES : []),
		];
	}

	/**
	 * Rebuild all custom tools and refresh the active tool list.
	 * Called whenever capabilities or web search settings change.
	 */
	private refreshAllTools(): void {
		const activeNames = this.createActiveToolNames();
		// Settings are global — propagate the refreshed tool set to every live session.
		const customTools = this.createCustomTools();
		for (const context of this.sessions.values()) {
			if (!this.isStandardContext(context)) continue;
			context.refreshTools(customTools, activeNames);
		}
	}

	private async createSessionRuntime(
		sessionManager: SessionManager,
		runtimeOptions: {
			thinkingLevel: DesktopAssistantSettings["thinkingLevel"];
			sessionStartEvent?: SessionStartEvent;
			profile?: ConversationRuntimeProfile;
		},
	): Promise<AgentSessionRuntime> {
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			agentDir,
			sessionManager,
			sessionStartEvent,
		}) => {
			const profile = runtimeOptions.profile;
			const model = await configureDeepSeekDefaults(this.modelRegistry, this.authStorage, this.settings);
			const skillFiles = resolveDesktopSkillFiles(cwd);
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				authStorage: this.authStorage,
				modelRegistry: this.modelRegistry,
				settingsManager: this.settingsManager,
				resourceLoaderOptions: {
					additionalSkillPaths: DESKTOP_CAPABILITY_IDS.map((id) => dirname(skillFiles[id])),
					appendSystemPrompt: [
						...(this.settings.mcp.enabled ? [buildMcpAppendPrompt(this.activeMcpToolNames())] : []),
						...(this.settings.tokenSaving.enabled ? [buildTokenSavingAppendPrompt()] : []),
						...(this.settings.browser.allowAiControl
							? [
									buildBrowserRoutingAppendPrompt(
										this.settings.browser.defaultBrowser,
										this.settings.browser.aiBrowserPreference,
									),
								]
							: []),
						buildSystemOperationAppendPrompt(skillFiles.system, this.settings.sandbox.enabled),
						...(profile?.appendSystemPrompt ?? []),
					],
				},
			});
			const activeToolNames = profile?.activeToolNames ?? this.createActiveToolNames();
			const customTools = profile?.customTools ?? this.createCustomTools();
			const result = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model,
				thinkingLevel: runtimeOptions.thinkingLevel,
				tools: activeToolNames,
				noTools: "builtin",
				customTools,
			});
			return {
				...result,
				services,
				diagnostics: [...services.diagnostics],
			};
		};
		return createAgentSessionRuntime(createRuntime, {
			cwd: this.options.cwd,
			agentDir: this.options.agentDir,
			sessionManager,
			sessionStartEvent: runtimeOptions.sessionStartEvent,
		});
	}

	async initialize(): Promise<void> {
		// Arm reminders for any memo whose time is still pending; missed ones fire now.
		this.memoReminderScheduler.rescheduleAll(this.memoRepository.all());
		this.rescheduleAutomations();
		// Kick off sandbox initialization asynchronously — it must not block chat.
		// Skipped under the test runner to keep the suite hermetic (the init probe
		// spawns PowerShell); SandboxManager tests drive init() directly instead.
		if (!process.env.VITEST && this.settings.sandbox.enabled && this.settings.sandbox.workspace.autoInitOnStartup) {
			void this.sandboxManager.init();
		}
		if (this.context.hasRuntime) {
			this.emit({ type: "snapshot", snapshot: this.snapshot() });
			return;
		}
		await this.mcpManager.applySettings(this.settings.mcp);
		await this.context.initializeRuntime();
		// One-time GC of empty conversation husks left on disk by earlier runs.
		if (!this.startupPruneDone) {
			this.startupPruneDone = true;
			await this.pruneAbandonedEmptyConversations();
		}
		this.emit({ type: "snapshot", snapshot: this.snapshot() });
	}

	/**
	 * Delete archived conversations that never received a user/assistant message and
	 * are not currently live. Empty husks (e.g. from rapid new-conversation churn on
	 * the home page) otherwise pile up on disk and slow every history listing.
	 */
	private async pruneAbandonedEmptyConversations(): Promise<void> {
		try {
			const summaries = await this.coordinator.listConversationSummaries();
			for (const summary of summaries) {
				if (this.findContextEntry(summary.sessionId)) continue; // live — keep
				if (this.buildHistoryEntry(summary)) continue; // has real content — keep
				const metadata = this.coordinator.getConversationMetadata(summary.sessionId);
				this.coordinator.deleteConversationArchive(summary.sessionId);
				this.coordinator.deleteSessionFile(metadata?.sessionFile);
			}
		} catch (error) {
			console.warn("Failed to prune empty conversations:", error);
		}
	}

	async prompt(
		message: string,
		source: "text" | "voice" = "text",
		attachments: PendingPromptAttachment[] = [],
		sessionId?: string,
	): Promise<void> {
		const target = this.contextFor(sessionId);
		if (!target.session) {
			await this.initialize();
		}
		await target.prompt(message, source, attachments);
	}

	/**
	 * Flush all pending archive writes to disk and wait for completion.
	 * Useful in tests to ensure the archive reflects the latest state before
	 * reading files directly.
	 */
	async drainArchive(): Promise<void> {
		await this.context.archive.flushSnapshots();
	}

	async newConversation(): Promise<DesktopAssistantSnapshot> {
		if (!this.context.hasRuntime) {
			await this.initialize();
		}
		// The previously focused conversation is intentionally NOT disposed — it
		// stays live in the roster so multiple conversations run in parallel.
		const previousSessionFile = this.context.session?.sessionFile;
		await this.createAndFocusNewConversation(previousSessionFile);
		this.emit({ type: "snapshot", snapshot: this.snapshot() });
		return this.snapshot();
	}

	/** The live session roster (focused + background), for the session list. */
	listSessions(): ListSessionsResponse {
		return { sessions: this.buildSessionSummaries(), focusedSessionId: this.focusedSessionId() };
	}

	/**
	 * Focus a conversation that is already live in memory, without any teardown
	 * or archive rebuild. This is the fast path the session list uses to switch
	 * between running/background conversations. Falls back to resumeConversation
	 * (rebuild from disk) when the session is not currently live.
	 */
	async focusSession(sessionId: string): Promise<DesktopAssistantSnapshot> {
		const entry = this.findContextEntry(sessionId);
		if (!entry) {
			return this.resumeConversation(sessionId);
		}
		this.setFocusedKey(entry.key);
		this.emit({ type: "snapshot", snapshot: this.snapshot() });
		return this.snapshot();
	}

	/**
	 * Close a single live conversation (dispose its runtime and drop it from the
	 * roster) without deleting its archive. If the focused one is closed, focus
	 * falls back to the most recent remaining conversation, or a fresh one.
	 */
	async closeSession(sessionId: string): Promise<DesktopAssistantSnapshot> {
		const entry = this.findContextEntry(sessionId);
		if (!entry) {
			return this.snapshot();
		}
		const wasFocused = entry.key === this.focusedKey;
		this.sessions.delete(entry.key);
		await entry.context.dispose({ archiveMode: "flush" });
		if (wasFocused) {
			await this.refocusAfterRemoval();
		}
		this.emit({ type: "snapshot", snapshot: this.snapshot() });
		return this.snapshot();
	}

	/** Restore a valid focus after the focused context was removed. */
	private async refocusAfterRemoval(): Promise<void> {
		const nextKey = this.mostRecentKey();
		if (nextKey) {
			this.setFocusedKey(nextKey);
		} else {
			this.focusedKey = "";
			await this.createAndFocusNewConversation();
		}
	}

	async resumeConversation(sessionId: string): Promise<DesktopAssistantSnapshot> {
		if (!this.context.hasRuntime) {
			await this.initialize();
		}
		const metadata = this.coordinator.getConversationMetadata(sessionId);
		const sessionFile = [metadata?.sessionFile, metadata?.sessionMirrorFile].find((candidate): candidate is string =>
			Boolean(candidate && existsSync(candidate)),
		);
		if (!sessionFile) {
			throw new Error(`Conversation session file not found for sessionId: ${sessionId}`);
		}
		const previousSessionFile = this.context.session?.sessionFile;
		// Drop any live instance of this session so we rebuild cleanly from disk.
		// (Switching among already-live sessions should use focusSession instead.)
		const existing = this.findContextEntry(sessionId);
		if (existing) {
			this.sessions.delete(existing.key);
			if (existing.key === this.focusedKey) this.focusedKey = "";
			await existing.context.dispose({ archiveMode: "detach" });
		}
		const next = await ConversationContext.resume(
			this.buildContextDeps(),
			sessionId,
			sessionFile,
			(file) => SessionManager.open(file),
			{
				sessionStartEvent: {
					type: "session_start",
					reason: "resume",
					previousSessionFile,
				},
			},
		);
		this.registerContext(next, { focus: true });
		await this.evictIdleSessionsIfNeeded();
		this.emit({ type: "snapshot", snapshot: this.snapshot() });
		return this.snapshot();
	}

	async listConversationHistory(): Promise<{ conversations: ConversationHistoryEntry[] }> {
		await this.context.archive.flushSnapshots();
		const summaries = await this.coordinator.listConversationSummaries();
		const entries: ConversationHistoryEntry[] = [];
		for (const summary of summaries) {
			const entry = this.buildHistoryEntry(summary);
			if (entry) entries.push(entry);
		}
		return { conversations: entries };
	}

	listGlobalMemories(): GlobalMemoryListResponse {
		return { memories: this.memoryStore.list() };
	}

	deleteGlobalMemory(id: string): GlobalMemoryListResponse {
		this.memoryStore.delete(id);
		return this.listGlobalMemories();
	}

	clearGlobalMemories(): { deletedCount: number } {
		const deletedCount = this.memoryStore.clear();
		this.context.lastInjectedMemoryCount = 0;
		this.emit({ type: "snapshot", snapshot: this.snapshot() });
		return { deletedCount };
	}

	updateGlobalMemory(
		id: string,
		update: Partial<Pick<GlobalMemoryEntry, "kind" | "text" | "confidence" | "tags" | "archived">>,
	): GlobalMemoryEntry | undefined {
		const updated = this.memoryStore.update(id, update);
		this.emit({ type: "snapshot", snapshot: this.snapshot() });
		return updated;
	}

	// ── 备忘录 / 待办 ──────────────────────────────────────────────────────────
	// All writes go through these methods (IPC handlers and AI tools share them)
	// so the reminder scheduler and the renderer "memo_changed" feed stay in sync.

	/** The subset of this service the memo AI tools drive. */
	private memoHost(): MemoToolHost {
		return {
			createMemo: (request) => this.createMemo(request),
			updateMemo: (request) => this.updateMemo(request),
			completeMemo: (request) => this.completeMemo(request),
			deleteMemo: (request) => this.deleteMemo(request),
			setMemoReminder: (request) => this.setMemoReminder(request),
			listMemos: (request) => this.listMemos(request),
			searchMemos: (query, limit) => this.memoRepository.search(query, limit),
			getSourceSessionId: () => this.context.session?.sessionId,
		};
	}

	listMemos(request: MemoListRequest = {}): MemoListResponse {
		return this.memoRepository.list(request);
	}

	getMemoSummary(): MemoSummary {
		return this.memoRepository.summary();
	}

	createMemo(request: MemoCreateRequest): MemoItem {
		const memo = this.memoRepository.create(request);
		this.memoReminderScheduler.set(memo);
		this.emitMemoChanged();
		return memo;
	}

	updateMemo(request: MemoUpdateRequest): MemoItem {
		const memo = this.memoRepository.update(request);
		this.memoReminderScheduler.set(memo);
		this.emitMemoChanged();
		return memo;
	}

	completeMemo(request: MemoCompleteRequest): MemoItem {
		const memo = this.memoRepository.complete(request.id, request.completed ?? true);
		// set() cancels any existing timer first, then re-arms only if the (possibly
		// rolled-forward recurring) memo is active with a pending reminder.
		this.memoReminderScheduler.set(memo);
		this.emitMemoChanged();
		return memo;
	}

	snoozeMemo(request: MemoSnoozeRequest): MemoItem {
		const memo = this.memoRepository.snooze(request.id, request.until);
		this.memoReminderScheduler.set(memo);
		this.emitMemoChanged();
		return memo;
	}

	setMemoReminder(request: MemoSetReminderRequest): MemoItem {
		const memo = this.memoRepository.setReminder(request.id, request.reminderAt);
		this.memoReminderScheduler.set(memo);
		this.emitMemoChanged();
		return memo;
	}

	deleteMemo(request: MemoDeleteRequest): boolean {
		this.memoReminderScheduler.cancel(request.id);
		const deleted = this.memoRepository.delete(request.id);
		this.emitMemoChanged();
		return deleted;
	}

	private emitMemoChanged(): void {
		this.emit({ type: "memo_changed", memoSummary: this.memoRepository.summary() });
	}

	/** Scheduler callback: a memo's reminder time arrived (missed = fired late on startup). */
	private onMemoReminder(memoId: string, missed: boolean): void {
		const memo = this.memoRepository.markReminderFired(memoId, missed);
		if (!memo) return;
		this.emit({ type: "memo_reminder", memo, memoSummary: this.memoRepository.summary() });
		// AI 主动开口：仅在聚焦会话空闲时插入一句提醒气泡，避免打断正在进行的回复。
		if (!this.context.isBusy) {
			const tag = memo.reminderMissed ? "提醒（错过）" : "提醒";
			const body = memo.notes ? `\n${memo.notes}` : "";
			this.context.pushMessage("assistant", `⏰ ${tag}：${memo.title}${body}`);
		}
	}

	// Automation flows -------------------------------------------------------

	listAutomations(): AutomationListResponse {
		return this.automationRepository.list();
	}

	getAutomation(request: AutomationGetRequest): AutomationFlow | undefined {
		return this.automationRepository.get(request.id);
	}

	getAutomationSummary(): AutomationSummary {
		return this.automationRepository.summary();
	}

	createAutomation(request: AutomationCreateRequest): AutomationFlow {
		const flow = this.automationRepository.create(normalizeAutomationMutationRequest(request));
		this.scheduleAutomation(flow);
		this.emitAutomationChanged(flow.id);
		return flow;
	}

	updateAutomation(request: AutomationUpdateRequest): AutomationFlow {
		const flow = this.automationRepository.update(normalizeAutomationMutationRequest(request));
		this.scheduleAutomation(flow);
		this.emitAutomationChanged(flow.id);
		return flow;
	}

	deleteAutomation(request: AutomationDeleteRequest): boolean {
		this.automationScheduler.cancel(request.id);
		const deleted = this.automationRepository.delete(request.id);
		this.emitAutomationChanged(request.id);
		return deleted;
	}

	setAutomationEnabled(request: AutomationSetEnabledRequest): AutomationFlow {
		const flow = this.automationRepository.setEnabled(request.id, request.enabled);
		this.scheduleAutomation(flow);
		this.emitAutomationChanged(flow.id);
		return flow;
	}

	async runAutomation(request: AutomationRunRequest): Promise<AutomationRunResponse> {
		const flow = this.automationRepository.get(request.id);
		if (!flow) throw new Error(`Automation flow not found: ${request.id}`);
		const run = await this.automationRunner.runAutomation(flow, {
			trigger: request.trigger ?? request.reason ?? "manual",
		});
		const updated = this.automationRepository.get(flow.id) ?? flow;
		this.scheduleAutomation(updated);
		return { flow: updated, run };
	}

	cancelAutomationRun(request: AutomationCancelRunRequest): boolean {
		return this.automationRunner.cancelRun(request.flowId);
	}

	async openAutomationEditor(request: AutomationOpenEditorRequest = {}): Promise<void> {
		if (request.flowId) {
			const flow = this.automationRepository.get(request.flowId);
			if (flow) this.automationDraftSession.loadFromFlow(flow);
		} else {
			this.automationDraftSession.reset();
		}
		// Every editor session starts a brand-new design conversation — never carry one over.
		await this.resetAutomationDesignContext();
		await this.options.openFlowEditorWindow?.(request.flowId);
	}

	/** Dispose the current design session so the next one starts fresh. */
	private async resetAutomationDesignContext(): Promise<void> {
		const context = this.automationDesignContext;
		this.automationDesignContext = undefined;
		if (!context) return;
		for (const [key, value] of this.sessions) {
			if (value === context) this.sessions.delete(key);
		}
		await context.dispose({ archiveMode: "detach" });
	}

	getAutomationDraft(request: AutomationDraftGetRequest = {}): AutomationDraft {
		if (request.flowId) {
			const flow = this.automationRepository.get(request.flowId);
			if (flow) return this.automationDraftSession.getDraft(flow);
		}
		return this.automationDraftSession.getDraft();
	}

	applyAutomationDraft(request: AutomationDraftApplyRequest): AutomationDraft {
		return this.automationDraftSession.applyOps(request.ops);
	}

	saveAutomationDraft(request: AutomationDraftSaveRequest = {}): AutomationDraftSaveResponse {
		const draft = this.automationDraftSession.getDraft();
		const flowId = request.flowId ?? draft.flowId;
		const payload = {
			name: draft.name,
			description: draft.description,
			nodes: draft.nodes,
			edges: draft.edges,
			trigger: draft.trigger,
			runPolicy: draft.runPolicy,
		};
		const flow = flowId
			? this.automationRepository.update({ id: flowId, ...payload })
			: this.automationRepository.create(payload);
		this.scheduleAutomation(flow);
		const savedDraft = this.automationDraftSession.markSaved(flow);
		this.emitAutomationChanged(flow.id);
		return { flow, draft: savedDraft };
	}

	async designAutomation(request: AutomationDesignChatRequest): Promise<AutomationDesignChatResponse> {
		if (request.flowId) {
			const flow = this.automationRepository.get(request.flowId);
			if (flow) this.automationDraftSession.getDraft(flow);
		}
		const context = await this.ensureAutomationDesignContext();
		// Remember where this turn begins so we can surface only the reply it produces.
		const baseMessageCount = context.messages.length;
		await context.prompt(request.message, "text");
		const reply = [...context.messages.slice(baseMessageCount)]
			.reverse()
			.find((message) => message.role === "assistant")?.text;
		return {
			snapshot: this.automationDraftSession.getDraft(),
			reply,
			...automationDesignStateFromContext(context),
		};
	}

	/**
	 * Start (or reuse) the design session and return its id + messages. The editor calls this on
	 * open so it knows the session id up front — letting it stream the very first reply live.
	 */
	async startAutomationDesignSession(): Promise<AutomationDesignStateResponse> {
		const context = await this.ensureAutomationDesignContext();
		return automationDesignStateFromContext(context);
	}

	private async ensureAutomationDesignContext(): Promise<ConversationContext> {
		const cached = this.automationDesignContext;
		// Reuse only if the cached design session is still alive in the registry —
		// otherwise it was disposed and the reference is stale.
		if (cached?.hasRuntime && [...this.sessions.values()].includes(cached)) return cached;
		this.automationDesignContext = undefined;
		// The design assistant is a full chat agent (all normal tools) PLUS the flow_* tools,
		// so it can ask questions, research, and edit the graph just like normal chat.
		const profile: ConversationRuntimeProfile = {
			customTools: [
				...this.createCustomTools(),
				...createFlowDesignToolDefinitions({
					getDraft: () => this.automationDraftSession.getDraft(),
					applyOps: (ops) => this.automationDraftSession.applyOps(ops),
				}),
			],
			activeToolNames: [...this.createActiveToolNames(), ...FLOW_DESIGN_TOOL_NAMES],
			kind: "automation_design",
			agentSource: "interactive",
			appendSystemPrompt: [buildAutomationDesignAppendPrompt()],
		};
		const context = new ConversationContext(
			this.buildContextDeps(),
			SessionManager.create(this.options.cwd, this.coordinator.paths.sessionsDir),
			{ profile },
		);
		this.registerContext(context, { focus: false });
		await context.initializeRuntime({
			sessionStartEvent: { type: "session_start", reason: "new" },
		});
		this.automationDesignContext = context;
		await this.evictIdleSessionsIfNeeded();
		return context;
	}

	private async createAutomationConversation(
		flow: AutomationFlow,
		run: AutomationRunRecord,
	): Promise<{
		sessionId: string;
		prompt(message: string): Promise<void>;
		abort(): void;
		finalize(): Promise<void>;
	}> {
		const runHost: AutomationRunToolHost = {
			flowId: flow.id,
			runId: run.id,
			reportProgress: (event) =>
				this.emitAutomationProgress({
					...event,
					flowId: flow.id,
					runId: run.id,
					timestamp: new Date().toISOString(),
				}),
			finishRun: (status, summary) => {
				this.automationRepository.recordRunFinish(flow.id, run.id, status, { summary });
				this.emitAutomationChanged(flow.id);
			},
		};
		const profile: ConversationRuntimeProfile = {
			customTools: [
				...this.createCustomTools({ permissionMode: flow.runPolicy.permissionMode }),
				...createAutomationRunToolDefinitions(runHost),
			],
			activeToolNames: [...this.createActiveToolNames(), ...AUTOMATION_RUN_TOOL_NAMES],
			kind: "automation",
			agentSource: "interactive",
			appendSystemPrompt: [buildAutomationRunAppendPrompt(flow, run)],
		};
		const context = new ConversationContext(
			this.buildContextDeps(),
			SessionManager.create(this.options.cwd, this.coordinator.paths.sessionsDir),
			{ profile },
		);
		const key = this.registerContext(context, { focus: false });
		await context.initializeRuntime({
			sessionStartEvent: { type: "session_start", reason: "new" },
		});
		await context.archive.setTitle(`Automation: ${flow.name}`, "auto");
		await this.evictIdleSessionsIfNeeded();
		return {
			sessionId: context.sessionId,
			prompt: (message) => context.prompt(message, "automation"),
			abort: () => context.abort(),
			// When the run ends, flush the conversation to disk and drop it from the live
			// roster: it stays resumable from history (so the timeline is still viewable)
			// without leaking a runtime per run.
			finalize: async () => {
				this.sessions.delete(key);
				await context.dispose({ archiveMode: "flush" });
				this.emit({ type: "snapshot", snapshot: this.snapshot() });
			},
		};
	}

	private scheduleAutomation(flow: AutomationFlow): void {
		const nextRunAt = this.automationScheduler.set(flow);
		this.automationRepository.setNextRunAt(flow.id, nextRunAt);
	}

	private rescheduleAutomations(): void {
		const flows = this.automationRepository.all();
		const missed = this.automationScheduler.rescheduleAll(flows);
		for (const { flowId, missedAt } of missed) {
			const flow = this.automationRepository.get(flowId);
			if (!flow) continue;
			this.emit({
				type: "automation_missed",
				automation: flow,
				automationSummary: this.automationRepository.summary(),
			});
			this.emitAutomationProgress({
				flowId,
				runId: "missed",
				kind: "log",
				message: `Scheduled run missed at ${missedAt}; not auto-compensated.`,
				timestamp: new Date().toISOString(),
			});
		}
		for (const flow of flows) {
			const nextRun = computeNextRun(flow.trigger, new Date());
			this.automationRepository.setNextRunAt(flow.id, nextRun?.toISOString());
		}
	}

	private onAutomationFire(flowId: string, missed: boolean): void {
		if (missed) {
			const flow = this.automationRepository.get(flowId);
			if (flow) {
				this.emit({
					type: "automation_missed",
					automation: flow,
					automationSummary: this.automationRepository.summary(),
				});
			}
			return;
		}
		const flow = this.automationRepository.get(flowId);
		if (!flow) return;
		void this.runAutomation({ id: flowId, trigger: "scheduled" }).catch((error: unknown) => {
			this.reportError(error);
		});
	}

	private emitAutomationChanged(flowId?: string): void {
		this.emit({
			type: "automation_changed",
			automation: flowId ? this.automationRepository.get(flowId) : undefined,
			automations: this.automationRepository.all(),
			automationSummary: this.automationRepository.summary(),
		});
	}

	private emitAutomationProgress(event: AutomationProgressEvent): void {
		this.emit({ type: "automation_progress", automationProgress: event });
	}

	async updateConversationThinking(enabled: boolean, sessionId?: string): Promise<DesktopAssistantSnapshot> {
		await this.contextFor(sessionId).updateConversationThinking(enabled);
		this.emit({ type: "snapshot", snapshot: this.snapshot() });
		return this.snapshot();
	}

	loadConversationPage(request: LoadConversationPageRequest): LoadConversationPageResponse {
		const limit = normalizeHistoryLimit(request.limit, HISTORY_PAGE_LIMIT);
		const source = readHistoryDisplaySource(this.coordinator, request.sessionId);
		const page = sliceHistoryDisplayItems(source, {
			beforeOrder: request.beforeOrder,
			messageLimit: limit,
			timelineLimit: limit,
		});
		return {
			sessionId: request.sessionId,
			messages: page.messages,
			timeline: page.timeline,
			hasMoreBefore: page.hasMoreBefore,
			oldestOrder: page.oldestOrder,
			loadedFrom: source.loadedFrom,
		};
	}

	async deleteConversation(sessionId: string): Promise<DeleteConversationResponse> {
		if (!this.context.hasRuntime) {
			await this.initialize();
		}
		await this.context.archive.flushSnapshots();
		const metadata = this.coordinator.getConversationMetadata(sessionId);
		const deletingActive = this.context.session?.sessionId === sessionId;
		// Tear down any live instance (focused or background) before deleting files.
		const live = this.findContextEntry(sessionId);
		if (live) {
			this.sessions.delete(live.key);
			if (live.key === this.focusedKey) this.focusedKey = "";
			await live.context.dispose({ archiveMode: "detach" });
		}
		if (deletingActive || !this.sessions.get(this.focusedKey)) {
			await this.refocusAfterRemoval();
		}
		const deletedArchive = this.coordinator.deleteConversationArchive(sessionId);
		const deletedSession = this.coordinator.deleteSessionFile(metadata?.sessionFile);
		await this.context.archive.flushSnapshots();
		this.context.archive.write("conversation_deleted", {
			sessionId,
			deletedArchive,
			deletedSession,
			deletingActive,
		});
		await this.context.archive.flushSnapshots();
		return {
			deletedSessionId: sessionId,
			activeSessionId: this.snapshot().sessionId,
		};
	}

	async clearConversationHistory(): Promise<ClearConversationHistoryResponse> {
		if (!this.context.hasRuntime) {
			await this.initialize();
		}
		await this.context.archive.flushSnapshots();
		const summaries = await this.coordinator.listConversationSummaries();
		const sessionsToDelete = summaries.map((summary) => ({
			sessionId: summary.sessionId,
			sessionFile: this.coordinator.getConversationMetadata(summary.sessionId)?.sessionFile,
		}));
		// Clearing history tears down every live conversation and starts one fresh.
		for (const [key, context] of [...this.sessions]) {
			this.sessions.delete(key);
			await context.dispose({ archiveMode: "detach" });
		}
		this.focusedKey = "";
		await this.createAndFocusNewConversation();
		const preservedSessionId = this.context.session?.sessionId;
		let deletedCount = 0;
		for (const entry of sessionsToDelete) {
			if (entry.sessionId === preservedSessionId) {
				continue;
			}
			if (this.coordinator.deleteConversationArchive(entry.sessionId)) {
				deletedCount += 1;
			}
			this.coordinator.deleteSessionFile(entry.sessionFile);
		}
		this.context.archive.write("conversation_history_cleared", {
			deletedCount,
			preservedSessionId,
			clearedSessionIds: sessionsToDelete
				.map((entry) => entry.sessionId)
				.filter((sessionId) => sessionId !== preservedSessionId),
		});
		await this.context.archive.flushSnapshots();
		return {
			deletedCount,
			activeSessionId: this.snapshot().sessionId,
		};
	}

	getSkillFile(capabilityId: DesktopCapabilityId): SkillFileView {
		const normalizedCapabilityId = normalizeCapabilityId(capabilityId);
		const filePath = resolveDesktopSkillFile(this.options.cwd, normalizedCapabilityId);
		return {
			capabilityId: normalizedCapabilityId,
			skillName: this.settings.capabilities[normalizedCapabilityId].skillName,
			path: filePath,
			content: readFileSync(filePath, "utf-8"),
			editable: true,
		};
	}

	async updateSkillFile(capabilityId: DesktopCapabilityId, content: string): Promise<SkillFileView> {
		const normalizedCapabilityId = normalizeCapabilityId(capabilityId);
		const filePath = resolveDesktopSkillFile(this.options.cwd, normalizedCapabilityId);
		writeFileSync(filePath, content, "utf-8");
		this.context.archive.write("skill_file_updated", {
			capabilityId: normalizedCapabilityId,
			path: filePath,
			content,
		});
		await (this.context.resourceLoader as DefaultResourceLoader | undefined)?.reload();
		const view = this.getSkillFile(normalizedCapabilityId);
		this.emit({ type: "skill_file", skillFile: view });
		return view;
	}

	getAppLaunchCache(): AppLaunchCacheView {
		return readAppLaunchCache(this.appLaunchCachePath);
	}

	clearAppLaunchCache(): AppLaunchCacheView {
		const cache = clearAppLaunchCache(this.appLaunchCachePath);
		this.context.archive.write("app_launch_cache_cleared", cache);
		this.context.pushTimeline({
			id: randomUUID(),
			kind: "agent",
			title: "App launch cache cleared",
			detail: cache.path,
			status: "succeeded",
			timestamp: Date.now(),
		});
		return cache;
	}

	deleteAppLaunchCacheEntry(alias: string): AppLaunchCacheView {
		const cache = deleteAppLaunchCacheEntry(this.appLaunchCachePath, alias);
		this.context.archive.write("app_launch_cache_entry_deleted", { alias, cache });
		this.context.pushTimeline({
			id: randomUUID(),
			kind: "agent",
			title: "App launch cache entry deleted",
			detail: alias,
			status: "succeeded",
			timestamp: Date.now(),
		});
		return cache;
	}

	abort(sessionId?: string): void {
		this.contextFor(sessionId).abort();
	}

	async approveConfirmation(id: string, sessionId?: string): Promise<DesktopAssistantSnapshot> {
		await this.contextForConfirmation(id, sessionId).approveConfirmation(id);
		return this.snapshot();
	}

	async rejectConfirmation(id: string, sessionId?: string): Promise<DesktopAssistantSnapshot> {
		await this.contextForConfirmation(id, sessionId).rejectConfirmation(id);
		return this.snapshot();
	}

	/**
	 * Route a confirmation action to its owning conversation. Prefers an explicit
	 * sessionId; otherwise finds the live context holding that confirmation id, so
	 * approving session A's request can never touch session B.
	 */
	private contextForConfirmation(id: string, sessionId?: string): ConversationContext {
		if (sessionId) return this.contextFor(sessionId);
		for (const context of this.sessions.values()) {
			if (context.pendingConfirmations.some((confirmation) => confirmation.id === id)) {
				return context;
			}
		}
		return this.context;
	}

	reportError(error: unknown): void {
		this.context.reportError(error);
	}

	async updateApiKey(apiKey: string): Promise<DesktopAssistantSnapshot> {
		const trimmed = apiKey.trim();
		const authProvider = getDeepSeekAuthProvider(this.settings);
		const connection = resolveDeepSeekApiConnection(this.settings);
		if (!trimmed) {
			this.authStorage.remove(authProvider);
			if (authProvider === DEEPSEEK_OFFICIAL_AUTH_PROVIDER) {
				this.authStorage.remove(DEEPSEEK_PROVIDER);
			}
			await syncDeepSeekRuntimeAuth(this.authStorage, this.settings);
			this.apiKeyStatus = { state: "idle", code: "cleared" };
			this.context.archive.write("api_key_updated", {
				provider: authProvider,
				connection,
				status: this.apiKeyStatus,
				action: "cleared",
			});
			this.modelRegistry.refresh();
			await this.applyConfiguredDeepSeekModel();
			this.emit({ type: "snapshot", snapshot: this.snapshot() });
			return this.snapshot();
		}

		this.apiKeyStatus = { state: "validating", code: "validating" };
		this.context.archive.write("api_key_validation_started", {
			provider: authProvider,
			connection,
			hasApiKey: true,
			length: trimmed.length,
		});
		this.emit({ type: "snapshot", snapshot: this.snapshot() });

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 20000);
		try {
			const discoveredRelayModels = await (this.options.validateApiKey ?? validateDeepSeekApiKey)(
				trimmed,
				connection,
				controller.signal,
			);
			if (connection.mode === "relay" && discoveredRelayModels) {
				const selectedRelayModel =
					discoveredRelayModels.find((model) => model.id === this.settings.modelId) ??
					selectPreferredRelayModel(discoveredRelayModels);
				this.settings = normalizeSettings({
					...this.settings,
					deepseekRelayModels: discoveredRelayModels,
					modelId: selectedRelayModel?.id ?? this.settings.modelId,
				});
				this.settingsManager.applyOverrides({
					defaultProvider:
						this.settings.provider === DEEPSEEK_PROVIDER ? DEEPSEEK_RUNTIME_PROVIDER : this.settings.provider,
					defaultModel: this.settings.modelId,
					defaultThinkingLevel: this.settings.thinkingLevel,
				});
			}
			this.authStorage.set(authProvider, { type: "api_key", key: trimmed });
			await syncDeepSeekRuntimeAuth(this.authStorage, this.settings);
			this.apiKeyStatus = { state: "valid", code: "valid" };
			this.context.archive.write("api_key_updated", {
				provider: authProvider,
				connection,
				status: this.apiKeyStatus,
				action: "validated_and_stored",
			});
			this.context.pushTimeline({
				id: randomUUID(),
				kind: "agent",
				title: "API Key 已保存",
				detail: "DeepSeek API Key 已验证并保存到当前连接方式的本机认证存储。",
				status: "succeeded",
				timestamp: Date.now(),
			});
		} catch (error) {
			await syncDeepSeekRuntimeAuth(this.authStorage, this.settings);
			this.apiKeyStatus = {
				state: "invalid",
				code: "invalid",
				detail: error instanceof Error ? error.message : String(error),
			};
			this.context.archive.write("api_key_validation_failed", {
				provider: authProvider,
				connection,
				status: this.apiKeyStatus,
				error,
			});
			this.emit({ type: "snapshot", snapshot: this.snapshot() });
			return this.snapshot();
		} finally {
			clearTimeout(timeout);
		}
		this.modelRegistry.refresh();
		await this.applyConfiguredDeepSeekModel();
		this.emit({ type: "snapshot", snapshot: this.snapshot() });
		return this.snapshot();
	}

	async updateVoiceApiKey(apiKey: string): Promise<DesktopAssistantSnapshot> {
		const trimmed = apiKey.trim();
		if (!trimmed) {
			this.authStorage.remove(VOICE_STT_AUTH_PROVIDER);
			this.authStorage.removeRuntimeApiKey(VOICE_STT_AUTH_PROVIDER);
			this.modelRegistry.refresh();
			this.context.archive.write("voice_api_key_updated", { action: "cleared" });
			this.emit({ type: "snapshot", snapshot: this.snapshot() });
			return this.snapshot();
		}
		this.authStorage.set(VOICE_STT_AUTH_PROVIDER, { type: "api_key", key: trimmed });
		this.authStorage.removeRuntimeApiKey(VOICE_STT_AUTH_PROVIDER);
		this.modelRegistry.refresh();
		this.context.archive.write("voice_api_key_updated", { action: "stored", length: trimmed.length });
		this.emit({ type: "snapshot", snapshot: this.snapshot() });
		return this.snapshot();
	}

	async updateSettings(update: Partial<DesktopAssistantSettings>): Promise<DesktopAssistantSnapshot> {
		const previousConnection = resolveDeepSeekApiConnection(this.settings);
		this.settings = normalizeSettings({ ...this.settings, ...update });
		const nextConnection = resolveDeepSeekApiConnection(this.settings);
		if (previousConnection.mode !== nextConnection.mode || previousConnection.baseUrl !== nextConnection.baseUrl) {
			this.apiKeyStatus = DEFAULT_API_KEY_STATUS;
		}
		if (update.mcp) {
			await this.mcpManager.applySettings(this.settings.mcp);
			this.persistMcpSettings();
		}
		if (update.sandbox) {
			this.persistSandbox();
			// Re-initialize so a changed root/quota/enable takes effect immediately.
			if (this.settings.sandbox.enabled) void this.sandboxManager.init();
		}
		this.context.archive.write("settings_updated", {
			update: sanitizeSettingsForArchive(update),
			settings: sanitizeSettingsForArchive(this.settings),
		});
		this.settingsManager.applyOverrides({
			defaultProvider:
				this.settings.provider === DEEPSEEK_PROVIDER ? DEEPSEEK_RUNTIME_PROVIDER : this.settings.provider,
			defaultModel: this.settings.modelId,
			defaultThinkingLevel: this.settings.thinkingLevel,
		});
		// Only try to load a DeepSeek model when the provider is actually deepseek.
		// Other providers are stored as preferences but require future backend wiring
		// before they can drive the agent session.
		if (this.settings.provider === DEEPSEEK_PROVIDER) {
			await this.applyConfiguredDeepSeekModel();
		}
		this.context.refreshConversationThinkingFromSettings();
		// Rebuild and refresh all tools so new settings take effect immediately.
		this.refreshAllTools();
		this.emit({ type: "snapshot", snapshot: this.snapshot() });
		return this.snapshot();
	}

	private async applyConfiguredDeepSeekModel(): Promise<void> {
		try {
			await syncDeepSeekRuntimeAuth(this.authStorage, this.settings);
			const model = getConfiguredDeepSeekModel(this.modelRegistry, this.settings);
			if (!this.modelRegistry.hasConfiguredAuth(model)) {
				return;
			}
			await this.context.applyModel(model);
		} catch (error) {
			console.warn("Failed to apply DeepSeek model:", error);
		}
	}

	listMcpServers(): McpServerListResponse {
		return this.mcpManager.list();
	}

	async upsertMcpServer(request: McpServerUpsertRequest): Promise<McpServerListResponse> {
		const next = await this.mcpManager.upsertServer(request.server);
		this.settings = normalizeSettings({ ...this.settings, mcp: this.mcpManager.getSettings() });
		this.persistMcpSettings();
		this.context.archive.write("mcp_server_upserted", {
			server: sanitizeMcpServerForArchive(normalizeMcpServerConfig(request.server)),
		});
		this.refreshAllTools();
		this.emit({ type: "snapshot", snapshot: this.snapshot() });
		this.emit({ type: "mcp_status", mcp: next });
		return next;
	}

	async deleteMcpServer(request: McpServerDeleteRequest): Promise<McpServerListResponse> {
		const next = await this.mcpManager.deleteServer(request.id);
		this.settings = normalizeSettings({ ...this.settings, mcp: this.mcpManager.getSettings() });
		this.persistMcpSettings();
		this.context.archive.write("mcp_server_deleted", { id: request.id });
		this.refreshAllTools();
		this.emit({ type: "snapshot", snapshot: this.snapshot() });
		this.emit({ type: "mcp_status", mcp: next });
		return next;
	}

	async testMcpServer(request: McpServerActionRequest): Promise<McpServerStatus> {
		const status = await this.mcpManager.testServer(request);
		this.context.archive.write("mcp_server_tested", { id: request.id ?? request.server?.id, state: status.state });
		this.emit({ type: "mcp_status", mcp: this.mcpManager.list() });
		return status;
	}

	async refreshMcpServer(request: McpServerActionRequest): Promise<McpServerListResponse> {
		if (!request.id) throw new Error("refreshMcpServer requires an id.");
		const next = await this.mcpManager.refreshServer(request.id);
		this.refreshAllTools();
		this.emit({ type: "mcp_status", mcp: next });
		return next;
	}

	async setMcpEnabled(request: McpEnabledUpdateRequest): Promise<McpServerListResponse> {
		const next = await this.mcpManager.setEnabled(request.enabled);
		this.settings = normalizeSettings({ ...this.settings, mcp: this.mcpManager.getSettings() });
		this.persistMcpSettings();
		this.context.archive.write("mcp_enabled_updated", { enabled: request.enabled });
		this.refreshAllTools();
		this.emit({ type: "snapshot", snapshot: this.snapshot() });
		this.emit({ type: "mcp_status", mcp: next });
		return next;
	}

	listPersonalSkills(): PersonalSkillListResponse {
		return this.personalSkillRepository.list();
	}

	searchPersonalSkills(request: PersonalSkillSearchRequest): PersonalSkillListResponse {
		return this.personalSkillRepository.search(request.query, request.limit);
	}

	readPersonalSkill(request: PersonalSkillReadRequest): PersonalSkillFileView {
		return this.personalSkillRepository.read(request.id);
	}

	savePersonalSkill(request: PersonalSkillSaveRequest): PersonalSkillFileView {
		const view = this.personalSkillRepository.save({
			...request,
			sourceSessionId: request.sourceSessionId ?? this.context.session?.sessionId,
		});
		this.context.archive.write("personal_skill_saved", {
			id: view.id,
			path: view.path,
			title: view.title,
		});
		return view;
	}

	archivePersonalSkill(request: PersonalSkillArchiveRequest): PersonalSkillListResponse {
		const result = this.personalSkillRepository.archive(request.id);
		this.context.archive.write("personal_skill_archived", { id: request.id });
		return result;
	}

	refreshPersonalSkills(): PersonalSkillListResponse {
		return this.personalSkillRepository.refresh();
	}

	listSoftwarePlugins(): SoftwarePluginListResponse {
		return this.softwarePluginManager.list();
	}

	validateSoftwarePluginTarget(request: ValidateSoftwarePluginTargetRequest): SoftwarePluginTargetValidation {
		return this.softwarePluginManager.validateTarget(request);
	}

	async installSoftwarePlugin(request: InstallSoftwarePluginRequest): Promise<InstallSoftwarePluginResponse> {
		const result = await this.softwarePluginManager.install(request);
		const next = await this.mcpManager.upsertServer(this.softwarePluginManager.getMcpServerConfig(request.pluginId));
		this.settings = normalizeSettings({ ...this.settings, mcp: this.mcpManager.getSettings() });
		this.persistMcpSettings();
		this.context.archive.write("software_plugin_installed", {
			plugin: redactInstalledPlugin(result.plugin),
			validation: result.validation,
			mcpServer: sanitizeMcpServerForArchive(result.mcpServer),
		});
		this.refreshAllTools();
		this.emit({ type: "snapshot", snapshot: this.snapshot() });
		this.emit({ type: "mcp_status", mcp: next });
		return result;
	}

	async uninstallSoftwarePlugin(request: UninstallSoftwarePluginRequest): Promise<UninstallSoftwarePluginResponse> {
		const result = this.softwarePluginManager.uninstall(request.pluginId);
		let next: McpServerListResponse | undefined;
		if (
			result.mcpServerId &&
			this.mcpManager.getSettings().servers.some((server) => server.id === result.mcpServerId)
		) {
			next = await this.mcpManager.deleteServer(result.mcpServerId);
			this.settings = normalizeSettings({ ...this.settings, mcp: this.mcpManager.getSettings() });
			this.persistMcpSettings();
		}
		this.context.archive.write("software_plugin_uninstalled", result);
		this.refreshAllTools();
		this.emit({ type: "snapshot", snapshot: this.snapshot() });
		if (next) this.emit({ type: "mcp_status", mcp: next });
		return result;
	}

	testSoftwarePluginBridge(request: TestSoftwarePluginBridgeRequest): Promise<TestSoftwarePluginBridgeResponse> {
		return this.softwarePluginManager.testBridge(request.pluginId);
	}

	listForgeExtensions(): ListForgeExtensionsResponse {
		return { extensions: readForgeExtensions() };
	}

	setForgeExtensionTrust(request: SetForgeExtensionTrustRequest): ForgeExtensionMutationResponse {
		const ok = updateForgeExtensionTrust(request.appId, request.name, request.trusted);
		return { ok, extensions: readForgeExtensions() };
	}

	deleteForgeExtension(request: DeleteForgeExtensionRequest): ForgeExtensionMutationResponse {
		const ok = removeForgeExtension(request.appId, request.name);
		return { ok, extensions: readForgeExtensions() };
	}

	getSoftwarePluginProgress(): SoftwarePluginOperationProgress | undefined {
		return this.latestSoftwarePluginProgress;
	}

	private reportSoftwarePluginProgress(progress: SoftwarePluginOperationProgress): void {
		this.latestSoftwarePluginProgress = {
			...progress,
			steps: progress.steps.map((step) => ({ ...step })),
		};
		this.emit({
			type: "software_plugin_progress",
			softwarePluginProgress: this.latestSoftwarePluginProgress,
		});
	}

	updateVoiceOverlay(update: Partial<VoiceOverlayState>): void {
		this.voiceOverlay = { ...this.voiceOverlay, ...update };
		this.context.archive.write("voice_overlay_updated", {
			update,
			voiceOverlay: this.voiceOverlay,
		});
		this.emit({ type: "voice", voiceOverlay: this.voiceOverlay });
		this.emit({ type: "snapshot", snapshot: this.snapshot() });
	}

	snapshot(): DesktopAssistantSnapshot {
		const fragment = this.context.snapshotFragment();
		return {
			sessionId: fragment.sessionId,
			sessions: this.buildSessionSummaries(),
			focusedSessionId: fragment.sessionId,
			settings: {
				...this.settings,
				mcp: redactMcpSettings(this.settings.mcp) ?? this.settings.mcp,
			},
			authStatus: getDeepSeekAuthStatus(this.authStorage, this.settings),
			voiceAuthStatus: getDesktopAuthStatus(this.authStorage, VOICE_STT_AUTH_PROVIDER),
			apiKeyStatus: this.apiKeyStatus,
			isRunning: fragment.isRunning,
			streamingText: fragment.streamingText,
			streamingThinking: fragment.streamingThinking,
			messages: fragment.messages,
			timeline: fragment.timeline,
			pendingConfirmations: fragment.pendingConfirmations,
			voiceOverlay: this.voiceOverlay,
			conversationThinking: fragment.conversationThinking,
			historyWindow: fragment.historyWindow,
			memoryEnabled: this.settings.memory.enabled,
			lastInjectedMemoryCount: fragment.lastInjectedMemoryCount,
			contextUsage: fragment.contextUsage,
			sandboxStatus: this.sandboxManager.getStatus(),
			memoSummary: this.memoRepository.summary(),
			automationSummary: this.automationRepository.summary(),
		};
	}

	getAuthStorage(): AuthStorage {
		return this.authStorage;
	}

	private persistMcpSettings(): void {
		try {
			writeFileSync(this.mcpSettingsPath, JSON.stringify(this.mcpManager.getSettings(), null, 2), "utf-8");
		} catch (error) {
			console.warn("Failed to persist MCP settings:", error);
		}
	}

	private persistSandbox(): void {
		try {
			writeFileSync(this.sandboxSettingsPath, JSON.stringify(this.settings.sandbox, null, 2), "utf-8");
		} catch (error) {
			console.warn("Failed to persist sandbox settings:", error);
		}
	}

	// ── Sandbox control (IPC) ────────────────────────────────────────────────────

	getSandboxStatus(): SandboxStatus {
		return this.sandboxManager.getStatus();
	}

	getSandboxRoot(): string {
		return this.sandboxManager.root;
	}

	async initSandbox(): Promise<SandboxStatus> {
		return this.sandboxManager.retry();
	}

	async resetSandbox(): Promise<SandboxStatus> {
		const status = await this.sandboxManager.reset();
		this.emit({ type: "snapshot", snapshot: this.snapshot() });
		return status;
	}

	cleanSandbox(request: SandboxCleanRequest): SandboxCleanResponse {
		const outcome = this.sandboxManager.clean(request.strategy ?? "oldest", request.targetMb);
		this.emit({ type: "sandbox_status", sandboxStatus: outcome.status });
		return { status: outcome.status, removedEntries: outcome.removedEntries, freedMb: outcome.freedMb };
	}

	private buildHistoryEntry(summary: ConversationArchiveSummary): ConversationHistoryEntry | undefined {
		// Skip conversations that have literally zero records (brand-new unused sessions).
		if (summary.recordCount === 0) {
			return undefined;
		}
		const archive = existsSync(summary.conversationFile)
			? readAiReadableConversationArchive(summary.conversationFile)
			: undefined;
		const latestMessages = this.getHistoryPreviewMessages(summary, archive);
		if (!latestMessages.lastUserMessage && !latestMessages.lastAssistantMessage) {
			return undefined;
		}
		const storedTitle = summary.title?.trim();
		return {
			sessionId: summary.sessionId,
			title: latestMessages.lastUserMessage?.slice(0, 28) || "新对话",
			preview:
				latestMessages.lastAssistantMessage?.slice(0, 48) ||
				latestMessages.lastUserMessage?.slice(0, 48) ||
				"暂无内容",
			updatedAt: Date.parse(summary.updatedAt) || Date.now(),
			messageCount: archive?.stats.messageCount ?? summary.recordCount,
			...(storedTitle ? { title: storedTitle } : {}),
		};
	}

	private getHistoryPreviewMessages(
		summary: ConversationArchiveSummary,
		archive?: AiReadableConversationArchive,
	): {
		lastUserMessage?: string;
		lastAssistantMessage?: string;
	} {
		const lastUserMessage = summary.lastUserMessage?.trim();
		const lastAssistantMessage = summary.lastAssistantMessage?.trim();
		if (lastUserMessage || lastAssistantMessage) {
			return { lastUserMessage, lastAssistantMessage };
		}
		if (!existsSync(summary.conversationFile)) {
			return {};
		}
		if (archive) {
			const archiveLastUserMessage =
				archive.latest.lastUserMessage?.trim() ?? this.findLatestArchiveMessage(archive, "user");
			const archiveLastAssistantMessage =
				archive.latest.lastAssistantMessage?.trim() ?? this.findLatestArchiveMessage(archive, "assistant");
			return {
				lastUserMessage: archiveLastUserMessage,
				lastAssistantMessage: archiveLastAssistantMessage,
			};
		}
		return {};
	}

	private findLatestArchiveMessage(
		archive: AiReadableConversationArchive,
		role: "user" | "assistant",
	): string | undefined {
		for (let index = archive.messages.length - 1; index >= 0; index -= 1) {
			const message = archive.messages[index];
			if (message.role !== role) {
				continue;
			}
			const text = message.text.trim();
			if (text) {
				return text;
			}
		}
		return undefined;
	}

	private async selectSkillForPrompt(message: string): Promise<SkillFileView | undefined> {
		const enabledCapabilities = DESKTOP_CAPABILITY_IDS.filter((id) => this.settings.capabilities[id].enabled);
		if (enabledCapabilities.length === 0) return undefined;

		const classifier =
			this.options.classifySkill ?? ((text, capabilities) => this.classifySkillWithModel(text, capabilities));
		const classified = await classifier(message, enabledCapabilities).catch(() =>
			classifySkillHeuristically(message, enabledCapabilities),
		);
		const selectedId =
			classified && enabledCapabilities.includes(classified)
				? classified
				: classifySkillHeuristically(message, enabledCapabilities);
		return selectedId ? this.getSkillFile(selectedId) : undefined;
	}

	private async selectPersonalSkillForPrompt(message: string): Promise<PersonalSkillFileView | undefined> {
		const explicitId = selectExplicitPersonalSkillId(message);
		if (!explicitId) return undefined;
		try {
			return this.personalSkillRepository.read(explicitId);
		} catch {
			return undefined;
		}
	}

	private async generateConversationTitle(input: {
		userMessage: string;
		assistantMessage?: string;
		signal?: AbortSignal;
		onDiagnostic?: (diagnostic: {
			level: "debug" | "info" | "warn" | "error";
			title: string;
			details?: Record<string, unknown>;
		}) => void;
	}): Promise<string | undefined> {
		if (!this.settings.autoTitle.enabled) {
			input.onDiagnostic?.({ level: "info", title: "skipped because autoTitle is disabled" });
			return undefined;
		}
		const connection = resolveDeepSeekApiConnection(this.settings);
		const authProvider = getDeepSeekAuthProvider(this.settings);
		const apiKey = await this.authStorage.getApiKey(authProvider, { includeFallback: false });
		if (!apiKey) {
			input.onDiagnostic?.({
				level: "warn",
				title: "skipped because api key is missing",
				details: {
					authProvider,
					connectionMode: connection.mode,
					includeFallback: false,
				},
			});
			return undefined;
		}

		// Pick the cheapest valid model for the current connection.
		//
		// Official mode: the built-in flash id IS the API model name, so use it directly.
		// Relay mode: the relay exposes its own model ids — the built-in `deepseek-v4-flash`
		// id usually does not exist there and would 400 (the previous `getDeepSeekRuntimeModelId`
		// "fallback" was dead code because relay mode never throws for a non-empty id). Prefer a
		// configured flash-like relay model for cost, otherwise reuse the active model id, which
		// is known to work for the running conversation.
		let modelId: string;
		if (connection.mode === "relay") {
			const relayModels = this.settings.deepseekRelayModels ?? [];
			const flashRelayModel = relayModels.find((model) => /flash/i.test(model.id));
			const candidate = flashRelayModel?.id ?? this.settings.modelId;
			try {
				modelId = getDeepSeekRuntimeModelId(connection.mode, candidate);
			} catch (error) {
				input.onDiagnostic?.({
					level: "error",
					title: "skipped because model resolution failed",
					details: {
						connectionMode: connection.mode,
						candidateModelId: candidate,
						settingsModelId: this.settings.modelId,
						error: describeUnknownError(error),
					},
				});
				return undefined;
			}
		} else {
			modelId = DEEPSEEK_FLASH_MODEL;
		}

		input.onDiagnostic?.({
			level: "info",
			title: "service configured request",
			details: {
				connectionMode: connection.mode,
				baseUrl: connection.baseUrl,
				authProvider,
				hasApiKey: true,
				modelId,
			},
		});

		return generateConversationTitle({
			baseUrl: connection.baseUrl,
			apiKey,
			modelId,
			userMessage: input.userMessage,
			assistantMessage: input.assistantMessage,
			signal: input.signal,
			onDiagnostic: input.onDiagnostic,
		});
	}

	private async classifySkillWithModel(
		message: string,
		enabledCapabilities: DesktopCapabilityId[],
	): Promise<DesktopCapabilityId | undefined> {
		await syncDeepSeekRuntimeAuth(this.authStorage, this.settings);
		const model = getConfiguredDeepSeekModel(this.modelRegistry, this.settings);
		if (!this.modelRegistry.hasConfiguredAuth(model)) {
			return classifySkillHeuristically(message, enabledCapabilities);
		}
		const auth = await this.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			return classifySkillHeuristically(message, enabledCapabilities);
		}
		const response = await completeSimple(
			model,
			{
				systemPrompt: [
					"You are a routing classifier for a Windows desktop assistant.",
					"Return exactly one token from the allowed list. Do not explain.",
					"system = Windows/OS/app/window/audio/display/input/file/shell desktop control.",
					"document = Word/text document/report/contract/notes editing or export.",
					"ppt = PowerPoint/presentation/slides/deck/speaker notes.",
					"excel = spreadsheet/workbook/table/formula/chart/data cleaning.",
					"none = general chat or no matching enabled capability.",
				].join("\n"),
				messages: [createTextMessage(`Allowed: ${enabledCapabilities.join(", ")}, none\nUser request: ${message}`)],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: 8,
				reasoning: "minimal",
			},
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			return classifySkillHeuristically(message, enabledCapabilities);
		}
		const text = response.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("")
			.toLowerCase()
			.trim();
		const match = DESKTOP_CAPABILITY_IDS.find((id) => text === id || text.startsWith(`${id}\n`));
		return match && enabledCapabilities.includes(match) ? match : undefined;
	}

	private emit(event: DesktopAssistantEvent, archive?: ConversationArchiveWriter): void {
		// agent_event is already conditionally archived in handleSessionEvent;
		// streaming_text is intentionally not archived, and snapshots /
		// session_status / session_notification are volatile UI projections that
		// must not feed history reconstruction.
		if (!VOLATILE_EVENT_TYPES.has(event.type)) {
			(archive ?? this.context.archive).write("desktop_assistant_event", event);
		}
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	/** Emit a cross-session toast/dot signal (with a refreshed roster) for the UI. */
	private emitSessionNotification(sessionId: string, kind: SessionNotificationKind): void {
		const entry = this.findContextEntry(sessionId);
		const title = entry ? this.deriveSessionTitle(entry.context) : "会话";
		this.emit({
			type: "session_notification",
			sessionNotification: { sessionId, title, kind },
			sessions: this.buildSessionSummaries(),
			focusedSessionId: this.focusedSessionId(),
		});
	}

	/** sessionId of the focused conversation, or "" during a focus handover. */
	private focusedSessionId(): string {
		return this.sessions.get(this.focusedKey)?.sessionId ?? "";
	}
}

const VOLATILE_EVENT_TYPES = new Set<DesktopAssistantEvent["type"]>([
	"streaming_text",
	"streaming_thinking",
	"agent_event",
	"snapshot",
	"session_status",
	"session_notification",
	"memo_changed",
	"memo_reminder",
]);

export function resolveSystemOperationSkillFile(cwd: string): string {
	return resolveDesktopSkillFile(cwd, "system");
}

export function resolveDesktopSkillFiles(cwd: string): Record<DesktopCapabilityId, string> {
	return {
		system: resolveDesktopSkillFile(cwd, "system"),
		document: resolveDesktopSkillFile(cwd, "document"),
		ppt: resolveDesktopSkillFile(cwd, "ppt"),
		excel: resolveDesktopSkillFile(cwd, "excel"),
	};
}

export function resolveDesktopSkillFile(cwd: string, capabilityId: DesktopCapabilityId): string {
	const skillDirectory = DESKTOP_SKILL_DIRECTORY_BY_CAPABILITY[normalizeCapabilityId(capabilityId)];
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolve(moduleDir, "..", "..", "skills", skillDirectory, "SKILL.md"),
		resolve(moduleDir, "..", "..", "..", "skills", skillDirectory, "SKILL.md"),
		resolve(cwd, "skills", skillDirectory, "SKILL.md"),
		resolve(cwd, "packages", "desktop-assistant", "skills", skillDirectory, "SKILL.md"),
	];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) {
		throw new Error(`Desktop skill file was not found for capability: ${capabilityId}`);
	}
	return found;
}

export function buildSystemOperationAppendPrompt(skillFile: string, sandboxEnabled = false): string {
	const content = readFileSync(skillFile, "utf-8");
	const blocks = [
		"<desktop_system_operation_skill>",
		"Always apply this skill for Windows desktop/system operation requests. This block is injected directly so it is available even when the read tool is not active.",
		content,
		"</desktop_system_operation_skill>",
		"<desktop_system_operation_guardrail>",
		"If the user asks you to operate the computer, you must call an appropriate desktop tool. Do not claim that a system operation has been completed unless a tool call succeeded or is waiting for approval.",
		"</desktop_system_operation_guardrail>",
	];
	if (sandboxEnabled) {
		blocks.push(
			"<sandbox_workflow_policy>",
			"沙箱已启用。修改或处理用户的现有文件时，必须走「沙箱优先」工作流——即使在「完全控制」权限模式下也必须这样做（完全控制只是不弹批准，不代表跳过沙箱）：",
			"1) 先用 sandbox_import 把目标文件或【整个文件夹】复制进沙箱（import 支持文件夹）。",
			"2) 在沙箱副本上完成全部检查与编辑：doc_inspect / doc_apply_edits / doc_verify / excel_* / ppt_* / office_*_run 都对【沙箱内副本的绝对路径】操作（用 $env:SANDBOX_ROOT\\... 或 sandbox_status 返回的 paths.sandboxRoot 拼路径）。",
			"3) 全部改完并自检/doc_verify 通过后，再用 sandbox_export 把成品导出回原始位置（或用户指定位置）。",
			"硬规则：不要直接对用户的真实原始文件执行写入/编辑（doc_apply_edits / office_*_run / excel_write / ppt_create 等）。只读查看（doc_read / doc_inspect 只为了解结构）可以读真实文件，但凡涉及写入一律先 sandbox_import 复制进沙箱再改。",
			"这样原始文件在 sandbox_export 之前始终保持不变（天然备份），即使中途出错也不会损坏用户数据。",
			"例外：纯桌面/系统类动作（开应用、键鼠、音量、窗口、改系统设置）无法在沙箱内完成，按权限模式直接在真实系统执行。",
			"</sandbox_workflow_policy>",
		);
	}
	return blocks.join("\n");
}

function buildAutomationDesignAppendPrompt(): string {
	return [
		"<automation_design_mode>",
		"你正在协助用户设计一个【自动化流程图】，供之后按计划重复执行。你的产出是这张流程图本身，而不是现在就去完成这件事。",
		"用 flow_* 工具读取并修改当前草稿：flow_get 查看现状；flow_add_node / flow_connect 增量构建；flow_update_node / flow_delete_node / flow_disconnect 调整；需要整体重画时用 flow_replace 给出完整图。",
		"绘制规则：流程通常包含一个 start 起点和一个 end 终点；节点 label 用简短标题，详细做法写进 instruction 字段；分支用 condition 节点并给每条出边加标签。添加节点可以不传坐标，系统会自动摆放，不会打乱已有节点。",
		"主动沟通：当目标、触发频率、关键步骤或成功判定不清楚时，先用自然语言向用户提问澄清，再动手画；每次改动流程图后用一两句话说明你做了什么。",
		"你可以使用其它所有可用工具（如联网搜索）来理解需求或查资料；但在设计阶段不要真正执行用户想自动化的任务（例如不要现在就去登录、签到、发消息）——那些只在流程运行时才发生。若用户想试运行，请提示其点击编辑器上的『测试』按钮。",
		"全程使用中文与用户交流。",
		"</automation_design_mode>",
	].join("\n");
}

function automationDesignStateFromContext(
	context: ConversationContext,
): AutomationDesignStateResponse & { sessionId: string } {
	const fragment = context.snapshotFragment();
	return {
		sessionId: fragment.sessionId,
		messages: [...fragment.messages],
		timeline: [...fragment.timeline],
		streamingText: fragment.streamingText,
		streamingThinking: fragment.streamingThinking,
	};
}

function buildAutomationRunAppendPrompt(flow: AutomationFlow, run: AutomationRunRecord): string {
	return [
		"<automation_run_mode>",
		`Automation flow id: ${flow.id}`,
		`Automation run id: ${run.id}`,
		"Follow the runbook exactly. Report node progress with automation_step, branch choices with automation_branch, and final outcome with automation_finish.",
		"Do not skip progress tools. If a desktop action requires approval, wait for approval instead of inventing success.",
		"</automation_run_mode>",
	].join("\n");
}

function normalizeAutomationMutationRequest<T extends AutomationCreateRequest | AutomationUpdateRequest>(
	request: T,
): T {
	const draftGraph = draftToFlowGraph(request.draft);
	return {
		...request,
		name: request.name ?? request.title,
		nodes: request.nodes ?? draftGraph.nodes,
		edges: request.edges ?? draftGraph.edges,
	};
}

function draftToFlowGraph(draft: unknown): { nodes?: FlowNode[]; edges?: FlowEdge[] } {
	if (!draft || typeof draft !== "object") return {};
	const raw = draft as Record<string, unknown>;
	const nodes = Array.isArray(raw.nodes)
		? raw.nodes.map(draftNodeToFlowNode).filter((node): node is FlowNode => node !== undefined)
		: undefined;
	const edges = Array.isArray(raw.edges)
		? raw.edges.map(draftEdgeToFlowEdge).filter((edge): edge is FlowEdge => edge !== undefined)
		: undefined;
	return { nodes, edges };
}

function draftNodeToFlowNode(value: unknown): FlowNode | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const data = raw.data && typeof raw.data === "object" ? (raw.data as Record<string, unknown>) : {};
	const position = raw.position && typeof raw.position === "object" ? (raw.position as Record<string, unknown>) : {};
	const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
	if (!id) return undefined;
	const rawKind = typeof data.kind === "string" ? data.kind : typeof raw.type === "string" ? raw.type : "";
	const kind = normalizeDraftNodeKind(rawKind);
	const label = typeof data.label === "string" && data.label.trim() ? data.label : id;
	const instruction =
		typeof data.description === "string"
			? data.description
			: typeof data.instruction === "string"
				? data.instruction
				: undefined;
	return {
		id,
		kind,
		label,
		instruction,
		position: {
			x: typeof position.x === "number" ? position.x : 0,
			y: typeof position.y === "number" ? position.y : 0,
		},
	};
}

function draftEdgeToFlowEdge(value: unknown): FlowEdge | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const source = typeof raw.source === "string" ? raw.source : undefined;
	const target = typeof raw.target === "string" ? raw.target : undefined;
	if (!source || !target) return undefined;
	return {
		id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `${source}-${target}`,
		source,
		target,
		label: typeof raw.label === "string" ? raw.label : undefined,
	};
}

function normalizeDraftNodeKind(value: string): FlowNode["kind"] {
	switch (value) {
		case "input":
		case "trigger":
		case "start":
			return "start";
		case "output":
		case "finish":
		case "end":
			return "end";
		case "condition":
			return "condition";
		case "loop":
			return "loop";
		case "wait":
			return "wait";
		default:
			return "task";
	}
}

export function detectMusicControlMcpTools(activeToolNames: string[]): string[] {
	const signature = /play_song|play_personal_fm|play_daily_recommend|play_playlist|like_song|^mcp_ncm_/i;
	return activeToolNames.filter((name) => name.startsWith("mcp_") && signature.test(name));
}

export function buildMcpAppendPrompt(activeToolNames: string[] = []): string {
	const musicTools = detectMusicControlMcpTools(activeToolNames);
	const lines = [
		"<mcp_control_policy>",
		"MCP is enabled. Prefer available tools whose names start with mcp_ for software-control tasks whenever they directly match the requested application or setting.",
		"Use normal desktop tools only when no suitable MCP tool exists, the MCP server is disconnected, the MCP capability is insufficient, or an MCP call fails.",
		"If an MCP tool fails, briefly use its structured error to choose a fallback instead of claiming the action succeeded.",
		"",
		"<music_playback_routing>",
		"When the user wants to play / search / control music (例如「我想听…」「放首…」「下一首」「点歌」):",
		"1) 先判断用户想用 / 电脑已安装哪个音乐软件（网易云音乐 / QQ音乐 / Spotify 等）。",
		"2) 若该音乐软件有对应的控制插件（名字以 mcp_ 开头的工具），必须用这些插件工具完成搜索 / 播放 / 暂停 / 切歌 / 点歌 / 红心 / 歌单，禁止改用 app_interaction、media_control、keyboard_mouse 去开应用、在界面里打字搜索。",
		"3) 只有当没有对应音乐控制插件、或插件调用失败时，才降级到 app_interaction → media_control → keyboard_mouse。",
		"4) 若音乐插件返回「目标软件正在启动中，请稍后重试」：它已自动启动了软件，请等待约 5~10 秒后【重试同一个插件工具一次】即可，不要反复重试，也不要因此改用桌面自动化打开应用。",
		"5) 切歌（上一首/下一首）直接用插件的 next_track/previous_track，它已自动适配所有播放模式（含心动/私人FM），一次调用即可，无需自己先查模式再决定。",
	];
	if (musicTools.length > 0) {
		lines.push(
			`检测到网易云音乐(NetEase Cloud Music)控制插件已激活。任何网易云相关的音乐请求都必须用这些 mcp_ 工具，例如：${musicTools
				.slice(0, 8)
				.join(", ")}。不要为音乐任务去打开应用并在其界面里键盘操作。`,
		);
	}
	lines.push("</music_playback_routing>", "</mcp_control_policy>");
	return lines.join("\n");
}

export function buildTokenSavingAppendPrompt(): string {
	return [
		"<token_saving_browser_snapshots>",
		"Token saving mode may replace large browser MCP results with summary/changeSummary plus snapshotId.",
		"Use the summary/changeSummary by default and continue the task from it.",
		"Do not repeat read_page for the same page when a usable snapshotId is available.",
		"When exact page text, HTML, links, forms, tables, or interactive elements are required, call browser_snapshot_read with the snapshotId and the smallest needed fields.",
		"For browser MCP automation, prefer focused element queries, selectors, visible text, and existing snapshot fields over repeated full-page reads.",
		"If a page is unchanged after a read_page call, stop rereading it; switch to query_elements, a targeted selector, a targeted evaluate_js extraction, or the existing snapshot.",
		"Use evaluate_js for narrow DOM extraction only. Do not dump full document HTML or body text unless the user explicitly needs it.",
		"</token_saving_browser_snapshots>",
	].join("\n");
}

export function classifySkillHeuristically(
	message: string,
	enabledCapabilities: readonly DesktopCapabilityId[] = DESKTOP_CAPABILITY_IDS,
): DesktopCapabilityId | undefined {
	const normalized = message.toLowerCase();
	const candidates: Array<{ id: DesktopCapabilityId; pattern: RegExp }> = [
		{
			id: "ppt",
			pattern:
				/(?:ppt|powerpoint|presentation|slide deck|slides?|演示文稿|幻灯片|讲稿|演讲稿|母版|放映|做一份.*汇报)/i,
		},
		{
			id: "excel",
			pattern:
				/(?:excel|spreadsheet|workbook|worksheet|表格|工作簿|工作表|公式|数据透视|透视表|图表|单元格|csv|xlsx)/i,
		},
		{
			id: "document",
			pattern: /(?:word|document|docx|report|contract|notes?|文档|报告|合同|简历|纪要|润色|改写|排版|导出.*pdf)/i,
		},
		{
			id: "system",
			pattern:
				/(?:打开|启动|关闭|设置|调整|调节|调到|调亮|调暗|变亮|变暗|屏幕|亮度|音量|声音|静音|窗口|键盘|鼠标|桌面|应用|软件|系统|settings?|volume|brightness|mute|unmute|window|app|launch|open|close)/i,
		},
	];
	for (const candidate of candidates) {
		if (enabledCapabilities.includes(candidate.id) && candidate.pattern.test(normalized)) {
			return candidate.id;
		}
	}
	return undefined;
}

function createTextMessage(text: string): Message {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function normalizeCapabilityId(capabilityId: DesktopCapabilityId): DesktopCapabilityId {
	if (!DESKTOP_CAPABILITY_IDS.includes(capabilityId)) {
		throw new Error(`Unknown desktop capability: ${capabilityId}`);
	}
	return capabilityId;
}

function normalizeDeepSeekRelayModels(
	models: DesktopAssistantSettings["deepseekRelayModels"],
): NonNullable<DesktopAssistantSettings["deepseekRelayModels"]> {
	if (!Array.isArray(models)) return [];
	const seen = new Set<string>();
	const normalized: NonNullable<DesktopAssistantSettings["deepseekRelayModels"]> = [];
	for (const model of models) {
		const id = typeof model?.id === "string" ? model.id.trim() : "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		normalized.push({
			id,
			label: typeof model.label === "string" && model.label.trim() ? model.label.trim() : id,
			ownedBy: typeof model.ownedBy === "string" && model.ownedBy.trim() ? model.ownedBy.trim() : undefined,
			supportedEndpointTypes: Array.isArray(model.supportedEndpointTypes)
				? model.supportedEndpointTypes.filter((value): value is string => typeof value === "string")
				: undefined,
		});
	}
	return normalized;
}

export function normalizeSettings(update: Partial<DesktopAssistantSettings> | undefined): DesktopAssistantSettings {
	const normalizedRelayModels = normalizeDeepSeekRelayModels(update?.deepseekRelayModels);
	const mergedVoice = {
		...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
		...update?.voice,
		wakeWord:
			update?.voice?.wakeWord?.trim() ||
			update?.wakeWord?.trim() ||
			DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice.wakeWord,
		language:
			update?.voice?.language?.trim() ||
			update?.voiceLanguage?.trim() ||
			DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice.language,
		postWakeWaitMs: clampMs(
			update?.voice?.postWakeWaitMs,
			DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice.postWakeWaitMs,
			1000,
			30000,
		),
		endSilenceMs: clampMs(
			update?.voice?.endSilenceMs,
			DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice.endSilenceMs,
			300,
			5000,
		),
		fuzzyThreshold: clampNumber(
			update?.voice?.fuzzyThreshold,
			DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice.fuzzyThreshold,
			0.1,
			1,
		),
		owwThreshold: clampNumber(
			update?.voice?.owwThreshold,
			DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice.owwThreshold ?? 0.5,
			0.05,
			1,
		),
		kwsSensitivity: clampNumber(
			update?.voice?.kwsSensitivity,
			DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice.kwsSensitivity ?? 0.6,
			0,
			1,
		),
	};
	mergedVoice.wakeEngine = normalizeWakeEngine(mergedVoice.wakeEngine);
	mergedVoice.activeOwwModelId = mergedVoice.activeOwwModelId?.trim() || undefined;
	mergedVoice.owwModelUrl = mergedVoice.owwModelUrl?.trim() || undefined;
	mergedVoice.kwsKeywords = mergedVoice.kwsKeywords?.trim() || undefined;
	const sttProvider = normalizeVoiceSttProvider(mergedVoice.sttProvider);
	mergedVoice.sttProvider = sttProvider;
	mergedVoice.sttModel = mergedVoice.sttModel?.trim() || DEFAULT_VOICE_STT_MODEL_BY_PROVIDER[sttProvider];
	mergedVoice.sttBaseUrl = mergedVoice.sttBaseUrl?.trim() || undefined;
	return {
		...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
		...update,
		apiConnectionMode: normalizeApiConnectionMode(update?.apiConnectionMode),
		apiBaseUrl: update?.apiBaseUrl?.trim() || undefined,
		deepseekRelayModels: normalizedRelayModels.length > 0 ? normalizedRelayModels : undefined,
		permissionMode: normalizePermissionMode(update?.permissionMode),
		voice: mergedVoice,
		wakeWord: mergedVoice.wakeWord,
		voiceLanguage: mergedVoice.language,
		capabilities: {
			...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.capabilities,
			...update?.capabilities,
			system: {
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.capabilities.system,
				...update?.capabilities?.system,
				commandFirst: true,
			},
			document: {
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.capabilities.document,
				...update?.capabilities?.document,
			},
			ppt: {
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.capabilities.ppt,
				...update?.capabilities?.ppt,
			},
			excel: {
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.capabilities.excel,
				...update?.capabilities?.excel,
			},
		},
		webSearch: {
			mode: update?.webSearch?.mode ?? DEFAULT_DESKTOP_ASSISTANT_SETTINGS.webSearch.mode,
			provider: update?.webSearch?.provider ?? DEFAULT_DESKTOP_ASSISTANT_SETTINGS.webSearch.provider,
			apiKey: update?.webSearch?.apiKey,
			googleCx: update?.webSearch?.googleCx,
			searxngUrl: update?.webSearch?.searxngUrl,
		},
		browser: normalizeBrowserSettings(update?.browser),
		mcp: normalizeMcpSettings(update?.mcp),
		memory: {
			enabled: update?.memory?.enabled ?? DEFAULT_DESKTOP_ASSISTANT_SETTINGS.memory.enabled,
			maxInjected: normalizeMemoryLimit(update?.memory?.maxInjected),
			autoExtract: update?.memory?.autoExtract ?? DEFAULT_DESKTOP_ASSISTANT_SETTINGS.memory.autoExtract,
		},
		tokenSaving: {
			enabled: update?.tokenSaving?.enabled ?? DEFAULT_DESKTOP_ASSISTANT_SETTINGS.tokenSaving.enabled,
		},
		autoTitle: {
			enabled: update?.autoTitle?.enabled ?? DEFAULT_DESKTOP_ASSISTANT_SETTINGS.autoTitle.enabled,
		},
		sandbox: normalizeSandboxSettings(update?.sandbox),
	};
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	const cleaned = value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return Array.from(new Set(cleaned));
}

function normalizeToolGates(value: unknown): Record<string, SandboxToolGate> {
	if (!value || typeof value !== "object") return { ...DEFAULT_SANDBOX_SETTINGS.toolGates };
	const out: Record<string, SandboxToolGate> = {};
	for (const [name, gate] of Object.entries(value as Record<string, unknown>)) {
		if (gate === "allow" || gate === "confirm" || gate === "deny") out[name] = gate;
	}
	return out;
}

/**
 * External "Browser Control" MCP tools are wrapped as mcp_browser_* (e.g. mcp_browser_list_tabs,
 * mcp_browser_control_take_control). They drive a separate extension/CDP-controlled browser, which
 * is not connected to the assistant's built-in browser — so they are suppressed while AI browser
 * control is active in favor of the built-in browser_* tools.
 */
export function isExternalBrowserControlToolName(name: string): boolean {
	return name.startsWith("mcp_browser_");
}

export function normalizeBrowserSettings(update?: Partial<BrowserSettings>): BrowserSettings {
	const d = DEFAULT_DESKTOP_ASSISTANT_SETTINGS.browser;
	return {
		defaultBrowser: normalizeBrowserTarget(update?.defaultBrowser),
		allowAiControl: update?.allowAiControl ?? d.allowAiControl,
		aiBrowserPreference: normalizeAiBrowserPreference(update?.aiBrowserPreference, d.aiBrowserPreference),
		homeUrl: normalizeBrowserHomeUrl(update?.homeUrl, d.homeUrl),
		maxTabs: Math.round(clampNumber(update?.maxTabs, d.maxTabs, 1, 32)),
		persistStorage: true,
		searchTemplate: normalizeSearchTemplate(update?.searchTemplate, d.searchTemplate),
		shortcuts: normalizeBrowserShortcuts(update?.shortcuts, d.shortcuts),
	};
}

function normalizeAiBrowserPreference(value: unknown, fallback: AiBrowserPreference): AiBrowserPreference {
	if (value === "built_in" || value === "external" || value === "auto") return value;
	return fallback;
}

const MAX_BROWSER_SHORTCUTS = 24;

function normalizeBrowserShortcuts(value: unknown, fallback: BrowserShortcut[]): BrowserShortcut[] {
	if (value === undefined) return fallback.map((item) => ({ ...item }));
	if (!Array.isArray(value)) return [];
	const seenIds = new Set<string>();
	const result: BrowserShortcut[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const candidate = raw as Partial<BrowserShortcut>;
		const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
		const rawUrl = typeof candidate.url === "string" ? candidate.url.trim() : "";
		if (!label || !rawUrl) continue;
		let id = typeof candidate.id === "string" ? candidate.id.trim() : "";
		if (!id || seenIds.has(id)) id = randomUUID();
		seenIds.add(id);
		const iconUrl =
			typeof candidate.iconUrl === "string" && candidate.iconUrl.trim() ? candidate.iconUrl.trim() : undefined;
		result.push({ id, label, url: normalizeBrowserHomeUrl(rawUrl, rawUrl), iconUrl });
		if (result.length >= MAX_BROWSER_SHORTCUTS) break;
	}
	return result;
}

function normalizeSearchTemplate(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	if (!trimmed.includes("%s")) return fallback;
	if (!/^https?:\/\//i.test(trimmed)) return fallback;
	return trimmed;
}

function normalizeBrowserTarget(value: unknown): BrowserTarget {
	if (value === "built_in" || value === "chrome" || value === "edge") return value;
	return DEFAULT_DESKTOP_ASSISTANT_SETTINGS.browser.defaultBrowser;
}

function normalizeBrowserHomeUrl(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	if (!trimmed) return fallback;
	if (trimmed === "about:blank") return trimmed;
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
	return `https://${trimmed}`;
}

export function normalizeSandboxSettings(update?: Partial<SandboxSettings>): SandboxSettings {
	const d = DEFAULT_SANDBOX_SETTINGS;
	const u = update ?? {};
	const preset =
		u.preset === "strict" || u.preset === "balanced" || u.preset === "permissive" || u.preset === "custom"
			? u.preset
			: d.preset;
	return {
		enabled: u.enabled ?? d.enabled,
		preset,
		workspace: {
			rootDir: u.workspace?.rootDir?.trim() || undefined,
			scope: u.workspace?.scope === "per_session" ? "per_session" : "global",
			quotaMb: clampNumber(u.workspace?.quotaMb, d.workspace.quotaMb, 64, 1_048_576),
			warnAtPercent: clampNumber(u.workspace?.warnAtPercent, d.workspace.warnAtPercent, 1, 100),
			overQuotaPolicy:
				u.workspace?.overQuotaPolicy === "deny_writes" ||
				u.workspace?.overQuotaPolicy === "auto_clean" ||
				u.workspace?.overQuotaPolicy === "confirm"
					? u.workspace.overQuotaPolicy
					: d.workspace.overQuotaPolicy,
			cleanOnSessionEnd: u.workspace?.cleanOnSessionEnd ?? d.workspace.cleanOnSessionEnd,
			autoInitOnStartup: u.workspace?.autoInitOnStartup ?? d.workspace.autoInitOnStartup,
			keepWarmProcess: u.workspace?.keepWarmProcess ?? d.workspace.keepWarmProcess,
		},
		filesystem: {
			writeRoots: normalizeStringArray(u.filesystem?.writeRoots, d.filesystem.writeRoots),
			readRoots: normalizeStringArray(u.filesystem?.readRoots, d.filesystem.readRoots),
			protectedPaths: normalizeStringArray(u.filesystem?.protectedPaths, d.filesystem.protectedPaths),
			confineWritesToRoots: u.filesystem?.confineWritesToRoots ?? d.filesystem.confineWritesToRoots,
			denySymlinkEscape: u.filesystem?.denySymlinkEscape ?? d.filesystem.denySymlinkEscape,
		},
		commands: {
			denyPatterns: normalizeStringArray(u.commands?.denyPatterns, d.commands.denyPatterns),
			allowPatterns: normalizeStringArray(u.commands?.allowPatterns, d.commands.allowPatterns),
			blockNetworkDownload: u.commands?.blockNetworkDownload ?? d.commands.blockNetworkDownload,
		},
		network: {
			domainAllowList: normalizeStringArray(u.network?.domainAllowList, d.network.domainAllowList),
			domainDenyList: normalizeStringArray(u.network?.domainDenyList, d.network.domainDenyList),
			blockPrivateIps: u.network?.blockPrivateIps ?? d.network.blockPrivateIps,
		},
		toolGates: normalizeToolGates(u.toolGates),
		resourceLimits: {
			commandTimeoutMs: clampNumber(
				u.resourceLimits?.commandTimeoutMs,
				d.resourceLimits.commandTimeoutMs,
				1000,
				600_000,
			),
			maxOutputChars: clampNumber(
				u.resourceLimits?.maxOutputChars,
				d.resourceLimits.maxOutputChars,
				1000,
				10_000_000,
			),
			maxConcurrentProcesses: clampNumber(
				u.resourceLimits?.maxConcurrentProcesses,
				d.resourceLimits.maxConcurrentProcesses,
				1,
				64,
			),
			killProcessTree: u.resourceLimits?.killProcessTree ?? d.resourceLimits.killProcessTree,
		},
		hardening: { runAsRestrictedUser: u.hardening?.runAsRestrictedUser ?? d.hardening.runAsRestrictedUser },
		audit: { logDecisions: u.audit?.logDecisions ?? d.audit.logDecisions },
		aiMayEdit: "tighten_only",
	};
}

function readPersistedSandbox(path: string): SandboxSettings | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<SandboxSettings>;
		return normalizeSandboxSettings(parsed);
	} catch (error) {
		console.warn("Failed to read persisted sandbox settings:", error);
		return undefined;
	}
}

function normalizePermissionMode(mode: unknown): AutomationPermissionMode {
	return AUTOMATION_PERMISSION_MODES.includes(mode as AutomationPermissionMode)
		? (mode as AutomationPermissionMode)
		: DEFAULT_DESKTOP_ASSISTANT_SETTINGS.permissionMode;
}

function readPersistedMcpSettings(path: string): DesktopAssistantSettings["mcp"] | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<DesktopAssistantSettings["mcp"]>;
		return normalizeMcpSettings(parsed);
	} catch (error) {
		console.warn("Failed to read persisted MCP settings:", error);
		return undefined;
	}
}

function normalizeVoiceSttProvider(provider: unknown): DesktopAssistantSettings["voice"]["sttProvider"] {
	if (provider === "openai" || provider === "siliconflow" || provider === "groq" || provider === "custom") {
		return provider;
	}
	return DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice.sttProvider;
}

function normalizeWakeEngine(engine: unknown): DesktopAssistantSettings["voice"]["wakeEngine"] {
	if (engine === "kws" || engine === "auto" || engine === "openwakeword" || engine === "vosk") return engine;
	return DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice.wakeEngine;
}

function sanitizeSettingsForArchive(
	settings: Partial<DesktopAssistantSettings> | DesktopAssistantSettings | undefined,
): Partial<DesktopAssistantSettings> | undefined {
	if (!settings) return undefined;
	return {
		...settings,
		voice: settings.voice
			? {
					...settings.voice,
					sttApiKey: settings.voice.sttApiKey ? "[redacted]" : undefined,
				}
			: undefined,
		webSearch: settings.webSearch
			? {
					...settings.webSearch,
					apiKey: settings.webSearch.apiKey ? "[redacted]" : undefined,
				}
			: undefined,
		mcp: redactMcpSettings(settings.mcp),
	};
}

function sanitizeMcpServerForArchive(server: McpServerConfig): McpServerConfig {
	return redactMcpSettings({ enabled: true, servers: [server] })?.servers[0] ?? server;
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

function getDesktopAuthStatus(
	authStorage: AuthStorage,
	provider: string,
): {
	configured: boolean;
	source?: string;
	needsRotationWarning: boolean;
} {
	const status = authStorage.getAuthStatus(provider);
	return {
		configured: status.configured,
		source: status.source,
		needsRotationWarning: false,
	};
}

function clampMs(value: number | undefined, fallback: number, min: number, max: number): number {
	return clampNumber(value, fallback, min, max);
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}
