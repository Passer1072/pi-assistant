import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { OfficeChatBridge, simplifyOfficeChatSnapshot } from "../src/main/office-chat-bridge.ts";
import type { DesktopAssistantEvent, DesktopAssistantSnapshot } from "../src/shared/types.ts";

describe("OfficeChatBridge", () => {
	it("rejects missing or invalid tokens", async () => {
		const service = fakeService();
		const port = await freePort();
		const bridge = new OfficeChatBridge({ port, getTokens: () => ["secret"], service });
		await bridge.listen();
		try {
			const response = await fetch(`http://127.0.0.1:${port}/snapshot?token=bad`);
			expect(response.status).toBe(401);
		} finally {
			await bridge.close();
		}
	});

	it("forwards prompts to the current focused conversation", async () => {
		const service = fakeService();
		const port = await freePort();
		const bridge = new OfficeChatBridge({ port, getTokens: () => ["secret"], service });
		await bridge.listen();
		try {
			const response = await fetch(`http://127.0.0.1:${port}/prompt?token=secret`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message: "把标题改得更正式" }),
			});
			expect(response.ok).toBe(true);
			expect(service.prompt).toHaveBeenCalledWith(
				"来自 Word 侧边栏：把标题改得更正式",
				"text",
				[],
				undefined,
				"prompt",
			);
		} finally {
			await bridge.close();
		}
	});

	it("simplifies snapshots for the Word sidebar", () => {
		const snapshot = makeSnapshot();
		const simple = simplifyOfficeChatSnapshot(snapshot);

		expect(simple).toEqual({
			sessionId: "s1",
			focusedSessionId: "s1",
			isRunning: false,
			messages: [
				{ id: "m1", role: "user", text: "hello", timestamp: 1, order: 1 },
				{ id: "m2", role: "assistant", text: "hi", timestamp: 2, order: 2 },
			],
			streamingText: "",
			pendingConfirmationCount: 1,
		});
	});
});

function fakeService() {
	const listeners = new Set<(event: DesktopAssistantEvent) => void>();
	return {
		snapshot: vi.fn(() => makeSnapshot()),
		prompt: vi.fn(async () => {}),
		abort: vi.fn(() => {}),
		subscribe: vi.fn((listener: (event: DesktopAssistantEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
		emit(event: DesktopAssistantEvent) {
			for (const listener of listeners) listener(event);
		},
	} as any;
}

function makeSnapshot(): DesktopAssistantSnapshot {
	return {
		sessionId: "s1",
		focusedSessionId: "s1",
		sessions: [],
		settings: {} as DesktopAssistantSnapshot["settings"],
		authStatus: {} as DesktopAssistantSnapshot["authStatus"],
		voiceAuthStatus: {} as DesktopAssistantSnapshot["voiceAuthStatus"],
		apiKeyStatus: {} as DesktopAssistantSnapshot["apiKeyStatus"],
		isRunning: false,
		streamingText: "",
		streamingThinking: "",
		messages: [
			{ id: "m1", role: "user", text: "hello", timestamp: 1, order: 1 },
			{ id: "m2", role: "assistant", text: "hi", timestamp: 2, order: 2 },
		],
		timeline: [],
		pendingConfirmations: [{ id: "c1" } as DesktopAssistantSnapshot["pendingConfirmations"][number]],
		queuedPreInputs: [],
		queuedSteeringMessages: [],
		steeringLog: [],
		voiceOverlay: {} as DesktopAssistantSnapshot["voiceOverlay"],
		conversationThinking: {} as DesktopAssistantSnapshot["conversationThinking"],
		memoryEnabled: false,
		lastInjectedMemoryCount: 0,
	};
}

async function freePort(): Promise<number> {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}
