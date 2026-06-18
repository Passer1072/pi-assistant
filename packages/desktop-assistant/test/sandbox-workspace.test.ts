import { describe, expect, it } from "vitest";
import {
	buildSandboxPathContext,
	canonicalize,
	expandRoots,
	isWithin,
	isWithinAny,
	resolvePathToken,
} from "../src/desktop/sandbox/sandbox-workspace.ts";

const ROOT = "C:\\Users\\me\\AppData\\Roaming\\app\\sandbox";

describe("canonicalize", () => {
	it("makes paths absolute, normalizes separators, and lowercases the drive", () => {
		expect(canonicalize("foo/bar", ROOT, { realpath: false })).toBe(
			`${ROOT.toLowerCase()[0]}${ROOT.slice(1)}\\foo\\bar`,
		);
		expect(canonicalize("C:/Windows/System32", ROOT, { realpath: false })).toBe("c:\\Windows\\System32");
	});

	it("collapses .. segments", () => {
		expect(canonicalize("C:/a/b/../c", ROOT, { realpath: false })).toBe("c:\\a\\c");
	});

	it("strips trailing separators", () => {
		expect(canonicalize("C:/a/b/", ROOT, { realpath: false })).toBe("c:\\a\\b");
	});
});

describe("isWithin / isWithinAny", () => {
	it("is case-insensitive and boundary-aware", () => {
		expect(isWithin("c:\\sandbox", "C:\\Sandbox\\file.txt")).toBe(true);
		expect(isWithin("c:\\sandbox", "c:\\sandbox")).toBe(true);
		expect(isWithin("c:\\sandbox", "c:\\sandbox-other\\x")).toBe(false);
		expect(isWithin("c:\\sandbox", "c:\\other\\x")).toBe(false);
	});

	it("matches against any of a set of roots", () => {
		expect(isWithinAny(["c:\\a", "c:\\b"], "c:\\b\\x")).toBe(true);
		expect(isWithinAny(["c:\\a", "c:\\b"], "c:\\c\\x")).toBe(false);
	});
});

describe("path tokens", () => {
	const ctx = buildSandboxPathContext({
		sandboxRoot: "C:\\sb",
		documents: "C:\\Users\\me\\Documents",
		windows: "C:\\Windows",
	});

	it("resolves known tokens to context paths", () => {
		expect(resolvePathToken("<sandbox>", ctx)).toBe("C:\\sb");
		expect(resolvePathToken("<documents>", ctx)).toBe("C:\\Users\\me\\Documents");
		expect(resolvePathToken("<system32>", ctx)).toBe("C:\\Windows\\System32");
	});

	it("passes through literal paths and unknown tokens", () => {
		expect(resolvePathToken("D:\\data", ctx)).toBe("D:\\data");
	});

	it("expandRoots resolves and canonicalizes a list", () => {
		const roots = expandRoots(["<sandbox>", "<documents>"], ctx);
		expect(roots).toContain("c:\\sb");
		expect(roots).toContain("c:\\Users\\me\\Documents");
	});
});
