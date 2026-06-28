import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ConversationThinkingState, MessageTokenUsageView } from "../shared/types.ts";

export interface ConversationArchivePaths {
	saveDir: string;
	sessionsDir: string;
	conversationsDir: string;
	indexFile: string;
	readmeFile: string;
}

export type ConversationArchiveTitleSource = "auto" | "manual";

export interface ConversationArchiveMetadata {
	schemaVersion: 3;
	sessionId: string;
	cwd: string;
	title?: string;
	titleSource?: ConversationArchiveTitleSource;
	sessionFile?: string;
	sessionMirrorFile: string;
	rawEventsFile: string;
	conversationFile: string;
	createdAt: string;
	updatedAt: string;
	recordsWritten: number;
	lastRecordAt?: string;
	lastUserMessage?: string;
	lastAssistantMessage?: string;
	lastEventKind?: string;
	status: "active" | "idle";
	conversationThinking?: ConversationThinkingState;
}

export interface ConversationArchiveRecord {
	schemaVersion: 1;
	sequence: number;
	recordedAt: string;
	sessionId: string;
	sessionFile?: string;
	kind: string;
	payload: unknown;
}

export interface ConversationArchiveSummary {
	schemaVersion: 1;
	sessionId: string;
	cwd: string;
	title?: string;
	titleSource?: ConversationArchiveTitleSource;
	status: "active" | "idle";
	createdAt: string;
	updatedAt: string;
	lastRecordAt?: string;
	recordCount: number;
	lastEventKind?: string;
	lastUserMessage?: string;
	lastAssistantMessage?: string;
	rawEventsFile: string;
	sessionMirrorFile: string;
	metadataFile: string;
	conversationFile: string;
}

export interface ConversationArchiveIndex {
	schemaVersion: 1;
	generatedAt: string;
	cwd: string;
	conversations: ConversationArchiveSummary[];
}

export interface AiReadableConversationArchive {
	schemaVersion: 1;
	sessionId: string;
	cwd: string;
	status: "active" | "idle";
	createdAt: string;
	updatedAt: string;
	lastRecordAt?: string;
	files: {
		metadata: string;
		rawEvents: string;
		sessionMirror: string;
	};
	stats: {
		recordCount: number;
		messageCount: number;
		userMessageCount: number;
		assistantMessageCount: number;
		toolCallCount: number;
		toolResultCount: number;
		thinkingDeltaCount: number;
		confirmationCount: number;
		errorCount: number;
	};
	latest: {
		lastEventKind?: string;
		lastUserMessage?: string;
		lastAssistantMessage?: string;
	};
	conversationThinking?: ConversationThinkingState;
	messages: Array<{
		role: "user" | "assistant" | "system";
		text: string;
		timestamp?: number;
		recordedAt?: string;
		sourceKind: string;
		sequence: number;
		tokenUsage?: MessageTokenUsageView;
		turnTokenUsage?: MessageTokenUsageView;
	}>;
	thinking: Array<{
		sequence: number;
		recordedAt: string;
		contentIndex?: number;
		delta: string;
	}>;
	tools: Array<{
		sequence: number;
		recordedAt: string;
		phase: "start" | "update" | "end";
		toolName: string;
		toolCallId?: string;
		args?: unknown;
		result?: unknown;
		isError?: boolean;
	}>;
	confirmations: Array<{
		sequence: number;
		recordedAt: string;
		kind: string;
		intent?: string;
		action?: string;
		target?: string;
		status?: string;
	}>;
	timeline: Array<{
		sequence: number;
		recordedAt: string;
		kind: string;
		payload: unknown;
	}>;
	steeringEntries?: Array<{
		id: string;
		text: string;
		appliedAt: number;
		order: number;
	}>;
	eventKinds: Record<string, number>;
}

export function getConversationArchivePaths(cwd: string, saveDir?: string): ConversationArchivePaths {
	const resolvedSaveDir = saveDir ? resolve(saveDir) : resolve(cwd, "save");
	return {
		saveDir: resolvedSaveDir,
		sessionsDir: join(resolvedSaveDir, "sessions"),
		conversationsDir: join(resolvedSaveDir, "conversations"),
		indexFile: join(resolvedSaveDir, "index.json"),
		readmeFile: join(resolvedSaveDir, "README.md"),
	};
}

/**
 * Owns cross-session archive resources: base directories, the README, the
 * global index.json, and conversation lookup/deletion. All index.json writes
 * are serialized through a single promise chain so concurrent per-session
 * writers can never interleave partial index contents.
 */
export class ConversationArchiveCoordinator {
	private readonly cwd: string;
	private readonly archivePaths: ConversationArchivePaths;
	private indexFlushChain: Promise<void> = Promise.resolve();

	constructor(cwd: string, saveDir?: string) {
		this.cwd = resolve(cwd);
		this.archivePaths = getConversationArchivePaths(this.cwd, saveDir);
		this.ensureBaseDirectories();
		this.writeReadme();
	}

	get paths(): ConversationArchivePaths {
		return this.archivePaths;
	}

	createWriter(sessionId: string, sessionFile?: string): ConversationArchiveWriter {
		return new ConversationArchiveWriter(this, this.cwd, sessionId, sessionFile);
	}

	/**
	 * Rebuild index.json from all conversation metadata files.
	 * Concurrent calls (e.g. from multiple session writers flushing at once)
	 * are chained so the file is only ever written by one task at a time.
	 */
	flushIndex(): Promise<void> {
		this.indexFlushChain = this.indexFlushChain.then(() => this.writeIndex());
		return this.indexFlushChain;
	}

