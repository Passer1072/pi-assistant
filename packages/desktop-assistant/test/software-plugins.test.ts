import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	NETEASE_PLUGIN_ID,
	SoftwarePluginManager,
	STEAM_PLUGIN_ID,
	validateNeteaseTarget,
	validateSteamTarget,
} from "../src/plugins/software-plugin-manager.ts";

const COMPATIBLE_NETEASE_VERSION = "2.10.12.201849";
// The version that used to break BetterNCM injection — CDP control must support it.
const PROTECTED_NETEASE_VERSION = "3.1.32.205206";

const SERVER_SCRIPT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"mcp-servers",
	"netease-music",
	"netease-music-mcp-server.mjs",
);
const STEAM_SERVER_SCRIPT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"mcp-servers",
	"steam",
	"steam-mcp-server.mjs",
);

function makeManager(agentDir: string, version: string) {
	return new SoftwarePluginManager({
		agentDir,
		nodeCommand: "node",
		serverScriptPath: SERVER_SCRIPT,
		steamServerScriptPath: STEAM_SERVER_SCRIPT,
		executableVersionReader: () => version,
	});
}

describe("software plugin manager (CDP control)", () => {
	it("validates a NetEase Cloud Music target path", () => {
		const dir = tempDir();
		try {
			createNeteaseInstall(dir);

			const result = validateNeteaseTarget(dir, () => COMPATIBLE_NETEASE_VERSION);

			expect(result.valid).toBe(true);
			expect(result.missingFiles).toEqual([]);
			expect(result.requiresHost).toBe(false);
			expect(result.autoHostInstallSupported).toBe(true);
			expect(result.softwareVersion).toBe(COMPATIBLE_NETEASE_VERSION);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("supports NetEase 3.1.x (CDP needs no injection, so it is never blocked)", () => {
		const dir = tempDir();
		try {
			createNeteaseInstall(dir);

			const result = validateNeteaseTarget(dir, () => PROTECTED_NETEASE_VERSION);

			expect(result.valid).toBe(true);
			expect(result.autoHostInstallSupported).toBe(true);
			expect(result.autoHostInstallBlockReason).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports missing NetEase files for wrong paths", () => {
		const dir = tempDir();
		try {
			writeFileSync(join(dir, "cloudmusic.exe"), "");

			const result = validateNeteaseTarget(dir, () => COMPATIBLE_NETEASE_VERSION);

			expect(result.valid).toBe(false);
			expect(result.missingFiles).toContain("cloudmusic.dll");
			expect(result.missingFiles).toContain("package/orpheus.ntpk");
			expect(result.missingFiles).toContain("libcef.dll");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("installs a CDP MCP server on NetEase 3.1.x without touching the install dir", async () => {
		const dir = tempDir();
		const agentDir = tempDir();
		try {
			createNeteaseInstall(dir);
			const manager = makeManager(agentDir, PROTECTED_NETEASE_VERSION);

			const result = await manager.install({ pluginId: NETEASE_PLUGIN_ID, targetPath: dir });

			expect(result.plugin.status).toBe("installed");
			expect(result.mcpServer.id).toBe("netease-cloud-music-api");
			expect(result.mcpServer.toolNamePrefix).toBe("ncm");
			expect(result.mcpServer.command).toBe("node");
			expect(result.mcpServer.args?.[0]).toMatch(/netease-music-mcp-server\.mjs$/);
			expect(result.mcpServer.env?.NCM_DEBUG_PORT).toBe("9222");
			expect(result.mcpServer.env?.NCM_EXE_PATH).toMatch(/cloudmusic\.exe$/);
			expect(result.mcpServer.env?.NCM_AUTO_LAUNCH).toBe("1");
			// the configured script must be a real, resolvable file (bundled in the repo, with node_modules nearby)
			expect(existsSync(result.mcpServer.args?.[0] ?? "")).toBe(true);
			// nothing is copied into AppData/agentDir, and the NetEase install dir is untouched
			expect(existsSync(join(agentDir, "software-plugin-assets", "netease-music-mcp-server.mjs"))).toBe(false);
			expect(existsSync(join(dir, "msimg32.dll"))).toBe(false);
			expect(existsSync(join(dir, "cloudmusic.exe"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("uses a stable MCP id and updates on repeated installs (custom debug port)", async () => {
		const dir = tempDir();
		const agentDir = tempDir();
		try {
			createNeteaseInstall(dir);
			const manager = makeManager(agentDir, COMPATIBLE_NETEASE_VERSION);

			const first = await manager.install({ pluginId: NETEASE_PLUGIN_ID, targetPath: dir });
			const second = await manager.install({ pluginId: NETEASE_PLUGIN_ID, targetPath: dir, bridgePort: 9333 });

			expect(first.mcpServer.id).toBe("netease-cloud-music-api");
			expect(second.mcpServer.id).toBe("netease-cloud-music-api");
			expect(second.mcpServer.env?.NCM_DEBUG_PORT).toBe("9333");
			expect(second.plugin.bridgeUrl).toBe("http://127.0.0.1:9333");
			expect(manager.list().plugins.filter((plugin) => plugin.installed).length).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("uninstalls only plugin-managed files and leaves NetEase intact", async () => {
		const dir = tempDir();
		const agentDir = tempDir();
		try {
			createNeteaseInstall(dir);
			const manager = makeManager(agentDir, COMPATIBLE_NETEASE_VERSION);
			await manager.install({ pluginId: NETEASE_PLUGIN_ID, targetPath: dir });

			manager.uninstall(NETEASE_PLUGIN_ID);

			// uninstall removes the record/MCP config but must NOT delete the bundled (repo) server script
			expect(existsSync(SERVER_SCRIPT)).toBe(true);
			expect(existsSync(join(dir, "cloudmusic.exe"))).toBe(true);
			expect(existsSync(join(dir, "cloudmusic.dll"))).toBe(true);
			expect(existsSync(join(dir, "package", "orpheus.ntpk"))).toBe(true);
			expect(existsSync(join(dir, "libcef.dll"))).toBe(true);
			expect(manager.list().plugins[0]?.installed).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("testBridge reports the debug-port reachability", async () => {
		const dir = tempDir();
		const agentDir = tempDir();
		try {
			createNeteaseInstall(dir);
			const okFetch = vi
				.fn()
				.mockResolvedValue(
					new Response(JSON.stringify({ Browser: "Chrome/91.0" }), { status: 200 }),
				) as unknown as typeof fetch;
			const manager = new SoftwarePluginManager({
				agentDir,
				nodeCommand: "node",
				serverScriptPath: SERVER_SCRIPT,
				executableVersionReader: () => PROTECTED_NETEASE_VERSION,
				fetchImpl: okFetch,
			});
			await manager.install({ pluginId: NETEASE_PLUGIN_ID, targetPath: dir });

			const reachable = await manager.testBridge(NETEASE_PLUGIN_ID);
			expect(reachable.ok).toBe(true);
			expect(reachable.bridgeUrl).toBe("http://127.0.0.1:9222");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("testBridge fails clearly when the debug port is unreachable", async () => {
		const dir = tempDir();
		const agentDir = tempDir();
		try {
			createNeteaseInstall(dir);
			const deadFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
			const manager = new SoftwarePluginManager({
				agentDir,
				nodeCommand: "node",
				serverScriptPath: SERVER_SCRIPT,
				executableVersionReader: () => COMPATIBLE_NETEASE_VERSION,
				fetchImpl: deadFetch,
			});
			await manager.install({ pluginId: NETEASE_PLUGIN_ID, targetPath: dir });

			const result = await manager.testBridge(NETEASE_PLUGIN_ID);
			expect(result.ok).toBe(false);
			expect(result.message).toContain("--remote-debugging-port");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("software plugin manager (Steam control)", () => {
	it("validates a Steam target path", () => {
		const dir = tempDir();
		try {
			createSteamInstall(dir);

			const result = validateSteamTarget(dir, () => "10.72.33.79");

			expect(result.valid).toBe(true);
			expect(result.missingFiles).toEqual([]);
			expect(result.requiresHost).toBe(false);
			expect(result.autoHostInstallSupported).toBe(true);
			expect(result.softwareVersion).toBe("10.72.33.79");
			expect(result.summary.join("\n")).toContain("steam:// URL protocol");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports missing Steam files for wrong paths", () => {
		const dir = tempDir();
		try {
			writeFileSync(join(dir, "steam.exe"), "exe");

			const result = validateSteamTarget(dir, () => "10.72.33.79");

			expect(result.valid).toBe(false);
			expect(result.missingFiles).toEqual(["steamapps/libraryfolders.vdf"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("installs a Steam MCP server without touching the Steam install dir", async () => {
		const dir = tempDir();
		const agentDir = tempDir();
		try {
			createSteamInstall(dir);
			const manager = makeManager(agentDir, "10.72.33.79");

			const result = await manager.install({ pluginId: STEAM_PLUGIN_ID, targetPath: dir });

			expect(result.plugin.status).toBe("installed");
			expect(result.plugin.bridgeUrl).toBe("steam://open/library");
			expect(result.mcpServer.id).toBe("steam-control");
			expect(result.mcpServer.toolNamePrefix).toBe("steam");
			expect(result.mcpServer.command).toBe("node");
			expect(result.mcpServer.args?.[0]).toMatch(/steam-mcp-server\.mjs$/);
			expect(result.mcpServer.env?.STEAM_ROOT).toBe(dir);
			expect(result.mcpServer.env?.STEAM_EXE_PATH).toBe(join(dir, "steam.exe"));
			expect(result.mcpServer.env?.STEAM_AUTO_LAUNCH).toBe("1");
			expect(existsSync(result.mcpServer.args?.[0] ?? "")).toBe(true);
			expect(existsSync(join(agentDir, "software-plugin-assets", "steam-mcp-server.mjs"))).toBe(false);
			expect(existsSync(join(dir, "steam.exe"))).toBe(true);
			expect(existsSync(join(dir, "steamapps", "libraryfolders.vdf"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("uses a stable Steam MCP id and updates on repeated installs", async () => {
		const dir = tempDir();
		const agentDir = tempDir();
		try {
			createSteamInstall(dir);
			const manager = makeManager(agentDir, "10.72.33.79");

			const first = await manager.install({ pluginId: STEAM_PLUGIN_ID, targetPath: dir });
			const second = await manager.install({ pluginId: STEAM_PLUGIN_ID, targetPath: dir });

			expect(first.mcpServer.id).toBe("steam-control");
			expect(second.mcpServer.id).toBe("steam-control");
			expect(manager.list().plugins.filter((plugin) => plugin.installed?.pluginId === STEAM_PLUGIN_ID)).toHaveLength(
				1,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("uninstalls only the Steam plugin record and leaves Steam intact", async () => {
		const dir = tempDir();
		const agentDir = tempDir();
		try {
			createSteamInstall(dir);
			const manager = makeManager(agentDir, "10.72.33.79");
			await manager.install({ pluginId: STEAM_PLUGIN_ID, targetPath: dir });

			manager.uninstall(STEAM_PLUGIN_ID);

			expect(existsSync(STEAM_SERVER_SCRIPT)).toBe(true);
			expect(existsSync(join(dir, "steam.exe"))).toBe(true);
			expect(existsSync(join(dir, "steamapps", "libraryfolders.vdf"))).toBe(true);
			expect(
				manager.list().plugins.find((plugin) => plugin.definition.id === STEAM_PLUGIN_ID)?.installed,
			).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("testBridge reports Steam local manifest readability", async () => {
		const dir = tempDir();
		const agentDir = tempDir();
		try {
			createSteamInstall(dir);
			const manager = makeManager(agentDir, "10.72.33.79");
			await manager.install({ pluginId: STEAM_PLUGIN_ID, targetPath: dir });

			const result = await manager.testBridge(STEAM_PLUGIN_ID);

			expect(result.ok).toBe(true);
			expect(result.message).toContain("Steam");
			expect(JSON.stringify(result.sample)).toContain("10.72.33.79");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "desktop-assistant-plugin-"));
}

function createNeteaseInstall(dir: string): void {
	mkdirSync(join(dir, "package"), { recursive: true });
	writeFileSync(join(dir, "cloudmusic.exe"), "exe");
	writeFileSync(join(dir, "cloudmusic.dll"), "dll");
	writeFileSync(join(dir, "package", "orpheus.ntpk"), "package");
	writeFileSync(join(dir, "libcef.dll"), "cef");
}

function createSteamInstall(dir: string): void {
	mkdirSync(join(dir, "steamapps"), { recursive: true });
	writeFileSync(join(dir, "steam.exe"), "exe");
	writeFileSync(
		join(dir, "steamapps", "libraryfolders.vdf"),
		[
			'"libraryfolders"',
			"{",
			'  "0"',
			"  {",
			`    "path"    "${dir.replace(/\\/g, "\\\\")}"`,
			'    "apps"',
			"    {",
			'      "228980"    "224575958"',
			"    }",
			"  }",
			"}",
		].join("\n"),
	);
}
