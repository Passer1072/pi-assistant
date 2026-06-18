import { describe, expect, it } from "vitest";
import { normalizeSandboxSettings, normalizeSettings } from "../src/agent/desktop-agent-service.ts";
import { DEFAULT_SANDBOX_SETTINGS } from "../src/shared/types.ts";

describe("normalizeSandboxSettings", () => {
	it("returns the balanced default when given nothing", () => {
		const s = normalizeSandboxSettings(undefined);
		expect(s.enabled).toBe(true);
		expect(s.preset).toBe("balanced");
		expect(s.aiMayEdit).toBe("tighten_only");
		expect(s.commands.denyPatterns).toEqual(DEFAULT_SANDBOX_SETTINGS.commands.denyPatterns);
	});

	it("deep-merges partial updates and keeps defaults for missing nested fields", () => {
		const s = normalizeSandboxSettings({ workspace: { quotaMb: 4096 } as never });
		expect(s.workspace.quotaMb).toBe(4096);
		// untouched nested fields fall back to defaults
		expect(s.workspace.overQuotaPolicy).toBe(DEFAULT_SANDBOX_SETTINGS.workspace.overQuotaPolicy);
		expect(s.filesystem.writeRoots).toEqual(DEFAULT_SANDBOX_SETTINGS.filesystem.writeRoots);
	});

	it("clamps out-of-range numbers", () => {
		const s = normalizeSandboxSettings({
			workspace: { quotaMb: 1 } as never,
			resourceLimits: { commandTimeoutMs: 1, maxConcurrentProcesses: 999 } as never,
		});
		expect(s.workspace.quotaMb).toBe(64);
		expect(s.resourceLimits.commandTimeoutMs).toBe(1000);
		expect(s.resourceLimits.maxConcurrentProcesses).toBe(64);
	});

	it("drops invalid tool gates and dedupes/trims string arrays", () => {
		const s = normalizeSandboxSettings({
			toolGates: { good: "deny", bad: "nonsense" } as never,
			filesystem: { protectedPaths: [" c:\\x ", "c:\\x", ""] } as never,
		});
		expect(s.toolGates.good).toBe("deny");
		expect(s.toolGates.bad).toBeUndefined();
		expect(s.filesystem.protectedPaths).toEqual(["c:\\x"]);
	});

	it("forces aiMayEdit to tighten_only regardless of input", () => {
		const s = normalizeSandboxSettings({ aiMayEdit: "anything" } as never);
		expect(s.aiMayEdit).toBe("tighten_only");
	});
});

describe("normalizeSettings — sandbox integration", () => {
	it("fills a balanced sandbox for installs that predate the field", () => {
		const s = normalizeSettings({});
		expect(s.sandbox).toBeDefined();
		expect(s.sandbox.enabled).toBe(true);
		expect(s.sandbox.preset).toBe("balanced");
	});
});
