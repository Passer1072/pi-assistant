import { once } from "node:events";
import { createServer, request } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createDebugBridgeHandlers } from "../src/main/debug-bridge/debug-bridge-handlers.ts";
import {
	createDebugBridgeHandshake,
	DebugBridgeServer,
	shouldStartDebugBridge,
} from "../src/main/debug-bridge/debug-bridge-server.ts";
import type { LogStore } from "../src/main/log-store.ts";
import type {
	DesktopAssistantEvent,
	DesktopAssistantSnapshot,
	LoadConversationPageResponse,
	LogEntry,
	SandboxStatus,
} from "../src/shared/types.ts";

describe("DebugBridgeServer", () => {
	it("serves unauthenticated health and rejects missing tokens elsewhere", async () => {
		const bridge = await startBridge();
		try {
			const health = await fetch(`${bridge.baseUrl}/health`);
			expect(health.status).toBe(200);
			expect(await health.json()).toMatchObject({ ok: true, version: "0.0.0", packaged: false });

			const denied = await fetch(`${bridge.baseUrl}/sessions`);
			expect(denied.status).toBe(401);
		} finally {
			await bridge.server.close();
		}
	});

	it("rejects non-local hosts and non-empty origins", async () => {
		const bridge = await startBridge();
		try {
			await expect(requestStatus(bridge.port, "evil.test")).resolves.toBe(403);

			const badOrigin = await fetch(`${bridge.baseUrl}/health`, { headers: { origin: "http://localhost:3000" } });
			expect(badOrigin.status).toBe(403);
		} finally {
			await bridge.server.close();
		}
	});

	it("listens on 127.0.0.1", async () => {
		const bridge = await startBridge();
		try {
			const address = bridge.server.address();
			expect(typeof address).toBe("object");
			if (typeof address === "object" && address) {
				expect(address.address).toBe("127.0.0.1");
			}
		} finally {
			await bridge.server.close();
		}
	});

	it("forwards prompts through HTTP", async () => {
		const bridge = await startBridge();
		try {
			const response = await fetch(`${bridge.baseUrl}/sessions/s1/prompt`, {
				method: "POST",
				headers: {
					authorization: "Bearer secret",
					"content-type": "application/json",
				},
				body: JSON.stringify({ message: "hello" }),
			});
			expect(response.status).toBe(200);
			expect(bridge.service.prompt).toHaveBeenCalledWith("hello", "text", [], "s1", "prompt");
		} finally {
			await bridge.server.close();
		}
	});

	it("returns session detail through HTTP", async () => {
		const bridge = await startBridge();
		try {
			const response = await fetch(`${bridge.baseUrl}/sessions/s1`, {
				headers: { authorization: "Bearer secret" },
			});
			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toMatchObject({ kind: "snapshot", snapshot: { sessionId: "s1" } });
		} finally {
			await bridge.server.close();
		}
	});

	it("closes unauthorized websocket connections with policy violation", async () => {
		const bridge = await startBridge();
		try {
			const socket = new WebSocket(`${bridge.wsUrl}/events?token=bad`);
			const event = await waitForWebSocketClose(socket);
			expect(event.code).toBe(1008);
		} finally {
			await bridge.server.close();
		}
	});

	it("streams raw service events and log entries", async () => {
		const bridge = await startBridge();
		try {
			const socket = new WebSocket(`${bridge.wsUrl}/events?token=secret`);
			const first = await nextMessage(socket);
			expect(first).toMatchObject({ type: "snapshot", snapshot: { sessionId: "s1" } });

			const event: DesktopAssistantEvent = { type: "streaming_text", streamingText: "abc", sessionId: "s1" };
			bridge.service.emit(event);
			await expect(nextMessage(socket)).resolves.toEqual(event);

			const entry: LogEntry = { id: "l1", ts: 1, cat: "system", title: "log" };
			bridge.logStore.push(entry);
			await expect(nextMessage(socket)).resolves.toEqual({ type: "log", entry });

			socket.close();
		} finally {
			await bridge.server.close();
		}
	});
});

