import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Prompt, Resource, Tool } from "@modelcontextprotocol/sdk/types.js";
import { type TSchema, Type } from "typebox";
import {
	DESKTOP_ASSISTANT_MCP_SERVER_ID,
	type DesktopToolResult,
	type McpPromptView,
	type McpResourceView,
	type McpServerConfig,
	type McpServerListResponse,
	type McpServerStatus,
	type McpSettings,
	type McpToolView,
} from "../shared/types.ts";
import {
	createDesktopAssistantMcpServer,
	type DesktopAssistantMcpServerOptions,
} from "./desktop-assistant-mcp-server.ts";
import {
	builtInMcpServerConfig,
	normalizeMcpServerConfig,
	normalizeMcpSettings,
	normalizeMcpToolName,
	redactMcpListResponse,
	toToolNameSegment,
} from "./mcp-config.ts";

export interface McpClientManagerOptions extends DesktopAssistantMcpServerOptions {
	initialSettings?: Partial<McpSettings>;
	onStatusChanged?: () => void;
}

interface McpConnection {
	config: McpServerConfig;
	client?: Client;
	transport?: StdioClientTransport | InMemoryTransport;
	server?: McpServer;
	status: McpServerStatus;
	tools: ToolDefinition[];
	originalToolNames: string[];
	originalToolByWrappedName: Map<string, string>;
}

const FALLBACK_SCHEMA = Type.Record(Type.String(), Type.Unknown());
const EMPTY_SCHEMA = Type.Object({});

export class McpClientManager {
	private options: McpClientManagerOptions;
	private settings: McpSettings = normalizeMcpSettings(undefined);
	private connections = new Map<string, McpConnection>();
	private shutdownCountValue = 0;

	constructor(options: McpClientManagerOptions) {
		this.options = options;
		this.settings = normalizeMcpSettings(options.initialSettings);
		for (const server of this.settings.servers) {
			this.connections.set(server.id, this.createDisconnectedConnection(server));
		}
	}

	get shutdownCount(): number {
		return this.shutdownCountValue;
	}

	getSettings(): McpSettings {
		return this.settings;
	}

	list(): McpServerListResponse {
		return redactMcpListResponse({
			enabled: this.settings.enabled,
			servers: this.settings.servers,
			statuses: this.getStatuses(),
		});
	}

	getTools(): ToolDefinition[] {
		if (!this.settings.enabled) return [];
		return this.settings.servers.flatMap((server) => this.connections.get(server.id)?.tools ?? []);
	}

	getActiveToolNames(): string[] {
		return this.getTools().map((tool) => tool.name);
	}

	async applySettings(update: Partial<McpSettings> | undefined): Promise<void> {
		const next = normalizeMcpSettings(update);
		this.settings = next;

		for (const server of next.servers) {
			if (!this.connections.has(server.id)) {
				this.connections.set(server.id, this.createDisconnectedConnection(server));
			}
		}
		for (const id of [...this.connections.keys()]) {
			if (!next.servers.some((server) => server.id === id)) {
				await this.disconnect(id, "deleted");
				this.connections.delete(id);
			}
		}

		if (!next.enabled) {
			await this.shutdownAll();
			return;
		}

		for (const server of next.servers) {
			const existing = this.connections.get(server.id);
			if (!server.enabled) {
				await this.disconnect(server.id, "disabled");
				continue;
			}
			if (!existing || this.shouldReconnect(existing.config, server) || existing.status.state !== "connected") {
				await this.connect(server);
			}
		}
		this.rebuildToolNameCollisions();
		this.options.onStatusChanged?.();
	}

	async shutdownAll(): Promise<void> {
		this.shutdownCountValue += 1;
		for (const id of [...this.connections.keys()]) {
			await this.disconnect(id, "disconnected");
		}
		this.rebuildToolNameCollisions();
		this.options.onStatusChanged?.();
	}

	async upsertServer(
		server: Partial<McpServerConfig> & Pick<McpServerConfig, "name">,
	): Promise<McpServerListResponse> {
		const existingConfig = server.id ? this.settings.servers.find((entry) => entry.id === server.id) : undefined;
		const normalized = normalizeMcpServerConfig(server);
		const normalizedWithEnv = existingConfig
			? { ...normalized, env: mergeRedactedEnv(existingConfig.env, normalized.env) }
			: normalized;
		const existing = this.settings.servers.find((entry) => entry.id === normalized.id);
		const nextServers = existing
			? this.settings.servers.map((entry) =>
					entry.id === normalized.id ? { ...normalizedWithEnv, builtIn: entry.builtIn } : entry,
				)
			: [...this.settings.servers, normalizedWithEnv];
		await this.applySettings({ ...this.settings, servers: nextServers });
		return this.list();
	}

