import { describe, expect, it } from "vitest";
import { DEFAULT_DESKTOP_ASSISTANT_SETTINGS, type WakeWordModelMetadata } from "../src/shared/types.ts";
import { syncOpenWakeWordModelWakeWordUpdate, syncVoiceWakeWordUpdate } from "../src/shared/wake-word-settings.ts";

describe("wake word settings sync", () => {
	it("uses selected openWakeWord model metadata when applying settings updates", () => {
		const model: WakeWordModelMetadata = {
			id: "model-winston",
			wakeWord: "winston",
			label: "winston",
			fileName: "model-winston.onnx",
			sizeBytes: 1,
			importedAt: 1,
		};

		const update = syncOpenWakeWordModelWakeWordUpdate(
			{
				voice: {
					...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
					wakeEngine: "openwakeword",
					activeOwwModelId: model.id,
					wakeWord: "old wake word",
				},
			},
			DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
			[model],
		);

		expect(update.voice?.wakeWord).toBe("winston");
		expect(update.wakeWord).toBe("winston");
	});

	it("prefers model label when imported metadata kept a stale wake word", () => {
		const model: WakeWordModelMetadata = {
			id: "model-winston",
			wakeWord: "你好小派",
			label: "Winston",
			fileName: "model-winston.onnx",
			sizeBytes: 1,
			importedAt: 1,
		};

		const update = syncVoiceWakeWordUpdate(
			{
				voice: {
					...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
					wakeEngine: "openwakeword",
					activeOwwModelId: model.id,
					wakeWord: "你好小派",
				},
			},
			DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
			[model],
		);

		expect(update.voice?.wakeWord).toBe("Winston");
		expect(update.wakeWord).toBe("Winston");
	});

	it("uses openWakeWord model URL when no imported model id is active", () => {
		const update = syncVoiceWakeWordUpdate(
			{
				voice: {
					...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
					wakeEngine: "openwakeword",
					activeOwwModelId: undefined,
					owwModelUrl: "models/oww/winston.onnx",
					wakeWord: "old wake word",
				},
			},
			DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
			[],
		);

		expect(update.voice?.wakeWord).toBe("winston");
		expect(update.wakeWord).toBe("winston");
	});

	it("keeps fallback wake word edits synchronized on partial settings updates", () => {
		const update = syncVoiceWakeWordUpdate(
			{
				voice: {
					...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
					wakeEngine: "vosk",
					wakeWord: "Winston",
				},
				wakeWord: "old wake word",
			},
			{
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
				voice: {
					...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
					wakeWord: "old wake word",
				},
				wakeWord: "old wake word",
			},
			[],
		);

		expect(update.voice?.wakeWord).toBe("Winston");
		expect(update.wakeWord).toBe("Winston");
	});
});