describe("debug bridge gates", () => {
	it("requires env opt-in and blocks packaged apps without force", () => {
		expect(
			shouldStartDebugBridge({ isPackaged: false, getVersion: () => "", relaunch: vi.fn(), exit: vi.fn() }, {}),
		).toBe(false);
		expect(
			shouldStartDebugBridge(
				{ isPackaged: true, getVersion: () => "", relaunch: vi.fn(), exit: vi.fn() },
				{ DA_DEBUG_BRIDGE: "1" },
			),
		).toBe(false);
		expect(
			shouldStartDebugBridge(
				{ isPackaged: true, getVersion: () => "", relaunch: vi.fn(), exit: vi.fn() },
				{ DA_DEBUG_BRIDGE: "1", DA_DEBUG_BRIDGE_FORCE: "1" },
			),
		).toBe(true);
	});

	it("builds handshake metadata", () => {
		expect(createDebugBridgeHandshake(49250, "secret")).toMatchObject({
			port: 49250,
			token: "secret",
			baseUrl: "http://127.0.0.1:49250",
			mcpUrl: "http://127.0.0.1:49250/mcp",
		});
	});
});

async function startBridge() {
	const service = fakeService();
	const logStore = fakeLogStore();
	const handlers = createDebugBridgeHandlers({
		service,
		logStore,
		app: { isPackaged: false, getVersion: () => "0.0.0", relaunch: vi.fn(), exit: vi.fn() },
		getWindows: () => [],
		agentDir: "C:/agent",
	});
	const port = await freePort();
	const server = new DebugBridgeServer({ port, getToken: () => "secret", handlers, service, logStore });
	await server.listen();
	return {
		server,
		service,
		logStore,
		port,
		baseUrl: `http://127.0.0.1:${port}`,
		wsUrl: `ws://127.0.0.1:${port}`,
	};
}

async function requestStatus(port: number, host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				path: "/health",
				headers: { host },
			},
			(res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode ?? 0));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

async function nextMessage(socket: WebSocket): Promise<unknown> {
	const event = await waitForWebSocketMessage(socket);
	return JSON.parse(String(event.data)) as unknown;
}

function waitForWebSocketMessage(socket: WebSocket): Promise<MessageEvent> {
	return new Promise((resolve, reject) => {
		socket.addEventListener("message", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
}

function waitForWebSocketClose(socket: WebSocket): Promise<CloseEvent> {
	return new Promise((resolve, reject) => {
		socket.addEventListener("close", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
}

function fakeService() {
	const listeners = new Set<(event: DesktopAssistantEvent) => void>();
	const snapshot = makeSnapshot();
	return {
		abort: vi.fn(),
		approveConfirmation: vi.fn(async () => snapshot),
		closeSession: vi.fn(async () => snapshot),
		focusSession: vi.fn(async () => snapshot),
		getSandboxStatus: vi.fn((): SandboxStatus => makeSandboxStatus()),
		listMcpServers: vi.fn(() => ({ enabled: false, servers: [], statuses: [] })),
		listSessions: vi.fn(() => ({ sessions: [], focusedSessionId: snapshot.focusedSessionId })),
		loadConversationPage: vi.fn(
			(): LoadConversationPageResponse => ({
				sessionId: "background",
				messages: [],
				timeline: [],
				hasMoreBefore: false,
				loadedFrom: "events",
			}),
		),
		newConversation: vi.fn(async () => snapshot),
		prompt: vi.fn(async () => {}),
		rejectConfirmation: vi.fn(async () => snapshot),
		snapshot: vi.fn(() => snapshot),
		subscribe: vi.fn((listener: (event: DesktopAssistantEvent) => void) => {
			listeners.add(listener);
			listener({ type: "snapshot", snapshot });
			return () => listeners.delete(listener);
		}),
		updateSettings: vi.fn(async () => snapshot),
		emit(event: DesktopAssistantEvent) {
			for (const listener of listeners) listener(event);
		},
	};
}

function makeSandboxStatus(): SandboxStatus {
	return {
		phase: "ready",
		progress: 100,
		currentStep: "ready",
		usageMb: 0,
		quotaMb: 1024,
		attempts: 0,
		updatedAt: 1,
	};
}

function fakeLogStore(): LogStore {
	const listeners = new Set<(entry: LogEntry) => void>();
	const entries: LogEntry[] = [];
	return {
		logFilePath: "debug.ndjson",
		push: vi.fn((entry: LogEntry) => {
			entries.push(entry);
			for (const listener of listeners) listener(entry);
		}),
		getAll: vi.fn(() => [...entries]),
		subscribe: vi.fn((listener: (entry: LogEntry) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
		close: vi.fn(),
	} as unknown as LogStore;
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
		messages: [],
		timeline: [],
		pendingConfirmations: [],
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
