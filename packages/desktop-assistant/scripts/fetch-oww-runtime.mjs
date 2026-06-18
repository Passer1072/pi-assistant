// Downloads the openWakeWord base models into resources/public so the wake word
// engine runs fully offline. The onnxruntime-web wasm is bundled automatically by
// Vite at build time, so it is NOT vendored here.
//
//   node scripts/fetch-oww-runtime.mjs
//
// The "小派" classifier model is NOT downloaded here — train it with the openWakeWord
// automatic training notebook and drop the result at:
//   resources/public/models/oww/xiaopai.onnx
// See packages/desktop-assistant/docs/wake-word.md for instructions.

import { createWriteStream } from "node:fs";
import { mkdir, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const owwDir = join(pkgRoot, "resources", "public", "models", "oww");

const BASE_MODEL_RELEASE = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1";
const BASE_MODELS = ["melspectrogram.onnx", "embedding_model.onnx"];

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function download(url, dest) {
	if (await exists(dest)) {
		console.log(`✓ ${dest} (already present)`);
		return;
	}
	console.log(`↓ ${url}`);
	const response = await fetch(url);
	if (!response.ok || !response.body) {
		throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
	}
	await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
	console.log(`✓ ${dest}`);
}

await mkdir(owwDir, { recursive: true });

for (const model of BASE_MODELS) {
	await download(`${BASE_MODEL_RELEASE}/${model}`, join(owwDir, model));
}

if (await exists(join(owwDir, "xiaopai.onnx"))) {
	console.log("✓ xiaopai.onnx present — wake word engine ready.");
} else {
	console.log('\n⚠ xiaopai.onnx not found. Train the "小派" model (see docs/wake-word.md) and place it at:');
	console.log(`   ${join(owwDir, "xiaopai.onnx")}`);
	console.log("   Until then the app falls back to the Vosk wake listener.");
}
