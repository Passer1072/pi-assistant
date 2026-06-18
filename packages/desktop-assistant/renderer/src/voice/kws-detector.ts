/// <reference lib="dom" />

import type { VoiceSettings } from "../../../src/shared/types.ts";
import { resampleTo16k, VOICE_SAMPLE_RATE } from "../../../src/voice/audio-format.ts";
import type {} from "../desktop-assistant-api.d.ts";

type WakeListener = (score: number) => void;
type HeardListener = (score: number) => void;
type ErrorListener = (error: Error) => void;

const REWAKE_DEBOUNCE_MS = 2000;

/**
 * Renderer-side handle for the sherpa-onnx keyword spotter that runs in the main
 * process. Captures microphone audio, resamples to 16 kHz mono, and streams it to
 * the native engine over IPC; fires `onWake` when the main process reports a
 * spotted keyword. Mirrors {@link OpenWakeWordDetector}'s shape so the wake word
 * multiplexer can treat both engines uniformly.
 */
export class KwsDetector {
	private settings: VoiceSettings;
	private audioContext: AudioContext | undefined;
	private source: MediaStreamAudioSourceNode | undefined;
	private processor: ScriptProcessorNode | undefined;
	private unsubscribe: (() => void) | undefined;
	private running = false;
	private lastWakeAt = 0;
	private wakeListeners = new Set<WakeListener>();
	private heardListeners = new Set<HeardListener>();
	private errorListeners = new Set<ErrorListener>();

	constructor(settings: VoiceSettings) {
		this.settings = settings;
	}

	onWake(listener: WakeListener): () => void {
		this.wakeListeners.add(listener);
		return () => this.wakeListeners.delete(listener);
	}

	onHeard(listener: HeardListener): () => void {
		this.heardListeners.add(listener);
		return () => this.heardListeners.delete(listener);
	}

	onError(listener: ErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	/** Resolves false (without emitting) when the native KWS engine/model is unavailable. */
	async start(stream: MediaStream): Promise<boolean> {
		if (this.running) return true;
		let response: { available: boolean };
		try {
			response = await window.desktopAssistant.startWakeKws({
				wakeWord: this.settings.wakeWord,
				sensitivity: this.settings.kwsSensitivity ?? 0.6,
				keywordsOverride: this.settings.kwsKeywords?.trim() || undefined,
			});
		} catch {
			return false;
		}
		if (!response.available) return false;

		this.running = true;
		this.unsubscribe = window.desktopAssistant.onWakeKwsWake(() => this.handleWake());
		this.audioContext = new AudioContext();
		this.source = this.audioContext.createMediaStreamSource(stream);
		this.processor = this.audioContext.createScriptProcessor(2048, 1, 1);
		this.processor.onaudioprocess = (event) => this.handleAudio(event.inputBuffer);
		this.source.connect(this.processor);
		this.processor.connect(this.audioContext.destination);
		return true;
	}

	stop(): void {
		this.running = false;
		this.processor?.disconnect();
		this.source?.disconnect();
		void this.audioContext?.close();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.processor = undefined;
		this.source = undefined;
		this.audioContext = undefined;
		try {
			window.desktopAssistant.stopWakeKws();
		} catch {
			// Best-effort: the main process may already have torn down the session.
		}
	}

	updateSettings(settings: VoiceSettings): void {
		this.settings = settings;
	}

	private handleAudio(inputBuffer: AudioBuffer): void {
		if (!this.running) return;
		const resampled = resampleTo16k(inputBuffer.getChannelData(0), inputBuffer.sampleRate);
		if (resampled.length === 0) return;
		// Copy so the transferred frame is independent of the reused audio buffer.
		const samples = resampled.slice();
		try {
			window.desktopAssistant.sendWakeKwsAudio({ samples, sampleRate: VOICE_SAMPLE_RATE });
		} catch (error) {
			this.emitError(error);
		}
	}

	private handleWake(): void {
		if (!this.running) return;
		const now = performance.now();
		if (now - this.lastWakeAt < REWAKE_DEBOUNCE_MS) return;
		this.lastWakeAt = now;
		// KWS reports a discrete spot rather than a probability; surface full confidence.
		for (const listener of this.wakeListeners) listener(1);
	}

	private emitError(error: unknown): void {
		const normalized = error instanceof Error ? error : new Error(String(error));
		for (const listener of this.errorListeners) listener(normalized);
	}
}
