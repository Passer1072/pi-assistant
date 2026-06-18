import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { buildKeywordsFileContent, KWS_KEYWORD_SCORE, sensitivityToThreshold } from "./kws-keywords.ts";

const require = createRequire(import.meta.url);

// ── Minimal typed surface of the parts of sherpa-onnx-node we use ─────────────

interface OnlineStreamLike {
	handle: unknown;
	acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void;
}

interface KeywordSpotterLike {
	createStream(): OnlineStreamLike;
	isReady(stream: OnlineStreamLike): boolean;
	decode(stream: OnlineStreamLike): void;
	reset(stream: OnlineStreamLike): void;
	getResult(stream: OnlineStreamLike): { keyword: string; tokens: string[] };
}

interface KeywordSpotterConfig {
	featConfig: { sampleRate: number; featureDim: number };
	modelConfig: {
		transducer: { encoder: string; decoder: string; joiner: string };
		tokens: string;
		numThreads: number;
		provider: string;
		debug: boolean;
	};
	keywordsFile: string;
	keywordsScore: number;
	keywordsThreshold: number;
	maxActivePaths: number;
}

interface SherpaModule {
	KeywordSpotter: new (config: KeywordSpotterConfig) => KeywordSpotterLike;
}

const MODEL_FILES = ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"] as const;
const REWAKE_GUARD_MS = 1500;

export interface KwsStartOptions {
	wakeWord: string;
	/** 0..1; higher is easier to wake. */
	sensitivity: number;
	/** Advanced: raw keywords-file content (model tokens) that overrides the wake word. */
	keywordsOverride?: string;
	onWake: (keyword: string) => void;
}

/**
 * Always-on keyword spotting backed by sherpa-onnx (native, fully offline).
 * Runs in the main process; the renderer streams 16 kHz mono frames in via IPC.
 *
 * The spotter (which loads ~13 MB of ONNX) is cached and only rebuilt when the
 * effective keywords or threshold change. A start/stop cycle just swaps the
 * lightweight per-session stream, so toggling wake listening is cheap.
 */
export class KwsService {
	private readonly modelDir: string;
	private readonly keywordsDir: string;
	private sherpa: SherpaModule | null | undefined;
	private spotter: KeywordSpotterLike | undefined;
	private spotterKey = "";
	private stream: OnlineStreamLike | undefined;
	private onWake: ((keyword: string) => void) | undefined;
	private active = false;
	private lastWakeAt = 0;
	private tokenSet: Set<string> | undefined;

	constructor(options: { modelDir: string; keywordsDir: string }) {
		this.modelDir = options.modelDir;
		this.keywordsDir = options.keywordsDir;
	}

	/** True when the native binary loaded and all model files are on disk. */
	isAvailable(): boolean {
		return this.loadSherpa() !== null && this.modelFilesPresent();
	}

	/** Configures the spotter for the given wake word and opens a fresh stream. */
	start(options: KwsStartOptions): { available: boolean } {
		const sherpa = this.loadSherpa();
		if (!sherpa || !this.modelFilesPresent()) return { available: false };

		const threshold = sensitivityToThreshold(options.sensitivity);
		const keywords = this.resolveKeywords(options.wakeWord, options.sensitivity, options.keywordsOverride);
		// Key on the keyword *content* (not the fixed file path) so changing the wake
		// word at the same sensitivity still rebuilds the spotter.
		const key = `${this.modelDir}|${keywords.tag}|${threshold}`;
		if (key !== this.spotterKey || !this.spotter) {
			this.spotter = new sherpa.KeywordSpotter(this.buildConfig(keywords.path, threshold));
			this.spotterKey = key;
		}
		this.stream = this.spotter.createStream();
		this.onWake = options.onWake;
		this.lastWakeAt = 0;
		this.active = true;
		return { available: true };
	}

	/** Feeds one frame of mono audio and reports a wake when a keyword is spotted. */
	acceptFrame(samples: Float32Array, sampleRate: number): void {
		if (!this.active || !this.spotter || !this.stream || samples.length === 0) return;
		const spotter = this.spotter;
		const stream = this.stream;
		stream.acceptWaveform({ samples, sampleRate });
		while (spotter.isReady(stream)) spotter.decode(stream);
		const result = spotter.getResult(stream);
		if (result.keyword && result.keyword.length > 0) {
			spotter.reset(stream);
			const now = Date.now();
			if (now - this.lastWakeAt < REWAKE_GUARD_MS) return;
			this.lastWakeAt = now;
			this.onWake?.(result.keyword);
		}
	}

	/** Ends the current session but keeps the spotter cached for a fast restart. */
	stop(): void {
		this.active = false;
		this.stream = undefined;
		this.onWake = undefined;
	}

	/** Fully releases the spotter (e.g. on window close). */
	dispose(): void {
		this.stop();
		this.spotter = undefined;
		this.spotterKey = "";
	}

	private buildConfig(keywordsFile: string, threshold: number): KeywordSpotterConfig {
		return {
			featConfig: { sampleRate: 16000, featureDim: 80 },
			modelConfig: {
				transducer: {
					encoder: join(this.modelDir, "encoder.onnx"),
					decoder: join(this.modelDir, "decoder.onnx"),
					joiner: join(this.modelDir, "joiner.onnx"),
				},
				tokens: join(this.modelDir, "tokens.txt"),
				numThreads: 1,
				provider: "cpu",
				debug: false,
			},
			keywordsFile,
			keywordsScore: KWS_KEYWORD_SCORE,
			keywordsThreshold: threshold,
			maxActivePaths: 4,
		};
	}

	/**
	 * Writes the generated keywords to userData and returns its path plus a cache
	 * tag derived from the content, or falls back to the model's shipped
	 * keywords.txt when the wake word is unknown.
	 */
	private resolveKeywords(wakeWord: string, sensitivity: number, override?: string): { path: string; tag: string } {
		const built = buildKeywordsFileContent(wakeWord, sensitivity, override, this.loadTokenSet());
		if (!built.content) return { path: join(this.modelDir, "keywords.txt"), tag: "shipped" };
		mkdirSync(this.keywordsDir, { recursive: true });
		const path = join(this.keywordsDir, "active-keywords.txt");
		writeFileSync(path, built.content, "utf-8");
		return { path, tag: built.content };
	}

	/** Loads and caches the model's token vocabulary (one token per line: "<token> <id>"). */
	private loadTokenSet(): Set<string> | undefined {
		if (this.tokenSet) return this.tokenSet;
		try {
			const content = readFileSync(join(this.modelDir, "tokens.txt"), "utf-8");
			const set = new Set<string>();
			for (const line of content.split(/\r?\n/)) {
				const token = line.split(/\s+/)[0];
				if (token) set.add(token);
			}
			this.tokenSet = set;
			return set;
		} catch {
			return undefined;
		}
	}

	private modelFilesPresent(): boolean {
		return MODEL_FILES.every((file) => existsSync(join(this.modelDir, file)));
	}

	private loadSherpa(): SherpaModule | null {
		if (this.sherpa !== undefined) return this.sherpa;
		try {
			this.sherpa = require("sherpa-onnx-node") as SherpaModule;
		} catch {
			this.sherpa = null;
		}
		return this.sherpa;
	}
}
