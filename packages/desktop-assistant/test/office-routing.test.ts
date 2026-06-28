import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DesktopAgentService,
	normalizeAiOfficePreference,
	normalizeOfficeSettings,
	normalizeSettings,
} from "../src/agent/desktop-agent-service.ts";
import { buildOfficeRoutingAppendPrompt } from "../src/agent/office-routing.ts";
import { DryRunDesktopAutomationHost } from "../src/desktop/automation-host.ts";
import { DEFAULT_DESKTOP_ASSISTANT_SETTINGS } from "../src/shared/types.ts";

describe("Office routing settings", () => {
	it("builds distinct routing prompts for live, file, and auto modes", () => {
		expect(buildOfficeRoutingAppendPrompt("live")).toContain("prefers live Office collaboration");
		expect(buildOfficeRoutingAppendPrompt("file")).toContain("prefers file-level Office work");
		expect(buildOfficeRoutingAppendPrompt("auto")).toContain("Two Office control surfaces");
	});

	it("normalizes Office preference settings", () => {
		expect(normalizeOfficeSettings(undefined).aiOfficePreference).toBe("auto");
		expect(normalizeOfficeSettings({ aiOfficePreference: "live" }).aiOfficePreference).toBe("live");
		expect(normalizeOfficeSettings({ aiOfficePreference: "file" }).aiOfficePreference).toBe("file");
		expect(normalizeAiOfficePreference("bad", "auto")).toBe("auto");
		expect(normalizeSettings({ office: { aiOfficePreference: "live" } }).office.aiOfficePreference).toBe("live");
	});

	it("filters live and file Office MCP tools by user preference and capability gates", async () => {
		const dir = mkdtempSync(join(tmpdir(), "desktop-assistant-office-routing-"));
		try {
			const service = new DesktopAgentService({
				cwd: process.cwd(),
				agentDir: dir,
				host: new DryRunDesktopAutomationHost(),
				settings: {
					office: { aiOfficePreference: "live" },
					capabilities: {
						...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.capabilities,
						document: { enabled: true, commandFirst: true, skillName: "document-operation" },
					},
				},
			});
			const isEnabled = (service as unknown as { isMcpToolEnabled(name: string): boolean }).isMcpToolEnabled.bind(
				service,
			);

			expect(isEnabled("mcp_word_replace_selection")).toBe(true);
			expect(isEnabled("mcp_xlsx_write_range")).toBe(false);
			expect(isEnabled("mcp_pptx_add_slide")).toBe(false);

			await service.updateSettings({
				office: { aiOfficePreference: "file" },
			});
			expect(isEnabled("mcp_word_replace_selection")).toBe(false);
			expect(isEnabled("mcp_xlsx_write_range")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
