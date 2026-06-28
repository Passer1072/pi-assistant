import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExternalAppRegistry } from "../src/main/external-app-registry.ts";

describe("ExternalAppRegistry", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "more-apps-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("lists the built-in apps with defaults", () => {
		const registry = new ExternalAppRegistry(dir);
		const apps = registry.list();
		const ids = apps.map((app) => app.id);
		expect(ids).toContain("email-manager");
		expect(ids).toContain("ebook-library");
		const email = apps.find((app) => app.id === "email-manager");
		expect(email?.autoStart).toBe(false);
		expect(email?.ai?.basePath).toBe("/api/v1");
		expect(email?.builtIn).toBe(true);
	});

	it("merges and persists per-app overrides", () => {
		const registry = new ExternalAppRegistry(dir);
		const updated = registry.updateConfig("email-manager", { autoStart: true, port: 9123 });
		expect(updated?.autoStart).toBe(true);
		expect(updated?.port).toBe(9123);
		expect(existsSync(join(dir, "more-apps.json"))).toBe(true);

		// A fresh instance reads the persisted overrides back.
		const reopened = new ExternalAppRegistry(dir);
		const email = reopened.get("email-manager");
		expect(email?.autoStart).toBe(true);
		expect(email?.port).toBe(9123);
	});

	it("merges env overrides over the built-in env", () => {
		const registry = new ExternalAppRegistry(dir);
		registry.updateConfig("ebook-library", { env: { EBOOK_DEBUG: "1", EXTRA: "x" } });
		const ebook = registry.get("ebook-library");
		expect(ebook?.env?.EBOOK_DEBUG).toBe("1");
		expect(ebook?.env?.EXTRA).toBe("x");
		// Built-in defaults survive when not overridden.
		expect(ebook?.env?.EBOOK_OPEN_BROWSER).toBe("0");
	});

	it("returns undefined when updating an unknown app", () => {
		const registry = new ExternalAppRegistry(dir);
		expect(registry.updateConfig("nope", { autoStart: true })).toBeUndefined();
	});

	it("writes a versioned payload", () => {
		const registry = new ExternalAppRegistry(dir);
		registry.updateConfig("email-manager", { port: 8001 });
		const payload = JSON.parse(readFileSync(join(dir, "more-apps.json"), "utf-8"));
		expect(payload.version).toBe(1);
		expect(payload.apps["email-manager"].port).toBe(8001);
	});
});
