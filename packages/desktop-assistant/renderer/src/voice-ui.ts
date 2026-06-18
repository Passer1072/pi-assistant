import { buildMicStatusDetail } from "./voice-status.ts";
import type { DesktopAssistantSettings, DesktopAssistantSnapshot, VoiceState, WakeWordModelMetadata } from "../../src/shared/types.ts";

export function buildMicStatusTitle(
	overlay: DesktopAssistantSnapshot["voiceOverlay"],
	voiceSettings?: DesktopAssistantSettings["voice"],
	wakeModels?: WakeWordModelMetadata[],
): string {
	const base = voiceStateLabels[overlay.state] ?? overlay.state;
	const detail = buildMicStatusDetail(overlay, voiceSettings, wakeModels);
	return detail ? `${base}: ${detail}` : base;
}

// Granular labels — only used for the hover tooltip, which can stay precise.
const voiceStateLabels: Record<VoiceState, string> = {
	idle: "空闲",
	"requesting-microphone": "请求麦克风",
	"wake-listening": "监听唤醒",
	"awaiting-speech": "等待说话",
	recording: "录音中",
	transcribing: "识别中",
	speaking: "播报中",
	error: "语音错误",
	unavailable: "不可用",
};

// Visible UI collapses the nine internal states into a handful of "tones".
export type VoiceTone = "idle" | "listening" | "capturing" | "processing" | "speaking" | "error";

export function voiceToneOf(state: VoiceState): VoiceTone {
	switch (state) {
		case "requesting-microphone":
		case "wake-listening":
			return "listening";
		case "awaiting-speech":
		case "recording":
			return "capturing";
		case "transcribing":
			return "processing";
		case "speaking":
			return "speaking";
		case "error":
		case "unavailable":
			return "error";
		default:
			return "idle";
	}
}

export const voiceToneLabels: Record<VoiceTone, string> = {
	idle: "空闲",
	listening: "监听唤醒",
	capturing: "录音中",
	processing: "识别中",
	speaking: "播报中",
	error: "语音不可用",
};