	async deleteServer(id: string): Promise<McpServerListResponse> {
		if (id === DESKTOP_ASSISTANT_MCP_SERVER_ID) {
			throw new Error("Built-in Desktop Assistant MCP cannot be deleted.");
		}
		await this.disconnect(id, "deleted");
		this.connections.delete(id);
		await this.applySettings({
			...this.settings,
			servers: this.settings.servers.filter((server) => server.id !== id),
		});
		return this.list();
	}

	async setEnabled(enabled: boolean): Promise<McpServerListResponse> {
		await this.applySettings({ ...this.settings, enabled });
		return this.list();
	}

	async refreshServer(id: string): Promise<McpServerListResponse> {
		this.assertGlobalEnabled();
		const server = this.settings.servers.find((entry) => entry.id === id);
		if (!server) throw new Error(`Unknown MCP server: ${id}`);
		if (!server.enabled) throw new Error(`MCP server is disabled: ${server.name}`);
		await this.connect(server);
		this.rebuildToolNameCollisions();
		this.options.onStatusChanged?.();
		return this.list();
	}

	async testServer(request: {
		id?: string;
		server?: Partial<McpServerConfig> & Pick<McpServerConfig, "name">;
	}): Promise<McpServerStatus> {
		this.assertGlobalEnabled();
		const config = request.server
			? normalizeMcpServerConfig(request.server)
			: this.settings.servers.find((server) => server.id === request.id);
		if (!config) throw new Error("MCP server not found.");

		const testConnection = this.createDisconnectedConnection(config);
		try {
			await this.connectWithConnection(testConnection);
			return testConnection.status;
		} finally {
			await this.closeConnection(testConnection);
		}
	}

	private async connect(server: McpServerConfig): Promise<void> {
		await this.disconnect(server.id, "connecting");
		const connection = this.createDisconnectedConnection(server);
		this.connections.set(server.id, connection);
		await this.connectWithConnection(connection);
	}

	private async connectWithConnection(connection: McpConnection): Promise<void> {
		const { config } = connection;
		connection.status = this.statusFor(config, "connecting");
		this.options.onStatusChanged?.();
		try {
			const client = new Client({ name: "pi-desktop-assistant", version: "1.0.0" });
			const { transport, server } = await this.createTransport(config);
			connection.client = client;
			connection.transport = transport;
			connection.server = server;
			await client.connect(transport);
			const [tools, resources, prompts] = await Promise.all([
				client.listTools(undefined, { timeout: config.timeoutMs }),
				client
					.listResources(undefined, { timeout: config.timeoutMs })
					.catch(() => ({ resources: [] as Resource[] })),
				client.listPrompts(undefined, { timeout: config.timeoutMs }).catch(() => ({ prompts: [] as Prompt[] })),
			]);
			const toolViews = tools.tools.map((tool) => toToolView(tool, config));
			const resourceViews = resources.resources.map(toResourceView);
			const promptViews = prompts.prompts.map(toPromptView);
			connection.status = {
				...this.statusFor(config, "connected"),
				toolCount: toolViews.length,
				resourceCount: resourceViews.length,
				promptCount: promptViews.length,
				tools: toolViews,
				resources: resourceViews,
				prompts: promptViews,
			};
			connection.tools = tools.tools.map((tool) => this.wrapTool(config, client, tool));
			connection.originalToolNames = tools.tools.map((tool) => tool.name);
			connection.originalToolByWrappedName = new Map(
				connection.tools.map((tool, index) => [tool.name, tools.tools[index]?.name ?? tool.name]),
			);
		} catch (error) {
			await this.closeConnection(connection);
			connection.status = {
				...this.statusFor(config, "error"),
				lastError: error instanceof Error ? error.message : String(error),
			};
			connection.tools = [];
			connection.originalToolNames = [];
			connection.originalToolByWrappedName.clear();
		}
	}

	private async createTransport(config: McpServerConfig): Promise<{
		transport: StdioClientTransport | InMemoryTransport;
		server?: McpServer;
	}> {
		if (config.id === DESKTOP_ASSISTANT_MCP_SERVER_ID || config.builtIn) {
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			const server = createDesktopAssistantMcpServer(this.options);
			await server.connect(serverTransport);
			return { transport: clientTransport, server };
		}
		if (config.transport !== "stdio") {
			throw new Error("Only stdio MCP transport is supported in this version.");
		}
		if (!config.command) {
			throw new Error("stdio MCP server requires a command.");
		}
		return {
			transport: new StdioClientTransport({
				command: config.command,
				args: config.args,
				env: config.env ? { ...getDefaultEnvironment(), ...config.env } : undefined,
				cwd: config.cwd,
				stderr: "pipe",
			}),
		};
	}

