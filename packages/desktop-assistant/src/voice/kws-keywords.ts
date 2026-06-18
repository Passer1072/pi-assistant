// Pure helpers that turn a wake word + sensitivity into a sherpa-onnx keyword
// spotter "keywords file" line. The WenetSpeech KWS model uses pinyin modeling
// units (声母 + 韵母), so a wake word must be expressed as space-separated model
// tokens — e.g. "小派" -> "x iǎo p ài". Any Chinese wake word is converted
// automatically via pinyin-pro and validated against the model's token vocabulary.
//
// Keyword line format (see sherpa-onnx docs):
//   <token> <token> ... @<display> :<boost> #<threshold>
// where :boost raises recall and #threshold is the per-keyword trigger score
// (lower = easier to wake).

import { pinyin } from "pinyin-pro";

/** Boost applied to the wake word so a short 2-syllable phrase still triggers. */
export const KWS_KEYWORD_SCORE = 2.0;

// Pinyin initials (声母). Two-letter initials come first so they win over their
// single-letter prefixes (e.g. "zh" before "z", "sh" before "s").
const PINYIN_INITIALS = [
	"zh",
	"ch",
	"sh",
	"b",
	"p",
	"m",
	"f",
	"d",
	"t",
	"n",
	"l",
	"g",
	"k",
	"h",
	"j",
	"q",
	"x",
	"r",
	"z",
	"c",
	"s",
	"y",
	"w",
];

export function normalizeWakeWord(wakeWord: string): string {
	return wakeWord.normalize("NFKC").trim();
}

/**
 * Maps a 0..1 sensitivity (higher = easier to wake) to a sherpa-onnx keyword
 * threshold. Clamped to a sane band so the slider can never fully disable or
 * spam the detector.
 */
export function sensitivityToThreshold(sensitivity: number): number {
	const clamped = Math.max(0, Math.min(1, Number.isFinite(sensitivity) ? sensitivity : 0.6));
	// sensitivity 0 -> 0.35 (strict), 1 -> 0.10 (loose)
	const threshold = 0.35 - clamped * 0.25;
	return Math.round(threshold * 100) / 100;
}

/** Splits one tone-marked pinyin syllable (e.g. "xiǎo") into model tokens (["x", "iǎo"]). */
function syllableToTokens(syllable: string): string[] {
	for (const initial of PINYIN_INITIALS) {
		if (syllable.startsWith(initial)) {
			const final = syllable.slice(initial.length);
			return final ? [initial, final] : [initial];
		}
	}
	return [syllable];
}

/**
 * Converts a Chinese wake word into space-separated sherpa-onnx model tokens
 * (pinyin 声母+韵母). Returns undefined when any syllable yields a token outside
 * the model's vocabulary (e.g. non-Chinese input or an unsupported reading), so
 * the caller can fall back instead of registering a keyword the model can't spot.
 */
export function wakeWordToTokens(wakeWord: string, tokenSet: ReadonlySet<string>): string | undefined {
	const word = normalizeWakeWord(wakeWord);
	if (!word) return undefined;
	const syllables = pinyin(word, { toneType: "symbol", type: "array", v: false });
	const tokens: string[] = [];
	for (const syllable of syllables) {
		for (const token of syllableToTokens(syllable)) {
			if (!tokenSet.has(token)) return undefined;
			tokens.push(token);
		}
	}
	return tokens.length > 0 ? tokens.join(" ") : undefined;
}

export interface KeywordsBuildResult {
	/** The keywords-file content, or undefined when the wake word can't be tokenized. */
	content: string | undefined;
	source: "override" | "auto" | "unknown";
}

/**
 * Builds the keywords-file content for a wake word. Returns `content: undefined`
 * with `source: "unknown"` when the wake word can't be converted (and no override
 * was supplied), so the caller can fall back to the shipped default.
 */
export function buildKeywordsFileContent(
	wakeWord: string,
	sensitivity: number,
	override?: string,
	tokenSet?: ReadonlySet<string>,
): KeywordsBuildResult {
	const trimmedOverride = override?.trim();
	if (trimmedOverride) {
		return { content: trimmedOverride.endsWith("\n") ? trimmedOverride : `${trimmedOverride}\n`, source: "override" };
	}

	const tokens = tokenSet ? wakeWordToTokens(wakeWord, tokenSet) : undefined;
	if (!tokens) {
		return { content: undefined, source: "unknown" };
	}

	const threshold = sensitivityToThreshold(sensitivity).toFixed(2);
	const display = normalizeWakeWord(wakeWord);
	return { content: `${tokens} @${display} :${KWS_KEYWORD_SCORE} #${threshold}\n`, source: "auto" };
}
