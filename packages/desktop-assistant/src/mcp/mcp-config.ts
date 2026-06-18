import { randomUUID } from "node:crypto";
import {
	DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
	DESKTOP_ASSISTANT_MCP_SERVER_ID,
	type McpServerConfig,
	type McpServerStatus,
	type McpSettings,
} from "../shared/types.ts";

const SECRET_ENV_PATTERN = /(key|token|secret|password|auth|credential)/i;
const DEFAULT_MCP_TIMEOUT_MS = 10000;

export function builtInMcpServerConfig(): McpServerConfig {
	return { ...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.mcp.servers[0] };
}

export function normalizeMcpSettings(update: Partial<McpSettings> | undefined): McpSettings {
	const incomingServers = update?.servers ?? [];
	const serversById = new Map<string, McpServerConfig>();
	serversById.set(DESKTOP_ASSISTANT_MCP_SERVER_ID, builtInMcpServerConfig());

	for (const server of incomingServers) {
		const normalized = normalizeMcpServerConfig(server);
		if (normalized.id === DESKTOP_ASSISTANT_MCP_SERVER_ID) {
			serversById.set(DESKTOP_ASSISTANT_MCP_SERVER_ID, {
				...builtInMcpServerConfig(),
				...normalized,
				id: DESKTOP_ASSISTANT_MCP_SERVER_ID,
				name: "Desktop Assistant MCP",
				builtIn: true,
			});
			continue;
		}
		serversById.set(normalized.id, normalized);
	}

	return {
		enabled: update?.enabled ?? DEFAULT_DESKTOP_ASSISTANT_SETTINGS.mcp.enabled,
		servers: [...serversById.values()],
	};
}

/**
 * Seed the packaged default external MCP servers (e.g. the Office Excel/PPT servers in
 * DEFAULT_DESKTOP_ASSISTANT_SETTINGS) into a user's MCP settings when they are absent by id.
 *
 * `normalizeMcpSettings` only force-keeps the built-in server and otherwise echoes back whatever
 * the caller passes, so packaged default servers never reach users who already have a persisted
 * `mcp-settings.json` (nor a fresh `normalizeMcpSettings(undefined)`). This runs once at load time.
 * Matching is by id, so a server the user has merely disabled — still present in the list — is left
 * untouched; only a fully removed default reappears on the next launch.
 */
export function seedDefaultMcpServers(settings: McpSettings): McpSettings {
	const seedable = DEFAULT_DESKTOP_ASSISTANT_SETTINGS.mcp.servers.filter((server) => !server.builtIn);
	const existingIds = new Set(settings.servers.map((server) => server.id));
	const missing = seedable
		.filter((server) => !existingIds.has(server.id))
		.map((server) => normalizeMcpServerConfig(server));
	if (missing.length === 0) return settings;
	return { ...settings, servers: [...settings.servers, ...missing] };
}

export function normalizeMcpServerConfig(
	server: Partial<McpServerConfig> & Pick<McpServerConfig, "name">,
): McpServerConfig {
	const name = server.name.trim() || "MCP Server";
	const id = server.id?.trim() || createMcpServerId(name);
	const builtIn = id === DESKTOP_ASSISTANT_MCP_SERVER_ID || server.builtIn === true;
	const timeoutMs =
		typeof server.timeoutMs === "number" && Number.isFinite(server.timeoutMs)
			? Math.min(120000, Math.max(1000, Math.floor(server.timeoutMs)))
			: DEFAULT_MCP_TIMEOUT_MS;
	return {
		id,
		name: builtIn ? "Desktop Assistant MCP" : name,
		enabled: server.enabled ?? true,
		transport: server.transport === "http" ? "http" : "stdio",
		command: builtIn ? undefined : cleanOptionalString(server.command),
		args: normalizeStringArray(server.args),
		env: normalizeEnv(server.env),
		cwd: cleanOptionalString(server.cwd),
		timeoutMs,
		toolNamePrefix: cleanOptionalString(server.toolNamePrefix) ?? toToolNameSegment(name),
		description: cleanOptionalString(server.description),
		builtIn,
	};
}

export function createMcpServerId(name: string): string {
	return `${toToolNameSegment(name) || "mcp"}-${randomUUID().slice(0, 8)}`;
}

export function toToolNameSegment(value: string | undefined): string {
	const cleaned = (value ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.replace(/_+/g, "_");
	return cleaned || "server";
}

export function normalizeMcpToolName(prefix: string | undefined, toolName: string): string {
	return `mcp_${toToolNameSegment(prefix)}_${toToolNameSegment(toolName)}`;
}

export function redactMcpSettings(settings: McpSettings | undefined): McpSettings | undefined {
	if (!settings) return undefined;
	return {
		...settings,
		servers: settings.servers.map(redactMcpServerConfig),
	};
}

export function redactMcpServerConfig(server: McpServerConfig): McpServerConfig {
	return {
		...server,
		env: server.env ? redactEnv(server.env) : undefined,
	};
}

export function redactMcpListResponse(params: {
	enabled: boolean;
	servers: McpServerConfig[];
	statuses: McpServerStatus[];
}): {
	enabled: boolean;
	servers: McpServerConfig[];
	statuses: McpServerStatus[];
} {
	return {
		enabled: params.enabled,
		servers: params.servers.map(redactMcpServerConfig),
		statuses: params.statuses,
	};
}

function cleanOptionalString(value: string | undefined): string | undefined {
	const cleaned = value?.trim();
	return cleaned ? cleaned : undefined;
}

function normalizeStringArray(value: string[] | undefined): string[] | undefined {
	if (!value) return undefined;
	const cleaned = value.map((item) => item.trim()).filter(Boolean);
	return cleaned.length > 0 ? cleaned : undefined;
}

function normalizeEnv(value: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!value) return undefined;
	const entries = Object.entries(value)
		.map(([key, envValue]) => [key.trim(), envValue] as const)
		.filter(([key]) => key.length > 0);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function redactEnv(env: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(env).map(([key, value]) => [key, value && SECRET_ENV_PATTERN.test(key) ? "[redacted]" : value]),
	);
}
