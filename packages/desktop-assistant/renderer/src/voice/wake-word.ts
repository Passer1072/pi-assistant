/// <reference lib="dom" />

import voskBrowserUrl from "vosk-browser/dist/vosk.js?url";
import type { VoiceSettings } from "../../../src/shared/types.ts";
import { scoreWakeWord } from "../../../src/voice/wake-matching.ts";
import { KwsDetector } from "./kws-detector.ts";
import { OpenWakeWordDetector } from "./openwakeword.ts";

interface VoskRecognizer extends EventTarget {
	id: string;
	acceptWaveform(buffer: AudioBuffer): void;
	remove(): void;
	on(event: "error" | "partialresult" | "result", listener: (message: RecognitionMessage) => void): void;
}

interface VoskModel {
	ready: boolean;
	KaldiRecognizer: new (sampleRate: number, grammar?: string) => VoskRecognizer;
	setLogLevel(level: number): void;
	terminate(): void;
}

interface VoskBrowserModule {
	createModel(modelUrl: string, logLevel?: number): Promise<VoskModel>;
}

interface RecognitionMessage {
	event?: string;
	error?: string;
	result?: {
		text?: string;
		partial?: string;
	};
}

interface SpeechRecognitionAlternative {
	transcript: string;
	confidence: number;
}

