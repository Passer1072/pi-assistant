import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type {
	AiReadableConversationArchive,
	ConversationArchiveIndex,
	ConversationArchiveMetadata,
	ConversationArchiveRecord,
} from "../src/agent/conversation-archive.ts";
import { ConversationArchiveCoordinator, getConversationArchivePaths } from "../src/agent/conversation-archive.ts";
import { DesktopAgentService } from "../src/agent/desktop-agent-service.ts";
import { DryRunDesktopAutomationHost } from "../src/desktop/automation-host.ts";

describe("conversation archive", () => {
	it("initializes AI-readable archive files under the save directory", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});

			await service.initialize();

			const snapshot = service.snapshot();
			const paths = getConversationArchivePaths(workspace.cwd);
			const conversationDir = join(paths.conversationsDir, snapshot.sessionId);
			const metadataPath = join(conversationDir, "metadata.json");
			const conversationPath = join(conversationDir, "conversation.json");

			expect(existsSync(paths.saveDir)).toBe(true);
			expect(existsSync(paths.indexFile)).toBe(true);
			expect(existsSync(paths.readmeFile)).toBe(true);
			expect(existsSync(metadataPath)).toBe(true);
			expect(existsSync(conversationPath)).toBe(true);

			const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as ConversationArchiveMetadata;
			expect(metadata.sessionId).toBe(snapshot.sessionId);
			expect(metadata.sessionMirrorFile).toBe(join(conversationDir, "session.jsonl"));
			expect(metadata.rawEventsFile).toBe(join(conversationDir, "events.jsonl"));
			expect(metadata.conversationFile).toBe(conversationPath);

			const conversation = JSON.parse(readFileSync(conversationPath, "utf-8")) as AiReadableConversationArchive;
			expect(conversation.sessionId).toBe(snapshot.sessionId);
			expect(conversation.files.metadata).toBe(metadataPath);
			expect(conversation.files.rawEvents).toBe(join(conversationDir, "events.jsonl"));
			expect(conversation.stats.recordCount).toBeGreaterThan(0);
		} finally {
			workspace.cleanup();
		}
	});

	it("builds an AI-friendly conversation summary from prompt and backend events", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});
			const internal = service as unknown as {
				sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
				bindSession(session: {
					sessionId: string;
					sessionFile?: string;
					sessionName?: string;
					prompt(message: string, options?: unknown): Promise<void>;
					subscribe(listener: (event: unknown) => void): () => void;
				}): void;
				handleSessionEvent(event: unknown): void;
			};
			const sessionId = internal.sessionManager.getSessionId();
			const sessionFile = internal.sessionManager.getSessionFile();

			internal.bindSession({
				sessionId,
				sessionFile,
				sessionName: "archive-test",
				prompt: async () => {},
				subscribe: () => () => {},
			});

			await service.prompt("hello archive");
			internal.handleSessionEvent({
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "Inspecting request",
				},
			});
			internal.handleSessionEvent({
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "open_app",
				args: { app: "notepad.exe" },
			});
			internal.handleSessionEvent({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "open_app",
				result: { ok: true },
				isError: false,
			});
			// Flush async archive writes triggered by handleSessionEvent() calls above.
			await service.drainArchive();

			const conversation = readConversationArchive(workspace.cwd, sessionId);
			expect(conversation.latest.lastUserMessage).toBe("hello archive");
			expect(
				conversation.messages.some((message) => message.role === "user" && message.text === "hello archive"),
			).toBe(true);
			expect(conversation.thinking.some((item) => item.delta === "Inspecting request")).toBe(true);
			expect(conversation.tools.some((tool) => tool.toolName === "open_app" && tool.phase === "start")).toBe(true);
			expect(conversation.tools.some((tool) => tool.toolName === "open_app" && tool.phase === "end")).toBe(true);
			expect(conversation.eventKinds.user_prompt_received).toBeGreaterThan(0);
			expect(conversation.eventKinds.agent_event).toBeGreaterThan(0);
		} finally {
			workspace.cleanup();
		}
	});

	it("injects attachment snapshots into the model prompt without showing them in the user bubble", async () => {
		const workspace = createTempWorkspace();
		try {
			const attachmentPath = join(workspace.cwd, "context.md");
			writeFileSync(attachmentPath, "# Context\n\nImportant formatting note.", "utf-8");
			const prompts: string[] = [];
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});
			const internal = service as unknown as {
				sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
				bindSession(session: {
					sessionId: string;
					sessionFile?: string;
					sessionName?: string;
					prompt(message: string, options?: unknown): Promise<void>;
					subscribe(listener: (event: unknown) => void): () => void;
				}): void;
			};

			internal.bindSession({
				sessionId: internal.sessionManager.getSessionId(),
				sessionFile: internal.sessionManager.getSessionFile(),
				sessionName: "attachment-test",
				prompt: async (message) => {
					prompts.push(message);
				},
				subscribe: () => () => {},
			});

			await service.prompt("summarize this", "text", [
				{
					id: "attachment-1",
					name: "context.md",
					path: attachmentPath,
					sizeBytes: 36,
					kind: "text",
				},
			]);

			expect(prompts.at(-1)).toContain('<attachments count="1">');
			expect(prompts.at(-1)).toContain("# Context");
			expect(service.snapshot().messages.at(-1)?.text).toBe("summarize this");
		} finally {
			workspace.cleanup();
		}
	});

	it("mirrors the persisted session file and exposes the archive through the global index", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});

			await service.initialize();

			const internal = service as unknown as {
				sessionManager: { appendMessage(message: AssistantMessage): string };
				handleSessionEvent(event: unknown): void;
			};
			const snapshot = service.snapshot();
			const assistantMessage = createAssistantMessage("archived assistant reply");

			internal.sessionManager.appendMessage(assistantMessage);
			internal.handleSessionEvent({ type: "message_end", message: assistantMessage });
			// Flush async archive writes (mirror copy + snapshot) before reading files.
			await service.drainArchive();

			const paths = getConversationArchivePaths(workspace.cwd);
			const sessionMirrorPath = join(paths.conversationsDir, snapshot.sessionId, "session.jsonl");
			expect(existsSync(sessionMirrorPath)).toBe(true);
			expect(readFileSync(sessionMirrorPath, "utf-8")).toContain("archived assistant reply");

			const index = JSON.parse(readFileSync(paths.indexFile, "utf-8")) as ConversationArchiveIndex;
			const entry = index.conversations.find((conversation) => conversation.sessionId === snapshot.sessionId);
			expect(entry).toBeDefined();
			expect(entry?.conversationFile).toBe(join(paths.conversationsDir, snapshot.sessionId, "conversation.json"));
		} finally {
			workspace.cleanup();
		}
	});

	it("preserves assistant token usage in snapshots and the readable archive", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});

			await service.initialize();
			const internal = service as unknown as {
				sessionManager: { appendMessage(message: AssistantMessage): string };
				handleSessionEvent(event: unknown): void;
			};
			const snapshot = service.snapshot();
			const assistantMessage = createAssistantMessage("token counted", {
				input: 100,
				output: 25,
				cacheRead: 10,
				cacheWrite: 5,
				totalTokens: 140,
			});

			internal.sessionManager.appendMessage(assistantMessage);
			internal.handleSessionEvent({ type: "message_end", message: assistantMessage });
			await service.drainArchive();

			expect(service.snapshot().contextUsage?.contextWindow).toBeGreaterThan(0);
			expect(service.snapshot().messages.at(-1)?.tokenUsage).toMatchObject({
				total: 140,
				input: 100,
				output: 25,
			});

			const paths = getConversationArchivePaths(workspace.cwd);
			const conversation = JSON.parse(
				readFileSync(join(paths.conversationsDir, snapshot.sessionId, "conversation.json"), "utf-8"),
			) as AiReadableConversationArchive;
			expect(conversation.messages.at(-1)?.tokenUsage).toMatchObject({
				total: 140,
				cacheRead: 10,
				cacheWrite: 5,
			});
		} finally {
			workspace.cleanup();
		}
	});

	it("shows full turn token usage on the final assistant reply", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});
			const internal = service as unknown as {
				handleSessionEvent(event: unknown): void;
			};

			await service.initialize();
			const hiddenToolPlanning = createAssistantMessage("", {
				input: 80,
				output: 8,
				cacheRead: 6,
				cacheWrite: 4,
				totalTokens: 98,
			});
			const finalReply = createAssistantMessage("最终回答", {
				input: 120,
				output: 30,
				cacheRead: 10,
				cacheWrite: 2,
				totalTokens: 162,
			});

			internal.handleSessionEvent({ type: "message_end", message: hiddenToolPlanning });
			internal.handleSessionEvent({ type: "message_end", message: finalReply });
			internal.handleSessionEvent({
				type: "agent_end",
				messages: [hiddenToolPlanning, finalReply],
				willRetry: false,
			});

			const finalMessage = service.snapshot().messages.at(-1);
			expect(finalMessage?.text).toBe("最终回答");
			expect(finalMessage?.tokenUsage).toMatchObject({
				input: 120,
				output: 30,
				cacheRead: 10,
				cacheWrite: 2,
				total: 162,
			});
			expect(finalMessage?.turnTokenUsage).toMatchObject({
				input: 200,
				output: 38,
				cacheRead: 16,
				cacheWrite: 6,
				total: 260,
			});
		} finally {
			workspace.cleanup();
		}
	});

	it("preserves full turn token usage in archives and resumed history", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});

			await service.initialize();
			const sessionId = service.snapshot().sessionId;
			const hiddenToolPlanning = createAssistantMessage("", {
				input: 50,
				output: 5,
				cacheRead: 7,
				cacheWrite: 3,
				totalTokens: 65,
			});
			const finalReply = createAssistantMessage("带工具的最终回答", {
				input: 100,
				output: 25,
				cacheRead: 11,
				cacheWrite: 4,
				totalTokens: 140,
			});
			writeArchiveRecords(workspace.cwd, sessionId, [
				createArchiveRecord(sessionId, 1, "user_prompt_received", { message: "run a tool" }),
				createArchiveRecord(sessionId, 2, "agent_event", {
					type: "message_end",
					message: hiddenToolPlanning,
				}),
				createArchiveRecord(sessionId, 3, "agent_event", {
					type: "message_end",
					message: finalReply,
				}),
				createArchiveRecord(sessionId, 4, "agent_event", {
					type: "agent_end",
					messages: [hiddenToolPlanning, finalReply],
				}),
			]);
			ensureArchivedSessionFile(workspace.cwd, sessionId);
			await service.drainArchive();

			const archive = readConversationArchive(workspace.cwd, sessionId);
			expect(archive.messages.at(-1)?.tokenUsage).toMatchObject({
				input: 100,
				output: 25,
				cacheRead: 11,
				cacheWrite: 4,
				total: 140,
			});
			expect(archive.messages.at(-1)?.turnTokenUsage).toMatchObject({
				input: 150,
				output: 30,
				cacheRead: 18,
				cacheWrite: 7,
				total: 205,
			});

			await service.newConversation();
			const resumed = await service.resumeConversation(sessionId);
			expect(resumed.messages.at(-1)?.tokenUsage).toMatchObject({
				input: 100,
				output: 25,
				cacheRead: 11,
				cacheWrite: 4,
				total: 140,
			});
			expect(resumed.messages.at(-1)?.turnTokenUsage).toMatchObject({
				input: 150,
				output: 30,
				cacheRead: 18,
				cacheWrite: 7,
				total: 205,
			});
		} finally {
			workspace.cleanup();
		}
	});

	it("creates a fresh archive directory and index entry for each new conversation", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});

			await service.initialize();
			const firstSessionId = service.snapshot().sessionId;

			await service.newConversation();
			await service.drainArchive();
			const secondSessionId = service.snapshot().sessionId;
			const paths = getConversationArchivePaths(workspace.cwd);
			const index = JSON.parse(readFileSync(paths.indexFile, "utf-8")) as ConversationArchiveIndex;

			expect(secondSessionId).not.toBe(firstSessionId);
			expect(existsSync(join(paths.conversationsDir, firstSessionId, "conversation.json"))).toBe(true);
			expect(existsSync(join(paths.conversationsDir, secondSessionId, "conversation.json"))).toBe(true);
			expect(index.conversations.some((conversation) => conversation.sessionId === firstSessionId)).toBe(true);
			expect(index.conversations.some((conversation) => conversation.sessionId === secondSessionId)).toBe(true);
		} finally {
			workspace.cleanup();
		}
	});

	it("persists conversation thinking state in metadata and restores it on resume", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});

			await service.initialize();
			const sessionId = service.snapshot().sessionId;
			await service.updateConversationThinking(false);
			await service.drainArchive();

			const metadataPath = join(
				getConversationArchivePaths(workspace.cwd).conversationsDir,
				sessionId,
				"metadata.json",
			);
			const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as ConversationArchiveMetadata;
			expect(metadata.conversationThinking).toMatchObject({
				enabled: false,
				effectiveLevel: "off",
			});

			ensureArchivedSessionFile(workspace.cwd, sessionId);
			await service.newConversation();
			const resumed = await service.resumeConversation(sessionId);
			expect(resumed.conversationThinking).toMatchObject({
				enabled: false,
				effectiveLevel: "off",
			});
		} finally {
			workspace.cleanup();
		}
	});

	it("falls back to settings defaults when archived metadata predates conversation thinking", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
				settings: { thinkingLevel: "medium" },
			});

			await service.initialize();
			const sessionId = service.snapshot().sessionId;
			await service.drainArchive();

			const metadataPath = join(
				getConversationArchivePaths(workspace.cwd).conversationsDir,
				sessionId,
				"metadata.json",
			);
			const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as ConversationArchiveMetadata & {
				conversationThinking?: unknown;
			};
			delete metadata.conversationThinking;
			writeFileSync(metadataPath, JSON.stringify(metadata, null, "\t"), "utf-8");

			ensureArchivedSessionFile(workspace.cwd, sessionId);
			await service.newConversation();
			const resumed = await service.resumeConversation(sessionId);
			expect(resumed.conversationThinking).toMatchObject({
				enabled: true,
				effectiveLevel: "medium",
			});
		} finally {
			workspace.cleanup();
		}
	});

	it("lists history, resumes a historical session, and continues on that same session", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});
			const internal = service as unknown as {
				sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
				session?: {
					sessionId: string;
					sessionFile?: string;
					sessionManager: { appendMessage(message: AssistantMessage): string };
				};
				handleSessionEvent(event: unknown): void;
			};

			await service.initialize();
			const sessionA = internal.sessionManager.getSessionId();
			internal.session?.sessionManager.appendMessage(createAssistantMessage("reply A"));
			internal.handleSessionEvent({
				type: "message_end",
				message: createAssistantMessage("reply A"),
			});
			await service.drainArchive();

			await service.newConversation();
			const sessionB = service.snapshot().sessionId;
			internal.session?.sessionManager.appendMessage(createAssistantMessage("reply B"));
			internal.handleSessionEvent({
				type: "message_end",
				message: createAssistantMessage("reply B"),
			});
			await service.drainArchive();

			const beforeResume = await service.listConversationHistory();
			expect(beforeResume.conversations.map((item) => item.sessionId)).toContain(sessionA);
			expect(beforeResume.conversations.map((item) => item.sessionId)).toContain(sessionB);

			const resumed = await service.resumeConversation(sessionA);
			expect(resumed.sessionId).toBe(sessionA);
			expect(resumed.messages.some((message) => message.text.includes("reply A"))).toBe(true);

			const archive = readConversationArchive(workspace.cwd, sessionA);
			expect(archive.messages.some((message) => message.role === "assistant" && message.text === "reply A")).toBe(
				true,
			);
		} finally {
			workspace.cleanup();
		}
	});

	it("lists archived conversations even when metadata preview fields are missing", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});
			const internal = service as unknown as {
				session?: {
					sessionId: string;
					sessionManager: { appendMessage(message: AssistantMessage): string };
				};
				handleSessionEvent(event: unknown): void;
			};

			await service.initialize();
			const sessionId = service.snapshot().sessionId;
			internal.session?.sessionManager.appendMessage(createAssistantMessage("history preview fallback reply"));
			internal.handleSessionEvent({
				type: "message_end",
				message: createAssistantMessage("history preview fallback reply"),
			});
			await service.drainArchive();

			const metadataPath = join(
				getConversationArchivePaths(workspace.cwd).conversationsDir,
				sessionId,
				"metadata.json",
			);
			const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as ConversationArchiveMetadata;
			delete metadata.lastUserMessage;
			delete metadata.lastAssistantMessage;
			metadata.updatedAt = new Date().toISOString();
			writeFileSync(metadataPath, JSON.stringify(metadata, null, "\t"), "utf-8");

			const history = await service.listConversationHistory();
			expect(history.conversations).toHaveLength(1);
			expect(history.conversations[0]?.sessionId).toBe(sessionId);
			expect(history.conversations[0]?.preview).toContain("history preview fallback reply");
		} finally {
			workspace.cleanup();
		}
	});

	it("recovers history and new conversation flows when focused context is orphaned", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});
			const internal = service as unknown as {
				focusedKey: string;
				session?: {
					sessionId: string;
					sessionManager: { appendMessage(message: AssistantMessage): string };
				};
				handleSessionEvent(event: unknown): void;
			};

			await service.initialize();
			const originalSessionId = service.snapshot().sessionId;
			internal.session?.sessionManager.appendMessage(createAssistantMessage("orphan recovery reply"));
			internal.handleSessionEvent({
				type: "message_end",
				message: createAssistantMessage("orphan recovery reply"),
			});
			await service.drainArchive();

			internal.focusedKey = "";

			const history = await service.listConversationHistory();
			expect(history.conversations.map((entry) => entry.sessionId)).toContain(originalSessionId);

			const snapshot = await service.newConversation();
			expect(snapshot.sessionId).not.toBe(originalSessionId);
			expect(service.listSessions().focusedSessionId).toBe(snapshot.sessionId);
		} finally {
			workspace.cleanup();
		}
	});

	it("deletes archives and session files for a single conversation and clear-all preserves only a fresh active session", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});
			const internal = service as unknown as {
				sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
				session?: {
					sessionId: string;
					sessionFile?: string;
					sessionManager: { appendMessage(message: AssistantMessage): string };
				};
				handleSessionEvent(event: unknown): void;
			};

			await service.initialize();
			const firstSessionId = service.snapshot().sessionId;
			internal.session?.sessionManager.appendMessage(createAssistantMessage("first reply"));
			internal.handleSessionEvent({
				type: "message_end",
				message: createAssistantMessage("first reply"),
			});
			await service.drainArchive();

			await service.newConversation();
			const secondSessionId = service.snapshot().sessionId;
			internal.session?.sessionManager.appendMessage(createAssistantMessage("second reply"));
			internal.handleSessionEvent({
				type: "message_end",
				message: createAssistantMessage("second reply"),
			});
			await service.drainArchive();

			const deleteResult = await service.deleteConversation(firstSessionId);
			expect(deleteResult.deletedSessionId).toBe(firstSessionId);
			expect(deleteResult.activeSessionId).toBe(secondSessionId);
			expect(existsSync(join(getConversationArchivePaths(workspace.cwd).conversationsDir, firstSessionId))).toBe(
				false,
			);
			expect(readIndex(workspace.cwd).conversations.some((entry) => entry.sessionId === firstSessionId)).toBe(false);

			const cleared = await service.clearConversationHistory();
			expect(cleared.activeSessionId).not.toBe(secondSessionId);
			expect(existsSync(join(getConversationArchivePaths(workspace.cwd).conversationsDir, secondSessionId))).toBe(
				false,
			);
			expect(service.snapshot().sessionId).toBe(cleared.activeSessionId);
			const history = await service.listConversationHistory();
			expect(history.conversations).toEqual([]);
		} finally {
			workspace.cleanup();
		}
	});

	it("restores historical order from events.jsonl instead of summary timestamps", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});

			await service.initialize();
			const originalSessionId = service.snapshot().sessionId;
			writeArchiveRecords(workspace.cwd, originalSessionId, [
				createArchiveRecord(originalSessionId, 1, "user_prompt_received", {
					message: "open notepad",
				}),
				createArchiveRecord(originalSessionId, 2, "agent_event", {
					type: "tool_execution_start",
					toolCallId: "tool-1",
					toolName: "open_app",
					args: { app: "notepad.exe" },
				}),
				createArchiveRecord(originalSessionId, 3, "agent_event", {
					type: "tool_execution_end",
					toolCallId: "tool-1",
					toolName: "open_app",
					result: { ok: true },
					isError: false,
				}),
				createArchiveRecord(originalSessionId, 4, "agent_event", {
					type: "message_end",
					message: createAssistantMessage("notepad opened"),
				}),
			]);
			ensureArchivedSessionFile(workspace.cwd, originalSessionId);

			await service.newConversation();
			const resumed = await service.resumeConversation(originalSessionId);

			expect(resumed.messages.map((message) => `${message.order}:${message.role}:${message.text}`)).toEqual([
				"1:user:open notepad",
				"4:assistant:notepad opened",
			]);
			expect(resumed.timeline.map((item) => `${item.order}:${item.title}`)).toEqual(["3:Tool finished: open_app"]);
		} finally {
			workspace.cleanup();
		}
	});

	it("resumes from conversation.json as a recent window when the snapshot is fresh", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});

			await service.initialize();
			const sessionId = service.snapshot().sessionId;
			const records = Array.from({ length: 80 }, (_, index) =>
				createArchiveRecord(sessionId, index + 1, index % 2 === 0 ? "user_prompt_received" : "agent_event", {
					...(index % 2 === 0
						? { message: `request ${index + 1}` }
						: { type: "message_end", message: createAssistantMessage(`reply ${index + 1}`) }),
				}),
			);
			writeArchiveRecords(workspace.cwd, sessionId, records);
			ensureArchivedSessionFile(workspace.cwd, sessionId);
			await service.drainArchive();

			await service.newConversation();
			const resumed = await service.resumeConversation(sessionId);

			expect(resumed.historyWindow).toMatchObject({
				sessionId,
				hasMoreBefore: true,
				loadedFrom: "conversation",
			});
			expect(resumed.messages).toHaveLength(30);
			expect(resumed.messages[0]?.order).toBe(51);
			expect(resumed.messages.at(-1)?.order).toBe(80);
		} finally {
			workspace.cleanup();
		}
	});

	it("does not duplicate messages that were already captured before snapshot archive events", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});

			await service.initialize();
			const sessionId = service.snapshot().sessionId;
			writeArchiveRecords(workspace.cwd, sessionId, [
				createArchiveRecord(sessionId, 1, "user_prompt_received", { message: "hello" }),
				createArchiveRecord(sessionId, 2, "agent_event", {
					type: "message_end",
					message: createAssistantMessage("hello reply"),
				}),
				createArchiveRecord(sessionId, 3, "desktop_assistant_event", {
					type: "snapshot",
					snapshot: {
						messages: [
							{ role: "user", text: "hello", timestamp: 1 },
							{ role: "assistant", text: "hello reply", timestamp: 2 },
						],
					},
				}),
				createArchiveRecord(sessionId, 4, "desktop_assistant_event", {
					type: "snapshot",
					snapshot: {
						messages: [
							{ role: "user", text: "hello", timestamp: 1 },
							{ role: "assistant", text: "hello reply", timestamp: 2 },
							{ role: "user", text: "hello", timestamp: 3 },
							{ role: "assistant", text: "hello reply", timestamp: 4 },
						],
					},
				}),
			]);
			ensureArchivedSessionFile(workspace.cwd, sessionId);
			await service.drainArchive();

			const archive = readConversationArchive(workspace.cwd, sessionId);
			expect(archive.messages.map((message) => `${message.role}:${message.text}`)).toEqual([
				"user:hello",
				"assistant:hello reply",
			]);

			await service.newConversation();
			const resumed = await service.resumeConversation(sessionId);
			expect(resumed.messages.map((message) => `${message.role}:${message.text}`)).toEqual([
				"user:hello",
				"assistant:hello reply",
			]);
		} finally {
			workspace.cleanup();
		}
	});

	it("keeps history resume idempotent instead of appending restored messages back into the archive", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});

			await service.initialize();
			const sessionId = service.snapshot().sessionId;
			writeArchiveRecords(workspace.cwd, sessionId, [
				createArchiveRecord(sessionId, 1, "user_prompt_received", { message: "你好" }),
				createArchiveRecord(sessionId, 2, "agent_event", {
					type: "message_end",
					message: createAssistantMessage("你好！有什么我可以帮你的吗？"),
				}),
			]);
			ensureArchivedSessionFile(workspace.cwd, sessionId);
			await service.drainArchive();

			for (let index = 0; index < 3; index += 1) {
				await service.newConversation();
				const resumed = await service.resumeConversation(sessionId);
				expect(resumed.messages.map((message) => `${message.role}:${message.text}`)).toEqual([
					"user:你好",
					"assistant:你好！有什么我可以帮你的吗？",
				]);

				const archive = readConversationArchive(workspace.cwd, sessionId);
				expect(archive.messages.map((message) => `${message.role}:${message.text}`)).toEqual([
					"user:你好",
					"assistant:你好！有什么我可以帮你的吗？",
				]);

				const history = await service.listConversationHistory();
				const historyEntry = history.conversations.find((conversation) => conversation.sessionId === sessionId);
				expect(historyEntry?.messageCount).toBe(2);
			}

			const records = readArchiveRecords(workspace.cwd, sessionId);
			expect(records.map((record) => record.kind)).toEqual(["user_prompt_received", "agent_event"]);
			expect(
				records.some(
					(record) =>
						record.kind === "desktop_assistant_event" &&
						typeof record.payload === "object" &&
						record.payload !== null &&
						(record.payload as { type?: unknown }).type === "snapshot",
				),
			).toBe(false);
		} finally {
			workspace.cleanup();
		}
	});

	it("keeps repeated user messages that are separate real prompts", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});

			await service.initialize();
			const sessionId = service.snapshot().sessionId;
			writeArchiveRecords(workspace.cwd, sessionId, [
				createArchiveRecord(sessionId, 1, "user_prompt_received", { message: "same question" }),
				createArchiveRecord(sessionId, 2, "user_prompt_received", { message: "same question" }),
			]);
			ensureArchivedSessionFile(workspace.cwd, sessionId);

			await service.newConversation();
			const resumed = await service.resumeConversation(sessionId);

			expect(resumed.messages.map((message) => `${message.order}:${message.role}:${message.text}`)).toEqual([
				"1:user:same question",
				"2:user:same question",
			]);
		} finally {
			workspace.cleanup();
		}
	});

	it("restores final assistant text from agent_end when no assistant message_end was emitted", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});

			await service.initialize();
			const sessionId = service.snapshot().sessionId;
			writeArchiveRecords(workspace.cwd, sessionId, [
				createArchiveRecord(sessionId, 1, "user_prompt_received", { message: "search news" }),
				createArchiveRecord(sessionId, 2, "agent_event", {
					type: "tool_execution_end",
					toolCallId: "tool-1",
					toolName: "web_search",
					result: { details: { status: "failed", stderr: "fetch failed" } },
					isError: false,
				}),
				createArchiveRecord(sessionId, 3, "agent_event", {
					type: "agent_end",
					messages: [createAssistantMessage("网络搜索失败，暂时无法获取新闻。")],
				}),
			]);
			ensureArchivedSessionFile(workspace.cwd, sessionId);
			await service.drainArchive();

			const archive = readConversationArchive(workspace.cwd, sessionId);
			expect(archive.messages.map((message) => `${message.role}:${message.text}`)).toContain(
				"assistant:网络搜索失败，暂时无法获取新闻。",
			);

			await service.newConversation();
			const resumed = await service.resumeConversation(sessionId);
			expect(resumed.messages.map((message) => `${message.role}:${message.text}`)).toContain(
				"assistant:网络搜索失败，暂时无法获取新闻。",
			);
		} finally {
			workspace.cleanup();
		}
	});

	it("shows final assistant text from live agent_end events when message_end is missing", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});
			const internal = service as unknown as {
				handleSessionEvent(event: unknown): void;
			};

			await service.initialize();
			internal.handleSessionEvent({
				type: "agent_end",
				messages: [createAssistantMessage("最终回答")],
			});

			expect(service.snapshot().messages.map((message) => message.text)).toContain("最终回答");
		} finally {
			workspace.cleanup();
		}
	});

	it("falls back to events.jsonl when conversation.json is stale and pages earlier history", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});

			await service.initialize();
			const sessionId = service.snapshot().sessionId;
			writeArchiveRecords(
				workspace.cwd,
				sessionId,
				Array.from({ length: 40 }, (_, index) =>
					createArchiveRecord(sessionId, index + 1, "user_prompt_received", { message: `request ${index + 1}` }),
				),
			);
			ensureArchivedSessionFile(workspace.cwd, sessionId);

			await service.newConversation();
			const resumed = await service.resumeConversation(sessionId);
			const page = service.loadConversationPage({
				sessionId,
				beforeOrder: resumed.historyWindow?.oldestOrder,
				limit: 10,
			});

			expect(resumed.historyWindow?.loadedFrom).toBe("events");
			expect(resumed.messages.map((message) => message.order)).toEqual(
				Array.from({ length: 30 }, (_, index) => index + 11),
			);
			expect(page.loadedFrom).toBe("events");
			expect(page.messages.map((message) => message.order)).toEqual(
				Array.from({ length: 10 }, (_, index) => index + 1),
			);
			expect(page.hasMoreBefore).toBe(false);
		} finally {
			workspace.cleanup();
		}
	});

	it("preserves legitimate duplicate messages when restoring history", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});

			await service.initialize();
			const sessionId = service.snapshot().sessionId;
			writeArchiveRecords(workspace.cwd, sessionId, [
				createArchiveRecord(sessionId, 1, "user_prompt_received", { message: "same request" }),
				createArchiveRecord(sessionId, 2, "agent_event", {
					type: "message_end",
					message: createAssistantMessage("same reply"),
				}),
				createArchiveRecord(sessionId, 3, "user_prompt_received", { message: "same request" }),
				createArchiveRecord(sessionId, 4, "agent_event", {
					type: "message_end",
					message: createAssistantMessage("same reply"),
				}),
			]);
			ensureArchivedSessionFile(workspace.cwd, sessionId);

			await service.newConversation();
			const resumed = await service.resumeConversation(sessionId);

			expect(resumed.messages.map((message) => `${message.order}:${message.role}:${message.text}`)).toEqual([
				"1:user:same request",
				"2:assistant:same reply",
				"3:user:same request",
				"4:assistant:same reply",
			]);
		} finally {
			workspace.cleanup();
		}
	});

	it("restores interleaved multi-tool events and pending confirmations in sequence order", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});

			await service.initialize();
			const sessionId = service.snapshot().sessionId;
			writeArchiveRecords(workspace.cwd, sessionId, [
				createArchiveRecord(sessionId, 1, "user_prompt_received", { message: "run both tasks" }),
				createArchiveRecord(sessionId, 2, "agent_event", {
					type: "tool_execution_start",
					toolCallId: "tool-a",
					toolName: "shell_command_safe",
					args: { command: "echo A" },
				}),
				createArchiveRecord(sessionId, 3, "agent_event", {
					type: "tool_execution_start",
					toolCallId: "tool-b",
					toolName: "open_app",
					args: { app: "calc.exe" },
				}),
				createArchiveRecord(sessionId, 4, "agent_event", {
					type: "tool_execution_end",
					toolCallId: "tool-a",
					toolName: "shell_command_safe",
					result: {
						stepId: "confirm-1",
						intent: "Run command",
						action: "shell",
						target: "echo A",
						status: "blocked",
						riskLevel: "medium",
						requiresConfirmation: true,
					},
					isError: false,
				}),
				createArchiveRecord(sessionId, 5, "agent_event", {
					type: "tool_execution_end",
					toolCallId: "tool-b",
					toolName: "open_app",
					result: { ok: true },
					isError: false,
				}),
			]);
			ensureArchivedSessionFile(workspace.cwd, sessionId);

			await service.newConversation();
			const resumed = await service.resumeConversation(sessionId);

			expect(resumed.timeline.map((item) => `${item.order}:${item.kind}`)).toEqual([
				"4:tool",
				"4:confirmation",
				"5:tool",
			]);
			expect(resumed.pendingConfirmations).toHaveLength(1);
			expect(resumed.pendingConfirmations[0]).toMatchObject({
				id: "confirm-1",
				intent: "Run command",
				action: "shell",
				target: "echo A",
			});
		} finally {
			workspace.cleanup();
		}
	});

	it("extracts a global memory in one conversation and injects it into the next prompt", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});
			const prompts: string[] = [];
			const internal = service as unknown as {
				sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
				bindSession(session: {
					sessionId: string;
					sessionFile?: string;
					sessionName?: string;
					prompt(message: string, options?: unknown): Promise<void>;
					subscribe(listener: (event: unknown) => void): () => void;
				}): void;
				handleSessionEvent(event: unknown): void;
			};

			internal.bindSession({
				sessionId: internal.sessionManager.getSessionId(),
				sessionFile: internal.sessionManager.getSessionFile(),
				sessionName: "memory-a",
				prompt: async (message) => {
					prompts.push(message);
				},
				subscribe: () => () => {},
			});

			await service.prompt("以后都用中文简洁回答");
			internal.handleSessionEvent({
				type: "agent_end",
				messages: [createAssistantMessage("好的，我会保持中文简洁回答。")],
				willRetry: false,
			});
			expect(service.listGlobalMemories().memories.some((memory) => memory.text.includes("中文简洁"))).toBe(true);

			await service.newConversation();
			internal.bindSession({
				sessionId: internal.sessionManager.getSessionId(),
				sessionFile: internal.sessionManager.getSessionFile(),
				sessionName: "memory-b",
				prompt: async (message) => {
					prompts.push(message);
				},
				subscribe: () => () => {},
			});
			await service.prompt("回答一个普通问题");

			expect(prompts.at(-1)).toContain("<global_memory_context>");
			expect(prompts.at(-1)).toContain("中文简洁");
			expect(service.snapshot().lastInjectedMemoryCount).toBeGreaterThan(0);
		} finally {
			workspace.cleanup();
		}
	});

	it("auto-generates a persistent title after the first completed turn", async () => {
		const workspace = createTempWorkspace();
		try {
			const fetchMock = vi.fn(async () => {
				return new Response(JSON.stringify({ choices: [{ message: { content: "「Archive Title」" } }] }), {
					status: 200,
				});
			});
			vi.stubGlobal("fetch", fetchMock);
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});
			service.getAuthStorage().set("deepseek-official", { type: "api_key", key: "test-key" });
			const internal = service as unknown as {
				sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
				bindSession(session: {
					sessionId: string;
					sessionFile?: string;
					sessionName?: string;
					prompt(message: string, options?: unknown): Promise<void>;
					subscribe(listener: (event: unknown) => void): () => void;
				}): void;
				handleSessionEvent(event: unknown): void;
			};
			internal.bindSession({
				sessionId: internal.sessionManager.getSessionId(),
				sessionFile: internal.sessionManager.getSessionFile(),
				sessionName: "title-test",
				prompt: async () => {},
				subscribe: () => () => {},
			});

			await service.prompt("please summarize this project plan");
			internal.handleSessionEvent({
				type: "agent_end",
				messages: [createAssistantMessage("Here is a concise plan.")],
				willRetry: false,
			});
			await vi.waitFor(async () => {
				const history = await service.listConversationHistory();
				expect(history.conversations.find((item) => item.sessionId === service.snapshot().sessionId)?.title).toBe(
					"Archive Title",
				);
			});

			expect(
				service.listSessions().sessions.find((item) => item.sessionId === service.snapshot().sessionId)?.title,
			).toBe("Archive Title");
		} finally {
			vi.unstubAllGlobals();
			workspace.cleanup();
		}
	});

	it("archives conflicting global preferences when the user corrects them", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});
			const internal = service as unknown as {
				sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
				bindSession(session: {
					sessionId: string;
					sessionFile?: string;
					sessionName?: string;
					prompt(message: string, options?: unknown): Promise<void>;
					subscribe(listener: (event: unknown) => void): () => void;
				}): void;
				handleSessionEvent(event: unknown): void;
			};

			internal.bindSession({
				sessionId: internal.sessionManager.getSessionId(),
				sessionFile: internal.sessionManager.getSessionFile(),
				sessionName: "memory-conflict",
				prompt: async () => {},
				subscribe: () => () => {},
			});
			await service.prompt("以后都用英文回答");
			internal.handleSessionEvent({
				type: "agent_end",
				messages: [createAssistantMessage("Understood.")],
				willRetry: false,
			});
			await service.prompt("纠正一下，以后不要用英文回答，改成中文");
			internal.handleSessionEvent({
				type: "agent_end",
				messages: [createAssistantMessage("好的，之后改用中文。")],
				willRetry: false,
			});

			const memories = service.listGlobalMemories().memories;
			expect(memories.some((memory) => memory.kind === "correction" && memory.text.includes("中文"))).toBe(true);
			expect(memories.some((memory) => memory.text.includes("英文回答") && memory.kind === "preference")).toBe(
				false,
			);
		} finally {
			workspace.cleanup();
		}
	});

	it("keeps secrets out of extracted global memories", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = new DesktopAgentService({
				cwd: workspace.cwd,
				agentDir: workspace.agentDir,
				host: new DryRunDesktopAutomationHost(),
			});
			const internal = service as unknown as {
				sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
				bindSession(session: {
					sessionId: string;
					sessionFile?: string;
					sessionName?: string;
					prompt(message: string, options?: unknown): Promise<void>;
					subscribe(listener: (event: unknown) => void): () => void;
				}): void;
				handleSessionEvent(event: unknown): void;
			};

			internal.bindSession({
				sessionId: internal.sessionManager.getSessionId(),
				sessionFile: internal.sessionManager.getSessionFile(),
				sessionName: "memory-secret",
				prompt: async () => {},
				subscribe: () => () => {},
			});
			await service.prompt("记住 api key: sk-1234567890abcdefghijklmnopqrstuvwxyz");
			internal.handleSessionEvent({
				type: "agent_end",
				messages: [createAssistantMessage("我不会保存敏感密钥。")],
				willRetry: false,
			});

			expect(JSON.stringify(service.listGlobalMemories())).not.toContain("sk-123456");
		} finally {
			workspace.cleanup();
		}
	});
});

