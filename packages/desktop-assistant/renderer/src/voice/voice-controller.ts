import type { DesktopAssistantSnapshot, VoiceOverlayState, VoiceSettings } from "../../../src/shared/types.ts";
import { isRetryableVoiceSttError, RETRYABLE_VOICE_STT_ERROR_MESSAGE } from "../../../src/shared/voice-errors.ts";
import { BrowserLiveTranscript } from "./live-transcript.ts";
import { requestMicrophoneStream, VoiceRecorder } from "./recorder.ts";
import { WakeWordDetector } from "./wake-word.ts";

type SnapshotGetter = () => DesktopAssistantSnapshot | undefined;
type SnapshotUpdater = (
	snapshot:
		| DesktopAssistantSnapshot
		| ((current: DesktopAssistantSnapshot | undefined) => DesktopAssistantSnapshot | undefined),
) => void;

export interface VoiceControllerOptions {
	getSnapshot: SnapshotGetter;
	setSnapshot: SnapshotUpdater;
	refreshHistory: () => Promise<void>;
	onWarning: (message: string) => void;
	onPartialTranscript: (text: string) => void;
	/**
	 * Runs once just before each voice capture begins (manual or wake-triggered),
	 * before the active run is interrupted. The home page uses it to start a fresh
	 * conversation so every voice input on the landing page is its own conversation.
	 */
	onBeforeInput?: () => Promise<void> | void;
}

export class VoiceController {
	private getSnapshot: SnapshotGetter;
	private setSnapshot: SnapshotUpdater;
	private refreshHistory: () => Promise<void>;
	private onWarning: (message: string) => void;
	private onPartialTranscript: (text: string) => void;
	private onBeforeInput: (() => Promise<void> | void) | undefined;
	private stream: MediaStream | undefined;
	private wakeDetector: WakeWordDetector | undefined;
	private recorder: VoiceRecorder | undefined;
	private liveTranscript: BrowserLiveTranscript | undefined;
	private enabled = false;
	private inputActive = false;
	private wakeSessionId = 0;
	private wakeStartSessionId: number | undefined;
	private lastWakeSettingsKey = "";
	private lastWakeHeardOverlayAt = 0;

	constructor(options: VoiceControllerOptions) {
		this.getSnapshot = options.getSnapshot;
		this.setSnapshot = options.setSnapshot;
		this.refreshHistory = options.refreshHistory;
		this.onWarning = options.onWarning;
		this.onPartialTranscript = options.onPartialTranscript;
		this.onBeforeInput = options.onBeforeInput;
	}