	async listConversationSummaries(): Promise<ConversationArchiveSummary[]> {
		if (!existsSync(this.archivePaths.indexFile)) {
			await this.flushIndex();
		}
		try {
			const parsed = JSON.parse(readFileSync(this.archivePaths.indexFile, "utf-8")) as ConversationArchiveIndex;
			if (!Array.isArray(parsed.conversations)) return [];
			return parsed.conversations;
		} catch {
			await this.flushIndex();
			try {
				const parsed = JSON.parse(readFileSync(this.archivePaths.indexFile, "utf-8")) as ConversationArchiveIndex;
				return Array.isArray(parsed.conversations) ? parsed.conversations : [];
			} catch {
				return [];
			}
		}
	}

	getConversationMetadata(sessionId: string): ConversationArchiveMetadata | undefined {
		const metadataPath = join(this.archivePaths.conversationsDir, sessionId, "metadata.json");
		if (!existsSync(metadataPath)) return undefined;
		try {
			return JSON.parse(readFileSync(metadataPath, "utf-8")) as ConversationArchiveMetadata;
		} catch {
			return undefined;
		}
	}

	deleteConversationArchive(sessionId: string): boolean {
		const archiveDir = join(this.archivePaths.conversationsDir, sessionId);
		if (!existsSync(archiveDir)) return false;
		rmSync(archiveDir, { recursive: true, force: true });
		return true;
	}

	deleteSessionFile(sessionFile: string | undefined): boolean {
		if (!sessionFile || !existsSync(sessionFile)) return false;
		try {
			unlinkSync(sessionFile);
			return true;
		} catch {
			return false;
		}
	}

	listSessionFiles(): string[] {
		try {
			return readSessionJsonlFiles(this.archivePaths.sessionsDir);
		} catch {
			return [];
		}
	}

	deleteAllConversationArchives(): number {
		let deletedCount = 0;
		try {
			const entries = readConversationDirectories(this.archivePaths.conversationsDir);
			for (const entry of entries) {
				rmSync(join(this.archivePaths.conversationsDir, entry), { recursive: true, force: true });
				deletedCount += 1;
			}
		} catch {
			return deletedCount;
		}
		return deletedCount;
	}

	private ensureBaseDirectories(): void {
		mkdirSync(this.archivePaths.saveDir, { recursive: true });
		mkdirSync(this.archivePaths.sessionsDir, { recursive: true });
		mkdirSync(this.archivePaths.conversationsDir, { recursive: true });
	}

	private writeReadme(): void {
		if (existsSync(this.archivePaths.readmeFile)) return;
		writeFileSync(this.archivePaths.readmeFile, ARCHIVE_README_CONTENT, "utf-8");
	}

	private async writeIndex(): Promise<void> {
		let entries: { name: string; isDirectory(): boolean }[];
		try {
			entries = await readdir(this.archivePaths.conversationsDir, { withFileTypes: true });
		} catch {
			return;
		}
		const metadataPaths = entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(this.archivePaths.conversationsDir, entry.name, "metadata.json"))
			.filter((metadataPath) => existsSync(metadataPath));

		const summaries = (await Promise.all(metadataPaths.map((p) => this.readSummaryFromMetadata(p)))).filter(
			(summary): summary is ConversationArchiveSummary => summary !== undefined,
		);
		summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

		const index: ConversationArchiveIndex = {
			schemaVersion: 1,
			generatedAt: new Date().toISOString(),
			cwd: this.cwd,
			conversations: summaries,
		};
		await writeFile(this.archivePaths.indexFile, JSON.stringify(index, null, "\t"), "utf-8").catch(() => {});
	}

	private async readSummaryFromMetadata(metadataPath: string): Promise<ConversationArchiveSummary | undefined> {
		try {
			const content = await readFile(metadataPath, "utf-8");
			// Cast to a loose type to handle both schema v1 (archiveFile) and v2 (rawEventsFile).
			const metadata = JSON.parse(content) as ConversationArchiveMetadata & { archiveFile?: string };
			// Old schema (v1) used "archiveFile" instead of "rawEventsFile".
			const rawEventsFile = metadata.rawEventsFile ?? metadata.archiveFile ?? "";
			// Old schema (v1) did not write conversationFile — fall back to the sibling path.
			const conversationFile = metadata.conversationFile ?? join(dirname(metadataPath), "conversation.json");
			return {
				schemaVersion: 1,
				sessionId: metadata.sessionId,
				cwd: metadata.cwd,
				title: metadata.title,
				titleSource: metadata.titleSource,
				status: metadata.status ?? "idle",
				createdAt: metadata.createdAt,
				updatedAt: metadata.updatedAt,
				lastRecordAt: metadata.lastRecordAt,
				recordCount: metadata.recordsWritten,
				lastEventKind: metadata.lastEventKind,
				lastUserMessage: metadata.lastUserMessage,
				lastAssistantMessage: metadata.lastAssistantMessage,
				rawEventsFile,
				sessionMirrorFile: metadata.sessionMirrorFile,
				metadataFile: metadataPath,
				conversationFile,
			};
		} catch {
			return undefined;
		}
	}
}

/**
 * Per-session archive writer. Bound to a single sessionId for its entire
 * lifetime; owns the session's events.jsonl / metadata.json / conversation.json
 * and the session file mirror. Multiple writers can run concurrently — each
 * has its own write buffer and snapshot debounce, and index.json updates go
 * through the shared coordinator's serialized flush chain.
 */
export class ConversationArchiveWriter {
	private readonly coordinator: ConversationArchiveCoordinator;
	private readonly cwd: string;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	private recordsWritten = 0;
	private createdAt = new Date().toISOString();
	private snapshotTimer: ReturnType<typeof setTimeout> | undefined;
	private snapshotDirty = false;
	private snapshotFlushChain: Promise<void> = Promise.resolve();
	private cachedArchive: AiReadableConversationArchive | undefined;
	private conversationThinking: ConversationThinkingState | undefined;
	private title: string | undefined;
	private titleSource: ConversationArchiveTitleSource | undefined;
	private static readonly SNAPSHOT_DEBOUNCE_MS = 2000;

