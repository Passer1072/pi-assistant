import { join } from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVoiceInputPrompt, normalizeSettings } from "../src/agent/desktop-agent-service.ts";
import { DEFAULT_DESKTOP_ASSISTANT_SETTINGS } from "../src/shared/types.ts";
import { isRetryableVoiceSttError, RETRYABLE_VOICE_STT_ERROR_MESSAGE } from "../src/shared/voice-errors.ts";
import { encodeWav } from "../src/voice/audio-format.ts";
import {
	buildTranscriptionEndpoint,
	resolveTranscriptionModel,
	transcribeAudio,
	VOICE_STT_AUTH_PROVIDER,
} from "../src/voice/stt-client.ts";
import { scoreWakeWord } from "../src/voice/wake-matching.ts";

describe("voice pipeline helpers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("normalizes OpenAI-compatible STT endpoints", () => {
		expect(buildTranscriptionEndpoint(DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice)).toBe(
			"https://api.openai.com/v1/audio/transcriptions",
		);
		expect(
			buildTranscriptionEndpoint({
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
				sttProvider: "custom",
				sttBaseUrl: "https://example.test/v1/",
			}),
		).toBe("https://example.test/v1/audio/transcriptions");
		expect(
			buildTranscriptionEndpoint({
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
				sttProvider: "groq",
				sttBaseUrl: undefined,
			}),
		).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
	});

	it("uses Groq's default STT model when no model is configured", () => {
		expect(
			resolveTranscriptionModel({
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
				sttProvider: "groq",
				sttModel: "",
			}),
		).toBe("whisper-large-v3-turbo");
	});

	it("stores voice STT credentials under an isolated provider id", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.set(VOICE_STT_AUTH_PROVIDER, { type: "api_key", key: "voice-key" });

		await expect(authStorage.getApiKey(VOICE_STT_AUTH_PROVIDER)).resolves.toBe("voice-key");
		expect(authStorage.get("deepseek")).toBeUndefined();
	});

	it("classifies TLS-disconnected STT fetch failures as retryable", () => {
		const error = new TypeError("fetch failed", {
			cause: Object.assign(
				new Error("Client network socket disconnected before secure TLS connection was established"),
				{
					code: "ECONNRESET",
					host: "api.groq.com",
				},
			),
		});

		expect(isRetryableVoiceSttError(error)).toBe(true);
	});

	it("normalizes retryable STT fetch failures into a user-facing retry message", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.set(VOICE_STT_AUTH_PROVIDER, { type: "api_key", key: "voice-key" });
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new TypeError("fetch failed", {
				cause: Object.assign(
					new Error("Client network socket disconnected before secure TLS connection was established"),
					{ code: "ECONNRESET", host: "api.groq.com" },
				),
			}),
		);

		await expect(
			transcribeAudio({
				audioWav: new ArrayBuffer(4),
				settings: {
					...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
					sttProvider: "groq",
				},
				authStorage,
			}),
		).rejects.toThrow(RETRYABLE_VOICE_STT_ERROR_MESSAGE);
	});

	it("fuzzy matches the default wake word and common Mandarin transcriptions", () => {
		expect(scoreWakeWord("Hi PI", "Hi PI")).toBe(1);
		expect(scoreWakeWord("嗨派", "Hi PI")).toBeGreaterThanOrEqual(0.6);
		expect(scoreWakeWord("open calculator", "Hi PI")).toBeLessThan(0.6);
	});

	it("matches short Hi wake words against Mandarin wake transcripts", () => {
		expect(scoreWakeWord("嗨", "Hi")).toBe(1);
		expect(scoreWakeWord("嘿", "Hi")).toBe(1);
		expect(scoreWakeWord("hai", "Hi")).toBe(1);
		expect(scoreWakeWord("open calculator", "Hi")).toBeLessThan(0.6);
	});

	it("encodes 16-bit mono wav data", () => {
		const wav = encodeWav(new Float32Array([0, 0.5, -0.5]));
		const view = new DataView(wav);

		expect(String.fromCharCode(...new Uint8Array(wav.slice(0, 4)))).toBe("RIFF");
		expect(String.fromCharCode(...new Uint8Array(wav.slice(8, 12)))).toBe("WAVE");
		expect(view.getUint16(22, true)).toBe(1);
		expect(view.getUint32(24, true)).toBe(16000);
		expect(view.getUint16(34, true)).toBe(16);
	});

	it("injects the voice correction skill for transcribed input", () => {
		const prompt = buildVoiceInputPrompt("打开寄事本", join(process.cwd(), "skills", "voice-input", "SKILL.md"));

		expect(prompt).toContain("<voice_input_skill");
		expect(prompt).toContain("speech recognition");
		expect(prompt).toContain("打开寄事本");
	});

	it("normalizes openWakeWord wake settings without dropping selected model metadata", () => {
		const settings = normalizeSettings({
			voice: {
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice,
				wakeEngine: "openwakeword",
				activeOwwModelId: " model-id ",
				owwModelUrl: " models/custom.onnx ",
				owwThreshold: 0.72,
			},
		});

		expect(settings.voice.wakeEngine).toBe("openwakeword");
		expect(settings.voice.activeOwwModelId).toBe("model-id");
		expect(settings.voice.owwModelUrl).toBe("models/custom.onnx");
		expect(settings.voice.owwThreshold).toBe(0.72);
	});
});
