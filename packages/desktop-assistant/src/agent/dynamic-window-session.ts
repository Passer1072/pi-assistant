import type {
	AutomationStatus,
	DynamicWindowCommand,
	DynamicWindowFacet,
	DynamicWindowFileNode,
	DynamicWindowOperation,
	DynamicWindowSnapshot,
	DynamicWindowWebPage,
	FileArtifact,
} from "../shared/types.ts";
import { collectArtifacts, collectTouchedFiles } from "./artifact-extractor.ts";

/** Per-tool-call context the session needs to attribute items to an operation. */
export interface DynamicWindowRecordContext {
	toolCallId: string;
	/** Base dir for resolving relative paths (sandbox root, else cwd). */
	baseDir: string;
	/** Epoch-ms turn start (for the produced-file freshness check). */
	turnStartedAt?: number;
	/** Human label for this operation (tool intent or name). */
	label?: string;
}

const ITEM_LIMIT = 200;
const OP_LIMIT = 60;

/**
 * In-memory per-session working state for the 灵动窗 (dynamic window). It watches the
 * model's tool calls and accumulates, over the whole conversation, what it's doing
 * across three facets — files touched/produced, web pages browsed, commands run —
 * each grouped by "operation" (one tool call) so the UI can scroll back. The flow
 * facet is NOT here; it reads `liveFlow` directly. State is ephemeral (never persisted);
 * history rebuilds it by replaying the archived tool records, like the artifact cards.
 *
 * Adding a new facet = add a branch in `recordTool` + a field in `getState()` (plus the
 * type + a renderer component); the existing facets are untouched.
 */
export class DynamicWindowSession {
	private activeFacet: DynamicWindowFacet = "files";
	private started = false;
	private readonly fileItems: DynamicWindowFileNode[] = [];
	private readonly produced: FileArtifact[] = [];
	private readonly webItems: DynamicWindowWebPage[] = [];
	private readonly commandItems: DynamicWindowCommand[] = [];
	private readonly fileOps: DynamicWindowOperation[] = [];
	private readonly webOps: DynamicWindowOperation[] = [];
	private readonly commandOps: DynamicWindowOperation[] = [];
	private readonly listeners = new Set<() => void>();

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}

	/** Feed one finished tool call. No-op (and no event) when nothing relevant is found. */
	recordTool(toolName: string, args: unknown, result: unknown, ctx: DynamicWindowRecordContext): void {
		let changed = false;
		const op: DynamicWindowOperation = {
			id: ctx.toolCallId,
			label: (ctx.label || toolName).slice(0, 80),
			timestamp: Date.now(),
		};

		// ── files: every touched path (read/written/operated), produced ones flagged ──
		let touched: FileArtifact[] = [];
		let producedNow: FileArtifact[] = [];
		try {
			touched = collectTouchedFiles(toolName, args, result, { baseDir: ctx.baseDir });
			producedNow = collectArtifacts(toolName, args, result, { baseDir: ctx.baseDir, since: ctx.turnStartedAt });
		} catch {
			touched = [];
			producedNow = [];
		}
		if (touched.length > 0 || producedNow.length > 0) {
			const producedPaths = new Set(producedNow.map((artifact) => artifact.path.toLowerCase()));
			let fileChanged = false;
			for (const artifact of touched) {
				if (artifact.isDirectory) continue;
				const key = artifact.path.toLowerCase();
				const existing = this.fileItems.find((node) => node.path.toLowerCase() === key);
				if (existing) {
					if (producedPaths.has(key)) existing.produced = true;
					continue;
				}
				this.fileItems.push({
					name: artifact.name,
					path: artifact.path,
					isDirectory: false,
					artifact,
					produced: producedPaths.has(key),
					operationId: ctx.toolCallId,
				});
				fileChanged = true;
			}
			for (const artifact of producedNow) {
				const key = artifact.path.toLowerCase();
				if (!this.produced.some((entry) => entry.path.toLowerCase() === key)) {
					this.produced.push(artifact);
					fileChanged = true;
				}
				const node = this.fileItems.find((entry) => entry.path.toLowerCase() === key);
				if (node) node.produced = true;
			}
			if (fileChanged) {
				this.pushOp(this.fileOps, op);
				this.activeFacet = "files";
				changed = true;
			}
		}

		// ── web: pages the model browsed/searched ──
		if (/^browser_/i.test(toolName) || /web[_-]?search|search[_-]?web|navigate/i.test(toolName)) {
			let webChanged = false;
			for (const page of extractWebPages(args, result)) {
				if (this.webItems.some((entry) => entry.url === page.url)) continue;
				this.webItems.push({
					url: page.url,
					title: page.title || page.url,
					visitedAt: Date.now(),
					operationId: ctx.toolCallId,
				});
				webChanged = true;
			}
			if (webChanged) {
				this.pushOp(this.webOps, op);
				this.activeFacet = "web";
				changed = true;
			}
		}

		// ── commands: desktop/shell tool calls that returned terminal output ──
		const parsed = liteParseToolResult(result);
		if (parsed && (typeof parsed.stdout === "string" || typeof parsed.stderr === "string")) {
			const command = (
				getStringField(args, "command") ||
				getStringField(args, "script") ||
				parsed.intent ||
				`${parsed.action ?? ""} ${parsed.target ?? ""}`
			)
				.trim()
				.slice(0, 400);
			this.commandItems.push({
				id: ctx.toolCallId,
				command: command || toolName,
				status: (parsed.status as AutomationStatus) ?? "succeeded",
				stdout: parsed.stdout?.slice(0, 4000),
				stderr: parsed.stderr?.slice(0, 4000),
				timestamp: Date.now(),
				operationId: ctx.toolCallId,
			});
			this.pushOp(this.commandOps, op);
			this.activeFacet = "commands";
			changed = true;
		}

		if (changed) {
			this.started = true;
			this.trim();
			this.emit();
		}
	}

	private pushOp(list: DynamicWindowOperation[], op: DynamicWindowOperation): void {
		if (list.some((entry) => entry.id === op.id)) return;
		list.push(op);
		if (list.length > OP_LIMIT) list.splice(0, list.length - OP_LIMIT);
	}

	private trim(): void {
		const cap = (list: unknown[]) => {
			if (list.length > ITEM_LIMIT) list.splice(0, list.length - ITEM_LIMIT);
		};
		cap(this.fileItems);
		cap(this.produced);
		cap(this.webItems);
		cap(this.commandItems);
	}

	/** Snapshot for the floating window; undefined until the first relevant tool call. */
	getState(): DynamicWindowSnapshot | undefined {
		if (!this.started) return undefined;
		return {
			activeFacet: this.activeFacet,
			files: { operations: [...this.fileOps], items: [...this.fileItems], produced: [...this.produced] },
			web: { operations: [...this.webOps], items: [...this.webItems] },
			commands: { operations: [...this.commandOps], items: [...this.commandItems] },
			updatedAt: Date.now(),
		};
	}
}