	// ── Async write buffer ─────────────────────────────────────────────────────
	// Writes are accumulated here and flushed as a single async appendFile call.
	// This prevents appendFileSync from blocking the Node.js event loop on every
	// agent event during streaming / tool execution.
	private writeBuffer: string[] = [];
	private writeFlushPending = false;
	// All async flushes are chained so writes always land in order.
	private writeFlushChain: Promise<void> = Promise.resolve();
	// Resolved placeholder kept so flushSnapshots() needn't branch on its existence.
	private readonly pendingMirrorSync: Promise<void> = Promise.resolve();
	// ──────────────────────────────────────────────────────────────────────────

	private disposed = false;

	constructor(coordinator: ConversationArchiveCoordinator, cwd: string, sessionId: string, sessionFile?: string) {
		this.coordinator = coordinator;
		this.cwd = resolve(cwd);
		this.sessionId = sessionId;
		this.sessionFile = sessionFile;
		mkdirSync(this.conversationDirPath(), { recursive: true });
		this.restoreMetadata();
	}

	/**
	 * Final flush and teardown. The writer must not be used afterwards.
	 */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.forceFlushWriteBufferSync();
		await this.flushSnapshots();
	}

	/**
	 * Stop debounced snapshot work and flush buffered event lines synchronously,
	 * WITHOUT regenerating metadata/conversation.json. Used when the facade
	 * switches sessions: pending lines must land in this session's events file,
	 * but snapshot freshness must stay untouched — rebuild-from-archive compares
	 * conversation.json freshness against events.jsonl to pick its source.
	 */
	detach(): void {
		this.disposed = true;
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = undefined;
		}
		this.snapshotDirty = false;
		this.forceFlushWriteBufferSync();
	}

	/**
	 * Append a record to the raw events file.
	 * Writes are buffered and flushed asynchronously to avoid blocking the
	 * Node.js event loop with synchronous disk I/O on the hot path.
	 */
	write(kind: string, payload: unknown): void {
		if (this.disposed) return;
		const record: ConversationArchiveRecord = {
			schemaVersion: 1,
			sequence: this.recordsWritten + 1,
			recordedAt: new Date().toISOString(),
			sessionId: this.sessionId,
			sessionFile: this.sessionFile,
			kind,
			payload: normalizePayload(payload),
		};
		this.writeBuffer.push(`${JSON.stringify(record)}\n`);
		this.recordsWritten = record.sequence;
		this.scheduleWriteFlush();
		this.scheduleSnapshotUpdate();
	}

	/**
	 * Copy the session file mirror synchronously.
	 *
	 * This is called infrequently (only on message_end, tool_execution_end,
	 * agent_end — never during streaming text or rapid tool-event bursts), so a
	 * brief synchronous copy is acceptable and avoids the Windows EBUSY error
	 * that arises when an async copyFile() holds a read-lock on the source file
	 * while SessionManager tries to appendFileSync to it concurrently.
	 */
	syncSessionFileMirror(): void {
		if (!this.sessionFile || !existsSync(this.sessionFile)) return;
		try {
			copyFileSync(this.sessionFile, this.sessionMirrorFilePath());
		} catch {
			// Ignore mirror errors — it is a non-critical debug copy.
		}
		this.scheduleSnapshotUpdate();
	}

	/**
	 * Flush pending snapshot files to disk.
	 * Async: drains the write buffer and awaits any in-flight mirror copy first,
	 * so callers that await this are guaranteed to see fully up-to-date files.
	 */
	async flushSnapshots(): Promise<void> {
		const flush = this.snapshotFlushChain.then(
			() => this.runSnapshotFlush(),
			() => this.runSnapshotFlush(),
		);
		this.snapshotFlushChain = flush.catch(() => {});
		await flush;
	}

	private async runSnapshotFlush(): Promise<void> {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = undefined;
		}
		this.snapshotDirty = false;
		// Drain buffered writes and mirror copy before reading records.
		await Promise.all([this.writeFlushChain, this.pendingMirrorSync]);
		await this.writeMetadata();
		await this.writeConversationSnapshot();
		await this.coordinator.flushIndex();
	}

	setConversationThinkingState(state: ConversationThinkingState): void {
		this.conversationThinking = { ...state };
		this.scheduleSnapshotUpdate();
	}

	async setTitle(title: string, source: ConversationArchiveTitleSource): Promise<void> {
		const trimmed = title.trim();
		if (!trimmed) return;
		if (this.titleSource === "manual" && source === "auto") return;
		this.title = trimmed;
		this.titleSource = source;
		this.write("conversation_title_generated", { title: trimmed, source });
		await this.flushSnapshots();
	}

	getTitle(): string | undefined {
		return this.title;
	}

	hasTitle(): boolean {
		return !!this.title?.trim();
	}

	// ── Write buffer internals ─────────────────────────────────────────────────

	/**
	 * Schedule an async drain of the write buffer via the chain.
	 * Multiple calls in the same tick are coalesced into one flush.
	 */
	private scheduleWriteFlush(): void {
		if (this.writeFlushPending) return;
		this.writeFlushPending = true;
		this.writeFlushChain = this.writeFlushChain.then(() => this.drainWriteBuffer());
	}

	private async drainWriteBuffer(): Promise<void> {
		this.writeFlushPending = false;
		if (this.writeBuffer.length === 0) return;
		const lines = this.writeBuffer.splice(0);
		await appendFile(this.rawEventsFilePath(), lines.join(""), "utf-8").catch(() => {
			// If the async write fails, put the lines back to retry on the next flush.
			this.writeBuffer.unshift(...lines);
		});
	}

	/**
	 * Synchronous fallback used only on teardown / session switch (non-hot-path).
	 * Ensures pending lines land in this session's events file immediately.
	 */
	forceFlushWriteBufferSync(): void {
		if (this.writeBuffer.length === 0) return;
		const lines = this.writeBuffer.splice(0);
		try {
			appendFileSync(this.rawEventsFilePath(), lines.join(""), "utf-8");
		} catch {
			// Best-effort.
		}
	}

	// ──────────────────────────────────────────────────────────────────────────

	private scheduleSnapshotUpdate(): void {
		this.snapshotDirty = true;
		if (this.snapshotTimer) return;
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = undefined;
			if (this.snapshotDirty) {
				void this.flushSnapshots();
			}
		}, ConversationArchiveWriter.SNAPSHOT_DEBOUNCE_MS);
	}

	private ensureConversationDirectory(): void {
		mkdirSync(this.conversationDirPath(), { recursive: true });
	}

	private restoreMetadata(): void {
		this.ensureConversationDirectory();
		const metadataPath = this.metadataFilePath();
		if (!existsSync(metadataPath)) return;
		try {
			const parsed = JSON.parse(readFileSync(metadataPath, "utf-8")) as Partial<ConversationArchiveMetadata>;
			if (typeof parsed.recordsWritten === "number" && Number.isFinite(parsed.recordsWritten)) {
				this.recordsWritten = parsed.recordsWritten;
			}
			if (typeof parsed.createdAt === "string" && parsed.createdAt) {
				this.createdAt = parsed.createdAt;
			}
			if (typeof parsed.title === "string" && parsed.title.trim()) {
				this.title = parsed.title.trim();
			}
			if (parsed.titleSource === "auto" || parsed.titleSource === "manual") {
				this.titleSource = parsed.titleSource;
			}
			if (parsed.conversationThinking) {
				this.conversationThinking = parsed.conversationThinking;
			}
		} catch {
			// Ignore corrupted metadata and keep a fresh archive state.
		}
	}

	private async writeMetadata(): Promise<void> {
		this.ensureConversationDirectory();
		const archive = this.cachedArchive ?? (await this.buildAiReadableArchive());
		this.cachedArchive = archive;
		const metadata: ConversationArchiveMetadata = {
			schemaVersion: 3,
			sessionId: this.sessionId,
			cwd: this.cwd,
			title: this.title,
			titleSource: this.titleSource,
			sessionFile: this.sessionFile,
			sessionMirrorFile: this.sessionMirrorFilePath(),
			rawEventsFile: this.rawEventsFilePath(),
			conversationFile: this.conversationFilePath(),
			createdAt: this.createdAt,
			updatedAt: new Date().toISOString(),
			recordsWritten: this.recordsWritten,
			lastRecordAt: archive.lastRecordAt,
			lastUserMessage: archive.latest.lastUserMessage,
			lastAssistantMessage: archive.latest.lastAssistantMessage,
			lastEventKind: archive.latest.lastEventKind,
			status: archive.status,
			conversationThinking: this.conversationThinking,
		};
		await writeFile(this.metadataFilePath(), JSON.stringify(metadata, null, "\t"), "utf-8").catch(() => {});
	}

	private async writeConversationSnapshot(): Promise<void> {
		const archive = this.cachedArchive ?? (await this.buildAiReadableArchive());
		this.cachedArchive = undefined;
		await writeFile(this.conversationFilePath(), JSON.stringify(archive, null, "\t"), "utf-8").catch(() => {});
	}

	private async buildAiReadableArchive(): Promise<AiReadableConversationArchive> {
		const records = await this.readRecords();
		const messages: AiReadableConversationArchive["messages"] = [];
		const thinking: AiReadableConversationArchive["thinking"] = [];
		const tools: AiReadableConversationArchive["tools"] = [];
		const confirmations: AiReadableConversationArchive["confirmations"] = [];
		const timeline: AiReadableConversationArchive["timeline"] = [];
		const steeringEntries: NonNullable<AiReadableConversationArchive["steeringEntries"]> = [];
		const eventKinds: Record<string, number> = {};
		let lastUserMessage: string | undefined;
		let lastAssistantMessage: string | undefined;
		let lastEventKind: string | undefined;
		let lastRecordAt: string | undefined;
		let toolCallCount = 0;
		let toolResultCount = 0;
		let confirmationCount = 0;
		let errorCount = 0;
		let previousSnapshotMessages: Array<{
			role: "user" | "assistant" | "system";
			text: string;
			timestamp?: number;
			tokenUsage?: MessageTokenUsageView;
			turnTokenUsage?: MessageTokenUsageView;
		}> = [];
		let directMessagesSinceSnapshot: Array<{ role: "user" | "assistant" | "system"; text: string }> = [];

		for (const record of records) {
			eventKinds[record.kind] = (eventKinds[record.kind] ?? 0) + 1;
			lastEventKind = record.kind;
			lastRecordAt = record.recordedAt;

			if (record.kind === "user_prompt_received") {
				const message = getStringField(record.payload, "message");
				if (message) {
					lastUserMessage = message;
					messages.push({
						role: "user",
						text: message,
						recordedAt: record.recordedAt,
						sourceKind: record.kind,
						sequence: record.sequence,
					});
					directMessagesSinceSnapshot.push({ role: "user", text: message });
				}
			}

			if (record.kind === "desktop_message") {
				const message = getDesktopMessage(record.payload);
				if (message) {
					messages.push({
						role: message.role,
						text: message.text,
						timestamp: message.timestamp,
						recordedAt: record.recordedAt,
						sourceKind: record.kind,
						sequence: record.sequence,
					});
					if (message.role === "user") lastUserMessage = message.text;
					if (message.role === "assistant") lastAssistantMessage = message.text;
					directMessagesSinceSnapshot.push({ role: message.role, text: message.text });
				}
			}

			if (record.kind === "desktop_assistant_event") {
				const eventType = getNestedStringField(record.payload, ["type"]);
				if (eventType === "snapshot") {
					const snapshotMessages = getSnapshotMessages(record.payload);
					const snapshotStartIndex = getSnapshotAppendStartIndex(previousSnapshotMessages, snapshotMessages);
					for (const item of snapshotMessages.slice(snapshotStartIndex)) {
						if (consumeMatchingDirectMessage(directMessagesSinceSnapshot, item)) {
							continue;
						}
						messages.push({
							role: item.role,
							text: item.text,
							timestamp: item.timestamp,
							recordedAt: record.recordedAt,
							sourceKind: `${record.kind}:snapshot`,
							sequence: record.sequence,
							tokenUsage: item.tokenUsage,
							turnTokenUsage: item.turnTokenUsage,
						});
						if (item.role === "user") lastUserMessage = item.text;
						if (item.role === "assistant") lastAssistantMessage = item.text;
					}
					previousSnapshotMessages = snapshotMessages;
					directMessagesSinceSnapshot = [];
				}
				if (eventType === "timeline") {
					// thinking_delta events are filtered from direct agent_event archiving
					// (see isStreamingDelta in handleSessionEvent) but arrive here via
					// pushTimeline() as thinking_summary timeline items.  Extract them so
					// conversation.thinking reflects actual reasoning even when streaming.
					const itemKind = getNestedStringField(record.payload, ["timelineItem", "kind"]);
					const itemDetail = getNestedStringField(record.payload, ["timelineItem", "detail"]);
					if (itemKind === "thinking_summary" && itemDetail) {
						thinking.push({
							sequence: record.sequence,
							recordedAt: record.recordedAt,
							delta: itemDetail,
						});
					}
					timeline.push({
						sequence: record.sequence,
						recordedAt: record.recordedAt,
						kind: "desktop_timeline",
						payload: record.payload,
					});
				}
				if (eventType === "error") {
					errorCount += 1;
				}
			}

			if (record.kind === "agent_event") {
				const eventType = getNestedStringField(record.payload, ["type"]);
				if (eventType === "message_update") {
					const assistantEventType = getNestedStringField(record.payload, ["assistantMessageEvent", "type"]);
					if (assistantEventType === "thinking_delta") {
						const delta = getNestedStringField(record.payload, ["assistantMessageEvent", "delta"]) ?? "";
						thinking.push({
							sequence: record.sequence,
							recordedAt: record.recordedAt,
							contentIndex: getNestedNumberField(record.payload, ["assistantMessageEvent", "contentIndex"]),
							delta,
						});
					}
				}
				if (eventType === "message_end") {
					const messageRole = getNestedStringField(record.payload, ["message", "role"]);
					if (messageRole === "assistant") {
						const assistantText = extractTextFromMessageObject(getNestedField(record.payload, ["message"]));
						if (assistantText) {
							lastAssistantMessage = assistantText;
							messages.push({
								role: "assistant",
								text: assistantText,
								recordedAt: record.recordedAt,
								sourceKind: `${record.kind}:message_end`,
								sequence: record.sequence,
								tokenUsage: extractMessageTokenUsage(getNestedField(record.payload, ["message"])),
							});
							directMessagesSinceSnapshot.push({ role: "assistant", text: assistantText });
						}
					}
				}
				if (eventType === "tool_execution_start") {
					toolCallCount += 1;
					tools.push({
						sequence: record.sequence,
						recordedAt: record.recordedAt,
						phase: "start",
						toolName: getNestedStringField(record.payload, ["toolName"]) ?? "unknown",
						toolCallId: getNestedStringField(record.payload, ["toolCallId"]),
						args: getNestedField(record.payload, ["args"]),
					});
				}
				if (eventType === "tool_execution_update") {
					tools.push({
						sequence: record.sequence,
						recordedAt: record.recordedAt,
						phase: "update",
						toolName: getNestedStringField(record.payload, ["toolName"]) ?? "unknown",
						toolCallId: getNestedStringField(record.payload, ["toolCallId"]),
						args: getNestedField(record.payload, ["args"]),
						result: getNestedField(record.payload, ["partialResult"]),
					});
				}
				if (eventType === "tool_execution_end") {
					toolResultCount += 1;
					if (getNestedBooleanField(record.payload, ["isError"])) {
						errorCount += 1;
					}
					tools.push({
						sequence: record.sequence,
						recordedAt: record.recordedAt,
						phase: "end",
						toolName: getNestedStringField(record.payload, ["toolName"]) ?? "unknown",
						toolCallId: getNestedStringField(record.payload, ["toolCallId"]),
						result: getNestedField(record.payload, ["result"]),
						isError: getNestedBooleanField(record.payload, ["isError"]),
					});
				}
				if (eventType === "agent_end") {
					const assistantText = extractLatestAssistantTextFromMessages(
						getNestedField(record.payload, ["messages"]),
					);
					const tokenUsage = extractAssistantTurnTokenUsage(getNestedField(record.payload, ["messages"]));
					if (assistantText) {
						const existingIndex = findCurrentTurnAssistantMessageIndex(messages, assistantText);
						if (existingIndex >= 0) {
							if (tokenUsage) {
								messages[existingIndex] = {
									...messages[existingIndex],
									turnTokenUsage: tokenUsage,
								};
							}
						} else {
							lastAssistantMessage = assistantText;
							messages.push({
								role: "assistant",
								text: assistantText,
								recordedAt: record.recordedAt,
								sourceKind: `${record.kind}:agent_end`,
								sequence: record.sequence,
								tokenUsage: extractLatestAssistantTokenUsage(getNestedField(record.payload, ["messages"])),
								turnTokenUsage: tokenUsage,
							});
							directMessagesSinceSnapshot.push({ role: "assistant", text: assistantText });
						}
					}
					timeline.push({
						sequence: record.sequence,
						recordedAt: record.recordedAt,
						kind: "agent_end",
						payload: record.payload,
					});
				}
			}

			if (record.kind === "steer_prompt_applied") {
				const id = getStringField(record.payload, "id");
				const text = getStringField(record.payload, "text");
				const appliedAt = getNestedNumberField(record.payload, ["appliedAt"]);
				const order = getNestedNumberField(record.payload, ["order"]);
				if (id && text && appliedAt !== undefined && order !== undefined) {
					steeringEntries.push({ id, text, appliedAt, order });
				}
			}

			if (record.kind.includes("confirmation")) {
				confirmationCount += 1;
				confirmations.push({
					sequence: record.sequence,
					recordedAt: record.recordedAt,
					kind: record.kind,
					intent:
						getNestedStringField(record.payload, ["confirmation", "intent"]) ??
						getNestedStringField(record.payload, ["intent"]),
					action:
						getNestedStringField(record.payload, ["confirmation", "action"]) ??
						getNestedStringField(record.payload, ["action"]),
					target:
						getNestedStringField(record.payload, ["confirmation", "target"]) ??
						getNestedStringField(record.payload, ["target"]),
					status: inferConfirmationStatus(record.kind),
				});
			}

			if (record.kind.includes("error") || record.kind === "service_error") {
				errorCount += 1;
			}
		}

		const dedupedMessages = dedupeArchiveMessages(messages).sort((a, b) => a.sequence - b.sequence);

		return {
			schemaVersion: 1,
			sessionId: this.sessionId,
			cwd: this.cwd,
			status: inferArchiveStatus(records),
			createdAt: this.createdAt,
			updatedAt: new Date().toISOString(),
			lastRecordAt,
			files: {
				metadata: this.metadataFilePath(),
				rawEvents: this.rawEventsFilePath(),
				sessionMirror: this.sessionMirrorFilePath(),
			},
			stats: {
				recordCount: records.length,
				messageCount: dedupedMessages.length,
				userMessageCount: dedupedMessages.filter((message) => message.role === "user").length,
				assistantMessageCount: dedupedMessages.filter((message) => message.role === "assistant").length,
				toolCallCount,
				toolResultCount,
				thinkingDeltaCount: thinking.length,
				confirmationCount,
				errorCount,
			},
			latest: {
				lastEventKind,
				lastUserMessage,
				lastAssistantMessage,
			},
			conversationThinking: this.conversationThinking,
			messages: dedupedMessages,
			thinking,
			tools,
			confirmations,
			timeline,
			steeringEntries: steeringEntries.length > 0 ? steeringEntries : undefined,
			eventKinds,
		};
	}

	private async readRecords(): Promise<ConversationArchiveRecord[]> {
		const path = this.rawEventsFilePath();
		if (!existsSync(path)) return [];
		try {
			const content = await readFile(path, "utf-8");
			return content
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.map((line) => JSON.parse(line) as ConversationArchiveRecord);
		} catch {
			return [];
		}
	}

	private conversationDirPath(): string {
		return join(this.coordinator.paths.conversationsDir, this.sessionId);
	}

	private rawEventsFilePath(): string {
		return join(this.conversationDirPath(), "events.jsonl");
	}

	private metadataFilePath(): string {
		return join(this.conversationDirPath(), "metadata.json");
	}

	private conversationFilePath(): string {
		return join(this.conversationDirPath(), "conversation.json");
	}

	private sessionMirrorFilePath(): string {
		return join(this.conversationDirPath(), "session.jsonl");
	}
}

