import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { getConversationArchivePaths } from "../src/agent/conversation-archive.ts";
import type { ConversationContext } from "../src/agent/conversation-context.ts";
import { DesktopAgentService } from "../src/agent/desktop-agent-service.ts";
import { DryRunDesktopAutomationHost } from "../src/desktop/automation-host.ts";

describe("multi-session orchestration", () => {
	it("keeps previous conversations live in the roster when starting a new one", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = newService(workspace);
			await service.initialize();
			const sessionA = service.snapshot().sessionId;

			await service.newConversation();
			const sessionB = service.snapshot().sessionId;

			const snapshot = service.snapshot();
			expect(sessionB).not.toBe(sessionA);
			expect(snapshot.focusedSessionId).toBe(sessionB);
			expect(snapshot.sessions).toHaveLength(2);
			expect(snapshot.sessions.map((s) => s.sessionId).sort()).toEqual([sessionA, sessionB].sort());
		} finally {
			workspace.cleanup();
		}
	});

	it("focusSession switches focus without disposing the background session", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = newService(workspace);
			await service.initialize();
			const sessionA = service.snapshot().sessionId;
			await service.newConversation();
			const sessionB = service.snapshot().sessionId;

			const focusedA = await service.focusSession(sessionA);
			expect(focusedA.focusedSessionId).toBe(sessionA);
			expect(focusedA.sessions).toHaveLength(2);

			// Switching back is instant and both remain live (no teardown / rebuild).
			const focusedB = await service.focusSession(sessionB);
			expect(focusedB.focusedSessionId).toBe(sessionB);
			expect(focusedB.sessions).toHaveLength(2);
		} finally {
			workspace.cleanup();
		}
	});

	it("flags unread completion (blue dot) for a background session that finishes", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = newService(workspace);
			await service.initialize();
			const sessionA = service.snapshot().sessionId;
			await service.newConversation(); // focus moves to B; A is now a background session

			const contextA = liveContext(service, sessionA);
			expect(contextA.isFocused).toBe(false);
			contextA.handleSessionEvent({
				type: "agent_end",
				messages: [createAssistantMessage("background reply")],
				willRetry: false,
			} as never);

			const beforeFocus = service.snapshot().sessions.find((s) => s.sessionId === sessionA);
			expect(beforeFocus?.unreadCompletion).toBe(true);

			// Focusing the session clears the blue dot.
			await service.focusSession(sessionA);
			const afterFocus = service.snapshot().sessions.find((s) => s.sessionId === sessionA);
			expect(afterFocus?.unreadCompletion).toBe(false);
		} finally {
			workspace.cleanup();
		}
	});

	it("caps live sessions, evicting the oldest idle ones from memory", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = newService(workspace);
			await service.initialize();
			const firstSessionId = service.snapshot().sessionId;

			// Spawn well past the live cap; idle background sessions must be evicted
			// so the roster never grows without bound.
			for (let index = 0; index < 8; index += 1) {
				await service.newConversation();
			}

			const roster = service.snapshot().sessions;
			expect(roster.length).toBeLessThanOrEqual(6);
			// The oldest session (the very first) is the prime eviction candidate.
			expect(roster.some((session) => session.sessionId === firstSessionId)).toBe(false);
			// The currently focused conversation is always kept live.
			expect(roster.some((session) => session.sessionId === service.snapshot().focusedSessionId)).toBe(true);
		} finally {
			workspace.cleanup();
		}
	});

	it("closeSession drops a conversation from the roster but keeps its archive", async () => {
		const workspace = createTempWorkspace();
		try {
			const service = newService(workspace);
			await service.initialize();
			const sessionA = service.snapshot().sessionId;
			await service.newConversation();
			const sessionB = service.snapshot().sessionId;
			await service.drainArchive();

			const closed = await service.closeSession(sessionA);
			expect(closed.sessions.map((s) => s.sessionId)).toEqual([sessionB]);
			// Archive on disk is preserved (close ≠ delete).
			const archiveDir = join(getConversationArchivePaths(workspace.cwd).conversationsDir, sessionA);
			expect(existsSync(archiveDir)).toBe(true);
		} finally {
			workspace.cleanup();
		}
	});
});

function newService(workspace: { cwd: string; agentDir: string }): DesktopAgentService {
	return new DesktopAgentService({
		cwd: workspace.cwd,
		agentDir: workspace.agentDir,
		host: new DryRunDesktopAutomationHost(),
	});
}

/** White-box accessor for a live context by sessionId (for background-event tests). */
function liveContext(service: DesktopAgentService, sessionId: string): ConversationContext {
	const sessions = (service as unknown as { sessions: Map<string, ConversationContext> }).sessions;
	for (const context of sessions.values()) {
		if (context.sessionId === sessionId) return context;
	}
	throw new Error(`No live context for sessionId ${sessionId}`);
}

function createTempWorkspace(): { cwd: string; agentDir: string; cleanup(): void } {
	const root = mkdtempSync(join(tmpdir(), "desktop-assistant-multi-session-"));
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

function createAssistantMessage(text: string, usageUpdate: Partial<Usage> = {}): AssistantMessage {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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
