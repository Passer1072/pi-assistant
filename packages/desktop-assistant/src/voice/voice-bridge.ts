import { EventEmitter } from "node:events";
import type { VoiceOverlayState } from "../shared/types.ts";

export interface VoiceBridgeEvents {
	wake: [state: VoiceOverlayState];
	transcript: [state: VoiceOverlayState];
	error: [state: VoiceOverlayState];
}

export class VoiceBridge extends EventEmitter {
	start(wakeWord: string, language: string, mode: "wake-listening" | "manual" = "wake-listening"): VoiceOverlayState {
		const state: VoiceOverlayState = {
			visible: true,
			state: mode === "manual" ? "awaiting-speech" : "wake-listening",
			transcript: "",
			currentStep:
				mode === "manual" ? `Waiting for speech (${language})` : `Listening for "${wakeWord}" (${language})`,
			wakeWord,
		};
		this.emit("wake", state);
		return state;
	}

	stop(): VoiceOverlayState {
		const state: VoiceOverlayState = { visible: false, state: "idle", transcript: "" };
		this.emit("transcript", state);
		return state;
	}

	update(update: Partial<VoiceOverlayState>): VoiceOverlayState {
		const state: VoiceOverlayState = {
			visible: update.visible ?? true,
			state: update.state ?? "idle",
			transcript: update.transcript ?? "",
			currentStep: update.currentStep,
			error: update.error,
			remainingMs: update.remainingMs,
			elapsedMs: update.elapsedMs,
			level: update.level,
			wakeWord: update.wakeWord,
		};
		if (state.state === "error" || state.error) {
			this.emit("error", state);
		} else {
			this.emit("transcript", state);
		}
		return state;
	}
}