/**
 * Backwards-compatible facade over ConversationArchiveCoordinator plus a
 * single "active" ConversationArchiveWriter. Switching sessions swaps the
 * writer; the old writer's buffered lines are flushed to its own files first,
 * so records can never leak into another session's archive.
 *
 * Multi-session callers should hold one ConversationArchiveWriter per live
 * session (via coordinator.createWriter) instead of using this facade.
 */
export class ConversationArchiveStore {
	private readonly coordinator: ConversationArchiveCoordinator;
	private writer: ConversationArchiveWriter;

	constructor(cwd: string, initialSessionId: string, initialSessionFile?: string, saveDir?: string) {
		this.coordinator = new ConversationArchiveCoordinator(cwd, saveDir);
		this.writer = this.coordinator.createWriter(initialSessionId, initialSessionFile);
		void this.writer.flushSnapshots();
		this.writer.syncSessionFileMirror();
	}

	get sessionDir(): string {
		return this.coordinator.paths.sessionsDir;
	}

	get indexFilePath(): string {
		return this.coordinator.paths.indexFile;
	}

	get conversationsDirPath(): string {
		return this.coordinator.paths.conversationsDir;
	}

	get archiveCoordinator(): ConversationArchiveCoordinator {
		return this.coordinator;
	}

	get activeWriter(): ConversationArchiveWriter {
		return this.writer;
	}

