import { describe, expect, it } from "vitest";
import {
	buildKeywordsFileContent,
	normalizeWakeWord,
	sensitivityToThreshold,
	wakeWordToTokens,
} from "../src/voice/kws-keywords.ts";

// A subset of the model's pinyin token vocabulary, enough to cover the words
// exercised below. Keeps the unit tests hermetic (no dependency on the fetched
// model files).
const tokenSet = new Set(["x", "iǎo", "p", "ài", "n", "ǐ", "h", "ǎo", "w", "èn"]);

describe("sensitivityToThreshold", () => {
	it("maps low sensitivity to a strict threshold and high to a loose one", () => {
		expect(sensitivityToThreshold(0)).toBe(0.35);
		expect(sensitivityToThreshold(1)).toBe(0.1);
		expect(sensitivityToThreshold(0.6)).toBe(0.2);
	});

	it("clamps out-of-range and non-finite values", () => {
		expect(sensitivityToThreshold(-5)).toBe(0.35);
		expect(sensitivityToThreshold(5)).toBe(0.1);
		expect(sensitivityToThreshold(Number.NaN)).toBe(0.2);
	});
});

describe("wakeWordToTokens", () => {
	it("converts the default 小派 wake word to verified pinyin tokens", () => {
		expect(wakeWordToTokens("小派", tokenSet)).toBe("x iǎo p ài");
	});

	it("converts an arbitrary Chinese wake word (matches the model's own example)", () => {
		expect(wakeWordToTokens("你好问问", tokenSet)).toBe("n ǐ h ǎo w èn w èn");
	});

	it("returns undefined when a token falls outside the model vocabulary", () => {
		// 排 (pái) -> needs "ái", which is not in this restricted token set.
		expect(wakeWordToTokens("小排", tokenSet)).toBeUndefined();
	});

	it("returns undefined for non-Chinese input so the caller can fall back", () => {
		expect(wakeWordToTokens("hello", tokenSet)).toBeUndefined();
		expect(wakeWordToTokens("   ", tokenSet)).toBeUndefined();
	});
});

describe("buildKeywordsFileContent", () => {
	it("auto-builds a keyword line for a Chinese wake word", () => {
		const result = buildKeywordsFileContent("小派", 0.6, undefined, tokenSet);
		expect(result.source).toBe("auto");
		expect(result.content).toBe("x iǎo p ài @小派 :2 #0.20\n");
	});

	it("uses the supplied sensitivity for the per-keyword threshold", () => {
		expect(buildKeywordsFileContent("小派", 1, undefined, tokenSet).content).toContain("#0.10");
		expect(buildKeywordsFileContent("小派", 0, undefined, tokenSet).content).toContain("#0.35");
	});

	it("passes an advanced override through verbatim with a trailing newline", () => {
		const result = buildKeywordsFileContent("anything", 0.6, "n ǐ h ǎo @你好 :1.5", tokenSet);
		expect(result.source).toBe("override");
		expect(result.content).toBe("n ǐ h ǎo @你好 :1.5\n");
	});

	it("returns no content when the wake word can't be tokenized", () => {
		const result = buildKeywordsFileContent("小排", 0.6, undefined, tokenSet);
		expect(result.source).toBe("unknown");
		expect(result.content).toBeUndefined();
	});

	it("returns no content when no token vocabulary is available", () => {
		expect(buildKeywordsFileContent("小派", 0.6).source).toBe("unknown");
	});

	it("normalizes wake word whitespace before conversion", () => {
		expect(normalizeWakeWord("  小派 ")).toBe("小派");
		expect(buildKeywordsFileContent("  小派 ", 0.6, undefined, tokenSet).source).toBe("auto");
	});
});
