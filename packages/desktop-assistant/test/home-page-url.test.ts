import { describe, expect, it } from "vitest";
import { resolveOmniboxUrl } from "../renderer/src/browser/home-page-url.ts";

const GOOGLE = "https://www.google.com/search?q=%s";

describe("resolveOmniboxUrl", () => {
	it("returns empty string for blank input", () => {
		expect(resolveOmniboxUrl("", GOOGLE)).toBe("");
		expect(resolveOmniboxUrl("   ", GOOGLE)).toBe("");
	});

	it("passes through inputs that already have a scheme", () => {
		expect(resolveOmniboxUrl("https://foo.com/x", GOOGLE)).toBe("https://foo.com/x");
		expect(resolveOmniboxUrl("about:blank", GOOGLE)).toBe("about:blank");
		expect(resolveOmniboxUrl("file:///c:/x.html", GOOGLE)).toBe("file:///c:/x.html");
	});

	it("treats bare hosts and domains as URLs with https", () => {
		expect(resolveOmniboxUrl("example.com", GOOGLE)).toBe("https://example.com");
		expect(resolveOmniboxUrl("a.b.co/path?x=1", GOOGLE)).toBe("https://a.b.co/path?x=1");
		expect(resolveOmniboxUrl("localhost:3000", GOOGLE)).toBe("https://localhost:3000");
		expect(resolveOmniboxUrl("localhost", GOOGLE)).toBe("https://localhost");
	});

	it("treats multi-word or dotless input as a search query", () => {
		expect(resolveOmniboxUrl("world travel", GOOGLE)).toBe("https://www.google.com/search?q=world%20travel");
		expect(resolveOmniboxUrl("电视剧推荐", GOOGLE)).toBe(
			`https://www.google.com/search?q=${encodeURIComponent("电视剧推荐")}`,
		);
		expect(resolveOmniboxUrl("hello", GOOGLE)).toBe("https://www.google.com/search?q=hello");
	});

	it("respects a custom search template", () => {
		expect(resolveOmniboxUrl("cats", "https://www.bing.com/search?q=%s")).toBe("https://www.bing.com/search?q=cats");
	});

	it("falls back to Google when the template lacks %s", () => {
		expect(resolveOmniboxUrl("cats", "https://broken")).toBe("https://www.google.com/search?q=cats");
	});
});