	setActiveSession(sessionId: string, sessionFile?: string, options?: { refreshSnapshots?: boolean }): void {
		const refreshSnapshots = options?.refreshSnapshots ?? true;
		// Flush the old writer's buffered lines into its own events file, but do
		// NOT regenerate its snapshots: matching the original single-writer
		// behavior, switching away must leave the old session's
		// conversation.json freshness untouched.
		this.writer.detach();
		this.writer = this.coordinator.createWriter(sessionId, sessionFile);
		if (refreshSnapshots) {
			void this.writer.flushSnapshots();
			this.writer.syncSessionFileMirror();
		}
	}

	write(kind: string, payload: unknown): void {
		this.writer.write(kind, payload);
	}

	syncSessionFileMirror(): void {
		this.writer.syncSessionFileMirror();
	}

	async flushSnapshots(): Promise<void> {
		await this.writer.flushSnapshots();
	}

	setConversationThinkingState(state: ConversationThinkingState): void {
		this.writer.setConversationThinkingState(state);
	}

	listConversationSummaries(): Promise<ConversationArchiveSummary[]> {
		return this.coordinator.listConversationSummaries();
	}

	getConversationMetadata(sessionId: string): ConversationArchiveMetadata | undefined {
		return this.coordinator.getConversationMetadata(sessionId);
	}

