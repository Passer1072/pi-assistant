import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WakeWordModelStore } from "../src/main/wake-word-model-store.ts";

describe("WakeWordModelStore", () => {
	it("imports and persists multiple openWakeWord classifier models", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-wake-models-"));
		const sourceA = join(root, "xiaopai.onnx");
		const sourceB = join(root, "hey-pi.onnx");
		await writeFile(sourceA, new Uint8Array([1, 2, 3]));
		await writeFile(sourceB, new Uint8Array([4, 5]));

		const store = new WakeWordModelStore(join(root, "store"));
		const first = await store.importModel(sourceA, { wakeWord: "小派" });
		const second = await store.importModel(sourceB, { wakeWord: "Hi PI", label: "English wake word" });

		expect(first.fileName).toBe(`${first.id}.onnx`);
		expect(first.wakeWord).toBe("xiaopai");
		expect(first.label).toBe("xiaopai");
		expect(second.wakeWord).toBe("hey-pi");
		expect(second.label).toBe("English wake word");
		expect(second.sizeBytes).toBe(2);

		const reloaded = new WakeWordModelStore(join(root, "store"));
		const models = await reloaded.list();
		expect(models.map((model) => model.id).sort()).toEqual([first.id, second.id].sort());
		expect(models.find((model) => model.id === first.id)?.wakeWord).toBe("xiaopai");
	});

	it("reads copied model bytes and deletes model metadata plus file", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-wake-models-"));
		const source = join(root, "wake.onnx");
		await writeFile(source, new Uint8Array([9, 8, 7, 6]));

		const store = new WakeWordModelStore(join(root, "store"));
		const model = await store.importModel(source, { wakeWord: "小派" });
		const copiedPath = join(root, "store", model.fileName);

		const read = await store.readModel(model.id);
		expect(read.model.id).toBe(model.id);
		expect([...new Uint8Array(read.data)]).toEqual([9, 8, 7, 6]);

		await expect(readFile(copiedPath)).resolves.toHaveLength(4);
		await expect(store.deleteModel(model.id)).resolves.toEqual([]);
		await expect(readFile(copiedPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects non-onnx files", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-wake-models-"));
		const source = join(root, "wake.txt");
		await writeFile(source, "not a model");

		const store = new WakeWordModelStore(join(root, "store"));
		await expect(store.importModel(source, { wakeWord: "小派" })).rejects.toThrow("Only .onnx");
	});
});