	private wrapTool(config: McpServerConfig, client: Client, tool: Tool): ToolDefinition {
		const wrappedName = normalizeMcpToolName(config.toolNamePrefix ?? config.name, tool.name);
		const parameters = schemaToTypebox(tool.inputSchema);
		return defineTool({
			name: wrappedName,
			label: tool.title ?? tool.name,
			description: tool.description ?? `MCP tool ${tool.name} from ${config.name}.`,
			promptSnippet: `MCP ${config.name}: ${tool.name}${tool.description ? ` - ${tool.description}` : ""}`,
			promptGuidelines: [
				`Prefer this MCP tool for tasks that match ${config.name}'s direct control surface before falling back to desktop automation.`,
				"If this MCP tool returns an error or cannot perform the requested action, you may use the normal desktop tools as a fallback.",
				...browserMcpPromptGuidelines(wrappedName, tool.name),
			],
			parameters,
			execute: async (_toolCallId, params, signal) => {
				try {
					const result = (await client.callTool(
						{ name: tool.name, arguments: params as Record<string, unknown> },
						undefined,
						{ timeout: config.timeoutMs, signal },
					)) as CallToolResult;
					return mcpToolResult({
						intent: `MCP ${config.name}`,
						action: tool.name,
						target: config.name,
						ok: result.isError !== true,
						stdout: stringifyMcpResult(result),
						stderr: result.isError ? stringifyMcpResult(result) : undefined,
					});
				} catch (error) {
					return mcpToolResult({
						intent: `MCP ${config.name}`,
						action: tool.name,
						target: config.name,
						ok: false,
						stderr: error instanceof Error ? error.message : String(error),
					});
				}
			},
		});
	}

	private async disconnect(id: string, state: "deleted" | "disabled" | "disconnected" | "connecting"): Promise<void> {
		const existing = this.connections.get(id);
		if (!existing) return;
		await this.closeConnection(existing);
		existing.tools = [];
		existing.originalToolNames = [];
		existing.originalToolByWrappedName.clear();
		const nextState = state === "deleted" || state === "connecting" ? "disconnected" : state;
		existing.status = this.statusFor(existing.config, nextState);
	}

	private async closeConnection(connection: McpConnection): Promise<void> {
		try {
			await connection.client?.close();
		} catch {
			// Ignore close failures; the manager is already dropping the client.
		}
		try {
			await connection.server?.close();
		} catch {
			// Ignore close failures for in-memory sample server.
		}
		try {
			await connection.transport?.close();
		} catch {
			// Ignore transport close failures.
		}
		connection.client = undefined;
		connection.transport = undefined;
		connection.server = undefined;
	}

	private rebuildToolNameCollisions(): void {
		const seen = new Map<string, number>();
		for (const connection of this.connections.values()) {
			connection.tools = connection.tools.map((tool) => {
				const count = seen.get(tool.name) ?? 0;
				seen.set(tool.name, count + 1);
				if (count === 0) return tool;
				const stableName = `${tool.name}_${toToolNameSegment(connection.config.id)}`;
				return { ...tool, name: stableName };
			});
			connection.status = {
				...connection.status,
				tools: connection.tools.map((tool, index) => ({
					name: tool.name,
					originalName:
						connection.originalToolNames[index] ??
						connection.originalToolByWrappedName.get(tool.name) ??
						tool.name,
					title: tool.label,
					description: tool.description,
				})),
				toolCount: connection.tools.length,
			};
		}
	}

	private shouldReconnect(left: McpServerConfig, right: McpServerConfig): boolean {
		return JSON.stringify(left) !== JSON.stringify(right);
	}

	private getStatuses(): McpServerStatus[] {
		return this.settings.servers.map((server) => {
			const connection = this.connections.get(server.id);
			if (!this.settings.enabled) return this.statusFor(server, server.enabled ? "disconnected" : "disabled");
			if (!server.enabled) return this.statusFor(server, "disabled");
			return connection?.status ?? this.statusFor(server, "disconnected");
		});
	}

	private createDisconnectedConnection(config: McpServerConfig): McpConnection {
		return {
			config,
			status: this.statusFor(config, config.enabled ? "disconnected" : "disabled"),
			tools: [],
			originalToolNames: [],
			originalToolByWrappedName: new Map(),
		};
	}

