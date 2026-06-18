import { describe, expect, it } from "vitest";
import { normalizeDraftSettingsBeforeApply } from "../renderer/src/settings-draft.ts";
import { DEFAULT_DESKTOP_ASSISTANT_SETTINGS, type WakeWordModelMetadata } from "../src/shared/types.ts";

describe("settings draft helpers", () => {
	it("uses the selected openWakeWord model wake word when applying", () => {
		const model: WakeWordModelMetadata = {
			id: "model-a",
			wakeWord: "hey-pi",
			label: "hey-pi",
			fileName: "model-a.onnx",
			sizeBytes: 42,
			importedAt: 1,
		};
		const settings = normalizeDraftSettingsBeforeApply(
			{
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
				voice: {
					...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
					wakeEngine: "openwakeword",
					activeOwwModelId: model.id,
					wakeWord: "manual text",
				},
				wakeWord: "manual text",
			},
			[model],
		);

		expect(settings.voice.wakeWord).toBe("hey-pi");
		expect(settings.wakeWord).toBe("hey-pi");
	});

	it("uses the selected openWakeWord model label when wake word metadata is stale", () => {
		const model: WakeWordModelMetadata = {
			id: "model-winston",
			wakeWord: "你好小派",
			label: "Winston",
			fileName: "model-winston.onnx",
			sizeBytes: 42,
			importedAt: 1,
		};
		const settings = normalizeDraftSettingsBeforeApply(
			{
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
				voice: {
					...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
					wakeEngine: "openwakeword",
					activeOwwModelId: model.id,
					wakeWord: "你好小派",
				},
				wakeWord: "你好小派",
			},
			[model],
		);

		expect(settings.voice.wakeWord).toBe("Winston");
		expect(settings.wakeWord).toBe("Winston");
	});

	it("uses the openWakeWord model URL wake word when applying", () => {
		const settings = normalizeDraftSettingsBeforeApply(
			{
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
				voice: {
					...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
					wakeEngine: "openwakeword",
					activeOwwModelId: undefined,
					owwModelUrl: "models/oww/winston.onnx",
					wakeWord: "old wake word",
				},
				wakeWord: "old wake word",
			},
			[],
		);

		expect(settings.voice.wakeWord).toBe("winston");
		expect(settings.wakeWord).toBe("winston");
	});

	it("allows fallback wake word to be cleared while editing but restores a usable value on apply", () => {
		const settings = normalizeDraftSettingsBeforeApply(
			{
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
				voice: {
					...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
					wakeEngine: "vosk",
					wakeWord: "",
				},
				wakeWord: "",
			},
			[],
		);

		expect(settings.voice.wakeWord).toBe(DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice.wakeWord);
		expect(settings.wakeWord).toBe(DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice.wakeWord);
	});

	it("keeps edited fallback wake word synchronized with legacy settings fields", () => {
		const settings = normalizeDraftSettingsBeforeApply(
			{
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
				voice: {
					...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
					wakeEngine: "vosk",
					wakeWord: "Winston",
				},
				wakeWord: "old wake word",
			},
			[],
		);

		expect(settings.voice.wakeWord).toBe("Winston");
		expect(settings.wakeWord).toBe("Winston");
	});

	it("keeps token saving settings when applying the draft", () => {
		const settings = normalizeDraftSettingsBeforeApply(
			{
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
				tokenSaving: { enabled: true },
			},
			[],
		);

		expect(settings.tokenSaving.enabled).toBe(true);
	});
});