	deleteConversationArchive(sessionId: string): boolean {
		return this.coordinator.deleteConversationArchive(sessionId);
	}

	deleteSessionFile(sessionFile: string | undefined): boolean {
		return this.coordinator.deleteSessionFile(sessionFile);
	}

	listSessionFiles(): string[] {
		return this.coordinator.listSessionFiles();
	}

	deleteAllConversationArchives(): number {
		return this.coordinator.deleteAllConversationArchives();
	}
}

function normalizePayload(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value, payloadReplacer));
}

function payloadReplacer(_key: string, value: unknown): unknown {
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};
	}
	if (value instanceof Map) {
		return Object.fromEntries(value);
	}
	if (value instanceof Set) {
		return [...value];
	}
	return value;
}

function getNestedField(value: unknown, path: string[]): unknown {
	let current: unknown = value;
	for (const segment of path) {
		if (typeof current !== "object" || current === null || !(segment in current)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function getNestedStringField(value: unknown, path: string[]): string | undefined {
	const field = getNestedField(value, path);
	return typeof field === "string" ? field : undefined;
}

function getNestedNumberField(value: unknown, path: string[]): number | undefined {
	const field = getNestedField(value, path);
	return typeof field === "number" ? field : undefined;
}

function getNestedBooleanField(value: unknown, path: string[]): boolean | undefined {
	const field = getNestedField(value, path);
	return typeof field === "boolean" ? field : undefined;
}

function getStringField(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "string" ? field : undefined;
}

function getSnapshotMessages(value: unknown): Array<{
	role: "user" | "assistant" | "system";
	text: string;
	timestamp?: number;
	tokenUsage?: MessageTokenUsageView;
	turnTokenUsage?: MessageTokenUsageView;
}> {
	const snapshotMessages = getNestedField(value, ["snapshot", "messages"]);
	if (!Array.isArray(snapshotMessages)) return [];
	const messages: Array<{
		role: "user" | "assistant" | "system";
		text: string;
		timestamp?: number;
		tokenUsage?: MessageTokenUsageView;
		turnTokenUsage?: MessageTokenUsageView;
	}> = [];
	for (const message of snapshotMessages) {
		if (typeof message !== "object" || message === null) continue;
		const role = (message as Record<string, unknown>).role;
		const text = (message as Record<string, unknown>).text;
		const timestamp = (message as Record<string, unknown>).timestamp;
		if ((role === "user" || role === "assistant" || role === "system") && typeof text === "string") {
			const normalizedRole: "user" | "assistant" | "system" = role;
			messages.push({
				role: normalizedRole,
				text,
				timestamp: typeof timestamp === "number" ? timestamp : undefined,
				tokenUsage: parseTokenUsageView((message as Record<string, unknown>).tokenUsage),
				turnTokenUsage: parseTokenUsageView((message as Record<string, unknown>).turnTokenUsage),
			});
		}
	}
	return messages;
}

function getDesktopMessage(
	value: unknown,
): { role: "user" | "assistant" | "system"; text: string; timestamp?: number } | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const role = (value as Record<string, unknown>).role;
	const text = (value as Record<string, unknown>).text;
	const timestamp = (value as Record<string, unknown>).timestamp;
	if ((role === "user" || role === "assistant" || role === "system") && typeof text === "string") {
		return {
			role,
			text,
			timestamp: typeof timestamp === "number" ? timestamp : undefined,
		};
	}
	return undefined;
}

function extractTextFromMessageObject(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const content = (message as Record<string, unknown>).content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map((item) => {
			if (typeof item !== "object" || item === null) return "";
			const type = (item as Record<string, unknown>).type;
			if (type === "text") {
				return typeof (item as Record<string, unknown>).text === "string"
					? ((item as Record<string, unknown>).text as string)
					: "";
			}
			return "";
		})
		.join("")
		.trim();
	return text || undefined;
}

function extractLatestAssistantTextFromMessages(messages: unknown): string | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== "object" || message === null) continue;
		if ((message as Record<string, unknown>).role !== "assistant") continue;
		const text = extractTextFromMessageObject(message);
		if (text) return text;
	}
	return undefined;
}

