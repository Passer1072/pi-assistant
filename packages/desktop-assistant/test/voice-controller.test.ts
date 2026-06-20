import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceController } from "../renderer/src/voice/voice-controller.ts";
import type { DesktopAssistantSnapshot, VoiceOverlayState } from "../src/shared/types.ts";
import { DEFAULT_API_KEY_STATUS, DEFAULT_DESKTOP_ASSISTANT_SETTINGS } from "../src/shared/types.ts";

const mockRequestMicrophoneStream = vi.hoisted(() => vi.fn());
const mockRecordOnce = vi.hoisted(() => vi.fn());
const mockRecorderStop = vi.hoisted(() => vi.fn());
const mockTranscriptStart = vi.hoisted(() => vi.fn());
const mockTranscriptStop = vi.hoisted(() => vi.fn());
const mockWakeDetectorStart = vi.hoisted(() => vi.fn());
const mockWakeDetectorStop = vi.hoisted(() => vi.fn());
const mockWakeDetectorUpdateSettings = vi.hoisted(() => vi.fn());
const mockWakeDetectorOnWake = vi.hoisted(() => vi.fn());
const mockWakeDetectorOnHeard = vi.hoisted(() => vi.fn());
const mockWakeDetectorOnError = vi.hoisted(() => vi.fn());

vi.mock("../renderer/src/voice/recorder.ts", () => ({
	requestMicrophoneStream: mockRequestMicrophoneStream,
	VoiceRecorder: vi.fn().mockImplementation(() => ({
		recordOnce: mockRecordOnce,
		stop: mockRecorderStop,
	})),
}));

vi.mock("../renderer/src/voice/live-transcript.ts", () => ({
	BrowserLiveTranscript: vi.fn().mockImplementation(() => ({
		start: mockTranscriptStart,
		stop: mockTranscriptStop,
	})),
}));

vi.mock("../renderer/src/voice/wake-word.ts", () => ({
	WakeWordDetector: vi.fn().mockImplementation(() => ({
		start: mockWakeDetectorStart,
		stop: mockWakeDetectorStop,
		updateSettings: mockWakeDetectorUpdateSettings,
		onWake: mockWakeDetectorOnWake,
		onHeard: mockWakeDetectorOnHeard,
		onError: mockWakeDetectorOnError,
	})),
}));