describe("conversation archive multi-session writers", () => {
	it("keeps interleaved writes from two writers in their own session archives", async () => {
		const workspace = createTempWorkspace();
		try {
			const coordinator = new ConversationArchiveCoordinator(workspace.cwd);
			const writerA = coordinator.createWriter("session-a");
			const writerB = coordinator.createWriter("session-b");

			writerA.write("user_prompt_received", { message: "task A" });
			writerB.write("user_prompt_received", { message: "task B" });
			writerA.write("agent_event", { type: "tool_execution_start", toolName: "open_app", toolCallId: "a-1" });
			writerB.write("agent_event", {
				type: "tool_execution_start",
				toolName: "shell_command_safe",
				toolCallId: "b-1",
			});
			writerA.write("busy_state_changed", { isBusy: false });

			await Promise.all([writerA.flushSnapshots(), writerB.flushSnapshots()]);

			const recordsA = readArchiveRecords(workspace.cwd, "session-a");
			const recordsB = readArchiveRecords(workspace.cwd, "session-b");
			expect(recordsA.map((record) => record.kind)).toEqual([
				"user_prompt_received",
				"agent_event",
				"busy_state_changed",
			]);
			expect(recordsB.map((record) => record.kind)).toEqual(["user_prompt_received", "agent_event"]);
			expect(recordsA.every((record) => record.sessionId === "session-a")).toBe(true);
			expect(recordsB.every((record) => record.sessionId === "session-b")).toBe(true);
			expect(recordsA.map((record) => record.sequence)).toEqual([1, 2, 3]);
			expect(recordsB.map((record) => record.sequence)).toEqual([1, 2]);

			const conversationA = readConversationArchive(workspace.cwd, "session-a");
			const conversationB = readConversationArchive(workspace.cwd, "session-b");
			expect(conversationA.latest.lastUserMessage).toBe("task A");
			expect(conversationB.latest.lastUserMessage).toBe("task B");
		} finally {
			workspace.cleanup();
		}
	});

	it("serializes concurrent index updates so index.json stays valid and lists every session", async () => {
		const workspace = createTempWorkspace();
		try {
			const coordinator = new ConversationArchiveCoordinator(workspace.cwd);
			const sessionIds = ["session-1", "session-2", "session-3", "session-4"];
			const writers = sessionIds.map((sessionId) => coordinator.createWriter(sessionId));
			for (const [position, writer] of writers.entries()) {
				writer.write("user_prompt_received", { message: `parallel task ${position + 1}` });
			}

			await Promise.all(writers.map((writer) => writer.flushSnapshots()));

			const index = readIndex(workspace.cwd);
			const listedIds = index.conversations.map((entry) => entry.sessionId).sort();
			expect(listedIds).toEqual(sessionIds);
		} finally {
			workspace.cleanup();
		}
	});

	it("persists conversation titles in metadata and index summaries", async () => {
		const workspace = createTempWorkspace();
		try {
			const coordinator = new ConversationArchiveCoordinator(workspace.cwd);
			const writer = coordinator.createWriter("session-title");
			writer.write("user_prompt_received", { message: "please name this conversation" });
			await writer.setTitle("Project Plan", "auto");

			const metadataPath = join(
				getConversationArchivePaths(workspace.cwd).conversationsDir,
				"session-title",
				"metadata.json",
			);
			const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as ConversationArchiveMetadata;
			expect(metadata.title).toBe("Project Plan");
			expect(metadata.titleSource).toBe("auto");
			expect(writer.getTitle()).toBe("Project Plan");
			expect(writer.hasTitle()).toBe(true);

			const restored = coordinator.createWriter("session-title");
			expect(restored.getTitle()).toBe("Project Plan");
			await restored.setTitle("Auto Override", "auto");
			await restored.setTitle("Manual Title", "manual");
			await restored.setTitle("Ignored Auto", "auto");

			const index = readIndex(workspace.cwd);
			const entry = index.conversations.find((conversation) => conversation.sessionId === "session-title");
			expect(entry).toMatchObject({
				title: "Manual Title",
				titleSource: "manual",
			});
		} finally {
			workspace.cleanup();
		}
	});

	it("ignores writes after detach and flushes buffered lines synchronously", () => {
		const workspace = createTempWorkspace();
		try {
			const coordinator = new ConversationArchiveCoordinator(workspace.cwd);
			const writer = coordinator.createWriter("session-detach");
			writer.write("user_prompt_received", { message: "before detach" });
			writer.detach();
			writer.write("user_prompt_received", { message: "after detach" });

			const records = readArchiveRecords(workspace.cwd, "session-detach");
			expect(records).toHaveLength(1);
			expect(records[0]?.payload).toMatchObject({ message: "before detach" });
		} finally {
			workspace.cleanup();
		}
	});
});

