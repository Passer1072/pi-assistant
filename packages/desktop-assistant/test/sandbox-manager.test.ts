import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SandboxManager } from "../src/desktop/sandbox/sandbox-manager.ts";
import { DEFAULT_SANDBOX_SETTINGS, type SandboxSettings } from "../src/shared/types.ts";

let workDir: string;
let settings: SandboxSettings;

const okProbe = async () => ({ stdout: "sandbox-ready", stderr: "" });
const failProbe = async () => ({ stdout: "", stderr: "boom" });

function makeManager(probe = okProbe): SandboxManager {
	return new SandboxManager({
		defaultRoot: join(workDir, "sandbox"),
		getSettings: () => settings,
		runProbe: probe,
	});
}

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "sb-test-"));
	settings = structuredClone(DEFAULT_SANDBOX_SETTINGS);
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("SandboxManager lifecycle", () => {
	it("initializes to ready and creates the workspace + tmp dir", async () => {
		const manager = makeManager();
		await manager.init();
		const status = manager.getStatus();
		expect(status.phase).toBe("ready");
		expect(status.progress).toBe(100);
		expect(existsSync(manager.root)).toBe(true);
		expect(existsSync(join(manager.root, "tmp"))).toBe(true);
	});

	it("emits failed then stuck after repeated probe failures", async () => {
		const manager = makeManager(failProbe);
		await manager.init();
		expect(manager.getStatus().phase).toBe("failed");
		await manager.init();
		await manager.init();
		expect(manager.getStatus().phase).toBe("stuck");
		expect(manager.getStatus().lastError).toBeTruthy();
	});

	it("exposes canonicalized runtime roots for the engine", async () => {
		const manager = makeManager();
		await manager.init();
		const runtime = manager.getRuntimeState();
		expect(runtime.phase).toBe("ready");
		expect(runtime.sandboxRoot.toLowerCase()).toContain("sandbox");
		expect(runtime.protectedPaths.length).toBeGreaterThan(0);
	});
});

describe("SandboxManager quota / cleanup", () => {
	it("tracks usage and cleans entries", async () => {
		const manager = makeManager();
		await manager.init();
		writeFileSync(join(manager.root, "a.txt"), "x".repeat(2048));
		writeFileSync(join(manager.root, "b.txt"), "y".repeat(2048));
		expect(manager.usageMb()).toBeGreaterThanOrEqual(0);
		expect(manager.list().length).toBe(2);
		const outcome = manager.clean("all");
		expect(outcome.removedEntries).toBe(2);
		expect(manager.list().length).toBe(0);
	});
});

describe("SandboxManager import / export", () => {
	it("imports a real file into the sandbox and exports one back out", async () => {
		const manager = makeManager();
		await manager.init();

		const src = join(workDir, "source.txt");
		writeFileSync(src, "hello");
		const imported = manager.importPath(src, "work/source.txt");
		expect(existsSync(imported.path)).toBe(true);
		expect(manager.root && imported.path.toLowerCase().includes("sandbox")).toBe(true);
		expect(manager.existsInside("work/source.txt")).toBe(true);
		expect(manager.existsInside("work/missing.txt")).toBe(false);

		const dest = join(workDir, "delivered.txt");
		const exported = manager.exportPath("work/source.txt", dest);
		expect(existsSync(exported.path)).toBe(true);
	});

	it("refuses to resolve a path that escapes the sandbox root", async () => {
		const manager = makeManager();
		await manager.init();
		expect(() => manager.resolveInside("..\\..\\escape.txt")).toThrow();
	});
});

describe("SandboxManager known paths", () => {
	it("exposes the real OS folders from runtime overrides (app.getPath), not hardcoded", () => {
		const manager = new SandboxManager({
			defaultRoot: join(workDir, "sandbox"),
			getSettings: () => settings,
			pathOverrides: {
				home: "F:\\Users\\me",
				desktop: "F:\\Users\\me\\Desktop",
				documents: "F:\\Users\\me\\Documents",
				downloads: "F:\\Users\\me\\Downloads",
			},
		});
		const paths = manager.knownPaths();
		expect(paths.desktop).toBe("F:\\Users\\me\\Desktop");
		expect(paths.documents).toBe("F:\\Users\\me\\Documents");
		expect(paths.downloads).toBe("F:\\Users\\me\\Downloads");
		expect(paths.sandboxRoot.toLowerCase()).toContain("sandbox");
	});
});