	async startWakeListening(): Promise<void> {
		if (this.wakeStartSessionId !== undefined) return;
		const settings = this.getSnapshot()?.settings.voice;
		if (!settings?.enabled || !settings.wakeWordEnabled) return;
		if (this.inputActive) return;
		this.enabled = true;
		this.stopWakeDetector();
		const wakeSessionId = this.wakeSessionId;
		this.wakeStartSessionId = wakeSessionId;
		try {
			await this.pushWakeOverlay(wakeSessionId, {
				visible: true,
				state: "requesting-microphone",
				transcript: "",
				currentStep: "Requesting microphone access",
				wakeWord: settings.wakeWord,
			});
			if (!this.isWakeSessionActive(wakeSessionId)) return;
			const stream = await this.ensureStream();
			if (!this.isWakeSessionActive(wakeSessionId)) return;
			await this.pushWakeOverlay(wakeSessionId, {
				visible: true,
				state: "wake-listening",
				transcript: "",
				currentStep: "Microphone active; loading wake listener",
				wakeWord: settings.wakeWord,
			});
			if (!this.isWakeSessionActive(wakeSessionId)) return;

			const detector = new WakeWordDetector(settings);
			this.wakeDetector = detector;
			detector.onWake((text, score) => {
				if (!this.isWakeSessionActive(wakeSessionId, detector)) return;
				void this.beginVoiceInput(`Wake word: ${text} (${Math.round(score * 100)}%)`);
			});
			detector.onHeard((text, score) => {
				if (!this.isWakeSessionActive(wakeSessionId, detector)) return;
				const now = performance.now();
				if (now - this.lastWakeHeardOverlayAt < 500) return;
				this.lastWakeHeardOverlayAt = now;
				queueMicrotask(() => {
					if (!this.isWakeSessionActive(wakeSessionId, detector)) return;
					void this.pushWakeOverlay(wakeSessionId, {
						visible: true,
						state: "wake-listening",
						transcript: text,
						currentStep: `Heard "${text}" - ${Math.round(score * 100)}% match`,
						wakeWord: settings.wakeWord,
					});
				});
			});
			detector.onError((error) => {
				if (!this.isWakeSessionActive(wakeSessionId, detector)) return;
				void this.pushWakeOverlay(wakeSessionId, {
					visible: true,
					state: "wake-listening",
					transcript: "",
					currentStep: `Wake listener fallback: ${error.message}`,
					wakeWord: settings.wakeWord,
				});
			});
			await detector.start(stream);
			if (!this.isWakeSessionActive(wakeSessionId, detector)) return;
			await this.pushWakeOverlay(wakeSessionId, {
				visible: true,
				state: "wake-listening",
				transcript: "",
				currentStep: `Listening for "${settings.wakeWord}"`,
				wakeWord: settings.wakeWord,
			});
		} catch (error) {
			if (this.isWakeSessionActive(wakeSessionId)) await this.handleMicrophoneError(error);
		} finally {
			if (this.wakeStartSessionId === wakeSessionId) {
				this.wakeStartSessionId = undefined;
			}
		}
	}

	async stop(): Promise<void> {
		this.enabled = false;
		this.inputActive = false;
		this.liveTranscript?.stop();
		this.recorder?.stop();
		this.stopWakeDetector();
		this.stream?.getTracks().forEach((track) => track.stop());
		this.recorder = undefined;
		this.stream = undefined;
		const overlay = await window.desktopAssistant.stopVoice();
		this.applyOverlay(overlay);
	}

	async manualInput(): Promise<void> {
		this.enabled = true;
		await this.beginVoiceInput("Manual voice input");
	}

	updateFromSnapshot(snapshot: DesktopAssistantSnapshot): void {
		const settings = snapshot.settings.voice;
		const nextWakeSettingsKey = buildWakeSettingsKey(snapshot);
		const changed = this.lastWakeSettingsKey !== "" && this.lastWakeSettingsKey !== nextWakeSettingsKey;
		this.lastWakeSettingsKey = nextWakeSettingsKey;
		this.wakeDetector?.updateSettings(settings);
		if (!settings.enabled || !settings.wakeWordEnabled) {
			this.stopWakeDetector();
			const wakeSessionId = this.wakeSessionId;
			if (changed && !this.inputActive) {
				void this.syncVoiceOverlay({
					visible: false,
					state: "idle",
					transcript: "",
					wakeWord: settings.wakeWord,
				}, wakeSessionId);
			}
			return;
		}
		if (changed && this.enabled && !this.inputActive) {
			this.stopWakeDetector();
			void this.restartWakeListening(settings);
			return;
		}
		if (!this.enabled && !this.inputActive && !this.wakeDetector && snapshot.voiceOverlay.state === "idle") {
			void this.startWakeListening();
		}
	}

	shouldApplyExternalOverlay(overlay: VoiceOverlayState): boolean {
		return !this.inputActive || overlay.state !== "wake-listening";
	}

