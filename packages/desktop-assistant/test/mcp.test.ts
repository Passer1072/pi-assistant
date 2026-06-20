import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMcpAppendPrompt, DesktopAgentService } from "../src/agent/desktop-agent-service.ts";
import { PersonalSkillRepositoryService } from "../src/agent/personal-skill-repository.ts";
import { DryRunDesktopAutomationHost } from "../src/desktop/automation-host.ts";
import { McpClientManager } from "../src/mcp/mcp-client-manager.ts";
import { normalizeMcpSettings, seedDefaultMcpServers } from "../src/mcp/mcp-config.ts";
import { DEFAULT_DESKTOP_ASSISTANT_SETTINGS, type DesktopAssistantSettings } from "../src/shared/types.ts";

describe("desktop assistant MCP", () => {
	it("does not expose MCP tools while the global switch is off", async () => {
		const dir = tempDir();
		try {
			const service = new DesktopAgentService({
				cwd: process.cwd(),
				agentDir: dir,
				host: new DryRunDesktopAutomationHost(),
				settings: { mcp: { enabled: false, servers: DEFAULT_DESKTOP_ASSISTANT_SETTINGS.mcp.servers } },
			});
			await service.initialize();
			const internal = service as unknown as {
				session?: {
					getToolDefinition: (name: string) => unknown;
				};
			};

			expect(service.snapshot().settings.mcp.enabled).toBe(false);
			expect(internal.session?.getToolDefinition("mcp_desktop_assistant_assistant_get_settings")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("seeds the packaged Office MCP servers into an existing persisted profile", async () => {
		const dir = tempDir();
		try {
			// A user who already has a persisted mcp-settings.json from before the Office servers shipped.
			writeFileSync(join(dir, "mcp-settings.json"), JSON.stringify({ enabled: true, servers: [] }), "utf-8");
			const service = new DesktopAgentService({
				cwd: process.cwd(),
				agentDir: dir,
				host: new DryRunDesktopAutomationHost(),
			});
			await service.initialize();
			const servers = service.snapshot().settings.mcp.servers;
			const ids = servers.map((server) => server.id);
			expect(ids).toContain("excel-mcp");
			expect(ids).toContain("ppt-mcp");
			// Seeded but disabled, so no external uvx process is spawned on startup.
			expect(servers.find((server) => server.id === "excel-mcp")?.enabled).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not duplicate Office MCP servers that are already present", () => {
		const seeded = seedDefaultMcpServers(normalizeMcpSettings({ enabled: true, servers: [] }));
		const again = seedDefaultMcpServers(seeded);
		expect(again.servers.filter((server) => server.id === "excel-mcp")).toHaveLength(1);
		expect(again.servers.filter((server) => server.id === "ppt-mcp")).toHaveLength(1);
	});

	it("shuts down MCP clients when the global switch is disabled", async () => {
		const dir = tempDir();
		try {
			const service = new DesktopAgentService({
				cwd: process.cwd(),
				agentDir: dir,
				host: new DryRunDesktopAutomationHost(),
				settings: { mcp: { enabled: true, servers: DEFAULT_DESKTOP_ASSISTANT_SETTINGS.mcp.servers } },
			});
			await service.initialize();
			const before = service.listMcpServers();

			const after = await service.setMcpEnabled({ enabled: false });

			expect(before.statuses[0]?.state).toBe("connected");
			expect(after.enabled).toBe(false);
			expect(after.statuses[0]?.state).toBe("disconnected");
			expect(service.listMcpServers().statuses[0]?.toolCount).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("connects only enabled servers when MCP is enabled", async () => {
		const settings = normalizeMcpSettings({
			enabled: true,
			servers: [
				{ ...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.mcp.servers[0], enabled: true },
				{
					id: "disabled-external",
					name: "Disabled External",
					enabled: false,
					transport: "stdio",
					command: "node",
					args: ["server.js"],
					toolNamePrefix: "disabled",
				},
			],
		});
		const manager = new McpClientManager({
			initialSettings: settings,
			getSettings: () => DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
			updateSettings: async (update) => ({
				sessionId: "test",
				sessions: [
					{
						sessionId: "test",
						title: "test",
						status: "idle" as const,
						isRunning: false,
						lastActivityAt: 0,
						pendingConfirmationCount: 0,
						unreadCompletion: false,
					},
				],
				focusedSessionId: "test",
				settings: { ...DEFAULT_DESKTOP_ASSISTANT_SETTINGS, ...update },
				authStatus: { configured: false, needsRotationWarning: false },
				voiceAuthStatus: { configured: false, needsRotationWarning: false },
				apiKeyStatus: { state: "idle" },
				isRunning: false,
				streamingText: "",
				streamingThinking: "",
				messages: [],
				timeline: [],
				pendingConfirmations: [],
				voiceOverlay: { visible: false, state: "idle", transcript: "" },
				conversationThinking: {
					enabled: true,
					effectiveLevel: "high",
					supported: true,
				},
				memoryEnabled: true,
				lastInjectedMemoryCount: 0,
			}),
			requestRoute: () => {},
		});

		await manager.applySettings(settings);
		const list = manager.list();

		expect(list.statuses.find((status) => status.id === "desktop-assistant")?.state).toBe("connected");
		expect(list.statuses.find((status) => status.id === "disabled-external")?.state).toBe("disabled");
		expect(manager.getActiveToolNames().every((name) => name.startsWith("mcp_"))).toBe(true);
	});

	it("uses a stable MCP tool prefix", async () => {
		const dir = tempDir();
		const manager = new McpClientManager({
			initialSettings: { enabled: true, servers: DEFAULT_DESKTOP_ASSISTANT_SETTINGS.mcp.servers },
			getSettings: () => DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
			updateSettings: async (update) => fakeSnapshot({ ...DEFAULT_DESKTOP_ASSISTANT_SETTINGS, ...update }),
			requestRoute: () => {},
			personalSkills: new PersonalSkillRepositoryService(dir),
		});

		try {
			await manager.applySettings({ enabled: true, servers: DEFAULT_DESKTOP_ASSISTANT_SETTINGS.mcp.servers });

			expect(manager.getActiveToolNames()).toContain("mcp_desktop_assistant_assistant_get_settings");
			expect(manager.getActiveToolNames()).toContain("mcp_desktop_assistant_assistant_update_settings");
			expect(manager.getActiveToolNames()).toContain("mcp_desktop_assistant_personal_skill_save");
			expect(manager.getActiveToolNames()).toContain("mcp_desktop_assistant_personal_skill_read");
			expect(manager.getActiveToolNames()).toContain("mcp_desktop_assistant_personal_skill_search");
		} finally {
			await manager.shutdownAll();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("connects to a mock stdio MCP server, lists tools, and calls a tool", async () => {
		const dir = mkdtempSync(join(process.cwd(), ".mcp-stdio-"));
		try {
			const serverPath = join(dir, "mock-mcp-server.mjs");
			writeFileSync(
				serverPath,
				[
					'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
					'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
					'import { z } from "zod";',
					'const server = new McpServer({ name: "mock-mcp", version: "1.0.0" });',
					'server.registerTool("echo", { title: "Echo", description: "Echo input", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text: JSON.stringify({ echoed: text }) }] }));',
					"await server.connect(new StdioServerTransport());",
				].join("\n"),
				"utf-8",
			);
			const mcpSettings = {
				enabled: true,
				servers: [
					...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.mcp.servers.map((server) => ({ ...server, enabled: false })),
					{
						id: "mock-stdio",
						name: "Mock Stdio",
						enabled: true,
						transport: "stdio" as const,
						command: process.execPath,
						args: [serverPath],
						toolNamePrefix: "mock",
						timeoutMs: 10000,
					},
				],
			};
			const manager = new McpClientManager({
				initialSettings: mcpSettings,
				getSettings: () => DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
				updateSettings: async (update) => fakeSnapshot({ ...DEFAULT_DESKTOP_ASSISTANT_SETTINGS, ...update }),
				requestRoute: () => {},
			});

			await manager.applySettings(mcpSettings);
			const tool = manager.getTools().find((entry) => entry.name === "mcp_mock_echo");
			if (!tool) throw new Error(`mock MCP echo tool missing: ${JSON.stringify(manager.list().statuses)}`);
			const response = await tool.execute("tool-stdio", { text: "hello" }, undefined, undefined, stubContext());

			expect(manager.list().statuses.find((status) => status.id === "mock-stdio")?.state).toBe("connected");
			expect(response.details).toMatchObject({ status: "succeeded" });
			expect(JSON.stringify(response.details)).toContain("hello");
			await manager.shutdownAll();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("built-in MCP can update assistant settings", async () => {
		let currentSettings: DesktopAssistantSettings = {
			...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
			mcp: { enabled: true, servers: DEFAULT_DESKTOP_ASSISTANT_SETTINGS.mcp.servers },
			webSearch: { mode: "auto", provider: "duckduckgo" },
		};
		const manager = new McpClientManager({
			initialSettings: currentSettings.mcp,
			getSettings: () => currentSettings,
			updateSettings: async (update) => {
				currentSettings = { ...currentSettings, ...update };
				return fakeSnapshot(currentSettings);
			},
			requestRoute: () => {},
		});
		await manager.applySettings(currentSettings.mcp);
		const tool = manager.getTools().find((entry) => entry.name === "mcp_desktop_assistant_assistant_set_web_search");
		if (!tool) throw new Error("built-in MCP web search tool missing");

		const response = await tool.execute("tool-1", { mode: "off" }, undefined, undefined, stubContext());

		expect(currentSettings.webSearch.mode).toBe("off");
		expect(response.details).toMatchObject({ status: "succeeded" });
	});

	it("built-in MCP can set full access permission mode", async () => {
		let currentSettings: DesktopAssistantSettings = {
			...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
			mcp: { enabled: true, servers: DEFAULT_DESKTOP_ASSISTANT_SETTINGS.mcp.servers },
		};
		const manager = new McpClientManager({
			initialSettings: currentSettings.mcp,
			getSettings: () => currentSettings,
			updateSettings: async (update) => {
				currentSettings = { ...currentSettings, ...update };
				return fakeSnapshot(currentSettings);
			},
			requestRoute: () => {},
		});
		await manager.applySettings(currentSettings.mcp);
		const tool = manager.getTools().find((entry) => entry.name === "mcp_desktop_assistant_assistant_update_settings");
		if (!tool) throw new Error("built-in MCP update settings tool missing");

		const response = await tool.execute(
			"tool-1",
			{ permissionMode: "full_access" },
			undefined,
			undefined,
			stubContext(),
		);

		expect(currentSettings.permissionMode).toBe("full_access");
		expect(response.details).toMatchObject({ status: "succeeded" });
		expect(readMcpDetailsPayload(response.details).settings.permissionMode).toBe("full_access");
	});

	it("built-in MCP cannot change system capability skill names", async () => {
		let currentSettings: DesktopAssistantSettings = {
			...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
			mcp: { enabled: true, servers: DEFAULT_DESKTOP_ASSISTANT_SETTINGS.mcp.servers },
		};
		const manager = new McpClientManager({
			initialSettings: currentSettings.mcp,
			getSettings: () => currentSettings,
			updateSettings: async (update) => {
				currentSettings = { ...currentSettings, ...update };
				return fakeSnapshot(currentSettings);
			},
			requestRoute: () => {},
		});
		await manager.applySettings(currentSettings.mcp);
		const tool = manager.getTools().find((entry) => entry.name === "mcp_desktop_assistant_assistant_update_settings");
		if (!tool) throw new Error("built-in MCP update settings tool missing");

		const response = await tool.execute(
			"tool-skill-name",
			{
				capability: {
					id: "system",
					enabled: true,
					skillName: "changed-by-ai",
				},
			},
			undefined,
			undefined,
			stubContext(),
		);

		expect(currentSettings.capabilities.system.skillName).toBe("system-operation");
		expect(response.details).toMatchObject({ status: "failed" });
		await manager.shutdownAll();
	});

	it("documents MCP priority policy for system prompt injection", () => {
		expect(buildMcpAppendPrompt()).toContain("Prefer available tools whose names start with mcp_");
	});

	it("routes music intents to an active music-control MCP plugin", () => {
		const prompt = buildMcpAppendPrompt(["mcp_ncm_play_song_by_name", "mcp_ncm_search", "media_control"]);
		// always carries the general music-routing policy
		expect(prompt).toContain("music_playback_routing");
		expect(prompt).toContain("禁止改用 app_interaction");
		// names the concrete active plugin tools so the model uses them
		expect(prompt).toContain("mcp_ncm_play_song_by_name");
		expect(prompt).toContain("控制插件已激活");
	});

	it("keeps fallback wording when no music-control plugin is active", () => {
		const prompt = buildMcpAppendPrompt(["media_control", "app_interaction"]);
		expect(prompt).toContain("music_playback_routing");
		expect(prompt).not.toContain("控制插件已激活");
	});
});

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "desktop-assistant-mcp-"));
}

function fakeSnapshot(settings: DesktopAssistantSettings) {
	return {
		sessionId: "test",
		sessions: [
			{
				sessionId: "test",
				title: "test",
				status: "idle" as const,
				isRunning: false,
				lastActivityAt: 0,
				pendingConfirmationCount: 0,
				unreadCompletion: false,
			},
		],
		focusedSessionId: "test",
		settings,
		authStatus: { configured: false, needsRotationWarning: false },
		voiceAuthStatus: { configured: false, needsRotationWarning: false },
		apiKeyStatus: { state: "idle" as const },
		isRunning: false,
		streamingText: "",
		streamingThinking: "",
		messages: [],
		timeline: [],
		pendingConfirmations: [],
		voiceOverlay: { visible: false, state: "idle" as const, transcript: "" },
		conversationThinking: {
			enabled: true,
			effectiveLevel: "high" as const,
			supported: true,
		},
		memoryEnabled: settings.memory.enabled,
		lastInjectedMemoryCount: 0,
	};
}

function readMcpDetailsPayload(details: unknown): { settings: DesktopAssistantSettings } {
	if (typeof details !== "object" || details === null) {
		throw new Error("Expected MCP tool details object.");
	}
	const stdout = (details as { stdout?: unknown }).stdout;
	if (typeof stdout !== "string") {
		throw new Error("Expected MCP tool details stdout.");
	}
	const outer = JSON.parse(stdout) as { content?: Array<{ text?: string }> };
	const text = outer.content?.[0]?.text;
	if (typeof text !== "string") {
		throw new Error("Expected MCP tool text content.");
	}
	return JSON.parse(text) as { settings: DesktopAssistantSettings };
}

function stubContext() {
	return {
		cwd: process.cwd(),
		hasUI: false,
		model: undefined,
		signal: undefined,
		sessionManager: {},
		modelRegistry: {},
		ui: {},
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as never;
}
