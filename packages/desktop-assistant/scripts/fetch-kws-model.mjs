// Downloads the sherpa-onnx keyword-spotting model used by the wake word engine
// and lays it out under resources/kws so detection runs fully offline at runtime.
//
//   node scripts/fetch-kws-model.mjs
//
// The model is a tiny (~3.3M param) streaming zipformer transducer trained on
// WenetSpeech, with pinyin (声母+韵母) modeling units. Keywords are supplied as a
// plain text file of model tokens, so NO per-word model training is needed — the
// default wake word "小派" maps to the tokens `x iǎo p ài`.
//
// Only the float epoch-12-avg-2 encoder/decoder/joiner + tokens.txt are kept; the
// int8 / alternate-epoch variants in the upstream archive are discarded.

import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const kwsDir = join(pkgRoot, "resources", "kws");

const MODEL = "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01";
const ARCHIVE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${MODEL}.tar.bz2`;

// upstream file name -> stable name used by the app
const FILES = {
	"encoder-epoch-12-avg-2-chunk-16-left-64.onnx": "encoder.onnx",
	"decoder-epoch-12-avg-2-chunk-16-left-64.onnx": "decoder.onnx",
	"joiner-epoch-12-avg-2-chunk-16-left-64.onnx": "joiner.onnx",
	"tokens.txt": "tokens.txt",
};

// "小派" in WenetSpeech pinyin tokens. Boost (:) raises recall; threshold (#)
// is the per-keyword trigger score (lower = easier to wake).
const DEFAULT_KEYWORDS = "x iǎo p ài @小派 :2.0 #0.20\n";

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function main() {
	await mkdir(kwsDir, { recursive: true });

	if (await exists(join(kwsDir, "encoder.onnx"))) {
		console.log("✓ resources/kws/encoder.onnx already present — KWS model ready.");
	} else {
		const tmp = await mkdtemp(join(tmpdir(), "pi-kws-"));
		const archive = join(tmp, `${MODEL}.tar.bz2`);
		try {
			console.log(`↓ ${ARCHIVE_URL}`);
			const response = await fetch(ARCHIVE_URL);
			if (!response.ok || !response.body) {
				throw new Error(`Failed to download model: ${response.status} ${response.statusText}`);
			}
			await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));

			console.log("⇡ extracting…");
			// bsdtar (Windows 10+, macOS) and GNU tar both auto-detect bzip2 with -xf.
			await execFileAsync("tar", ["-xf", archive, "-C", tmp]);

			const extracted = join(tmp, MODEL);
			for (const [src, dest] of Object.entries(FILES)) {
				await copyFile(join(extracted, src), join(kwsDir, dest));
				console.log(`✓ resources/kws/${dest}`);
			}
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	}

	const keywordsPath = join(kwsDir, "keywords.txt");
	if (!(await exists(keywordsPath))) {
		await writeFile(keywordsPath, DEFAULT_KEYWORDS, "utf-8");
		console.log("✓ resources/kws/keywords.txt (default 小派)");
	} else {
		const current = await readFile(keywordsPath, "utf-8");
		console.log(`✓ resources/kws/keywords.txt present: ${current.trim().split("\n")[0]}`);
	}

	console.log("\nKWS wake word engine ready. Default wake word: 小派");
}

main().catch((error) => {
	console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
	console.error("  Ensure 'tar' is available (Windows 10+, macOS, Linux all ship it).");
	process.exit(1);
});
