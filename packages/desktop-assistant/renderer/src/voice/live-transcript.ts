/// <reference lib="dom" />

interface LiveSpeechRecognitionAlternative {
	transcript: string;
	confidence: number;
}

interface LiveSpeechRecognitionResult {
	readonly isFinal: boolean;
	readonly length: number;
	item(index: number): LiveSpeechRecognitionAlternative;
	[index: number]: LiveSpeechRecognitionAlternative;
}

interface LiveSpeechRecognitionResultList {
	readonly length: number;
	item(index: number): LiveSpeechRecognitionResult;
	[index: number]: LiveSpeechRecognitionResult;
}

interface LiveSpeechRecognitionEvent extends Event {
	results: LiveSpeechRecognitionResultList;
	resultIndex: number;
}

interface LiveSpeechRecognitionErrorEvent extends Event {
	error: string;
	message?: string;
}

interface LiveSpeechRecognition extends EventTarget {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((event: LiveSpeechRecognitionEvent) => void) | null;
	onerror: ((event: LiveSpeechRecognitionErrorEvent) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
}

type LiveSpeechRecognitionConstructor = new () => LiveSpeechRecognition;

type SpeechWindow = Window &
	typeof globalThis & {
		SpeechRecognition?: LiveSpeechRecognitionConstructor;
		webkitSpeechRecognition?: LiveSpeechRecognitionConstructor;
	};

export class BrowserLiveTranscript {
	private recognition: LiveSpeechRecognition | undefined;
	private finalText = "";
	private running = false;
	private language: string;
	private onTranscript: (text: string) => void;

	constructor(language: string, onTranscript: (text: string) => void) {
		this.language = language;
		this.onTranscript = onTranscript;
	}

	start(): boolean {
		const speechWindow = window as SpeechWindow;
		const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
		if (!Recognition) return false;
		const recognition = new Recognition();
		this.recognition = recognition;
		this.running = true;
		recognition.continuous = true;
		recognition.interimResults = true;
		recognition.lang = this.language;
		recognition.onresult = (event) => {
			let interim = "";
			for (let index = event.resultIndex; index < event.results.length; index += 1) {
				const result = event.results[index];
				const transcript = result[0]?.transcript ?? "";
				if (result.isFinal) {
					this.finalText = `${this.finalText} ${transcript}`.trim();
				} else {
					interim = `${interim} ${transcript}`.trim();
				}
			}
			const text = `${this.finalText} ${interim}`.trim();
			if (text) this.onTranscript(text);
		};
		recognition.onerror = () => {
			this.running = false;
		};
		recognition.onend = () => {
			if (!this.running) return;
			try {
				recognition.start();
			} catch {
				// Restarting too quickly can throw in Chromium.
			}
		};
		try {
			recognition.start();
			return true;
		} catch {
			this.running = false;
			return false;
		}
	}

	stop(): void {
		this.running = false;
		try {
			this.recognition?.stop();
		} catch {
			// Best effort; live transcript is only a visual aid.
		}
		this.recognition = undefined;
	}
}
