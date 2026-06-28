import { timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WebSocketServer } from "ws";
import type { DesktopAgentService } from "../../agent/desktop-agent-service.ts";
import type { DesktopAssistantEvent } from "../../shared/types.ts";
import type { LogStore } from "../log-store.ts";
import type { DebugBridgeApp, DebugBridgeHandlers } from "./debug-bridge-handlers.ts";
import { createDebugBridgeMcpServer } from "./debug-bridge-mcp.ts";

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);

export interface DebugBridgeServerOptions {
	port: number;
	getToken: () => string;
	handlers: DebugBridgeHandlers;
	service: Pick<DesktopAgentService, "snapshot" | "subscribe">;
	logStore: LogStore;
}

export interface DebugBridgeHandshake {
	port: number;
	token: string;
	baseUrl: string;
	mcpUrl: string;
	openapiUrl: string;
	docPath: string;
	pid: number;
}

export class DebugBridgeServer {
	private readonly server: Server;
	private readonly wss: WebSocketServer;
	private readonly sockets = new Set<BridgeSocket>();
	private readonly unsubscribeService: () => void;
	private readonly unsubscribeLogs: () => void;
	private readonly options: DebugBridgeServerOptions;

	constructor(options: DebugBridgeServerOptions) {
		this.options = options;
		this.server = createServer((req, res) => {
			void this.handleHttp(req, res);
		});
		this.wss = new WebSocketServer({ server: this.server, path: "/events" });
		this.wss.on("connection", (rawSocket: unknown, req: IncomingMessage) => {
			const socket = rawSocket as BridgeSocket;
			if (!this.requestAllowed(req) || !this.tokenOk(tokenFromRequest(req))) {
				socket.close(1008, "debug bridge rejected");
				return;
			}
			this.sockets.add(socket);
			this.sendSocket(socket, { type: "snapshot", snapshot: this.options.service.snapshot() });
			socket.on("close", () => this.sockets.delete(socket));
		});
		this.unsubscribeService = this.options.service.subscribe((event) => this.broadcastServiceEvent(event));
		this.unsubscribeLogs = this.options.logStore.subscribe((entry) => this.broadcast({ type: "log", entry }));
	}

	listen(): Promise<void> {
		return new Promise((resolvePromise, rejectPromise) => {
			this.server.once("error", rejectPromise);
			this.server.listen(this.options.port, "127.0.0.1", () => {
				this.server.off("error", rejectPromise);
				resolvePromise();
			});
		});
	}

	address(): AddressInfo | string | null {
		return this.server.address();
	}

	close(): Promise<void> {
		this.unsubscribeService();
		this.unsubscribeLogs();
		for (const socket of this.sockets) socket.close(1001, "debug bridge closing");
		this.wss.close();
		return new Promise((resolvePromise) => this.server.close(() => resolvePromise()));
	}