	private statusFor(config: McpServerConfig, state: McpServerStatus["state"]): McpServerStatus {
		return {
			id: config.id,
			name: config.name,
			enabled: config.enabled,
			builtIn: config.builtIn === true || config.id === DESKTOP_ASSISTANT_MCP_SERVER_ID,
			state,
			toolCount: 0,
			resourceCount: 0,
			promptCount: 0,
			tools: [],
			resources: [],
			prompts: [],
		};
	}

	private assertGlobalEnabled(): void {
		if (!this.settings.enabled) {
			throw new Error("MCP is disabled. Enable MCP before testing or refreshing servers.");
		}
	}
}

export function createDefaultMcpSettings(): McpSettings {
	return normalizeMcpSettings({
		enabled: false,
		servers: [builtInMcpServerConfig()],
	});
}

function toToolView(tool: Tool, config: McpServerConfig): McpToolView {
	return {
		name: normalizeMcpToolName(config.toolNamePrefix ?? config.name, tool.name),
		originalName: tool.name,
		title: tool.title,
		description: tool.description,
	};
}

function toResourceView(resource: Resource): McpResourceView {
	return {
		uri: resource.uri,
		name: resource.name,
		title: resource.title,
		description: resource.description,
		mimeType: resource.mimeType,
	};
}

function toPromptView(prompt: Prompt): McpPromptView {
	return {
		name: prompt.name,
		title: prompt.title,
		description: prompt.description,
	};
}

function schemaToTypebox(schema: Tool["inputSchema"] | undefined): TSchema {
	if (!schema) return EMPTY_SCHEMA;
	if (schema.type === "object") {
		return Type.Unsafe(schema as TSchema);
	}
	return FALLBACK_SCHEMA;
}

function stringifyMcpResult(result: CallToolResult): string {
	return JSON.stringify(result, null, 2);
}

function mcpToolResult(params: {
	intent: string;
	action: string;
	target: string;
	ok: boolean;
	stdout?: string;
	stderr?: string;
}): { content: [{ type: "text"; text: string }]; details: DesktopToolResult } {
	const details: DesktopToolResult = {
		stepId: randomUUID(),
		intent: params.intent,
		action: params.action,
		target: params.target,
		status: params.ok ? "succeeded" : "failed",
		stdout: params.stdout,
		stderr: params.stderr,
		riskLevel: "low",
		requiresConfirmation: false,
	};
	return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

function browserMcpPromptGuidelines(wrappedName: string, originalName: string): string[] {
	if (!isBrowserMcpTool(wrappedName, originalName)) return [];
	return [
		"Before operating a page, call take_control once with the target tabId (from list_tabs) or a url, then act on THAT tab. Never assume the user's active tab — the user may switch tabs freely while you keep working on your controlled tab.",
		"Prefer the simulated mouse/keyboard (cursor_click/cursor_double_click/cursor_right_click/cursor_drag/cursor_hover/cursor_type) for interaction — they glide an on-page virtual mouse and type with trusted per-key events scoped to your tab only. They never move the real OS mouse and never reach the user's physical keyboard or other tabs.",
		"If a plain click/type_text does not work, do NOT retry the same code-driven call repeatedly — it already auto-falls back to the virtual cursor once; switch to cursor_click / cursor_type explicitly instead.",
		"Locate targets with find_element (returns a stable elementId + center point) and feed that to cursor_* tools; do not re-run read_page on an unchanged page.",
		"For browser automation, collect the smallest page state that answers the next decision. Prefer read_main_content for articles and read_accessibility_tree / read_tab outline for structure — both are far cheaper than a full read_page.",
		"Batch several independent same-tab steps with the batch tool to cut round-trips and tokens.",
		"Do not repeat read_page on an unchanged page. Use the previous browser snapshot summary or browser_snapshot_read with selected fields instead.",
		"Use evaluate_js only for targeted DOM extraction or actions that browser MCP tools cannot express; avoid dumping full HTML or document text.",
		"Use controlled_status to recall which tabs you control, and release_control when finished so the user fully regains the tab and the debugging banner clears.",
	];
}

function isBrowserMcpTool(wrappedName: string, originalName: string): boolean {
	const haystack = `${wrappedName} ${originalName}`.toLowerCase();
	return haystack.includes("mcp_browser_") || haystack.includes("browser");
}

function mergeRedactedEnv(
	existing: Record<string, string> | undefined,
	next: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!next) return undefined;
	const merged = { ...next };
	for (const [key, value] of Object.entries(next)) {
		if (value === "[redacted]" && existing?.[key] !== undefined) {
			merged[key] = existing[key];
		}
	}
	return merged;
}
