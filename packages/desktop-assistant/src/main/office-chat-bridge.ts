import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import type { DesktopAgentService } from "../agent/desktop-agent-service.ts";
import type { ChatMessageView, DesktopAssistantEvent, DesktopAssistantSnapshot } from "../shared/types.ts";

export interface OfficeChatBridgeOptions {
	port: number;
	getTokens: () => string[];
	service: DesktopAgentService;
}

export interface OfficeChatMessage {
	id: string;
	role: ChatMessageView["role"];
	text: string;
	timestamp: number;
	order: number;
}

export interface OfficeChatSnapshot {
	sessionId: string;
	focusedSessionId: string;
	isRunning: boolean;
	messages: OfficeChatMessage[];
	streamingText: string;
	pendingConfirmationCount: number;
}

export class OfficeChatBridge {
	private readonly server: Server;
	private readonly wss: WebSocketServer;
	private readonly sockets = new Set<BridgeSocket>();
	private readonly unsubscribe: () => void;
	private readonly options: OfficeChatBridgeOptions;

	constructor(options: OfficeChatBridgeOptions) {
		this.options = options;
		this.server = createServer((req, res) => {
			void this.handleHttp(req, res);
		});
		this.wss = new WebSocketServer({ server: this.server, path: "/events" });
		this.wss.on("connection", (rawSocket: unknown, req: IncomingMessage) => {
			const socket = rawSocket as BridgeSocket;
			const url = new URL(req.url || "/", "ws://localhost");
			if (!this.tokenOk(url.searchParams.get("token") || "")) {
				socket.close(1008, "bad token");
				return;
			}
			this.sockets.add(socket);
			this.sendSocket(socket, {
				type: "snapshot",
				snapshot: simplifyOfficeChatSnapshot(this.options.service.snapshot()),
			});
			socket.on("close", () => this.sockets.delete(socket));
		});
		this.unsubscribe = this.options.service.subscribe((event) => this.handleServiceEvent(event));
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

	close(): Promise<void> {
		this.unsubscribe();
		for (const socket of this.sockets) socket.close(1001, "bridge closing");
		this.wss.close();
		return new Promise((resolvePromise) => this.server.close(() => resolvePromise()));
	}

	private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url || "/", "http://localhost");
		if (req.method === "OPTIONS") {
			this.send(res, 204, "");
			return;
		}
		if (url.pathname === "/health" && req.method === "GET") {
			this.sendJson(res, 200, { ok: true, connectedToAssistant: true });
			return;
		}
		if (!this.tokenOk(url.searchParams.get("token") || "")) {
			this.sendJson(res, 401, { ok: false, message: "bad token" });
			return;
		}
		if (url.pathname === "/snapshot" && req.method === "GET") {
			this.sendJson(res, 200, simplifyOfficeChatSnapshot(this.options.service.snapshot()));
			return;
		}
		if (url.pathname === "/prompt" && req.method === "POST") {
			const body = await readJsonBody(req);
			const message = typeof body.message === "string" ? body.message.trim() : "";
			if (!message) {
				this.sendJson(res, 400, { ok: false, message: "message is required" });
				return;
			}
			await this.options.service.prompt(`来自 Word 侧边栏：${message}`, "text", [], undefined, "prompt");
			this.sendJson(res, 200, simplifyOfficeChatSnapshot(this.options.service.snapshot()));
			return;
		}
		if (url.pathname === "/new-conversation" && req.method === "POST") {
			await this.options.service.newConversation();
			this.sendJson(res, 200, simplifyOfficeChatSnapshot(this.options.service.snapshot()));
			return;
		}
		if (url.pathname === "/abort" && req.method === "POST") {
			this.options.service.abort();
			this.sendJson(res, 200, simplifyOfficeChatSnapshot(this.options.service.snapshot()));
			return;
		}
		this.sendJson(res, 404, { ok: false, message: "not found" });
	}

	private handleServiceEvent(event: DesktopAssistantEvent): void {
		if (!this.sockets.size) return;
		if (
			event.type !== "snapshot" &&
			event.type !== "streaming_text" &&
			event.type !== "timeline" &&
			event.type !== "session_status" &&
			event.type !== "error"
		) {
			return;
		}
		const snapshot = simplifyOfficeChatSnapshot(event.snapshot ?? this.options.service.snapshot());
		const payload = { type: "snapshot", snapshot };
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
			"access-control-allow-headers": "content-type",
			"access-control-allow-methods": "GET,POST,OPTIONS",
			"access-control-allow-origin": "https://localhost:49230",
			"content-type": type,
		});
		res.end(body);
	}

	private tokenOk(token: string): boolean {
		const a = Buffer.from(token);
		for (const candidate of this.options.getTokens()) {
			const b = Buffer.from(candidate);
			if (a.length === b.length && timingSafeEqual(a, b)) return true;
		}
		return false;
	}
}

interface BridgeSocket {
	readonly OPEN: number;
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	on(event: "close", listener: () => void): void;
}

export function simplifyOfficeChatSnapshot(snapshot: DesktopAssistantSnapshot): OfficeChatSnapshot {
	return {
		sessionId: snapshot.sessionId,
		focusedSessionId: snapshot.focusedSessionId,
		isRunning: snapshot.isRunning,
		messages: snapshot.messages.slice(-20).map((message) => ({
			id: message.id,
			role: message.role,
			text: message.text,
			timestamp: message.timestamp,
			order: message.order,
		})),
		streamingText: snapshot.streamingText,
		pendingConfirmationCount: snapshot.pendingConfirmations.length,
	};
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	if (!chunks.length) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
}