interface LiteToolResult {
	intent?: string;
	action?: string;
	target?: string;
	status?: string;
	stdout?: string;
	stderr?: string;
}

/**
 * Minimal stand-in for `parseDesktopToolResult` that avoids importing from
 * conversation-context.ts (which imports this module). Handles the direct shape and
 * the common `.details` wrapper — enough for desktop/shell command tools.
 */
function liteParseToolResult(result: unknown): LiteToolResult | undefined {
	const pick = (value: unknown): LiteToolResult | undefined => {
		if (!value || typeof value !== "object") return undefined;
		const object = value as Record<string, unknown>;
		if (
			typeof object.status === "string" &&
			(typeof object.stdout === "string" || typeof object.stderr === "string" || typeof object.intent === "string")
		) {
			return object as LiteToolResult;
		}
		return undefined;
	};
	return pick(result) ?? pick((result as { details?: unknown })?.details);
}

/** Collect distinct http(s) pages ({url, title}) anywhere in a tool's args/result. */
function extractWebPages(args: unknown, result: unknown): Array<{ url: string; title: string }> {
	const pages: Array<{ url: string; title: string }> = [];
	const seen = new Set<string>();
	const visit = (value: unknown, depth: number): void => {
		if (depth > 6 || value == null) return;
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry, depth + 1);
			return;
		}
		if (typeof value !== "object") return;
		const object = value as Record<string, unknown>;
		const rawUrl = typeof object.url === "string" ? object.url : typeof object.href === "string" ? object.href : "";
		if (/^https?:\/\//i.test(rawUrl) && !seen.has(rawUrl)) {
			seen.add(rawUrl);
			const title =
				typeof object.title === "string" ? object.title : typeof object.name === "string" ? object.name : rawUrl;
			pages.push({ url: rawUrl, title });
		}
		for (const child of Object.values(object)) visit(child, depth + 1);
	};
	visit(args, 0);
	visit(result, 0);
	return pages;
}

function getStringField(object: unknown, key: string): string | undefined {
	if (!object || typeof object !== "object") return undefined;
	const value = (object as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}
