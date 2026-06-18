/// <reference lib="dom" />

import type { VoiceSettings } from "../../../src/shared/types.ts";
import { resampleTo16k } from "../../../src/voice/audio-format.ts";
import type {} from "../desktop-assistant-api.d.ts";
import { EMBEDDING_STEP, EMBEDDING_WINDOW, OpenWakeWordRuntime, STEP_SAMPLES, WINDOW_SAMPLES } from "./openwakeword-runtime.ts";

export { OpenWakeWordRuntime };

type WakeListener = (score: number) => void;
type HeardListener = (score: number) => void;
type ErrorListener = (error: Error) => void;

type WorkerResponse =
	| { type: "loaded" }
	| { type: "score"; score: number }
	| { type: "error"; message: string };

export class OpenWakeWordDetector {
	private settings: VoiceSettings;
	private audioContext: AudioContext | undefined;
	private source: MediaStreamAudioSourceNode | undefined;
	private processor: ScriptProcessorNode | undefined;
	private worker: Worker | undefined;
	private loadResolver: ((loaded: boolean) => void) | undefined;
	private loadRejecter: ((error: unknown) => void) | undefined;
	private buffer: Float32Array<ArrayBufferLike> = new Float32Array(0);
	private samplesSinceRun = 0;
	private processing = false;
	private pendingWindow: Float32Array | undefined;
	private lastWakeAt = 0;
	private running = false;
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

	/** Resolves false (without emitting) when no classifier model is configured or it fails to load. */
	async start(stream: MediaStream): Promise<boolean> {
		if (this.running) return true;
		const classifier = await this.resolveClassifierModel();
		if (!classifier) return false;
		try {
			const worker = new Worker(new URL("./openwakeword-worker.ts", import.meta.url), { type: "module" });
			this.worker = worker;
			worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handleWorkerMessage(event.data);
			worker.onerror = (event) => {
				this.loadRejecter?.(new Error(event.message));
				this.emitError(event.message);
			};
			const loaded = await this.loadWorker(classifier);
			if (!loaded) return false;
		} catch {
			this.stopWorker();
			return false;
		}
		this.running = true;
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
		this.stopWorker();
		this.processor = undefined;
		this.source = undefined;
		this.audioContext = undefined;
		this.buffer = new Float32Array(0);
		this.pendingWindow = undefined;
		this.samplesSinceRun = 0;
		this.processing = false;
	}

	updateSettings(settings: VoiceSettings): void {
		this.settings = settings;
	}

	private loadWorker(classifier: string | Uint8Array): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			this.loadResolver = resolve;
			this.loadRejecter = reject;
			this.worker?.postMessage({ type: "load", classifier, baseHref: window.location.href });
		});
	}

	private stopWorker(): void {
		this.loadResolver = undefined;
		this.loadRejecter = undefined;
		this.worker?.postMessage({ type: "stop" });
		this.worker?.terminate();
		this.worker = undefined;
	}

	private async resolveClassifierModel(): Promise<string | Uint8Array | undefined> {
		const modelId = this.settings.activeOwwModelId?.trim();
		if (modelId) {
			const result = await window.desktopAssistant.readWakeWordModel({ id: modelId });
			return new Uint8Array(result.data);
		}
		const modelUrl = this.settings.owwModelUrl?.trim();
		return modelUrl ? new URL(modelUrl, window.location.href).toString() : undefined;
	}

	private handleAudio(inputBuffer: AudioBuffer): void {
		if (!this.running) return;
		const resampled = resampleTo16k(inputBuffer.getChannelData(0), inputBuffer.sampleRate);
		this.buffer = appendRolling(this.buffer, resampled, WINDOW_SAMPLES);
		this.samplesSinceRun += resampled.length;
		if (this.samplesSinceRun < STEP_SAMPLES) return;
		if (this.buffer.length < EMBEDDING_WINDOW * EMBEDDING_STEP) return;
		this.samplesSinceRun = 0;
		this.enqueueInference(this.buffer.slice());
	}

	private enqueueInference(window: Float32Array): void {
		if (!this.worker) return;
		if (this.processing) {
			this.pendingWindow = window;
			return;
		}
		this.processing = true;
		this.worker.postMessage({ type: "score", window }, [window.buffer]);
	}

	private handleWorkerMessage(message: WorkerResponse): void {
		if (message.type === "loaded") {
			this.loadResolver?.(true);
			this.loadResolver = undefined;
			this.loadRejecter = undefined;
			return;
		}
		if (message.type === "error") {
			this.loadRejecter?.(new Error(message.message));
			this.loadResolver = undefined;
			this.loadRejecter = undefined;
			this.processing = false;
			this.emitError(message.message);
			return;
		}
		if (message.type === "score") {
			this.handleScore(message.score);
			this.processing = false;
			const nextWindow = this.pendingWindow;
			this.pendingWindow = undefined;
			if (this.running && nextWindow) this.enqueueInference(nextWindow);
		}
	}

	private handleScore(score: number): void {
		for (const listener of this.heardListeners) listener(score);
		const threshold = this.settings.owwThreshold ?? 0.5;
		const now = performance.now();
		if (score >= threshold && now - this.lastWakeAt > 2000) {
			this.lastWakeAt = now;
			for (const listener of this.wakeListeners) listener(score);
		}
	}

	private emitError(error: unknown): void {
		const normalized = error instanceof Error ? error : new Error(String(error));
		for (const listener of this.errorListeners) listener(normalized);
	}
}

function appendRolling(
	buffer: Float32Array<ArrayBufferLike>,
	chunk: Float32Array<ArrayBufferLike>,
	maxLength: number,
): Float32Array<ArrayBufferLike> {
	const combined = new Float32Array(buffer.length + chunk.length);
	combined.set(buffer, 0);
	combined.set(chunk, buffer.length);
	if (combined.length <= maxLength) return combined;
	return combined.subarray(combined.length - maxLength).slice();
}
