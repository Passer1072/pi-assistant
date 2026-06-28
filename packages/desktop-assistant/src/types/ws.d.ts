declare module "ws" {
	import type { IncomingMessage, Server } from "node:http";

	export class WebSocketServer {
		constructor(options: { server: Server; path?: string });
		on(event: "connection", listener: (socket: unknown, request: IncomingMessage) => void): void;
		close(callback?: () => void): void;
	}
}