function extractAssistantTurnTokenUsage(messages: unknown): MessageTokenUsageView | undefined {
	if (!Array.isArray(messages)) return undefined;
	let totalUsage: MessageTokenUsageView | undefined;
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		if ((message as Record<string, unknown>).role !== "assistant") continue;
		const usage = extractMessageTokenUsage(message);
		if (!usage) continue;
		totalUsage = addTokenUsage(totalUsage, usage);
	}
	return totalUsage;
}

function extractLatestAssistantTokenUsage(messages: unknown): MessageTokenUsageView | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== "object" || message === null) continue;
		if ((message as Record<string, unknown>).role !== "assistant") continue;
		const usage = extractMessageTokenUsage(message);
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

function extractMessageTokenUsage(message: unknown): MessageTokenUsageView | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const usage = (message as Record<string, unknown>).usage;
	return parseTokenUsageView(usage);
}

function parseTokenUsageView(value: unknown): MessageTokenUsageView | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const usage = value as Record<string, unknown>;
	const input = numberField(usage.input);
	const output = numberField(usage.output);
	const cacheRead = numberField(usage.cacheRead);
	const cacheWrite = numberField(usage.cacheWrite);
	const totalTokens = numberField(usage.totalTokens);
	const total = numberField(usage.total);
	if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) {
		return undefined;
	}
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: totalTokens ?? total ?? input + output + cacheRead + cacheWrite,
	};
}

