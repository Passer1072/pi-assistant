import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DesktopAgentService,
	isExternalBrowserControlToolName,
	normalizeBrowserSettings,
	normalizeSettings,
} from "../src/agent/desktop-agent-service.ts";
import { DryRunDesktopAutomationHost } from "../src/desktop/automation-host.ts";
import { DEFAULT_DESKTOP_ASSISTANT_SETTINGS } from "../src/shared/types.ts";

describe("isExternalBrowserControlToolName", () => {
	it("matches external browser-control MCP tools (mcp_browser_*)", () => {
		expect(isExternalBrowserControlToolName("mcp_browser_list_tabs")).toBe(true);
		expect(isExternalBrowserControlToolName("mcp_browser_control_take_control")).toBe(true);
		expect(isExternalBrowserControlToolName("mcp_browser_read_page")).toBe(true);
	});

	it("does not match the built-in browser_* tools or unrelated MCP tools", () => {
		expect(isExternalBrowserControlToolName("browser_open_url")).toBe(false);
		expect(isExternalBrowserControlToolName("browser_read_page")).toBe(false);
		expect(isExternalBrowserControlToolName("mcp_ncm_play")).toBe(false);
		expect(isExternalBrowserControlToolName("mcp_desktop_assistant_set")).toBe(false);
	});
});

describe("normalizeBrowserSettings", () => {
	it("returns the built-in default when given nothing", () => {
		const b = normalizeBrowserSettings(undefined);
		expect(b.defaultBrowser).toBe("built_in");
		expect(b.allowAiControl).toBe(true);
		expect(b.homeUrl).toBe(DEFAULT_DESKTOP_ASSISTANT_SETTINGS.browser.homeUrl);
		expect(b.maxTabs).toBe(DEFAULT_DESKTOP_ASSISTANT_SETTINGS.browser.maxTabs);
		expect(b.persistStorage).toBe(true);
	});

	it("keeps valid default browser targets", () => {
		expect(normalizeBrowserSettings({ defaultBrowser: "chrome" }).defaultBrowser).toBe("chrome");
		expect(normalizeBrowserSettings({ defaultBrowser: "edge" }).defaultBrowser).toBe("edge");
		expect(normalizeBrowserSettings({ defaultBrowser: "built_in" }).defaultBrowser).toBe("built_in");
	});

	it("falls back to the built-in default for invalid targets", () => {
		expect(normalizeBrowserSettings({ defaultBrowser: "firefox" as never }).defaultBrowser).toBe("built_in");
		expect(normalizeBrowserSettings({ defaultBrowser: "" as never }).defaultBrowser).toBe("built_in");
	});

	it("normalizes the home url, prefixing https when no scheme is present", () => {
		expect(normalizeBrowserSettings({ homeUrl: "example.com" }).homeUrl).toBe("https://example.com");
		expect(normalizeBrowserSettings({ homeUrl: "https://foo.dev" }).homeUrl).toBe("https://foo.dev");
		expect(normalizeBrowserSettings({ homeUrl: "about:blank" }).homeUrl).toBe("about:blank");
		expect(normalizeBrowserSettings({ homeUrl: "  " }).homeUrl).toBe(
			DEFAULT_DESKTOP_ASSISTANT_SETTINGS.browser.homeUrl,
		);
	});

	it("clamps maxTabs into [1, 32]", () => {
		expect(normalizeBrowserSettings({ maxTabs: 0 }).maxTabs).toBe(1);
		expect(normalizeBrowserSettings({ maxTabs: 999 }).maxTabs).toBe(32);
		expect(normalizeBrowserSettings({ maxTabs: 5 }).maxTabs).toBe(5);
	});

	it("is applied by normalizeSettings as the browser block", () => {
		const settings = normalizeSettings({ browser: { defaultBrowser: "edge" } as never });
		expect(settings.browser.defaultBrowser).toBe("edge");
		expect(settings.browser.persistStorage).toBe(true);
	});

	it("keeps the default shortcuts when none are provided", () => {
		const b = normalizeBrowserSettings(undefined);
		expect(b.shortcuts).toEqual(DEFAULT_DESKTOP_ASSISTANT_SETTINGS.browser.shortcuts);
	});

	it("drops invalid shortcuts, normalizes urls, and dedupes ids", () => {
		const b = normalizeBrowserSettings({
			shortcuts: [
				{ id: "a", label: "Example", url: "example.com" },
				{ id: "a", label: "Dup id", url: "https://dup.com" },
				{ id: "", label: "No id", url: "https://noid.com" },
				{ id: "b", label: "  ", url: "https://blank-label.com" },
				{ id: "c", label: "No url", url: "" },
			] as never,
		});
		expect(b.shortcuts).toHaveLength(3);
		expect(b.shortcuts[0]).toEqual({ id: "a", label: "Example", url: "https://example.com", iconUrl: undefined });
		// duplicate id was reassigned, so both survive with distinct ids
		const ids = new Set(b.shortcuts.map((s) => s.id));
		expect(ids.size).toBe(3);
		expect(b.shortcuts.map((s) => s.label)).toEqual(["Example", "Dup id", "No id"]);
	});

	it("caps shortcuts at 24", () => {
		const many = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, label: `L${i}`, url: `https://x${i}.com` }));
		expect(normalizeBrowserSettings({ shortcuts: many as never }).shortcuts).toHaveLength(24);
	});

	it("normalizes aiBrowserPreference, defaulting and rejecting invalid values", () => {
		expect(normalizeBrowserSettings(undefined).aiBrowserPreference).toBe("built_in");
		expect(normalizeBrowserSettings({ aiBrowserPreference: "external" }).aiBrowserPreference).toBe("external");
		expect(normalizeBrowserSettings({ aiBrowserPreference: "auto" }).aiBrowserPreference).toBe("auto");
		expect(normalizeBrowserSettings({ aiBrowserPreference: "firefox" as never }).aiBrowserPreference).toBe(
			"built_in",
		);
	});

	it("validates the search template, falling back when %s or scheme is missing", () => {
		const d = DEFAULT_DESKTOP_ASSISTANT_SETTINGS.browser.searchTemplate;
		expect(normalizeBrowserSettings({ searchTemplate: "https://duckduckgo.com/?q=%s" }).searchTemplate).toBe(
			"https://duckduckgo.com/?q=%s",
		);
		expect(normalizeBrowserSettings({ searchTemplate: "https://example.com/search" }).searchTemplate).toBe(d);
		expect(normalizeBrowserSettings({ searchTemplate: "example.com/?q=%s" }).searchTemplate).toBe(d);
		expect(normalizeBrowserSettings({ searchTemplate: 42 as never }).searchTemplate).toBe(d);
	});
});

describe("browser settings persistence", () => {
	it("loads persisted shortcuts after the service restarts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "desktop-browser-settings-"));
		try {
			const service = new DesktopAgentService({
				cwd: process.cwd(),
				agentDir: dir,
				host: new DryRunDesktopAutomationHost(),
			});
			await service.updateSettings({
				browser: {
					...service.snapshot().settings.browser,
					shortcuts: [{ id: "custom-docs", label: "Docs", url: "example.com" }],
				},
			});

			const restarted = new DesktopAgentService({
				cwd: process.cwd(),
				agentDir: dir,
				host: new DryRunDesktopAutomationHost(),
			});

			expect(restarted.snapshot().settings.browser.shortcuts).toEqual([
				{ id: "custom-docs", label: "Docs", url: "https://example.com", iconUrl: undefined },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
