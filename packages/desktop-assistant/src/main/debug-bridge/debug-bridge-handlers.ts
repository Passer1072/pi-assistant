import { randomUUID } from "node:crypto";
import type { DesktopAgentService } from "../../agent/desktop-agent-service.ts";
import type {
	DesktopAssistantSettings,
	DesktopAssistantSnapshot,
	ListSessionsResponse,
	LogEntry,
	McpServerListResponse,
	PendingPromptAttachment,
	SandboxStatus,
} from "../../shared/types.ts";
import type { LogStore } from "../log-store.ts";

const DEFAULT_SESSION_PAGE_LIMIT = 500;

export interface DebugBridgeApp {
	readonly isPackaged: boolean;
	getVersion(): string;
	relaunch(): void;
	exit(code?: number): void;
}

export interface DebugBridgeWindow {
	isDestroyed(): boolean;
	webContents: {
		reloadIgnoringCache(): void;
	};
}

type DebugBridgeService = Pick<
	DesktopAgentService,
	| "abort"
	| "approveConfirmation"
	| "closeSession"
	| "focusSession"
	| "getSandboxStatus"
	| "listMcpServers"
	| "listSessions"
	| "loadConversationPage"
	| "newConversation"
	| "prompt"
	| "rejectConfirmation"
	| "snapshot"
	| "updateSettings"
>;

export interface DebugBridgeHandlersOptions {
	service: DebugBridgeService;
	logStore: LogStore;
	app: DebugBridgeApp;
	getWindows: () => Iterable<DebugBridgeWindow>;
	agentDir: string;
	clearCache?: () => Promise<void> | void;
}

export interface DebugBridgePromptRequest {
	message: string;
	attachments?: PendingPromptAttachment[];
}

export interface DebugBridgeSessionRequest {
	focus?: boolean;
	limit?: number;
}

export interface DebugBridgeCapabilities {
	name: "debug-bridge";
	version: string;
	defaultBaseUrl: string;
	docPath: string;
	handshakeFile: string;
	rest: Array<{ method: string; path: string; auth: boolean; description: string }>;
	websocket: Array<{ path: string; auth: boolean; description: string }>;
	mcp: {
		urlPath: string;
		tools: string[];
		resources: string[];
		prompts: string[];
	};
	notes: string[];
}

export interface DebugBridgeHandlers {
	health(): Promise<{ ok: true; version: string; packaged: boolean }>;
	capabilities(): Promise<DebugBridgeCapabilities>;
	openApi(): Promise<Record<string, unknown>>;
	listSessions(): Promise<ListSessionsResponse>;
	getSession(sessionId: string, request?: DebugBridgeSessionRequest): Promise<unknown>;
	newSession(): Promise<DesktopAssistantSnapshot>;
	sendPrompt(sessionId: string, request: DebugBridgePromptRequest): Promise<{ ok: true; sessionId: string }>;
	focusSession(sessionId: string): Promise<DesktopAssistantSnapshot>;
	closeSession(sessionId: string): Promise<DesktopAssistantSnapshot>;
	abort(sessionId?: string): Promise<{ ok: true; sessionId?: string }>;
	approveConfirmation(id: string, sessionId?: string): Promise<DesktopAssistantSnapshot>;
	rejectConfirmation(id: string, sessionId?: string): Promise<DesktopAssistantSnapshot>;
	getSettings(): Promise<DesktopAssistantSettings>;
	updateSettings(update: Partial<DesktopAssistantSettings>): Promise<DesktopAssistantSnapshot>;
	getLogs(limit?: number): Promise<{ entries: LogEntry[]; total: number; returned: number }>;
	reload(): Promise<{ ok: true; reloaded: number }>;
	relaunch(): Promise<{ ok: true; relaunching: true }>;
	clearCache(): Promise<{ ok: true }>;
	introspect(): Promise<{
		mcp?: McpServerListResponse;
		sandbox?: SandboxStatus;
		sessions: ListSessionsResponse;
		memory: NodeJS.MemoryUsage;
		uptime: number;
		pid: number;
	}>;
}

