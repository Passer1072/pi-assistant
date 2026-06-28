#!/usr/bin/env node
/**
 * Office live add-in bridge MCP server.
 *
 * The Office taskpane connects back over WSS, then this stdio MCP server forwards
 * whitelisted operations to Word.run/Excel.run/PowerPoint.run inside the visible
 * Office document. Phase 1 registers Word tools only.
 */
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

const HOST = process.env.OFFICE_HOST || "word";
const PORT = Number(process.env.OFFICE_BRIDGE_PORT || 49230);
const TOKEN = process.env.OFFICE_BRIDGE_TOKEN || "";
const MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));
const WEBDIR = resolve(process.env.OFFICE_WEB_DIR || join(MODULE_DIR, "web"));
const PFX_PATH = process.env.OFFICE_PFX_PATH || "";
const PFX_PASSPHRASE = process.env.OFFICE_PFX_PASSPHRASE || "";
const CHAT_BRIDGE_URL = process.env.OFFICE_CHAT_BRIDGE_URL || "";
const CHAT_BRIDGE_TOKEN = process.env.OFFICE_CHAT_BRIDGE_TOKEN || "";

const MIME = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".png": "image/png",
};

let liveSocket = null;
let lastSeen = null;
let lastState = null;
let nextId = 1;
const pending = new Map();

const tls = {
	pfx: readFileSync(PFX_PATH),
	passphrase: PFX_PASSPHRASE,
};

const httpsServer = createServer(tls, (req, res) => {
	const url = new URL(req.url || "/", `https://127.0.0.1:${PORT}`);
	const send = (code, body, type = "application/json; charset=utf-8") => {
		res.writeHead(code, { "content-type": type });
		res.end(body);
	};

	if (url.pathname === "/config") {
		send(200, JSON.stringify({ host: HOST, token: TOKEN, chatBridgeUrl: CHAT_BRIDGE_URL, chatBridgeToken: CHAT_BRIDGE_TOKEN }));
		return;
	}
	if (url.pathname === "/health") {
		send(200, JSON.stringify({ ok: true, host: HOST }));
		return;
	}
	if (url.pathname === "/bridge/status") {
		send(200, JSON.stringify({ connected: !!liveSocket, host: HOST, lastSeen, state: lastState }));
		return;
	}

	const requestPath = url.pathname === "/" ? "/taskpane.html" : url.pathname;
	const filePath = resolve(WEBDIR, normalize(requestPath).replace(/^[/\\]+/, ""));
	if (!isWithin(filePath, WEBDIR)) {
		send(403, JSON.stringify({ error: "forbidden" }));
		return;
	}

	try {
		const body = readFileSync(filePath);
		send(200, body, MIME[extname(filePath)] || "application/octet-stream");
	} catch {
		send(404, JSON.stringify({ error: "not found" }));
	}
});

const wss = new WebSocketServer({ server: httpsServer, path: "/ws" });
wss.on("connection", (socket, req) => {
	const url = new URL(req.url || "/", "wss://127.0.0.1");
	const host = url.searchParams.get("host") || "";
	const token = url.searchParams.get("token") || "";
	if (host !== HOST || !tokenOk(token)) {
		socket.close(1008, "bad token");
		return;
	}

	liveSocket = socket;
	lastSeen = Date.now();
	socket.on("message", (data) => {
		lastSeen = Date.now();
		let msg;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return;
		}
		if (msg.type === "state") {
			lastState = msg.state;
			return;
		}
		const item = pending.get(msg.id);
		if (!item) return;
		pending.delete(msg.id);
		item.resolve(msg);
	});
	socket.on("close", () => {
		if (liveSocket === socket) liveSocket = null;
		rejectPending(new Error("add-in disconnected"));
	});
});

