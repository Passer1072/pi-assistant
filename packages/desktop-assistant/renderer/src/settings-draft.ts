import {
	DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
	type DesktopAssistantSettings,
	type WakeWordModelMetadata,
} from "../../src/shared/types.ts";
import { syncOpenWakeWordModelWakeWord } from "../../src/shared/wake-word-settings.ts";

export function cloneSettings(settings: DesktopAssistantSettings): DesktopAssistantSettings {
	return JSON.parse(JSON.stringify(settings)) as DesktopAssistantSettings;
}

export function settingsKey(settings: DesktopAssistantSettings): string {
	return JSON.stringify(settings);
}

export function normalizeDraftSettingsBeforeApply(
	settings: DesktopAssistantSettings,
	wakeModels: WakeWordModelMetadata[],
): DesktopAssistantSettings {
	const next = syncOpenWakeWordModelWakeWord(cloneSettings(settings), wakeModels);
	if ((next.voice.wakeEngine ?? "kws") !== "openwakeword" && !next.voice.wakeWord.trim()) {
		next.voice.wakeWord = DEFAULT_DESKTOP_ASSISTANT_SETTINGS.voice.wakeWord;
	}
	if (Array.isArray(next.deepseekRelayModels)) {
		const seen = new Set<string>();
		next.deepseekRelayModels = next.deepseekRelayModels
			.map((model) => ({ ...model, id: model.id.trim(), label: model.label?.trim() || model.id.trim() }))
			.filter((model) => {
				if (!model.id || seen.has(model.id)) return false;
				seen.add(model.id);
				return true;
			});
		if (next.deepseekRelayModels.length === 0) {
			next.deepseekRelayModels = undefined;
		}
	}
	next.wakeWord = next.voice.wakeWord;
	next.voiceLanguage = next.voice.language;
	return next;
}
