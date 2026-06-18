import type { VoiceOverlayState, VoiceSettings, WakeWordModelMetadata } from "../../src/shared/types.ts";
import { resolveOpenWakeWordWakeWord } from "../../src/shared/wake-word-settings.ts";

export function buildMicStatusDetail(
	overlay: VoiceOverlayState,
	voiceSettings?: VoiceSettings,
	wakeModels: WakeWordModelMetadata[] = [],
): string {
	if (overlay.error) return overlay.error;
	if (overlay.state === "wake-listening") {
		const currentStep = overlay.currentStep ?? "";
		if (currentStep && !currentStep.startsWith("Heard ") && !currentStep.startsWith("Listening for ")) {
			return currentStep;
		}
		const wakeWord = resolveWakeWord(voiceSettings, wakeModels) || overlay.wakeWord?.trim();
		if (wakeWord) return `Listening for "${wakeWord}"`;
	}
	return overlay.currentStep || overlay.transcript || "";
}

function resolveWakeWord(voiceSettings: VoiceSettings | undefined, wakeModels: WakeWordModelMetadata[]): string {
	if (!voiceSettings) return "";
	const openWakeWordWakeWord = resolveOpenWakeWordWakeWord(voiceSettings, wakeModels);
	if (openWakeWordWakeWord) return formatWakeWordForDisplay(openWakeWordWakeWord);
	if ((voiceSettings.wakeEngine ?? "kws") === "openwakeword") return formatWakeWordForDisplay(voiceSettings.wakeWord);
	return voiceSettings.wakeWord.trim();
}

function formatWakeWordForDisplay(wakeWord: string): string {
	const trimmed = wakeWord.trim();
	if (/^[a-z][a-z0-9]*$/.test(trimmed)) {
		return `${trimmed[0].toUpperCase()}${trimmed.slice(1)}`;
	}
	return trimmed;
}