function createTempWorkspace(): { cwd: string; agentDir: string; cleanup(): void } {
	const root = mkdtempSync(join(tmpdir(), "desktop-assistant-archive-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	return {
		cwd,
		agentDir,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function readConversationArchive(cwd: string, sessionId: string): AiReadableConversationArchive {
	const conversationPath = join(getConversationArchivePaths(cwd).conversationsDir, sessionId, "conversation.json");
	return JSON.parse(readFileSync(conversationPath, "utf-8")) as AiReadableConversationArchive;
}

function readIndex(cwd: string): ConversationArchiveIndex {
	return JSON.parse(readFileSync(getConversationArchivePaths(cwd).indexFile, "utf-8")) as ConversationArchiveIndex;
}

function writeArchiveRecords(cwd: string, sessionId: string, records: ConversationArchiveRecord[]): void {
	const eventsPath = join(getConversationArchivePaths(cwd).conversationsDir, sessionId, "events.jsonl");
	writeFileSync(eventsPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
}

function readArchiveRecords(cwd: string, sessionId: string): ConversationArchiveRecord[] {
	const eventsPath = join(getConversationArchivePaths(cwd).conversationsDir, sessionId, "events.jsonl");
	return readFileSync(eventsPath, "utf-8")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ConversationArchiveRecord);
}

function ensureArchivedSessionFile(cwd: string, sessionId: string): void {
	const conversationDir = join(getConversationArchivePaths(cwd).conversationsDir, sessionId);
	const metadataPath = join(conversationDir, "metadata.json");
	const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as ConversationArchiveMetadata;
	const header = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
		cwd,
	};
	const sessionContent = `${JSON.stringify(header)}\n`;
	if (metadata.sessionFile) {
		writeFileSync(metadata.sessionFile, sessionContent, "utf-8");
	}
	writeFileSync(metadata.sessionMirrorFile, sessionContent, "utf-8");
}

function createArchiveRecord(
	sessionId: string,
	sequence: number,
	kind: string,
	payload: unknown,
): ConversationArchiveRecord {
	return {
		schemaVersion: 1,
		sequence,
		recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
		sessionId,
		kind,
		payload,
	};
}

function createAssistantMessage(text: string, usageUpdate: Partial<Usage> = {}): AssistantMessage {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
		...usageUpdate,
	};
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "responses",
		provider: "openai",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