function numberField(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function consumeMatchingDirectMessage(
	messages: Array<{ role: "user" | "assistant" | "system"; text: string }>,
	item: { role: "user" | "assistant" | "system"; text: string },
): boolean {
	const index = messages.findIndex((message) => message.role === item.role && message.text === item.text);
	if (index < 0) return false;
	messages.splice(index, 1);
	return true;
}

function findCurrentTurnAssistantMessageIndex(
	messages: Array<{ role: "user" | "assistant" | "system"; text: string }>,
	text: string,
): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "user") return -1;
		if (message.role === "assistant" && message.text === text) return index;
	}
	return -1;
}

function dedupeArchiveMessages(
	messages: AiReadableConversationArchive["messages"],
): AiReadableConversationArchive["messages"] {
	const directMessageCounts = new Map<string, number>();
	for (const message of messages) {
		if (!isSnapshotMessage(message)) {
			incrementCount(directMessageCounts, archiveMessageKey(message));
		}
	}

	const seenSnapshotSystemMessages = new Set<string>();
	return messages.filter((message) => {
		if (!isSnapshotMessage(message)) return true;
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

function isSnapshotMessage(message: AiReadableConversationArchive["messages"][number]): boolean {
	return message.sourceKind.includes(":snapshot");
}

function archiveMessageKey(message: { role: "user" | "assistant" | "system"; text: string }): string {
	return `${message.role}\u0000${message.text}`;
}

function incrementCount(counts: Map<string, number>, key: string): void {
	counts.set(key, (counts.get(key) ?? 0) + 1);
}

function getSnapshotAppendStartIndex(
	previousSnapshotMessages: Array<{ role: "user" | "assistant" | "system"; text: string; timestamp?: number }>,
	currentSnapshotMessages: Array<{ role: "user" | "assistant" | "system"; text: string; timestamp?: number }>,
): number {
	const sharedLength = Math.min(previousSnapshotMessages.length, currentSnapshotMessages.length);
	let prefixLength = 0;
	while (prefixLength < sharedLength) {
		const previous = previousSnapshotMessages[prefixLength];
		const current = currentSnapshotMessages[prefixLength];
		if (previous.role !== current.role || previous.text !== current.text) {
			break;
		}
		prefixLength += 1;
	}
	return prefixLength;
}

function inferArchiveStatus(records: ConversationArchiveRecord[]): "active" | "idle" {
	for (let index = records.length - 1; index >= 0; index -= 1) {
		const record = records[index];
		if (record.kind === "busy_state_changed") {
			const isBusy = getNestedBooleanField(record.payload, ["isBusy"]);
			return isBusy ? "active" : "idle";
		}
	}
	return "idle";
}

function inferConfirmationStatus(kind: string): string | undefined {
	if (kind === "confirmation_approved") return "approved";
	if (kind === "confirmation_rejected") return "rejected";
	if (kind === "approval_continuation_prompt") return "continued";
	return undefined;
}

function readConversationDirectories(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readDirectoryNames(dir, "directory");
}

function readSessionJsonlFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readDirectoryNames(dir, "file")
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(dir, name));
}

function readDirectoryNames(dir: string, type: "directory" | "file"): string[] {
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		return entries
			.filter((entry) => (type === "directory" ? entry.isDirectory() : entry.isFile()))
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

const ARCHIVE_README_CONTENT = `# Conversation Archive

This folder contains backend conversation archives optimized for programmatic AI reading.

## Read Order

1. Read \`index.json\` first.
2. Choose the target conversation by \`sessionId\`, recency, or \`lastUserMessage\`.
3. Read that conversation's \`conversation.json\` for an AI-friendly summary.
4. Only if needed, read the raw \`events.jsonl\` and \`session.jsonl\` for low-level debugging.

## Files

- \`index.json\`
  - Global index of all archived conversations.
  - Best entry point for another AI agent.
- \`conversations/<sessionId>/conversation.json\`
  - AI-friendly structured archive for one conversation.
  - Includes messages, thinking deltas, tool events, confirmation flow, and summary stats.
- \`conversations/<sessionId>/metadata.json\`
  - Lightweight metadata and file paths for the conversation.
- \`conversations/<sessionId>/events.jsonl\`
  - Raw append-only backend archive stream.
- \`conversations/<sessionId>/session.jsonl\`
  - Mirror of the persisted agent session file.

## AI-Friendly Fields

### index.json

- \`conversations[].sessionId\`
- \`conversations[].updatedAt\`
- \`conversations[].status\`
- \`conversations[].lastUserMessage\`
- \`conversations[].lastAssistantMessage\`
- \`conversations[].conversationFile\`

### conversation.json

- \`stats\`
  - Counts for messages, tools, thinking deltas, confirmations, and errors.
- \`latest\`
  - Last event kind and latest user/assistant messages.
- \`messages\`
  - Flattened readable chat history.
- \`thinking\`
  - Captured reasoning/thinking deltas actually emitted by the runtime.
- \`tools\`
  - Structured tool start/update/end events.
- \`confirmations\`
  - Approval and rejection flow.
- \`eventKinds\`
  - Frequency map for all backend archive record kinds.

## Notes

- \`conversation.json\` is intended for direct machine consumption.
- \`events.jsonl\` remains the source of truth for full-fidelity forensic debugging.
- If the underlying model/runtime does not emit hidden reasoning, it cannot be recovered. Only emitted thinking deltas are archived.
`;
