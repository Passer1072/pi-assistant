import { describe, expect, it } from "vitest";
import {
	type BrowserToolHost,
	buildBrowserRoutingAppendPrompt,
	createBrowserToolDefinitions,
} from "../src/agent/browser-tools.ts";
import type { BrowserTarget } from "../src/shared/types.ts";

interface Recorded {
	method: string;
	target: BrowserTarget;
}

function setup(defaultBrowser: BrowserTarget = "built_in") {
	const calls: Recorded[] = [];
	const record =
		(method: string) =>
		async (target: BrowserTarget): Promise<unknown> => {
			calls.push({ method, target });
			return { ok: true };
		};
	const host: BrowserToolHost = {
		getDefaultBrowser: () => defaultBrowser,
		listTabs: record("listTabs"),
		openUrl: record("openUrl"),
		newTab: record("newTab"),
		switchTab: record("switchTab"),
		closeTab: record("closeTab"),
		closeWindow: record("closeWindow"),
		readPage: record("readPage"),
		queryElements: record("queryElements"),
		click: record("click"),
		typeText: record("typeText"),
		pressKey: record("pressKey"),
		scroll: record("scroll"),
		screenshot: record("screenshot"),
		getCookies: record("getCookies"),
		clearStorage: record("clearStorage"),
		virtualMouse: record("virtualMouse"),
	};
	const tools = createBrowserToolDefinitions(host);
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const run = (name: string, params: Record<string, unknown>) =>
		(byName.get(name) as { execute: (...args: unknown[]) => Promise<unknown> }).execute(
			"t",
			params,
			undefined,
			undefined,
			undefined,
		);
	return { calls, run };
}

describe("browser tool routing", () => {
	it("routes through the default browser when no override is given", async () => {
		const { calls, run } = setup("built_in");
		await run("browser_open_url", { url: "https://example.com" });
		expect(calls).toEqual([{ method: "openUrl", target: "built_in" }]);
	});

	it("uses the configured default browser, not a hardcoded one", async () => {
		const { calls, run } = setup("chrome");
		await run("browser_read_page", {});
		expect(calls[0]?.target).toBe("chrome");
	});

	it("honors an explicit one-time browser override without touching the default", async () => {
		const { calls, run } = setup("built_in");
		await run("browser_open_url", { url: "https://example.com", browser: "edge" });
		expect(calls[0]).toEqual({ method: "openUrl", target: "edge" });
	});

	it("exposes a built-in browser_list_tabs tool routed to the default browser", async () => {
		const { calls, run } = setup("built_in");
		await run("browser_list_tabs", {});
		expect(calls).toEqual([{ method: "listTabs", target: "built_in" }]);
	});

	it("closes the browser window through a dedicated tool instead of closing a tab", async () => {
		const { calls, run } = setup("built_in");
		await run("browser_close_window", {});
		expect(calls).toEqual([{ method: "closeWindow", target: "built_in" }]);
	});

	it("always closes the built-in browser window even when the default browser is external", async () => {
		const { calls, run } = setup("chrome");
		await run("browser_close_window", {});
		expect(calls).toEqual([{ method: "closeWindow", target: "built_in" }]);
	});

	it("reports tool failures as a failed result instead of throwing", async () => {
		const host: BrowserToolHost = {
			getDefaultBrowser: () => "built_in",
			openUrl: async () => {
				throw new Error("Chrome was not found.");
			},
		} as unknown as BrowserToolHost;
		const tools = createBrowserToolDefinitions(host);
		const tool = tools.find((item) => item.name === "browser_open_url") as {
			execute: (...args: unknown[]) => Promise<{ details: { status: string; stderr?: string } }>;
		};
		const result = await tool.execute("t", { url: "https://x.com" }, undefined, undefined, undefined);
		expect(result.details.status).toBe("failed");
		expect(result.details.stderr).toContain("Chrome was not found.");
	});
});

describe("buildBrowserRoutingAppendPrompt", () => {
	it("built_in: mandates browser_* and forbids the external browser MCP", () => {
		const prompt = buildBrowserRoutingAppendPrompt("built_in", "built_in");
		expect(prompt).toContain("you MUST use the browser_* tools");
		expect(prompt).toContain("Do NOT use external browser-control");
	});

	it("external: directs the model to the external browser-control MCP", () => {
		const prompt = buildBrowserRoutingAppendPrompt("chrome", "external");
		expect(prompt).toContain("EXTERNAL browser");
		expect(prompt).toContain("external browser-control MCP");
		expect(prompt).toContain("built-in browser_* tools are disabled");
	});

	it("auto: presents both surfaces and tells the model to pick one", () => {
		const prompt = buildBrowserRoutingAppendPrompt("built_in", "auto");
		expect(prompt).toContain("Two browser control surfaces");
		expect(prompt).toContain("Pick ONE surface");
	});

	it("defaults to the built_in policy when preference is omitted", () => {
		expect(buildBrowserRoutingAppendPrompt("built_in")).toContain("you MUST use the browser_* tools");
	});
});