interface SpeechRecognitionResult {
	readonly isFinal: boolean;
	readonly length: number;
	item(index: number): SpeechRecognitionAlternative;
	[index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
	readonly length: number;
	item(index: number): SpeechRecognitionResult;
	[index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
	results: SpeechRecognitionResultList;
	resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
	error: string;
	message?: string;
}

interface SpeechRecognitionConstructor {
	new (): SpeechRecognition;
}

interface SpeechRecognition extends EventTarget {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((event: SpeechRecognitionEvent) => void) | null;
	onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
}

declare global {
	interface Window {
		SpeechRecognition?: SpeechRecognitionConstructor;
		webkitSpeechRecognition?: SpeechRecognitionConstructor;
	}

	var Vosk: VoskBrowserModule | undefined;
}

type WakeListener = (text: string, score: number) => void;
type ErrorListener = (error: Error) => void;
type HeardListener = (text: string, score: number) => void;

export class WakeWordDetector {
	private settings: VoiceSettings;
	private audioContext: AudioContext | undefined;
	private source: MediaStreamAudioSourceNode | undefined;
	private processor: ScriptProcessorNode | undefined;
	private voskModel: VoskModel | undefined;
	private recognizer: VoskRecognizer | undefined;
	private browserRecognition: SpeechRecognition | undefined;
	private openWakeWord: OpenWakeWordDetector | undefined;
	private kws: KwsDetector | undefined;
	private wakeListeners = new Set<WakeListener>();
	private errorListeners = new Set<ErrorListener>();
	private heardListeners = new Set<HeardListener>();
	private running = false;

	constructor(settings: VoiceSettings) {
		this.settings = settings;
	}

	onWake(listener: WakeListener): () => void {
		this.wakeListeners.add(listener);
		return () => this.wakeListeners.delete(listener);
	}

	onError(listener: ErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	onHeard(listener: HeardListener): () => void {
		this.heardListeners.add(listener);
		return () => this.heardListeners.delete(listener);
	}

	async start(stream: MediaStream): Promise<void> {
		if (this.running) return;
		this.running = true;
		const engine = this.settings.wakeEngine ?? "kws";
		// sherpa-onnx keyword spotting is the primary offline engine.
		if (engine === "kws" || engine === "auto") {
			if (await this.tryStartKws(stream)) return;
			// Model not fetched yet — degrade to the legacy engines, but hint how to fix.
			this.emitError(
				new Error("本地唤醒引擎不可用，已回退。运行 npm run fetch:kws 下载模型可获得更可靠的唤醒。"),
			);
		}
		if (engine === "openwakeword") {
			if (await this.tryStartOpenWakeWord(stream)) return;
			this.emitError(new Error("openWakeWord model is unavailable; check the selected wake word model."));
			return;
		}
		const startedVosk = await this.tryStartVosk(stream);
		if (!startedVosk) {
			this.startBrowserRecognition();
		}
	}

	stop(): void {
		this.running = false;
		this.kws?.stop();
		this.kws = undefined;
		this.openWakeWord?.stop();
		this.openWakeWord = undefined;
		this.processor?.disconnect();
		this.source?.disconnect();
		void this.audioContext?.close();
		this.recognizer?.remove();
		this.voskModel?.terminate();
		this.browserRecognition?.stop();
		this.processor = undefined;
		this.source = undefined;
		this.audioContext = undefined;
		this.recognizer = undefined;
		this.voskModel = undefined;
		this.browserRecognition = undefined;
	}

	updateSettings(settings: VoiceSettings): void {
		this.settings = settings;
		this.kws?.updateSettings(settings);
		this.openWakeWord?.updateSettings(settings);
		if (this.browserRecognition) {
			this.browserRecognition.lang = settings.language;
		}
	}

	private async tryStartKws(stream: MediaStream): Promise<boolean> {
		const detector = new KwsDetector(this.settings);
		detector.onWake((score) => {
			for (const listener of this.wakeListeners) listener(this.settings.wakeWord, score);
		});
		detector.onError((error) => this.emitError(error));
		const started = await detector.start(stream);
		if (!started) {
			detector.stop();
			return false;
		}
		this.kws = detector;
		return true;
	}

	private async tryStartOpenWakeWord(stream: MediaStream): Promise<boolean> {
		const detector = new OpenWakeWordDetector(this.settings);
		detector.onWake((score) => {
			for (const listener of this.wakeListeners) listener(this.settings.wakeWord, score);
		});
		detector.onHeard((score) => {
			for (const listener of this.heardListeners) listener(this.settings.wakeWord, score);
		});
		detector.onError((error) => this.emitError(error));
		const started = await detector.start(stream);
		if (!started) {
			detector.stop();
			return false;
		}
		this.openWakeWord = detector;
		return true;
	}

	private async tryStartVosk(stream: MediaStream): Promise<boolean> {
		const modelUrl = resolveWakeModelUrl(this.settings);
		if (!modelUrl) return false;
		try {
			const vosk = await loadVoskBrowser();
			this.voskModel = await vosk.createModel(modelUrl);
			this.voskModel.setLogLevel?.(-1);
			this.recognizer = new this.voskModel.KaldiRecognizer(16000);
			this.recognizer.on("result", (message: RecognitionMessage) => {
				if (message.event === "error") {
					this.emitError(message.error ?? "Wake word recognition failed.");
					return;
				}
				this.checkText(message.result?.text ?? "");
			});
			this.recognizer.on("partialresult", (message: RecognitionMessage) => {
				if (message.event === "error") {
					this.emitError(message.error ?? "Wake word recognition failed.");
					return;
				}
				this.checkText(message.result?.partial ?? "");
			});
			this.audioContext = new AudioContext({ sampleRate: 16000 });
			this.source = this.audioContext.createMediaStreamSource(stream);
			this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
			this.processor.onaudioprocess = (event) => {
				try {
					this.recognizer?.acceptWaveform(event.inputBuffer);
				} catch (error) {
					this.emitError(error);
				}
			};
			this.source.connect(this.processor);
			this.processor.connect(this.audioContext.destination);
			return true;
		} catch (error) {
			this.emitError(error);
			this.recognizer?.remove();
			this.voskModel?.terminate();
			this.recognizer = undefined;
			this.voskModel = undefined;
			return false;
		}
	}

	private startBrowserRecognition(): void {
		const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
		if (!Recognition) {
			this.emitError(new Error("Wake word recognition is unavailable in this browser."));
			return;
		}
		const recognition = new Recognition();
		this.browserRecognition = recognition;
		recognition.continuous = true;
		recognition.interimResults = true;
		recognition.lang = this.settings.language;
		recognition.onresult = (event) => {
			for (let index = event.resultIndex; index < event.results.length; index += 1) {
				const result = event.results[index];
				this.checkText(result[0]?.transcript ?? "");
			}
		};
		recognition.onerror = (event) => {
			this.emitError(new Error(event.message || event.error));
		};
		recognition.onend = () => {
			if (!this.running) return;
			try {
				recognition.start();
			} catch {
				// Browser recognition can throw if restarted too quickly.
			}
		};
		try {
			recognition.start();
		} catch (error) {
			this.emitError(error);
		}
	}

	private checkText(text: string): void {
		const normalizedText = text.trim();
		if (!normalizedText) return;
		const score = scoreWakeWord(text, this.settings.wakeWord);
		for (const listener of this.heardListeners) {
			listener(normalizedText, score);
		}
		if (score < this.settings.fuzzyThreshold) return;
		for (const listener of this.wakeListeners) {
			listener(normalizedText, score);
		}
	}

	private emitError(error: unknown): void {
		const normalized = error instanceof Error ? error : new Error(String(error));
		for (const listener of this.errorListeners) {
			listener(normalized);
		}
	}
}

function resolveWakeModelUrl(settings: VoiceSettings): string | undefined {
	if (settings.wakeModelUrl?.trim()) return settings.wakeModelUrl.trim();
	const language = settings.language.toLowerCase().split("-")[0];
	if (!language) return undefined;
	const modelName = language === "zh" || language === "cn" ? "vosk-model-small-cn-0.22.tar.gz" : `vosk-model-small-${language}.tar.gz`;
	return new URL(`models/${modelName}`, window.location.href).toString();
}

let voskBrowserLoad: Promise<VoskBrowserModule> | undefined;

function loadVoskBrowser(): Promise<VoskBrowserModule> {
	if (globalThis.Vosk) return Promise.resolve(globalThis.Vosk);
	if (!voskBrowserLoad) {
		voskBrowserLoad = new Promise<VoskBrowserModule>((resolve, reject) => {
			const script = document.createElement("script");
			script.async = true;
			script.src = voskBrowserUrl;
			script.onload = () => {
				if (globalThis.Vosk) {
					resolve(globalThis.Vosk);
					return;
				}
				reject(new Error("Vosk wake word runtime did not initialize."));
			};
			script.onerror = () => reject(new Error("Unable to load Vosk wake word runtime."));
			document.head.appendChild(script);
		});
	}
	return voskBrowserLoad;
}
