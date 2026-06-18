/// <reference lib="dom" />

import * as ort from "onnxruntime-web";
import { VOICE_SAMPLE_RATE } from "../../../src/voice/audio-format.ts";

// openWakeWord feature pipeline constants. See:
// https://github.com/dscripka/openWakeWord (utils.AudioFeatures)
const MEL_BINS = 32; // mel bands produced by melspectrogram.onnx
export const EMBEDDING_WINDOW = 76; // mel frames consumed per embedding
export const EMBEDDING_STEP = 8; // mel-frame hop between embeddings (~80ms)
const CLASSIFIER_FRAMES = 16; // embeddings consumed by the wake-word classifier
const MEL_DIVISOR = 10; // openWakeWord normalizes mel output as mel/10 + 2
const MEL_OFFSET = 2;

// ~10ms per mel frame, so the classifier needs (16-1)*8 + 76 = 196 mel frames
// (~2.0s) of audio. Keep a rolling 2.1s window and evaluate every 80ms.
export const WINDOW_SAMPLES = Math.round(VOICE_SAMPLE_RATE * 2.1);
export const STEP_SAMPLES = 1280;

let ortConfigured = false;

function configureOrt(): void {
	if (ortConfigured) return;
	ortConfigured = true;
	// Force single-threaded execution: threaded wasm needs SharedArrayBuffer +
	// COOP/COEP, which the Electron file:// renderer does not provide.
	ort.env.wasm.numThreads = 1;
	ort.env.logLevel = "error";
}

/**
 * Runs the openWakeWord melspectrogram -> embedding -> classifier pipeline over a
 * raw 16kHz mono window and returns the activation probability (0..1).
 */
export class OpenWakeWordRuntime {
	private melSession: ort.InferenceSession;
	private embeddingSession: ort.InferenceSession;
	private classifierSession: ort.InferenceSession;

	private constructor(mel: ort.InferenceSession, embedding: ort.InferenceSession, classifier: ort.InferenceSession) {
		this.melSession = mel;
		this.embeddingSession = embedding;
		this.classifierSession = classifier;
	}

	static async load(classifier: string | Uint8Array, baseHref = globalThis.location?.href ?? "file:///"): Promise<OpenWakeWordRuntime> {
		configureOrt();
		const baseDir = new URL("models/oww/", baseHref);
		const melUrl = new URL("melspectrogram.onnx", baseDir).toString();
		const embeddingUrl = new URL("embedding_model.onnx", baseDir).toString();
		const options: ort.InferenceSession.SessionOptions = { executionProviders: ["wasm"] };
		const classifierSessionPromise =
			typeof classifier === "string"
				? ort.InferenceSession.create(classifier, options)
				: ort.InferenceSession.create(classifier, options);
		const [mel, embedding, classifierSession] = await Promise.all([
			ort.InferenceSession.create(melUrl, options),
			ort.InferenceSession.create(embeddingUrl, options),
			classifierSessionPromise,
		]);
		return new OpenWakeWordRuntime(mel, embedding, classifierSession);
	}

	async score(window: Float32Array): Promise<number> {
		const mels = await this.computeMels(window);
		const frames = Math.floor(mels.length / MEL_BINS);
		if (frames < EMBEDDING_WINDOW) return 0;
		const embeddings = await this.computeEmbeddings(mels, frames);
		if (embeddings.length < CLASSIFIER_FRAMES) return 0;
		return this.classify(embeddings.slice(-CLASSIFIER_FRAMES));
	}

	private async computeMels(window: Float32Array): Promise<Float32Array> {
		const name = this.melSession.inputNames[0];
		const tensor = new ort.Tensor("float32", window, [1, window.length]);
		const output = await this.melSession.run({ [name]: tensor });
		const raw = output[this.melSession.outputNames[0]].data as Float32Array;
		const mels = new Float32Array(raw.length);
		for (let i = 0; i < raw.length; i += 1) mels[i] = raw[i] / MEL_DIVISOR + MEL_OFFSET;
		return mels;
	}

	private async computeEmbeddings(mels: Float32Array, frames: number): Promise<Float32Array[]> {
		const name = this.embeddingSession.inputNames[0];
		const outName = this.embeddingSession.outputNames[0];
		const embeddings: Float32Array[] = [];
		for (let start = 0; start + EMBEDDING_WINDOW <= frames; start += EMBEDDING_STEP) {
			const slice = mels.subarray(start * MEL_BINS, (start + EMBEDDING_WINDOW) * MEL_BINS);
			const tensor = new ort.Tensor("float32", slice, [1, EMBEDDING_WINDOW, MEL_BINS, 1]);
			const output = await this.embeddingSession.run({ [name]: tensor });
			embeddings.push(output[outName].data as Float32Array);
		}
		return embeddings;
	}

	private async classify(embeddings: Float32Array[]): Promise<number> {
		const featureSize = embeddings[0]?.length ?? 0;
		const flat = new Float32Array(embeddings.length * featureSize);
		embeddings.forEach((embedding, index) => flat.set(embedding, index * featureSize));
		const name = this.classifierSession.inputNames[0];
		const tensor = new ort.Tensor("float32", flat, [1, embeddings.length, featureSize]);
		const output = await this.classifierSession.run({ [name]: tensor });
		const data = output[this.classifierSession.outputNames[0]].data as Float32Array;
		return data[0] ?? 0;
	}
}
