import type { DesktopAssistantSettings, WakeWordModelMetadata } from "./types.ts";

export function syncOpenWakeWordModelWakeWord(
	settings: DesktopAssistantSettings,
	wakeModels: WakeWordModelMetadata[],
): DesktopAssistantSettings {
	const wakeWord = resolveSettingsWakeWord(settings.voice, wakeModels);
	if (!wakeWord || (settings.voice.wakeWord === wakeWord && settings.wakeWord === wakeWord)) return settings;
	return {
		...settings,
		voice: {
			...settings.voice,
			wakeWord,
		},
		wakeWord,
	};
}

export function syncOpenWakeWordModelWakeWordUpdate(
	update: Partial<DesktopAssistantSettings>,
	current: DesktopAssistantSettings,
	wakeModels: WakeWordModelMetadata[],
): Partial<DesktopAssistantSettings> {
	return syncVoiceWakeWordUpdate(update, current, wakeModels);
}

export function syncVoiceWakeWordUpdate(
	update: Partial<DesktopAssistantSettings>,
	current: DesktopAssistantSettings,
	wakeModels: WakeWordModelMetadata[],
): Partial<DesktopAssistantSettings> {
	if (!update.voice) return update;
	const voiceUpdate = update.voice as Partial<DesktopAssistantSettings["voice"]>;
	const mergedVoice = {
		...current.voice,
		...voiceUpdate,
	};
	const wakeWord = resolveSettingsWakeWord(mergedVoice, wakeModels);
	if (!wakeWord) return update;
	return {
		...update,
		voice: {
			...mergedVoice,
			wakeWord,
		},
		wakeWord,
	};
}

export function resolveOpenWakeWordWakeWord(
	voiceSettings: Pick<DesktopAssistantSettings["voice"], "activeOwwModelId" | "owwModelUrl" | "wakeEngine">,
	wakeModels: WakeWordModelMetadata[],
): string {
	if ((voiceSettings.wakeEngine ?? "vosk") !== "openwakeword") return "";
	const model = findOpenWakeWordModel(voiceSettings.activeOwwModelId, wakeModels);
	if (model) return resolveWakeWordModelWakeWord(model);
	return resolveWakeWordFromModelUrl(voiceSettings.owwModelUrl);
}

export function resolveWakeWordModelWakeWord(model: WakeWordModelMetadata): string {
	const wakeWord = model.wakeWord.trim();
	const label = model.label.trim();
	if (label && !isGenericWakeWordLabel(label)) return label;
	return wakeWord || label;
}

export function resolveWakeWordFromModelUrl(modelUrl: string | undefined): string {
	const trimmed = modelUrl?.trim();
	if (!trimmed) return "";
	const path = trimmed.split(/[?#]/, 1)[0] ?? "";
	const fileName = path.split(/[\\/]/).pop() ?? "";
	return fileName.replace(/\.onnx$/i, "").trim();
}

function resolveSettingsWakeWord(
	voiceSettings: DesktopAssistantSettings["voice"],
	wakeModels: WakeWordModelMetadata[],
): string {
	return resolveOpenWakeWordWakeWord(voiceSettings, wakeModels) || voiceSettings.wakeWord.trim();
}

function findOpenWakeWordModel(
	activeOwwModelId: string | undefined,
	wakeModels: WakeWordModelMetadata[],
): WakeWordModelMetadata | undefined {
	if (!activeOwwModelId) return undefined;
	return wakeModels.find((model) => model.id === activeOwwModelId);
}

function isGenericWakeWordLabel(label: string): boolean {
	return /^(?:wake word|openwakeword model|model|english wake word|chinese wake word|唤醒词|模型)$/i.test(label);
}