	private async beginVoiceInput(reason: string): Promise<void> {
		if (this.inputActive) return;
		this.inputActive = true;
		this.stopWakeDetector();
		// Let the host start a fresh conversation first (home page: every voice input
		// is its own conversation) before we touch the focused session.
		try {
			await this.onBeforeInput?.();
		} catch (error) {
			console.warn("onBeforeInput hook failed:", error);
		}
		// A wake word fired while the previous turn may still be running: interrupt the
		// focused session's model + in-flight actions before capturing the new command.
		await this.interruptActiveRun();
		const settings = this.getSnapshot()?.settings.voice;
		if (!settings?.enabled) {
			await this.pushOverlay({
				visible: true,
				state: "unavailable",
				transcript: "",
				currentStep: "Voice input is disabled.",
			});
			this.inputActive = false;
			return;
		}
		try {
			await this.pushOverlay({
				visible: true,
				state: "requesting-microphone",
				transcript: "",
				currentStep: "Requesting microphone access",
			});
			const stream = await this.ensureStream();
			const overlay = await window.desktopAssistant.startVoice({ mode: "manual" });
			this.applyOverlay({ ...overlay, currentStep: reason, remainingMs: settings.postWakeWaitMs });
			this.liveTranscript?.stop();
			this.liveTranscript = new BrowserLiveTranscript(settings.language, (text) => this.onPartialTranscript(text));
			this.liveTranscript.start();
			this.recorder = new VoiceRecorder(stream, {
				postWakeWaitMs: settings.postWakeWaitMs,
				endSilenceMs: settings.endSilenceMs,
				onState: (state) => {
					void this.pushOverlay({
						visible: true,
						state: state.phase,
						transcript: "",
						currentStep: state.phase === "awaiting-speech" ? "Waiting for speech" : "Recording",
						remainingMs: state.remainingMs,
						elapsedMs: state.elapsedMs,
						level: state.level,
					});
				},
			});
			const recording = await this.recorder.recordOnce();
			this.recorder = undefined;
			this.liveTranscript?.stop();
			this.liveTranscript = undefined;
			if (!recording) {
				this.onPartialTranscript("");
				await this.pushOverlay({
					visible: false,
					state: this.enabled ? "wake-listening" : "idle",
					transcript: "",
					currentStep: "No speech detected.",
				});
				return;
			}
			await this.pushOverlay({
				visible: true,
				state: "transcribing",
				transcript: "",
				currentStep: "Transcribing voice input",
				elapsedMs: recording.durationMs,
			});
			const result = await window.desktopAssistant.transcribeAudio({
				audioWav: recording.audioWav,
				mimeType: "audio/wav",
			});
			const text = result.text.trim();
			if (text) this.onPartialTranscript(text);
			await this.pushOverlay({
				visible: true,
				state: "transcribing",
				transcript: text,
				currentStep: "Sending voice input",
			});
			if (text) {
				this.onPartialTranscript("");
				// Fire the prompt without awaiting it, then resume wake listening below so a
				// second wake word can interrupt the running model (see interruptActiveRun).
				// The chat/snapshot updates arrive live via the main-process event stream.
				this.dispatchPrompt(text);
			}
		} catch (error) {
			this.liveTranscript?.stop();
			this.liveTranscript = undefined;
			this.onPartialTranscript("");
			const message = error instanceof Error ? error.message : String(error);
			if (isRetryableVoiceSttError(error)) {
				this.onWarning(RETRYABLE_VOICE_STT_ERROR_MESSAGE);
			}
			await this.pushOverlay({
				visible: true,
				state: "error",
				transcript: "",
				currentStep: "Voice input failed",
				error: message,
			});
		} finally {
			this.inputActive = false;
			if (this.enabled) {
				await this.startWakeListening();
			}
		}
	}

	/** Aborts the focused session's in-flight model run + actions, if any (current session only). */
	private async interruptActiveRun(): Promise<void> {
		const snapshot = this.getSnapshot();
		if (!snapshot?.isRunning) return;
		try {
			await window.desktopAssistant.abort({ sessionId: snapshot.focusedSessionId });
		} catch (error) {
			console.warn("Failed to interrupt running session before voice input:", error);
		}
	}

