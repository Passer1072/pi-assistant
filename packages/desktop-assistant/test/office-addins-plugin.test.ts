import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	OFFICE_WORD_PLUGIN_ID,
	SoftwarePluginManager,
	validateOfficeTarget,
} from "../src/plugins/software-plugin-manager.ts";

const OFFICE_SERVER_SCRIPT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"mcp-servers",
	"office-addins",
	"office-addin-mcp-server.mjs",
);

describe("software plugin manager (Office live add-in)", () => {
	it("validates a Word Office.js target path", () => {
		const dir = tempDir();
		try {
			createWordInstall(dir);

			const result = validateOfficeTarget("word", dir, () => "16.0.17726.20126");

			expect(result.valid).toBe(true);
			expect(result.softwareVersion).toBe("16.0.17726.20126");
			expect(result.summary.join("\n")).toContain("Office.js add-in");
			expect(result.warnings.join("\n")).toContain("localhost certificate");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects Word versions older than Office 2016", () => {
		const dir = tempDir();
		try {
			createWordInstall(dir);

			const result = validateOfficeTarget("word", dir, () => "15.0.9999.1");

			expect(result.valid).toBe(false);
			expect(result.summary.join("\n")).toContain("Office 2016");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("installs a Word live add-in MCP server and sideload manifest", async () => {
		const dir = tempDir();
		const agentDir = tempDir();
		const scripts: string[] = [];
		try {
			createWordInstall(dir);
			const manager = makeManager(agentDir, scripts);

			const result = await manager.install({ pluginId: OFFICE_WORD_PLUGIN_ID, targetPath: dir });

			expect(result.plugin.status).toBe("installed");
			expect(result.plugin.bridgeUrl).toBe("https://localhost:49230");
			expect(result.plugin.token).toBe("[redacted]");
			expect(result.plugin.officeChatBridgeUrl).toBe("http://127.0.0.1:49240");
			expect(result.plugin.officeChatBridgeToken).toBe("[redacted]");
			expect(result.plugin.certThumbprint).toBe("FAKE_THUMBPRINT");
			expect(result.plugin.registryValueName).toMatch(/manifest\.xml$/);
			expect(result.mcpServer.id).toBe("office-word-live");
			expect(result.mcpServer.command).toBe("node");
			expect(result.mcpServer.args).toEqual([OFFICE_SERVER_SCRIPT]);
			expect(result.mcpServer.toolNamePrefix).toBe("word");
			expect(result.mcpServer.env?.OFFICE_HOST).toBe("word");
			expect(result.mcpServer.env?.OFFICE_BRIDGE_PORT).toBe("49230");
			expect(result.mcpServer.env?.OFFICE_BRIDGE_TOKEN).toBe("[redacted]");
			expect(result.mcpServer.env?.OFFICE_CHAT_BRIDGE_URL).toBe("http://127.0.0.1:49240");
			expect(result.mcpServer.env?.OFFICE_CHAT_BRIDGE_TOKEN).toBe("[redacted]");
			expect(result.mcpServer.env?.OFFICE_WEB_DIR).toMatch(/office-addins[\\/]web$/);
			expect(existsSync(result.plugin.registryValueName ?? "")).toBe(true);
			expect(scripts.some((script) => script.includes("New-SelfSignedCertificate"))).toBe(true);
			expect(scripts.some((script) => script.includes("certutil.exe"))).toBe(true);
			expect(scripts.some((script) => script.includes("'-user','-addstore','Root'"))).toBe(true);
			expect(scripts.some((script) => script.includes("New-ItemProperty"))).toBe(true);

			const restored = manager.getMcpServerConfig(OFFICE_WORD_PLUGIN_ID);
			expect(restored.env?.OFFICE_BRIDGE_TOKEN).toBe("office-token");
			expect(restored.env?.OFFICE_PFX_PASSPHRASE).toBe("office-token");
			expect(restored.env?.OFFICE_CHAT_BRIDGE_TOKEN).toBe("office-token");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("uninstalls a Word live add-in and removes sideload/certificate registration", async () => {
		const dir = tempDir();
		const agentDir = tempDir();
		const scripts: string[] = [];
		try {
			createWordInstall(dir);
			const manager = makeManager(agentDir, scripts);
			await manager.install({ pluginId: OFFICE_WORD_PLUGIN_ID, targetPath: dir });

			const result = manager.uninstall(OFFICE_WORD_PLUGIN_ID);

			expect(result.mcpServerId).toBe("office-word-live");
			expect(result.removedFiles.some((file) => file.endsWith("manifest.xml"))).toBe(true);
			expect(scripts.some((script) => script.includes("Remove-ItemProperty"))).toBe(true);
			expect(scripts.some((script) => script.includes("Cert:\\CurrentUser\\Root\\$thumb"))).toBe(true);
			expect(
				manager.list().plugins.find((plugin) => plugin.definition.id === OFFICE_WORD_PLUGIN_ID)?.installed,
			).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("testBridge reports taskpane connection state", async () => {
		const dir = tempDir();
		const agentDir = tempDir();
		try {
			createWordInstall(dir);
			const fetchImpl = vi
				.fn()
				.mockResolvedValue(
					new Response(JSON.stringify({ connected: true, host: "word", lastSeen: 123 }), { status: 200 }),
				) as unknown as typeof fetch;
			const manager = makeManager(agentDir, [], fetchImpl);
			await manager.install({ pluginId: OFFICE_WORD_PLUGIN_ID, targetPath: dir });

			const connected = await manager.testBridge(OFFICE_WORD_PLUGIN_ID);

			expect(connected.ok).toBe(true);
			expect(connected.message).toContain("add-in is connected");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("testBridge gives an actionable message when the bridge is running but the taskpane is not connected", async () => {
		const dir = tempDir();
		const agentDir = tempDir();
		try {
			createWordInstall(dir);
			const fetchImpl = vi
				.fn()
				.mockResolvedValue(
					new Response(JSON.stringify({ connected: false, host: "word", lastSeen: null }), { status: 200 }),
				) as unknown as typeof fetch;
			const manager = makeManager(agentDir, [], fetchImpl);
			await manager.install({ pluginId: OFFICE_WORD_PLUGIN_ID, targetPath: dir });

			const result = await manager.testBridge(OFFICE_WORD_PLUGIN_ID);

			expect(result.ok).toBe(false);
			expect(result.message).toContain("show the Desktop Assistant taskpane");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("reads installed plugin records when the store has a UTF-8 BOM", () => {
		const agentDir = tempDir();
		try {
			const storePath = join(agentDir, "software-plugins.json");
			mkdirSync(dirname(storePath), { recursive: true });
			writeFileSync(
				storePath,
				`\uFEFF${JSON.stringify({
					version: 1,
					plugins: [
						{
							pluginId: OFFICE_WORD_PLUGIN_ID,
							status: "installed",
							targetPath: "F:\\Program Files\\Microsoft Office\\Root\\Office16",
							bridgeUrl: "https://localhost:49230",
							installedFiles: [],
						},
					],
				})}`,
				"utf-8",
			);

			const manager = makeManager(agentDir, []);
			const item = manager.list().plugins.find((plugin) => plugin.definition.id === OFFICE_WORD_PLUGIN_ID);

			expect(item?.installed?.status).toBe("installed");
			expect(item?.installed?.bridgeUrl).toBe("https://localhost:49230");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

function makeManager(agentDir: string, scripts: string[], fetchImpl?: typeof fetch): SoftwarePluginManager {
	return new SoftwarePluginManager({
		agentDir,
		nodeCommand: "node",
		officeServerScriptPath: OFFICE_SERVER_SCRIPT,
		executableVersionReader: () => "16.0.17726.20126",
		tokenFactory: () => "office-token",
		fetchImpl,
		powerShellRunner: (script) => {
			scripts.push(script);
			if (script.includes('Test-Path "Cert:\\CurrentUser\\Root\\$thumb"')) return "";
			if (script.includes("certutil.exe")) return "trusted\n";
			if (script.includes("New-SelfSignedCertificate")) return "FAKE_THUMBPRINT\n";
			if (script.includes("New-ItemProperty")) {
				const match = /\$manifest = '([^']+)'/.exec(script);
				return `${match?.[1] ?? ""}\n`;
			}
			return "";
		},
	});
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "desktop-assistant-office-plugin-"));
}

function createWordInstall(dir: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "WINWORD.EXE"), "exe");
}
