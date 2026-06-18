import { describe, expect, it } from "vitest";
import { buildMicStatusDetail } from "../renderer/src/voice-status.ts";
import { DEFAULT_DESKTOP_ASSISTANT_SETTINGS, type VoiceOverlayState } from "../src/shared/types.ts";

describe("buildMicStatusDetail", () => {
	it("uses the current configured wake word while wake listening", () => {
		const overlay: VoiceOverlayState = {
			visible: true,
			state: "wake-listening",
			transcript: "old wake transcript",
			currentStep: 'Heard "old wake transcript" - 99% match',
			wakeWord: "old wake word",
		};

		expect(
			buildMicStatusDetail(overlay, {
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
				wakeWord: "new wake word",
			}),
		).toBe('Listening for "new wake word"');
	});

	it("prefers the selected openWakeWord model wake word over stale voice settings", () => {
		const overlay: VoiceOverlayState = {
			visible: true,
			state: "wake-listening",
			transcript: "",
			currentStep: 'Listening for "你好小派"',
			wakeWord: "你好小派",
		};

		expect(
			buildMicStatusDetail(
				overlay,
				{
					...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
					wakeEngine: "openwakeword",
					activeOwwModelId: "model-winston",
					wakeWord: "你好小派",
				},
				[
					{
						id: "model-winston",
						wakeWord: "winston",
						label: "winston",
						fileName: "model-winston.onnx",
						sizeBytes: 1,
						importedAt: 1,
					},
				],
			),
		).toBe('Listening for "Winston"');
	});

	it("prefers the selected openWakeWord model label over stale wake word metadata", () => {
		const overlay: VoiceOverlayState = {
			visible: true,
			state: "wake-listening",
			transcript: "",
			currentStep: 'Listening for "你好小派"',
			wakeWord: "你好小派",
		};

		expect(
			buildMicStatusDetail(
				overlay,
				{
					...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
					wakeEngine: "openwakeword",
					activeOwwModelId: "model-winston",
					wakeWord: "你好小派",
				},
				[
					{
						id: "model-winston",
						wakeWord: "你好小派",
						label: "Winston",
						fileName: "model-winston.onnx",
						sizeBytes: 1,
						importedAt: 1,
					},
				],
			),
		).toBe('Listening for "Winston"');
	});

	it("uses the openWakeWord model file name when no imported model id is active", () => {
		const overlay: VoiceOverlayState = {
			visible: true,
			state: "wake-listening",
			transcript: "",
			currentStep: 'Listening for "你好小派"',
			wakeWord: "你好小派",
		};

		expect(
			buildMicStatusDetail(overlay, {
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
				wakeEngine: "openwakeword",
				activeOwwModelId: undefined,
				owwModelUrl: "models/oww/winston.onnx",
				wakeWord: "你好小派",
			}),
		).toBe('Listening for "Winston"');
	});

	it("keeps errors more visible than wake listening context", () => {
		const overlay: VoiceOverlayState = {
			visible: true,
			state: "wake-listening",
			transcript: "",
			currentStep: 'Listening for "new wake word"',
			error: "microphone denied",
			wakeWord: "new wake word",
		};

		expect(buildMicStatusDetail(overlay, DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice)).toBe("microphone denied");
	});

	it("keeps non-stale wake listener diagnostics visible", () => {
		const overlay: VoiceOverlayState = {
			visible: true,
			state: "wake-listening",
			transcript: "",
			currentStep: "Wake listener fallback: runtime unavailable",
			wakeWord: "new wake word",
		};

		expect(buildMicStatusDetail(overlay, DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice)).toBe(
			"Wake listener fallback: runtime unavailable",
		);
	});
});