	private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const url = new URL(req.url || "/", "http://localhost");
			if (!this.requestAllowed(req)) {
				this.sendJson(res, 403, { ok: false, message: "debug bridge rejects this host or origin" });
				return;
			}
			if (req.method === "OPTIONS") {
				this.send(res, 204, "");
				return;
			}
			if (url.pathname === "/health" && req.method === "GET") {
				this.sendJson(res, 200, await this.options.handlers.health());
				return;
			}
			if (!this.tokenOk(tokenFromRequest(req))) {
				this.sendJson(res, 401, { ok: false, message: "bad token" });
				return;
			}
			if (url.pathname === "/mcp") {
				await this.handleMcp(req, res);
				return;
			}
			await this.dispatchRest(req, res, url);
		} catch (error) {
			const status = error instanceof SyntaxError ? 400 : 500;
			this.sendJson(res, status, {
				ok: false,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async dispatchRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		const path = url.pathname;
		if (path === "/capabilities" && req.method === "GET") {
			this.sendJson(res, 200, await this.options.handlers.capabilities());
			return;
		}
		if (path === "/openapi.json" && req.method === "GET") {
			this.sendJson(res, 200, await this.options.handlers.openApi());
			return;
		}
		if (path === "/sessions" && req.method === "GET") {
			this.sendJson(res, 200, await this.options.handlers.listSessions());
			return;
		}
		if (path === "/sessions" && req.method === "POST") {
			this.sendJson(res, 200, await this.options.handlers.newSession());
			return;
		}
		const sessionRoute = matchRoute(path, /^\/sessions\/([^/]+)(?:\/([^/]+))?$/);
		if (sessionRoute) {
			const [sessionId, action] = sessionRoute;
			if (!sessionId) {
				this.sendJson(res, 404, { ok: false, message: "not found" });
				return;
			}
			if (!action && req.method === "GET") {
				this.sendJson(
					res,
					200,
					await this.options.handlers.getSession(sessionId, {
						focus: url.searchParams.get("focus") === "1" || url.searchParams.get("focus") === "true",
						limit: numberParam(url, "limit"),
					}),
				);
				return;
			}
			if (action === "prompt" && req.method === "POST") {
				const body = await readJsonBody(req);
				const message = typeof body.message === "string" ? body.message : "";
				const attachments = Array.isArray(body.attachments) ? body.attachments : undefined;
				this.sendJson(
					res,
					200,
					await this.options.handlers.sendPrompt(sessionId, {
						message,
						attachments: attachments as never,
					}),
				);
				return;
			}
			if (action === "focus" && req.method === "POST") {
				this.sendJson(res, 200, await this.options.handlers.focusSession(sessionId));
				return;
			}
			if (action === "close" && req.method === "POST") {
				this.sendJson(res, 200, await this.options.handlers.closeSession(sessionId));
				return;
			}
			if (action === "abort" && req.method === "POST") {
				this.sendJson(res, 200, await this.options.handlers.abort(sessionId));
				return;
			}
		}
		const confirmationRoute = matchRoute(path, /^\/confirmations\/([^/]+)\/(approve|reject)$/);
		if (confirmationRoute && req.method === "POST") {
			const [id, action] = confirmationRoute;
			if (!id) {
				this.sendJson(res, 404, { ok: false, message: "not found" });
				return;
			}
			const body = await readJsonBody(req);
			const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
			const result =
				action === "approve"
					? await this.options.handlers.approveConfirmation(id, sessionId)
					: await this.options.handlers.rejectConfirmation(id, sessionId);
			this.sendJson(res, 200, result);
			return;
		}
		if (path === "/settings" && req.method === "GET") {
			this.sendJson(res, 200, await this.options.handlers.getSettings());
			return;
		}
		if (path === "/settings" && req.method === "PATCH") {
			const body = await readJsonBody(req);
			const update = isObjectRecord(body.settings) ? body.settings : body;
			this.sendJson(res, 200, await this.options.handlers.updateSettings(update));
			return;
		}
		if (path === "/logs" && req.method === "GET") {
			this.sendJson(res, 200, await this.options.handlers.getLogs(numberParam(url, "limit")));
			return;
		}
		if (path === "/actions/reload" && req.method === "POST") {
			this.sendJson(res, 200, await this.options.handlers.reload());
			return;
		}
		if (path === "/actions/relaunch" && req.method === "POST") {
			this.sendJson(res, 202, await this.options.handlers.relaunch());
			return;
		}
		if (path === "/actions/clear-cache" && req.method === "POST") {
			this.sendJson(res, 200, await this.options.handlers.clearCache());
			return;
		}
		if (path === "/introspect" && req.method === "GET") {
			this.sendJson(res, 200, await this.options.handlers.introspect());
			return;
		}
		this.sendJson(res, 404, { ok: false, message: "not found" });
	}

	private async handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const mcpServer = createDebugBridgeMcpServer(this.options.handlers);
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		try {
			await mcpServer.connect(transport);
			await transport.handleRequest(req, res);
			res.on("close", () => {
				void transport.close();
				void mcpServer.close();
			});
		} catch (error) {
			void transport.close();
			void mcpServer.close();
			if (!res.headersSent) {
				this.sendJson(res, 500, {
					jsonrpc: "2.0",
					error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
					id: null,
				});
			}
		}
	}

	private broadcastServiceEvent(event: DesktopAssistantEvent): void {
		this.broadcast(event);
	}

	private broadcast(payload: unknown): void {
		for (const socket of this.sockets) this.sendSocket(socket, payload);
	}

	private sendSocket(socket: BridgeSocket, payload: unknown): void {
		if (socket.readyState !== socket.OPEN) return;
		socket.send(JSON.stringify(payload));
	}

	private sendJson(res: ServerResponse, code: number, payload: unknown): void {
		this.send(res, code, JSON.stringify(payload), "application/json; charset=utf-8");
	}

	private send(res: ServerResponse, code: number, body: string, type = "text/plain; charset=utf-8"): void {
		res.writeHead(code, {
			"cache-control": "no-store",
			"content-type": type,
		});
		res.end(body);
	}

	private requestAllowed(req: IncomingMessage): boolean {
		if (!hostAllowed(req.headers.host)) return false;
		const origin = headerValue(req.headers.origin);
		return origin === undefined || origin === "";
	}

	private tokenOk(token: string): boolean {
		const a = Buffer.from(token);
		const b = Buffer.from(this.options.getToken());
		return a.length === b.length && timingSafeEqual(a, b);
	}
}