	/** Sends a transcribed command without blocking, so wake listening can resume during the run. */
	private dispatchPrompt(text: string): void {
		void window.desktopAssistant
			.prompt({ message: text, source: "voice" })
			.then(() => this.refreshHistory())
			.catch((error) => console.warn("Voice prompt failed:", error));
	}

	private async ensureStream(): Promise<MediaStream> {
		if (this.stream && this.stream.active) return this.stream;
		this.stream = await requestMicrophoneStream();
		return this.stream;
	}

	private async handleMicrophoneError(error: unknown): Promise<void> {
		const message =
			error instanceof DOMException && error.name === "NotAllowedError"
				? "Microphone permission was denied. Open Windows microphone privacy settings and allow this app."
				: error instanceof Error
					? error.message
					: String(error);
		await this.pushOverlay({
			visible: true,
			state: "unavailable",
			transcript: "",
			currentStep: message,
			error: message,
		});
	}

	private async pushOverlay(update: Partial<VoiceOverlayState>): Promise<void> {
		const overlay = await window.desktopAssistant.updateVoiceOverlay({ update });
		this.applyOverlay(overlay);
	}

	private async pushWakeOverlay(wakeSessionId: number, update: Partial<VoiceOverlayState>): Promise<void> {
		if (!this.isWakeSessionActive(wakeSessionId)) return;
		const overlay = await window.desktopAssistant.updateVoiceOverlay({ update });
		if (this.isWakeSessionActive(wakeSessionId)) {
			this.applyOverlay(overlay);
		}
	}

	private async restartWakeListening(settings: VoiceSettings): Promise<void> {
		const wakeSessionId = this.wakeSessionId;
		await this.syncVoiceOverlay(
			{
				visible: true,
				state: "wake-listening",
				transcript: "",
				currentStep: `Listening for "${settings.wakeWord}"`,
				wakeWord: settings.wakeWord,
			},
			wakeSessionId,
		);
		if (!this.isWakeSessionActive(wakeSessionId)) return;
		await this.startWakeListening();
	}

	private async syncVoiceOverlay(overlay: VoiceOverlayState, wakeSessionId?: number): Promise<void> {
		if (wakeSessionId !== undefined && !this.isWakeSessionActive(wakeSessionId)) return;
		this.applyOverlay(overlay);
		const next = await window.desktopAssistant.updateVoiceOverlay({ update: overlay });
		if (wakeSessionId === undefined || this.isWakeSessionActive(wakeSessionId)) {
			this.applyOverlay(next);
		}
	}

	private stopWakeDetector(): void {
		this.wakeSessionId += 1;
		this.wakeStartSessionId = undefined;
		this.wakeDetector?.stop();
		this.wakeDetector = undefined;
	}

	private isWakeSessionActive(wakeSessionId: number, detector?: WakeWordDetector): boolean {
		if (this.inputActive || this.wakeSessionId !== wakeSessionId) return false;
		return detector === undefined || this.wakeDetector === detector;
	}

	private applyOverlay(overlay: VoiceOverlayState): void {
		this.setSnapshot((current) => (current ? { ...current, voiceOverlay: overlay } : current));
	}
}

function buildWakeSettingsKey(snapshot: DesktopAssistantSnapshot): string {
	const voice = snapshot.settings.voice;
	return JSON.stringify({
		enabled: voice.enabled,
		wakeWordEnabled: voice.wakeWordEnabled,
		wakeWord: voice.wakeWord,
		language: voice.language,
		wakeEngine: voice.wakeEngine ?? "kws",
		activeOwwModelId: voice.activeOwwModelId ?? "",
		owwModelUrl: voice.owwModelUrl ?? "",
		owwThreshold: voice.owwThreshold ?? 0.5,
		kwsSensitivity: voice.kwsSensitivity ?? 0.6,
		kwsKeywords: voice.kwsKeywords ?? "",
		fuzzyThreshold: voice.fuzzyThreshold,
	});
}