describe("VoiceController", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		mockRequestMicrophoneStream.mockReset();
		mockRecordOnce.mockReset();
		mockRecorderStop.mockReset();
		mockTranscriptStart.mockReset();
		mockTranscriptStop.mockReset();
		mockWakeDetectorStart.mockReset();
		mockWakeDetectorStop.mockReset();
		mockWakeDetectorUpdateSettings.mockReset();
		mockWakeDetectorOnWake.mockReset();
		mockWakeDetectorOnHeard.mockReset();
		mockWakeDetectorOnError.mockReset();
	});

	it("clears the transcript callback as soon as voice input is sent", async () => {
		const transcriptEvents: string[] = [];
		let resolvePrompt: ((snapshot: DesktopAssistantSnapshot) => void) | undefined;
		const promptPromise = new Promise<DesktopAssistantSnapshot>((resolve) => {
			resolvePrompt = resolve;
		});
		let overlayState: VoiceOverlayState = {
			visible: false,
			state: "idle",
			transcript: "",
		};
		let currentSnapshot = createSnapshot();
		const promptMock = vi.fn().mockReturnValue(promptPromise);
		const refreshHistory = vi.fn().mockResolvedValue(undefined);

		mockRequestMicrophoneStream.mockResolvedValue({
			active: true,
			getTracks: () => [],
		});
		mockRecordOnce.mockResolvedValue({
			audioWav: new ArrayBuffer(8),
			durationMs: 420,
		});
		mockTranscriptStart.mockReturnValue(true);

		vi.stubGlobal("window", {
			desktopAssistant: {
				startVoice: vi.fn().mockResolvedValue({
					visible: true,
					state: "awaiting-speech",
					transcript: "",
				}),
				stopVoice: vi.fn().mockResolvedValue({
					visible: false,
					state: "idle",
					transcript: "",
				}),
				updateVoiceOverlay: vi
					.fn()
					.mockImplementation(async ({ update }: { update: Partial<VoiceOverlayState> }) => {
						overlayState = { ...overlayState, ...update };
						return overlayState;
					}),
				transcribeAudio: vi.fn().mockResolvedValue({
					text: "打开记事本",
				}),
				prompt: promptMock,
			},
		});

		const controller = new VoiceController({
			getSnapshot: () => currentSnapshot,
			setSnapshot: (next) => {
				currentSnapshot = typeof next === "function" ? (next(currentSnapshot) ?? currentSnapshot) : next;
			},
			refreshHistory,
			onWarning: vi.fn(),
			onPartialTranscript: (text) => {
				transcriptEvents.push(text);
			},
		});

		const pending = controller.manualInput();

		await vi.waitFor(() => {
			expect(promptMock).toHaveBeenCalledWith({ message: "打开记事本", source: "voice" });
			expect(transcriptEvents).toEqual(["打开记事本", ""]);
		});

		resolvePrompt?.(currentSnapshot);
		await pending;

		expect(refreshHistory).toHaveBeenCalledTimes(1);
	});

	it("starts wake listening when an enabled wake snapshot arrives while idle", async () => {
		const stream = {
			active: true,
			getTracks: () => [],
		};
		let overlayState: VoiceOverlayState = {
			visible: false,
			state: "idle",
			transcript: "",
		};
		let currentSnapshot = createSnapshot({ wakeWordEnabled: true });

		mockRequestMicrophoneStream.mockResolvedValue(stream);
		mockWakeDetectorStart.mockResolvedValue(undefined);

		vi.stubGlobal("window", {
			desktopAssistant: {
				updateVoiceOverlay: vi
					.fn()
					.mockImplementation(async ({ update }: { update: Partial<VoiceOverlayState> }) => {
						overlayState = { ...overlayState, ...update };
						return overlayState;
					}),
			},
		});

		const controller = new VoiceController({
			getSnapshot: () => currentSnapshot,
			setSnapshot: (next) => {
				currentSnapshot = typeof next === "function" ? (next(currentSnapshot) ?? currentSnapshot) : next;
			},
			refreshHistory: vi.fn(),
			onWarning: vi.fn(),
			onPartialTranscript: vi.fn(),
		});

		controller.updateFromSnapshot(currentSnapshot);

		await vi.waitFor(() => {
			expect(mockRequestMicrophoneStream).toHaveBeenCalledTimes(1);
			expect(mockWakeDetectorStart).toHaveBeenCalledWith(stream);
		});
		expect(overlayState).toMatchObject({
			visible: true,
			state: "wake-listening",
			transcript: "",
			wakeWord: currentSnapshot.settings.voice.wakeWord,
		});
	});
});

function createSnapshot(options: { wakeWordEnabled?: boolean } = {}): DesktopAssistantSnapshot {
	return {
		sessionId: "voice-session",
		sessions: [
			{
				sessionId: "voice-session",
				title: "voice-session",
				status: "idle",
				isRunning: false,
				lastActivityAt: 0,
				pendingConfirmationCount: 0,
				unreadCompletion: false,
			},
		],
		focusedSessionId: "voice-session",
		settings: {
			...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
			voice: {
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
				wakeWordEnabled: options.wakeWordEnabled ?? false,
			},
		},
		authStatus: {
			configured: true,
			needsRotationWarning: false,
		},
		voiceAuthStatus: {
			configured: true,
			needsRotationWarning: false,
		},
		apiKeyStatus: DEFAULT_API_KEY_STATUS,
		isRunning: false,
		streamingText: "",
		streamingThinking: "",
		messages: [],
		timeline: [],
		pendingConfirmations: [],
		voiceOverlay: {
			visible: false,
			state: "idle",
			transcript: "",
		},
		conversationThinking: {
			enabled: true,
			effectiveLevel: "high",
			supported: true,
		},
		memoryEnabled: true,
		lastInjectedMemoryCount: 0,
	};
}
