import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { LogEntry, LogEntryCat } from "../shared/types.ts";

const MAX_BUFFER = 1500;
const MIRRORED_CATEGORIES = new Set<LogEntryCat>([
	"tool_call",
	"tool_result",
	"diagnostic",
	"system",
	"error",
	"abort",
	"retry",
]);
const DIAGNOSTIC_ALREADY_PRINTED = /^\[(?:debug|info|warning|error)\] \[/;

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
		mirrorEntryToConsole(entry);
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

function mirrorEntryToConsole(entry: LogEntry): void {
	if (!MIRRORED_CATEGORIES.has(entry.cat)) return;
	if (DIAGNOSTIC_ALREADY_PRINTED.test(entry.title)) return;
	const line = `[${new Date(entry.ts).toISOString()}] [${entry.cat.toUpperCase()}] ${entry.title}`;
	const text = entry.detail ? `${line}\n${entry.detail}` : line;
	if (entry.cat === "error" || entry.cat === "abort" || entry.cat === "retry") {
		console.error(text);
	} else {
		console.info(text);
	}
}