export function createDebugBridgeHandlers(options: DebugBridgeHandlersOptions): DebugBridgeHandlers {
	return {
		async health() {
			return {
				ok: true,
				version: options.app.getVersion(),
				packaged: options.app.isPackaged,
			};
		},
		async capabilities() {
			return createCapabilities(options.app.getVersion(), options.agentDir);
		},
		async openApi() {
			return createOpenApi();
		},
		async listSessions() {
			return options.service.listSessions();
		},
		async getSession(sessionId, request = {}) {
			const snapshot = options.service.snapshot();
			if (sessionId === snapshot.sessionId || sessionId === snapshot.focusedSessionId) {
				return {
					kind: "snapshot",
					focusChanged: false,
					snapshot,
				};
			}
			const limit = normalizePositiveInt(request.limit, DEFAULT_SESSION_PAGE_LIMIT);
			const page = options.service.loadConversationPage({ sessionId, limit });
			return {
				kind: "history_page",
				focusChanged: false,
				note: request.focus
					? "Read endpoints do not change focus. Use POST /sessions/:id/focus before reading a live snapshot."
					: "Use POST /sessions/:id/focus before reading this session as the focused live snapshot.",
				page,
			};
		},
		async newSession() {
			audit(options.logStore, "new session", {});
			return options.service.newConversation();
		},
		async sendPrompt(sessionId, request) {
			const message = request.message;
			if (typeof message !== "string" || !message.trim()) {
				throw new Error("message is required");
			}
			const attachments = Array.isArray(request.attachments) ? request.attachments : [];
			audit(options.logStore, "send prompt", {
				sessionId,
				messageLength: message.length,
				attachmentCount: attachments.length,
			});
			await options.service.prompt(message, "text", attachments, sessionId, "prompt");
			return { ok: true, sessionId };
		},
		async focusSession(sessionId) {
			audit(options.logStore, "focus session", { sessionId });
			return options.service.focusSession(sessionId);
		},
		async closeSession(sessionId) {
			audit(options.logStore, "close session", { sessionId });
			return options.service.closeSession(sessionId);
		},
		async abort(sessionId) {
			audit(options.logStore, "abort session", { sessionId });
			options.service.abort(sessionId);
			return { ok: true, sessionId };
		},
		async approveConfirmation(id, sessionId) {
			audit(options.logStore, "approve confirmation", { id, sessionId });
			return options.service.approveConfirmation(id, sessionId);
		},
		async rejectConfirmation(id, sessionId) {
			audit(options.logStore, "reject confirmation", { id, sessionId });
			return options.service.rejectConfirmation(id, sessionId);
		},
		async getSettings() {
			return options.service.snapshot().settings;
		},
		async updateSettings(update) {
			const current = options.service.snapshot().settings;
			const merged = mergeTopLevelSettingsUpdate(current, update);
			audit(options.logStore, "update settings", { keys: Object.keys(update) });
			return options.service.updateSettings(merged);
		},
		async getLogs(limit) {
			const entries = options.logStore.getAll();
			const normalizedLimit = normalizePositiveInt(limit, entries.length);
			const returnedEntries = entries.slice(-normalizedLimit);
			return {
				entries: returnedEntries,
				total: entries.length,
				returned: returnedEntries.length,
			};
		},
		async reload() {
			let reloaded = 0;
			for (const win of options.getWindows()) {
				if (win.isDestroyed()) continue;
				win.webContents.reloadIgnoringCache();
				reloaded += 1;
			}
			audit(options.logStore, "reload windows", { reloaded });
			return { ok: true, reloaded };
		},
		async relaunch() {
			audit(options.logStore, "relaunch app", {});
			options.app.relaunch();
			setTimeout(() => options.app.exit(0), 0);
			return { ok: true, relaunching: true };
		},
		async clearCache() {
			audit(options.logStore, "clear cache", {});
			await options.clearCache?.();
			return { ok: true };
		},
		async introspect() {
			return {
				mcp: options.service.listMcpServers(),
				sandbox: options.service.getSandboxStatus(),
				sessions: options.service.listSessions(),
				memory: process.memoryUsage(),
				uptime: process.uptime(),
				pid: process.pid,
			};
		},
	};
}

export function mergeTopLevelSettingsUpdate(
	current: DesktopAssistantSettings,
	update: Partial<DesktopAssistantSettings>,
): Partial<DesktopAssistantSettings> {
	const merged: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(update)) {
		const currentValue = getSettingValue(current, key);
		merged[key] = isPlainObject(currentValue) && isPlainObject(value) ? deepMerge(currentValue, value) : value;
	}
	return merged as Partial<DesktopAssistantSettings>;
}

function getSettingValue(settings: DesktopAssistantSettings, key: string): unknown {
	return (settings as unknown as Record<string, unknown>)[key];
}

