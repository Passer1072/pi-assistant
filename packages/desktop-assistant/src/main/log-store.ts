import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { LogEntry } from "../shared/types.ts";

const MAX_BUFFER = 1500;

export class LogStore {
	private buffer: LogEntry[] = [];
	private stream: WriteStream;
	readonly logFilePath: string;
	private listeners = new Set<(entry: LogEntry) => void>();

	constructor(logDir: string) {
		mkdirSync(logDir, { recursive: true });
		const ts = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
		this.logFilePath = join(logDir, `session-${ts}.ndjson`);
		this.stream = createWriteStream(this.logFilePath, { flags: "a", encoding: "utf-8" });
	}

	push(entry: LogEntry): void {
		this.buffer.push(entry);
		if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
		this.stream.write(`${JSON.stringify(entry)}\n`);
		for (const fn of this.listeners) fn(entry);
	}

	getAll(): LogEntry[] {
		return [...this.buffer];
	}

	subscribe(fn: (entry: LogEntry) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	close(): void {
		this.stream.end();
	}
}
