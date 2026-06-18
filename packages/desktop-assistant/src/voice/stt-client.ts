import type { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { VoiceSettings } from "../shared/types.ts";
import { DEFAULT_VOICE_STT_BASE_URL_BY_PROVIDER, DEFAULT_VOICE_STT_MODEL_BY_PROVIDER } from "../shared/types.ts";
import { isRetryableVoiceSttError, RETRYABLE_VOICE_STT_ERROR_MESSAGE } from "../shared/voice-errors.ts";

export const VOICE_STT_AUTH_PROVIDER = "desktop-assistant-voice-stt";

export interface TranscribeAudioOptions {
	audioWav: ArrayBuffer;
	settings: VoiceSettings;
	authStorage: AuthStorage;
	signal?: AbortSignal;
}

export async function transcribeAudio(options: TranscribeAudioOptions): Promise<string> {
	const { audioWav, settings, authStorage, signal } = options;
	const apiKey = await authStorage.getApiKey(VOICE_STT_AUTH_PROVIDER);
	if (!apiKey) {
		throw new Error("Voice STT API key is not configured.");
	}
	const endpoint = buildTranscriptionEndpoint(settings);
	if (!endpoint) {
		throw new Error("Voice STT base URL is not configured.");
	}

	const form = new FormData();
	form.set("file", new Blob([audioWav], { type: "audio/wav" }), "voice-input.wav");
	form.set("model", resolveTranscriptionModel(settings));
	const language = normalizeTranscriptionLanguage(settings.language);
	if (language) {
		form.set("language", language);
	}

	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		body: form,
		signal,
	}).catch((error: unknown) => {
		if (isRetryableVoiceSttError(error)) {
			throw new Error(RETRYABLE_VOICE_STT_ERROR_MESSAGE);
		}
		throw error;
	});
	const payload = (await readResponsePayload(response)) as unknown;
	if (!response.ok) {
		throw new Error(extractSttErrorMessage(payload, response.status));
	}
	const text = extractTranscriptionText(payload);
	if (!text) {
		throw new Error("Voice STT response did not include transcription text.");
	}
	return text;
}

export function buildTranscriptionEndpoint(settings: VoiceSettings): string {
	const rawBaseUrl = settings.sttBaseUrl?.trim() || DEFAULT_VOICE_STT_BASE_URL_BY_PROVIDER[settings.sttProvider];
	if (!rawBaseUrl) return "";
	const trimmed = rawBaseUrl.replace(/\/+$/, "");
	return trimmed.endsWith("/audio/transcriptions") ? trimmed : `${trimmed}/audio/transcriptions`;
}

export function resolveTranscriptionModel(settings: VoiceSettings): string {
	return settings.sttModel.trim() || DEFAULT_VOICE_STT_MODEL_BY_PROVIDER[settings.sttProvider];
}

function normalizeTranscriptionLanguage(language: string): string | undefined {
	const normalized = language.trim();
	if (!normalized) return undefined;
	return normalized.split("-")[0]?.toLowerCase();
}

async function readResponsePayload(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text.trim()) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

function extractTranscriptionText(payload: unknown): string {
	if (typeof payload === "string") return payload.trim();
	if (typeof payload !== "object" || payload === null) return "";
	const record = payload as Record<string, unknown>;
	const text = record.text;
	if (typeof text === "string") return text.trim();
	const data = record.data;
	if (Array.isArray(data)) {
		return data
			.map((item) => {
				if (typeof item === "string") return item;
				if (typeof item !== "object" || item === null) return "";
				const itemText = (item as Record<string, unknown>).text;
				return typeof itemText === "string" ? itemText : "";
			})
			.join("")
			.trim();
	}
	return "";
}

function extractSttErrorMessage(payload: unknown, status: number): string {
	if (typeof payload === "string" && payload.trim()) return payload.trim();
	if (typeof payload === "object" && payload !== null) {
		const record = payload as Record<string, unknown>;
		const error = record.error;
		if (typeof error === "string") return error;
		if (typeof error === "object" && error !== null) {
			const message = (error as Record<string, unknown>).message;
			if (typeof message === "string") return message;
		}
		const message = record.message;
		if (typeof message === "string") return message;
	}
	return `Voice STT request failed with HTTP ${status}.`;
}
