import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DesktopAssistantSettings, PendingPromptAttachment } from "../../shared/types.ts";
import type { DebugBridgeHandlers } from "./debug-bridge-handlers.ts";

const DEBUG_BRIDGE_DOC_PATH = "packages/desktop-assistant/docs/DEBUG_BRIDGE.md";

export function createDebugBridgeMcpServer(handlers: DebugBridgeHandlers): McpServer {
	const server = new McpServer(
		{
			name: "desktop-assistant-debug-bridge",
			version: "1.0.0",
		},
		{
			capabilities: {
				tools: {},
				resources: {},
				prompts: {},
			},
		},
	);

	server.registerTool(
		"debug_list_sessions",
		{
			title: "List sessions",
			description: "List live Desktop Assistant sessions.",
			inputSchema: {},
		},
		async () => textResult(await handlers.listSessions()),
	);

	server.registerTool(
		"debug_get_session",
		{
			title: "Get session",
			description:
				"Read the focused session as a full snapshot. For non-focused sessions, returns a side-effect-free history page unless focus is true.",
			inputSchema: {
				sessionId: z.string().min(1),
				focus: z.boolean().optional(),
				limit: z.number().int().positive().optional(),
			},
		},
		async ({ sessionId, focus, limit }) => textResult(await handlers.getSession(sessionId, { focus, limit })),
	);

	server.registerTool(
		"debug_new_session",
		{
			title: "New session",
			description: "Create and focus a new Desktop Assistant session.",
			inputSchema: {},
		},
		async () => textResult(await handlers.newSession()),
	);

	server.registerTool(
		"debug_send_prompt",
		{
			title: "Send prompt",
			description: "Send a prompt to a Desktop Assistant session as the user.",
			inputSchema: {
				sessionId: z.string().min(1),
				message: z.string().min(1),
				attachments: z.array(z.record(z.unknown())).optional(),
			},
		},
		async ({ sessionId, message, attachments }) =>
			textResult(
				await handlers.sendPrompt(sessionId, {
					message,
					attachments: attachments as PendingPromptAttachment[] | undefined,
				}),
			),
	);

	server.registerTool(
		"debug_focus_session",
		{
			title: "Focus session",
			description: "Focus a live or archived Desktop Assistant session.",
			inputSchema: { sessionId: z.string().min(1) },
		},
		async ({ sessionId }) => textResult(await handlers.focusSession(sessionId)),
	);

	server.registerTool(
		"debug_close_session",
		{
			title: "Close session",
			description: "Close a live Desktop Assistant session without deleting its archive.",
			inputSchema: { sessionId: z.string().min(1) },
		},
		async ({ sessionId }) => textResult(await handlers.closeSession(sessionId)),
	);

	server.registerTool(
		"debug_abort",
		{
			title: "Abort session",
			description: "Abort a running Desktop Assistant session.",
			inputSchema: { sessionId: z.string().min(1).optional() },
		},
		async ({ sessionId }) => textResult(await handlers.abort(sessionId)),
	);

	server.registerTool(
		"debug_approve_confirmation",
		{
			title: "Approve confirmation",
			description: "Approve a pending confirmation by id.",
			inputSchema: {
				id: z.string().min(1),
				sessionId: z.string().min(1).optional(),
			},
		},
		async ({ id, sessionId }) => textResult(await handlers.approveConfirmation(id, sessionId)),
	);

	server.registerTool(
		"debug_reject_confirmation",
		{
			title: "Reject confirmation",
			description: "Reject a pending confirmation by id.",
			inputSchema: {
				id: z.string().min(1),
				sessionId: z.string().min(1).optional(),
			},
		},
		async ({ id, sessionId }) => textResult(await handlers.rejectConfirmation(id, sessionId)),
	);

	server.registerTool(
		"debug_get_settings",
		{
			title: "Get settings",
			description: "Return the live Desktop Assistant settings snapshot. Treat returned secrets as sensitive.",
			inputSchema: {},
		},
		async () => textResult(await handlers.getSettings()),
	);

	server.registerTool(
		"debug_update_settings",
		{
			title: "Update settings",
			description: "Deep-merge Desktop Assistant settings and return the resulting snapshot.",
			inputSchema: {
				settings: z.record(z.unknown()),
			},
		},
		async ({ settings }) => textResult(await handlers.updateSettings(settings as Partial<DesktopAssistantSettings>)),
	);

	server.registerTool(
		"debug_get_logs",
		{
			title: "Get logs",
			description: "Return recent in-memory Desktop Assistant log entries.",
			inputSchema: { limit: z.number().int().positive().optional() },
		},
		async ({ limit }) => textResult(await handlers.getLogs(limit)),
	);

	server.registerTool(
		"debug_reload",
		{
			title: "Reload assistant windows",
			description: "Reload all Desktop Assistant windows, ignoring cache.",
			inputSchema: {},
		},
		async () => textResult(await handlers.reload()),
	);

	server.registerTool(
		"debug_relaunch",
		{
			title: "Relaunch assistant",
			description: "Relaunch Desktop Assistant.",
			inputSchema: {},
		},
		async () => textResult(await handlers.relaunch()),
	);

	server.registerTool(
		"debug_introspect",
		{
			title: "Introspect assistant",
			description: "Return process, MCP, sandbox, and session status.",
			inputSchema: {},
		},
		async () => textResult(await handlers.introspect()),
	);

	server.registerResource(
		"debug_guide",
		"debug://guide",
		{
			title: "Debug Bridge guide",
			description: "Full operational guide for the Desktop Assistant Debug Bridge.",
			mimeType: "text/markdown",
		},
		() => ({
			contents: [{ uri: "debug://guide", mimeType: "text/markdown", text: readGuideMarkdown() }],
		}),
	);

	server.registerResource(
		"debug_capabilities",
		"debug://capabilities",
		{
			title: "Debug Bridge capabilities",
			description: "The same JSON returned by GET /capabilities.",
			mimeType: "application/json",
		},
		async () => ({
			contents: [
				{
					uri: "debug://capabilities",
					mimeType: "application/json",
					text: JSON.stringify(await handlers.capabilities(), null, 2),
				},
			],
		}),
	);

	server.registerResource(
		"debug_session",
		new ResourceTemplate("debug://session/{id}", { list: undefined }),
		{
			title: "Debug Bridge session",
			description: "Read a Desktop Assistant session by id.",
			mimeType: "application/json",
		},
		async (uri, variables) => {
			const id = String(variables.id ?? "");
			return {
				contents: [
					{
						uri: uri.toString(),
						mimeType: "application/json",
						text: JSON.stringify(await handlers.getSession(id), null, 2),
					},
				],
			};
		},
	);

	server.registerPrompt(
		"cojoint_debug_session",
		{
			title: "Co-joint debug session",
			description: "Guide an external AI through edit, reload, prompt, observe, and iterate.",
		},
		() => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: "Use the Debug Bridge to co-debug Desktop Assistant: read capabilities, list sessions, reload after code changes, send a prompt to the target session, then observe /events or debug_get_session until the run is complete. Treat the bridge token as a full-control secret.",
					},
				},
			],
		}),
	);

	return server;
}

function readGuideMarkdown(): string {
	try {
		return readFileSync(join(process.cwd(), DEBUG_BRIDGE_DOC_PATH), "utf-8");
	} catch {
		return [
			"# Desktop Assistant Debug Bridge",
			"",
			"Start the app with DA_DEBUG_BRIDGE=1, read the handshake file from the agent directory, then use the REST, WebSocket, or MCP surface on 127.0.0.1.",
		].join("\n");
	}
}

function textResult(value: unknown): { content: [{ type: "text"; text: string }] } {
	return {
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
	};
}