function isWithin(filePath, root) {
	const rel = relative(root, filePath);
	return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function tokenOk(token) {
	const a = Buffer.from(token);
	const b = Buffer.from(TOKEN);
	return a.length === b.length && timingSafeEqual(a, b);
}

function rejectPending(error) {
	for (const [, item] of pending) item.reject(error);
	pending.clear();
}

async function call(op, args = {}) {
	if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN) {
		throw new Error(
			`${HOST} add-in is not connected. Open a ${hostLabel()} document, show the Desktop Assistant taskpane, then retry this tool once.`,
		);
	}
	const id = nextId++;
	return await new Promise((resolvePromise, rejectPromise) => {
		const timer = setTimeout(() => {
			if (!pending.has(id)) return;
			pending.delete(id);
			rejectPromise(new Error(`operation ${op} timed out`));
		}, 15000);
		pending.set(id, {
			resolve: (msg) => {
				clearTimeout(timer);
				if (msg.ok) resolvePromise(msg);
				else rejectPromise(new Error(msg.message || `operation ${op} failed`));
			},
			reject: (error) => {
				clearTimeout(timer);
				rejectPromise(error);
			},
		});
		liveSocket.send(JSON.stringify({ id, op, args }));
	});
}

function hostLabel() {
	return { word: "Word", excel: "Excel", ppt: "PowerPoint" }[HOST] || HOST;
}

httpsServer.listen(PORT, "127.0.0.1");

const server = new McpServer({ name: `office-${HOST}-live`, version: "1.0.0" });

function ok(payload) {
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(error) {
	const message = error instanceof Error ? error.message : String(error);
	return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, message }, null, 2) }] };
}

function tool(name, title, description, inputSchema, handler) {
	server.registerTool(name, { title, description, inputSchema }, async (args) => {
		try {
			return ok(await handler(args || {}));
		} catch (error) {
			return fail(error);
		}
	});
}

if (HOST === "word") {
	tool(
		"read_state",
		"Read Word state",
		"Read the current selection text, selected style, paragraph count, and body length before editing.",
		{},
		() => call("read_state").then((response) => response.state),
	);
	tool(
		"read_document",
		"Read Word document",
		"Read document body text. maxChars defaults to 20000 and truncates long documents.",
		{ maxChars: z.number().int().min(1).max(200000).optional() },
		(args) => call("read_document", args).then((response) => response.result),
	);
	tool(
		"set_selection",
		"Select matching text",
		"Select the first body match for the given text so following operations can replace or format it.",
		{ find: z.string() },
		(args) => call("set_selection", args).then((response) => ({ ...response.result, state: response.state })),
	);
	tool(
		"insert_text",
		"Insert Word text",
		"Insert text at the current selection, start, or end of the visible Word document.",
		{ text: z.string(), location: z.enum(["selection", "start", "end"]).optional() },
		(args) => call("insert_text", args).then((response) => response.state),
	);
	tool(
		"replace_selection",
		"Replace Word selection",
		"Replace the current Word selection with text.",
		{ text: z.string() },
		(args) => call("replace_selection", args).then((response) => response.state),
	);
	tool(
		"replace_all",
		"Replace all Word matches",
		"Replace all body matches of find with replace.",
		{ find: z.string(), replace: z.string(), matchCase: z.boolean().optional() },
		(args) => call("replace_all", args).then((response) => ({ ...response.result, state: response.state })),
	);
	tool(
		"format_selection",
		"Format Word selection",
		"Apply bold, italic, font, size, color, or highlight to the current selection.",
		{
			bold: z.boolean().optional(),
			italic: z.boolean().optional(),
			font: z.string().optional(),
			size: z.number().positive().optional(),
			color: z.string().optional(),
			highlight: z.string().optional(),
		},
		(args) => call("format_selection", args).then((response) => response.state),
	);
	tool(
		"apply_style",
		"Apply Word paragraph style",
		"Apply a Word built-in style to the current selection. Prefer Word.BuiltInStyleName keys when possible.",
		{ style: z.string() },
		(args) => call("apply_style", args).then((response) => response.state),
	);
	tool(
		"insert_html",
		"Insert Word HTML",
		"Insert HTML at the current selection, start, or end of the visible Word document.",
		{ html: z.string(), location: z.enum(["selection", "start", "end"]).optional() },
		(args) => call("insert_html", args).then((response) => response.state),
	);
}

await server.connect(new StdioServerTransport());
