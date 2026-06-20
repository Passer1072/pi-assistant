import { DEFAULT_VOICE_STT_BASE_URL_BY_PROVIDER, DEFAULT_VOICE_STT_MODEL_BY_PROVIDER, type DesktopAssistantSettings } from "../../src/shared/types.ts";

export const PROVIDERS: { id: string; label: string; models: { id: string; label: string }[] }[] = [
	{
		id: "deepseek",
		label: "DeepSeek",
		models: [
			{ id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
			{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
		],
	},
	{
		id: "openai",
		label: "OpenAI",
		models: [
			{ id: "gpt-4o", label: "GPT-4o" },
			{ id: "gpt-4o-mini", label: "GPT-4o mini" },
			{ id: "o1-preview", label: "o1 Preview" },
		],
	},
	{
		id: "anthropic",
		label: "Anthropic",
		models: [
			{ id: "claude-opus-4-6", label: "Claude Opus 4.6" },
			{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
			{ id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
		],
	},
	{
		id: "custom",
		label: "自定义（OpenAI 兼容）",
		models: [],
	},
];
export const VOICE_PROVIDER_LABEL: Record<DesktopAssistantSettings["voice"]["sttProvider"], string> = {
	openai: "OpenAI compatible",
	siliconflow: "SiliconFlow",
	groq: "Groq",
	custom: "Custom",
};
export const VOICE_STT_MODEL_HINT = "OpenAI: whisper-1 · Groq: whisper-large-v3-turbo / whisper-large-v3";
export function updateVoiceSettings(
	settings: DesktopAssistantSettings,
	update: Partial<DesktopAssistantSettings["voice"]>,
): Partial<DesktopAssistantSettings> {
	const voice = { ...settings.voice, ...update };
	if (update.sttProvider && update.sttProvider !== settings.voice.sttProvider) {
		const previousDefaultBaseUrl = DEFAULT_VOICE_STT_BASE_URL_BY_PROVIDER[settings.voice.sttProvider];
		if (!voice.sttBaseUrl || voice.sttBaseUrl === previousDefaultBaseUrl) {
			voice.sttBaseUrl = undefined;
		}
		voice.sttModel = DEFAULT_VOICE_STT_MODEL_BY_PROVIDER[update.sttProvider];
	}
	if (update.wakeEngine === "vosk") {
		voice.activeOwwModelId = undefined;
	}
	return {
		voice,
		wakeWord: voice.wakeWord,
		voiceLanguage: voice.language,
	};
}
