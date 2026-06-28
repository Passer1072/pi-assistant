import { describe, expect, it, vi } from "vitest";
import {
	createDebugBridgeHandlers,
	type DebugBridgeWindow,
	mergeTopLevelSettingsUpdate,
} from "../src/main/debug-bridge/debug-bridge-handlers.ts";
import type { LogStore } from "../src/main/log-store.ts";
import type {
	DesktopAssistantSettings,
	DesktopAssistantSnapshot,
	LoadConversationPageResponse,
	SandboxStatus,
} from "../src/shared/types.ts";

describe("Debug Bridge handlers", () => {
	it("deep-merges nested settings before calling updateSettings", async () => {
		const snapshot = makeSnapshot({
			settings: {
				browser: {
					allowAiControl: false,
					defaultBrowser: "chrome",
					aiBrowserPreference: "auto",
					homeUrl: "https://example.test",
					maxTabs: 4,
					persistStorage: true,
					shortcuts: [{ id: "a", label: "A", url: "https://a.test" }],
					searchTemplate: "https://search.test?q=%s",
				},
			} as DesktopAssistantSettings,
		});
		const service = fakeService(snapshot);
		const handlers = createDebugBridgeHandlers({
			service,
			logStore: fakeLogStore(),
			app: fakeApp(),
			getWindows: () => [],
			agentDir: "C:/agent",
		});

		await handlers.updateSettings({ browser: { allowAiControl: true } } as Partial<DesktopAssistantSettings>);

		expect(service.updateSettings).toHaveBeenCalledWith({
			browser: {
				allowAiControl: true,
				defaultBrowser: "chrome",
				aiBrowserPreference: "auto",
				homeUrl: "https://example.test",
				maxTabs: 4,
				persistStorage: true,
				shortcuts: [{ id: "a", label: "A", url: "https://a.test" }],
				searchTemplate: "https://search.test?q=%s",
			},
		});
	});

	it("forwards prompts with the expected service arguments", async () => {
		const service = fakeService(makeSnapshot());
		const handlers = createDebugBridgeHandlers({
			service,
			logStore: fakeLogStore(),
			app: fakeApp(),
			getWindows: () => [],
			agentDir: "C:/agent",
		});

		await handlers.sendPrompt("s1", { message: "hello", attachments: [] });

		expect(service.prompt).toHaveBeenCalledWith("hello", "text", [], "s1", "prompt");
	});

	it("does not focus when reading a non-focused session", async () => {
		const service = fakeService(makeSnapshot({ sessionId: "focused", focusedSessionId: "focused" }));
		const handlers = createDebugBridgeHandlers({
			service,
			logStore: fakeLogStore(),
			app: fakeApp(),
			getWindows: () => [],
			agentDir: "C:/agent",
		});

		const result = await handlers.getSession("background", { focus: true });

		expect(service.focusSession).not.toHaveBeenCalled();
		expect(service.loadConversationPage).toHaveBeenCalledWith({ sessionId: "background", limit: 500 });
		expect(result).toMatchObject({ kind: "history_page", focusChanged: false });
	});

	it("reloads non-destroyed windows", async () => {
		const reload = vi.fn();
		const windows: DebugBridgeWindow[] = [
			{ isDestroyed: () => false, webContents: { reloadIgnoringCache: reload } },
			{ isDestroyed: () => true, webContents: { reloadIgnoringCache: vi.fn() } },
		];
		const handlers = createDebugBridgeHandlers({
			service: fakeService(makeSnapshot()),
			logStore: fakeLogStore(),
			app: fakeApp(),
			getWindows: () => windows,
			agentDir: "C:/agent",
		});

		await expect(handlers.reload()).resolves.toEqual({ ok: true, reloaded: 1 });
		expect(reload).toHaveBeenCalledTimes(1);
	});
});

describe("mergeTopLevelSettingsUpdate", () => {
	it("preserves sibling fields inside nested objects", () => {
		const merged = mergeTopLevelSettingsUpdate(
			{
				experimental: {
					errorSelfSummary: { enabled: false },
					liveFlow: { enabled: true },
				},
			} as DesktopAssistantSettings,
			{ experimental: { errorSelfSummary: { enabled: true } } } as Partial<DesktopAssistantSettings>,
		);

		expect(merged).toEqual({
			experimental: {
				errorSelfSummary: { enabled: true },
				liveFlow: { enabled: true },
			},
		});
	});
});

function fakeService(snapshot: DesktopAssistantSnapshot) {
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
		updateSettings: vi.fn(async () => snapshot),
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
	const entries: LogStore["getAll"] extends () => infer T ? T : never = [];
	return {
		logFilePath: "debug.ndjson",
		push: vi.fn((entry) => {
			entries.push(entry);
		}),
		getAll: vi.fn(() => entries),
		subscribe: vi.fn(() => () => {}),
		close: vi.fn(),
	} as unknown as LogStore;
}

function fakeApp() {
	return {
		isPackaged: false,
		getVersion: () => "0.0.0",
		relaunch: vi.fn(),
		exit: vi.fn(),
	};
}

function makeSnapshot(update: Partial<DesktopAssistantSnapshot> = {}): DesktopAssistantSnapshot {
	return {
		sessionId: "s1",
		focusedSessionId: "s1",
		sessions: [],
		settings: {} as DesktopAssistantSettings,
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
		...update,
	};
}
