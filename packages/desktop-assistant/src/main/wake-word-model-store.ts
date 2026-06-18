import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { WakeWordModelMetadata } from "../shared/types.ts";

interface WakeWordModelIndex {
	version: 1;
	models: WakeWordModelMetadata[];
}

const INDEX_FILE = "index.json";
const MODEL_ID_PATTERN = /^[a-f0-9-]{36}$/i;

export class WakeWordModelStore {
	private dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	async list(): Promise<WakeWordModelMetadata[]> {
		return (await this.readIndex()).models;
	}

	async importModel(
		sourcePath: string,
		options: { wakeWord?: string; label?: string },
	): Promise<WakeWordModelMetadata> {
		if (extname(sourcePath).toLowerCase() !== ".onnx") {
			throw new Error("Only .onnx openWakeWord models can be imported.");
		}
		const sourceDetails = await stat(sourcePath);
		if (!sourceDetails.isFile()) {
			throw new Error("Only file-based .onnx openWakeWord models can be imported.");
		}

		await this.ensureDir();
		const id = randomUUID();
		const fileName = `${id}.onnx`;
		const destination = join(this.dir, fileName);
		await copyFile(sourcePath, destination);
		const details = await stat(destination);
		const sourceName = basename(sourcePath, extname(sourcePath));
		const wakeWord = sourceName.trim();
		if (!wakeWord) {
			throw new Error("Wake word model file name must include the trained wake word.");
		}
		const label = options.label?.trim() || wakeWord;
		const model: WakeWordModelMetadata = {
			id,
			wakeWord,
			label,
			fileName,
			sizeBytes: details.size,
			importedAt: Date.now(),
		};
		const index = await this.readIndex();
		index.models = [...index.models, model].sort((left, right) => right.importedAt - left.importedAt);
		await this.writeIndex(index);
		return model;
	}

	async deleteModel(id: string): Promise<WakeWordModelMetadata[]> {
		validateModelId(id);
		const index = await this.readIndex();
		const model = index.models.find((entry) => entry.id === id);
		if (!model) return index.models;
		index.models = index.models.filter((entry) => entry.id !== id);
		await this.writeIndex(index);
		await rm(join(this.dir, model.fileName), { force: true });
		return index.models;
	}

	async readModel(id: string): Promise<{ model: WakeWordModelMetadata; data: ArrayBuffer }> {
		validateModelId(id);
		const model = (await this.list()).find((entry) => entry.id === id);
		if (!model) {
			throw new Error(`Wake word model not found: ${id}`);
		}
		const data = await readFile(join(this.dir, model.fileName));
		const buffer = new ArrayBuffer(data.byteLength);
		new Uint8Array(buffer).set(data);
		return {
			model,
			data: buffer,
		};
	}

	private async ensureDir(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
	}

	private async readIndex(): Promise<WakeWordModelIndex> {
		await this.ensureDir();
		try {
			const raw = await readFile(join(this.dir, INDEX_FILE), "utf-8");
			const parsed = JSON.parse(raw) as unknown;
			return normalizeIndex(parsed);
		} catch (error) {
			if (isMissingFileError(error)) return { version: 1, models: [] };
			throw error;
		}
	}

	private async writeIndex(index: WakeWordModelIndex): Promise<void> {
		await this.ensureDir();
		await writeFile(join(this.dir, INDEX_FILE), `${JSON.stringify(normalizeIndex(index), null, 2)}\n`, "utf-8");
	}
}

function normalizeIndex(value: unknown): WakeWordModelIndex {
	if (typeof value !== "object" || value === null) return { version: 1, models: [] };
	const rawModels = Array.isArray((value as { models?: unknown }).models)
		? (value as { models: unknown[] }).models
		: [];
	const models = rawModels.flatMap((entry) => {
		const model = normalizeModel(entry);
		return model ? [model] : [];
	});
	return { version: 1, models };
}

function normalizeModel(value: unknown): WakeWordModelMetadata | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const model = value as Partial<WakeWordModelMetadata>;
	if (
		typeof model.id !== "string" ||
		!MODEL_ID_PATTERN.test(model.id) ||
		typeof model.fileName !== "string" ||
		model.fileName !== `${model.id}.onnx`
	) {
		return undefined;
	}
	return {
		id: model.id,
		wakeWord: typeof model.wakeWord === "string" && model.wakeWord.trim() ? model.wakeWord.trim() : "小派",
		label: typeof model.label === "string" && model.label.trim() ? model.label.trim() : model.wakeWord || "Wake word",
		fileName: model.fileName,
		sizeBytes: normalizeNonNegativeNumber(model.sizeBytes),
		importedAt: normalizeNonNegativeNumber(model.importedAt),
	};
}

function normalizeNonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function validateModelId(id: string): void {
	if (!MODEL_ID_PATTERN.test(id)) {
		throw new Error(`Invalid wake word model id: ${id}`);
	}
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}
