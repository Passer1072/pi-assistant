/// <reference lib="dom" />

import { concatFloat32, encodeWav, resampleTo16k, VOICE_SAMPLE_RATE } from "../../../src/voice/audio-format.ts";

export interface VoiceRecorderOptions {
	postWakeWaitMs: number;
	endSilenceMs: number;
	onState?: (state: VoiceRecorderState) => void;
}

export interface VoiceRecorderState {
	phase: "awaiting-speech" | "recording";
	level: number;
	remainingMs?: number;
	elapsedMs?: number;
}

export interface VoiceRecordingResult {
	audioWav: ArrayBuffer;
	durationMs: number;
}

const SPEECH_RMS_THRESHOLD = 0.018;

export async function requestMicrophoneStream(): Promise<MediaStream> {
	return navigator.mediaDevices.getUserMedia({
		video: false,
		audio: {
			echoCancellation: true,
			noiseSuppression: true,
			channelCount: 1,
			sampleRate: VOICE_SAMPLE_RATE,
		},
	});
}

export class VoiceRecorder {
	private stream: MediaStream;
	private audioContext: AudioContext | undefined;
	private source: MediaStreamAudioSourceNode | undefined;
	private processor: ScriptProcessorNode | undefined;
	private chunks: Float32Array[] = [];
	private options: VoiceRecorderOptions;
	private startedAt = 0;
	private recordingStartedAt = 0;
	private lastSpeechAt = 0;
	private settled = false;
	private resolveResult: ((result: VoiceRecordingResult | undefined) => void) | undefined;
	private rejectResult: ((error: unknown) => void) | undefined;

	constructor(stream: MediaStream, options: VoiceRecorderOptions) {
		this.stream = stream;
		this.options = options;
	}

	async recordOnce(): Promise<VoiceRecordingResult | undefined> {
		this.startedAt = performance.now();
		this.audioContext = new AudioContext();
		this.source = this.audioContext.createMediaStreamSource(this.stream);
		this.processor = this.audioContext.createScriptProcessor(2048, 1, 1);
		this.processor.onaudioprocess = (event) => this.handleAudio(event.inputBuffer);
		this.source.connect(this.processor);
		this.processor.connect(this.audioContext.destination);
		return new Promise<VoiceRecordingResult | undefined>((resolve, reject) => {
			this.resolveResult = resolve;
			this.rejectResult = reject;
		});
	}

	stop(): void {
		this.finish(undefined);
	}

	private handleAudio(inputBuffer: AudioBuffer): void {
		if (this.settled) return;
		const now = performance.now();
		const input = inputBuffer.getChannelData(0);
		const level = calculateRms(input);
		const speechDetected = level >= SPEECH_RMS_THRESHOLD;
		if (this.recordingStartedAt === 0) {
			const remainingMs = Math.max(0, this.options.postWakeWaitMs - (now - this.startedAt));
			this.options.onState?.({ phase: "awaiting-speech", level, remainingMs });
			if (!speechDetected) {
				if (remainingMs <= 0) {
					this.finish(undefined);
				}
				return;
			}
			this.recordingStartedAt = now;
			this.lastSpeechAt = now;
		}

		if (speechDetected) {
			this.lastSpeechAt = now;
		}
		this.chunks.push(new Float32Array(input));
		this.options.onState?.({
			phase: "recording",
			level,
			elapsedMs: now - this.recordingStartedAt,
		});
		if (now - this.lastSpeechAt >= this.options.endSilenceMs) {
			this.finish({
				audioWav: encodeWav(resampleTo16k(concatFloat32(this.chunks), this.audioContext?.sampleRate ?? 48000)),
				durationMs: now - this.recordingStartedAt,
			});
		}
	}

	private finish(result: VoiceRecordingResult | undefined): void {
		if (this.settled) return;
		this.settled = true;
		this.processor?.disconnect();
		this.source?.disconnect();
		void this.audioContext?.close();
		this.resolveResult?.(result);
	}
}

function calculateRms(samples: Float32Array): number {
	let sum = 0;
	for (const sample of samples) {
		sum += sample * sample;
	}
	return Math.sqrt(sum / samples.length);
}