interface BridgeSocket {
	readonly OPEN: number;
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	on(event: "close", listener: () => void): void;
}

export function shouldStartDebugBridge(app: DebugBridgeApp, env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.DA_DEBUG_BRIDGE !== "1") return false;
	if (app.isPackaged && env.DA_DEBUG_BRIDGE_FORCE !== "1") return false;
	return true;
}

export function createDebugBridgeHandshake(port: number, token: string): DebugBridgeHandshake {
	const baseUrl = `http://127.0.0.1:${port}`;
	return {
		port,
		token,
		baseUrl,
		mcpUrl: `${baseUrl}/mcp`,
		openapiUrl: `${baseUrl}/openapi.json`,
		docPath: "packages/desktop-assistant/docs/DEBUG_BRIDGE.md",
		pid: process.pid,
	};
}

export function writeDebugBridgeHandshakeFile(agentDir: string, handshake: DebugBridgeHandshake): string {
	mkdirSync(agentDir, { recursive: true });
	const filePath = join(agentDir, "debug-bridge.json");
	writeFileSync(filePath, `${JSON.stringify(handshake, null, 2)}\n`, "utf-8");
	try {
		chmodSync(filePath, 0o600);
	} catch {
		// Best effort on Windows.
	}
	return filePath;
}

export function printDebugBridgeBanner(handshakeFile: string, handshake: DebugBridgeHandshake): void {
	console.info(
		[
			"Debug Bridge enabled",
			`  baseUrl: ${handshake.baseUrl}`,
			`  mcpUrl: ${handshake.mcpUrl}`,
			`  handshake: ${handshakeFile}`,
			`  docs: ${handshake.docPath}`,
			"  token: stored in the handshake file",
		].join("\n"),
	);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_JSON_BODY_BYTES) {
			throw new Error("JSON body exceeds 1 MiB");
		}
		chunks.push(buffer);
	}
	if (!chunks.length) return {};
	const text = Buffer.concat(chunks).toString("utf-8");
	return JSON.parse(text) as Record<string, unknown>;
}

function tokenFromRequest(req: IncomingMessage): string {
	const url = new URL(req.url || "/", "http://localhost");
	const queryToken = url.searchParams.get("token");
	if (queryToken) return queryToken;
	const authorization = headerValue(req.headers.authorization);
	const prefix = "Bearer ";
	return authorization?.startsWith(prefix) ? authorization.slice(prefix.length) : "";
}

function hostAllowed(host: string | string[] | undefined): boolean {
	const value = headerValue(host);
	if (!value) return false;
	const hostname = value.startsWith("[") ? value.slice(1, value.indexOf("]")) : value.split(":")[0];
	return ALLOWED_HOSTS.has(hostname.toLowerCase());
}

function headerValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function matchRoute(pathname: string, pattern: RegExp): Array<string | undefined> | undefined {
	const match = pattern.exec(pathname);
	if (!match) return undefined;
	return match.slice(1).map((part) => (part === undefined ? undefined : decodeURIComponent(part)));
}

function numberParam(url: URL, name: string): number | undefined {
	const value = url.searchParams.get(name);
	if (value === null || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