function deepMerge(base: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
	const next: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(update)) {
		const currentValue = next[key];
		next[key] = isPlainObject(currentValue) && isPlainObject(value) ? deepMerge(currentValue, value) : value;
	}
	return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePositiveInt(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

function audit(logStore: LogStore, action: string, details: Record<string, unknown>): void {
	logStore.push({
		id: randomUUID(),
		ts: Date.now(),
		cat: "system",
		title: `Debug bridge: ${action}`,
		detail: JSON.stringify({ source: "debug-bridge", action, ...details }),
	});
}

function createCapabilities(version: string, agentDir: string): DebugBridgeCapabilities {
	return {
		name: "debug-bridge",
		version,
		defaultBaseUrl: "http://127.0.0.1:49250",
		docPath: "packages/desktop-assistant/docs/DEBUG_BRIDGE.md",
		handshakeFile: `${agentDir.replace(/\\/g, "/")}/debug-bridge.json`,
		rest: [
			{ method: "GET", path: "/health", auth: false, description: "Minimal liveness check." },
			{ method: "GET", path: "/capabilities", auth: true, description: "Self-description for tools and docs." },
			{ method: "GET", path: "/openapi.json", auth: true, description: "Small OpenAPI description." },
			{ method: "GET", path: "/sessions", auth: true, description: "List live sessions." },
			{ method: "GET", path: "/sessions/:id", auth: true, description: "Read focused snapshot or history page." },
			{ method: "POST", path: "/sessions", auth: true, description: "Create a new session." },
			{ method: "POST", path: "/sessions/:id/prompt", auth: true, description: "Send a prompt as the user." },
			{ method: "POST", path: "/sessions/:id/focus", auth: true, description: "Focus a session." },
			{ method: "POST", path: "/sessions/:id/close", auth: true, description: "Close a live session." },
			{ method: "POST", path: "/sessions/:id/abort", auth: true, description: "Abort a running session." },
			{ method: "POST", path: "/confirmations/:id/approve", auth: true, description: "Approve a confirmation." },
			{ method: "POST", path: "/confirmations/:id/reject", auth: true, description: "Reject a confirmation." },
			{ method: "GET", path: "/settings", auth: true, description: "Return settings from the live snapshot." },
			{ method: "PATCH", path: "/settings", auth: true, description: "Deep-merge settings and update them." },
			{ method: "GET", path: "/logs", auth: true, description: "Return recent in-memory logs." },
			{ method: "POST", path: "/actions/reload", auth: true, description: "Reload all assistant windows." },
			{ method: "POST", path: "/actions/relaunch", auth: true, description: "Relaunch the app." },
			{ method: "POST", path: "/actions/clear-cache", auth: true, description: "Clear Electron cache." },
			{ method: "GET", path: "/introspect", auth: true, description: "Return process and internal status." },
		],
		websocket: [
			{
				path: "/events",
				auth: true,
				description: "Streams raw DesktopAssistantEvent payloads plus {type:'log', entry}.",
			},
		],
		mcp: {
			urlPath: "/mcp",
			tools: [
				"debug_list_sessions",
				"debug_get_session",
				"debug_new_session",
				"debug_send_prompt",
				"debug_focus_session",
				"debug_close_session",
				"debug_abort",
				"debug_approve_confirmation",
				"debug_reject_confirmation",
				"debug_get_settings",
				"debug_update_settings",
				"debug_get_logs",
				"debug_reload",
				"debug_relaunch",
				"debug_introspect",
			],
			resources: ["debug://guide", "debug://capabilities", "debug://session/{id}"],
			prompts: ["cojoint_debug_session"],
		},
		notes: [
			"Disabled by default. Start with DA_DEBUG_BRIDGE=1.",
			"Token access is equivalent to local full control of the assistant.",
			"Only binds to 127.0.0.1 and rejects browser Origin headers by default.",
		],
	};
}

function createOpenApi(): Record<string, unknown> {
	return {
		openapi: "3.1.0",
		info: {
			title: "Pi Desktop Assistant Debug Bridge",
			version: "1.0.0",
		},
		servers: [{ url: "http://127.0.0.1:49250" }],
		security: [{ bearerAuth: [] }],
		paths: {
			"/health": { get: { security: [], responses: { "200": { description: "OK" } } } },
			"/capabilities": { get: { responses: { "200": { description: "Capabilities" } } } },
			"/sessions": {
				get: { responses: { "200": { description: "List sessions" } } },
				post: { responses: { "200": { description: "New session snapshot" } } },
			},
			"/sessions/{id}": { get: { responses: { "200": { description: "Session detail" } } } },
			"/sessions/{id}/prompt": { post: { responses: { "200": { description: "Prompt accepted" } } } },
			"/settings": {
				get: { responses: { "200": { description: "Settings" } } },
				patch: { responses: { "200": { description: "Updated snapshot" } } },
			},
			"/logs": { get: { responses: { "200": { description: "Recent logs" } } } },
			"/introspect": { get: { responses: { "200": { description: "Internal status" } } } },
		},
		components: {
			securitySchemes: {
				bearerAuth: { type: "http", scheme: "bearer" },
			},
		},
	};
}
