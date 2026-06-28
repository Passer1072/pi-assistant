import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { DesktopToolResult } from "../shared/types.ts";
import type { BrowserSnapshotStore } from "./browser-snapshot-store.ts";

const RECENT_TEXT_LIMIT = 8000;
const OLD_TEXT_LIMIT = 1200;
const ARRAY_ITEM_LIMIT = 20;
const OLD_ARRAY_ITEM_LIMIT = 5;
const STRING_VALUE_LIMIT = 1000;
const OLD_STRING_VALUE_LIMIT = 300;
const RECENT_BROWSER_CONTEXT_BUDGET = 24000;
const BROWSER_AUTO_COMPACTION_BUDGET = 200_000;

const BROWSER_TOOL_PREFIXES = ["mcp_browser_", "mcp_browser_control_"] as const;
const BROWSER_HEAVY_ACTIONS = new Set(["read_page", "query_elements", "list_tabs"]);

/**
 * Per-session memo of frozen compacted forms, keyed by a stable tool-call
 * identity. See {@link TokenSavingContextOptions.frozenForms}.
 */
export type TokenSavingFrozenForms = Map<string, AgentMessage>;

export interface TokenSavingContextOptions {
	snapshotStore?: BrowserSnapshotStore;
	onTelemetry?: (telemetry: TokenSavingTelemetry) => void;
	onAutoCompactionNeeded?: (reason: string) => void;
	/**
	 * Per-session memo of already-frozen compacted forms, keyed by a stable
	 * message identity (tool call id). Once a browser tool result leaves the
	 * recent window it is compacted exactly once and stored here; every later
	 * turn replays the identical bytes. This keeps the sent prefix byte-stable
	 * so DeepSeek's server-side prefix cache keeps hitting instead of being
	 * re-billed at full price every turn (the root cause of the long-flow token
	 * blow-up). Omit it to fall back to the old per-turn recompute behaviour.
	 */
	frozenForms?: TokenSavingFrozenForms;
}

export interface TokenSavingTelemetry {
	originalChars: number;
	compactedChars: number;
	snapshotsCreated: number;
	unchangedSnapshots: number;
	browserResultCount: number;
	totalBrowserChars: number;
}

export function compactTokenSavingMessages(
	messages: AgentMessage[],
	options: TokenSavingContextOptions = {},
): AgentMessage[] {
	const browserEntries = collectBrowserToolResultEntries(messages);
	if (browserEntries.length === 0) return messages;
	let remainingRecentBudget = RECENT_BROWSER_CONTEXT_BUDGET;
	const recentIndexes = new Set<number>();
	for (let index = browserEntries.length - 1; index >= 0; index -= 1) {
		const entry = browserEntries[index];
		if (remainingRecentBudget <= 0) break;
		recentIndexes.add(entry.index);
		remainingRecentBudget -= Math.max(1, entry.size);
	}
	const telemetry: TokenSavingTelemetry = {
		originalChars: 0,
		compactedChars: 0,
		snapshotsCreated: 0,
		unchangedSnapshots: 0,
		browserResultCount: browserEntries.length,
		totalBrowserChars: 0,
	};
	const totalBrowserChars = browserEntries.reduce((sum, entry) => sum + entry.size, 0);
	telemetry.totalBrowserChars = totalBrowserChars;
	if (totalBrowserChars > BROWSER_AUTO_COMPACTION_BUDGET) {
		options.onAutoCompactionNeeded?.(`browser MCP tool history is ${totalBrowserChars} characters`);
	}

	const frozenForms = options.frozenForms;

	return messages.map((message, index) => {
		if (message.role !== "toolResult" || !isBrowserToolResult(message)) {
			return message;
		}
		const isRecent = recentIndexes.has(index);
		// Freeze-once: a result that has left the recent window keeps a single
		// byte-stable compacted form for the rest of the session, so the sent
		// prefix never changes again and DeepSeek's prefix cache keeps hitting.
		// The frozen form is replayed whenever one exists — independent of the
		// current recent/old classification. In append-only flows a frozen result
		// is old forever, but the heap-side rewrite (applyFrozenFormsToMessages)
		// shrinks the retained message in place, which could otherwise drop it back
		// under the recent budget and get it recomputed/re-snapshotted. Replaying
		// the existing freeze keeps the bytes sent to the model byte-identical.
		const freezeKey = frozenFormKey(message);
		let resolved: AgentMessage;
		if (freezeKey && frozenForms?.has(freezeKey)) {
			resolved = frozenForms.get(freezeKey) as AgentMessage;
		} else {
			resolved = compactBrowserToolResult(message, isRecent, options.snapshotStore, telemetry) ?? message;
			if (!isRecent && freezeKey && frozenForms) {
				frozenForms.set(freezeKey, resolved);
			}
		}
		const before = JSON.stringify(message).length;
		const after = JSON.stringify(resolved).length;
		telemetry.originalChars += before;
		telemetry.compactedChars += after;
		if (index === browserEntries[browserEntries.length - 1]?.index) {
			options.onTelemetry?.(telemetry);
		}
		return resolved;
	});
}

/**
 * Stable identity for freeze-once memoization. Tool call ids are unique per
 * invocation and never change once emitted, so the compacted bytes stored under
 * this key can be replayed verbatim on every subsequent turn.
 */
function frozenFormKey(message: ToolResultMessage<unknown>): string | undefined {
	return message.toolCallId ? `${message.toolName}:${message.toolCallId}` : undefined;
}

/**
 * Persist already-frozen (out-of-recent-window) browser compactions back into a
 * retained message array, replacing the full original payloads in place and
 * dropping the heavy DOM/HTML/screenshot bytes from RAM.
 *
 * This is the heap-side counterpart to {@link compactTokenSavingMessages}:
 * that function builds the *outbound* compacted copy each turn (what the model
 * receives), while this function rewrites the *retained* `agent.state.messages`
 * so the originals stop accumulating across a long session.
 *
 * Only messages that already have a frozen form are rewritten — i.e. results
 * that have left the recent window and whose compacted bytes are already what
 * the model is being sent. Recent-window results are left untouched, so the
 * bytes sent to the model on the next turn are byte-identical. Returns the
 * number of messages rewritten.
 */
export function applyFrozenFormsToMessages(messages: AgentMessage[], frozenForms: TokenSavingFrozenForms): number {
	if (frozenForms.size === 0) return 0;
	let rewritten = 0;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message.role !== "toolResult" || !isBrowserToolResult(message)) continue;
		const key = frozenFormKey(message);
		if (!key) continue;
		const frozen = frozenForms.get(key);
		if (frozen && frozen !== message) {
			messages[index] = frozen;
			rewritten += 1;
		}
	}
	return rewritten;
}

function collectBrowserToolResultEntries(messages: AgentMessage[]): Array<{ index: number; size: number }> {
	const entries: Array<{ index: number; size: number }> = [];
	messages.forEach((message, index) => {
		if (message.role === "toolResult" && isBrowserToolResult(message)) {
			entries.push({ index, size: JSON.stringify(message).length });
		}
	});
	return entries;
}

function isBrowserToolResult(message: ToolResultMessage<unknown>): boolean {
	// Never re-compact the snapshot-read tool's own output: it is content the
	// model explicitly asked for, and its mcp_browser_-prefixed alias would
	// otherwise be caught by the prefix check below (the canonical name is not),
	// giving inconsistent behaviour depending on which name the model used.
	if (message.toolName.includes("snapshot_read")) return false;
	return BROWSER_TOOL_PREFIXES.some((prefix) => message.toolName.startsWith(prefix));
}

function compactBrowserToolResult(
	message: ToolResultMessage<unknown>,
	keepRecent: boolean,
	snapshotStore: BrowserSnapshotStore | undefined,
	telemetry: TokenSavingTelemetry,
): ToolResultMessage<unknown> | undefined {
	const originalText = textContent(message.content);
	const details = parseDesktopToolResult(message.details) ?? parseDesktopToolResultFromText(originalText);
	if (!details) {
		return compactTextOnlyToolResult(message, originalText, keepRecent);
	}
	const action = details.action;
	if (!BROWSER_HEAVY_ACTIONS.has(action) && originalText.length <= RECENT_TEXT_LIMIT) {
		return undefined;
	}
	if (snapshotStore && BROWSER_HEAVY_ACTIONS.has(action)) {
		const parsedStdout = parseJson(details.stdout);
		const snapshot = snapshotStore.create({
			sourceKey: message.toolCallId,
			toolName: message.toolName,
			action,
			url: extractBrowserString(parsedStdout, "url") ?? extractBrowserString(details.observedState, "url"),
			title: extractBrowserString(parsedStdout, "title") ?? extractBrowserString(details.observedState, "title"),
			stdout: details.stdout,
			stderr: details.stderr,
			observedState: details.observedState,
			raw: parsedStdout ?? details,
		});
		const reference = snapshotStore.toReference(snapshot);
		telemetry.snapshotsCreated += 1;
		if (snapshot.unchanged) telemetry.unchangedSnapshots += 1;
		const compactedDetails: DesktopToolResult = {
			...details,
			stdout: JSON.stringify(reference, null, 2),
			stderr: compactMcpText(details.stderr, false),
			observedState: reference,
		};
		return {
			...message,
			content: [{ type: "text", text: JSON.stringify(compactedDetails) }],
			details: compactedDetails,
		};
	}
	const stdout = compactMcpText(details.stdout, keepRecent);
	const stderr = compactMcpText(details.stderr, keepRecent);
	const compactedDetails: DesktopToolResult = {
		...details,
		stdout,
		stderr,
		observedState: compactUnknown(details.observedState, keepRecent),
	};
	const contentText = JSON.stringify(compactedDetails);
	return {
		...message,
		content: [{ type: "text", text: contentText }],
		details: compactedDetails,
	};
}

function compactTextOnlyToolResult(
	message: ToolResultMessage<unknown>,
	originalText: string,
	keepRecent: boolean,
): ToolResultMessage<unknown> | undefined {
	const limit = keepRecent ? RECENT_TEXT_LIMIT : OLD_TEXT_LIMIT;
	if (originalText.length <= limit) return undefined;
	const compactedText = truncateText(originalText, limit);
	return {
		...message,
		content: [{ type: "text", text: compactedText }],
		details: compactUnknown(message.details, keepRecent),
	};
}

function textContent(content: Array<TextContent | ImageContent>): string {
	return content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function parseDesktopToolResult(value: unknown): DesktopToolResult | undefined {
	if (isDesktopToolResult(value)) return value;
	if (typeof value !== "object" || value === null) return undefined;
	const details = (value as { details?: unknown }).details;
	return isDesktopToolResult(details) ? details : undefined;
}

function parseDesktopToolResultFromText(text: string): DesktopToolResult | undefined {
	try {
		const parsed = JSON.parse(text) as unknown;
		return parseDesktopToolResult(parsed);
	} catch {
		return undefined;
	}
}

function isDesktopToolResult(value: unknown): value is DesktopToolResult {
	if (typeof value !== "object" || value === null) return false;
	const item = value as Partial<DesktopToolResult>;
	return (
		typeof item.stepId === "string" &&
		typeof item.intent === "string" &&
		typeof item.action === "string" &&
		typeof item.target === "string" &&
		typeof item.status === "string" &&
		typeof item.riskLevel === "string" &&
		typeof item.requiresConfirmation === "boolean"
	);
}

function compactMcpText(text: string | undefined, keepRecent: boolean): string | undefined {
	if (!text) return text;
	const parsed = parseJson(text);
	if (parsed === undefined) {
		return truncateText(text, keepRecent ? RECENT_TEXT_LIMIT : OLD_TEXT_LIMIT);
	}
	return JSON.stringify(compactUnknown(parsed, keepRecent), null, 2);
}

function parseJson(text: string | undefined): unknown | undefined {
	if (!text) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function extractBrowserString(value: unknown, key: "url" | "title"): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const nested = extractBrowserString(item, key);
			if (nested) return nested;
		}
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const direct = record[key];
	if (typeof direct === "string" && direct.trim()) return direct;
	for (const entry of Object.values(record)) {
		const nested = extractBrowserString(entry, key);
		if (nested) return nested;
	}
	return undefined;
}

function compactUnknown(value: unknown, keepRecent: boolean): unknown {
	if (typeof value === "string") {
		return truncateText(value, keepRecent ? RECENT_TEXT_LIMIT : OLD_TEXT_LIMIT);
	}
	if (!value || typeof value !== "object") return value;
	if (Array.isArray(value)) return compactArray(value, keepRecent);

	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(input)) {
		output[key] = compactField(key, entry, keepRecent);
	}
	return output;
}

function compactField(key: string, value: unknown, keepRecent: boolean): unknown {
	if (key === "html") {
		return summarizeRemovedField(value, "html");
	}
	if (key === "images" || key === "tables" || key === "links" || key === "forms" || key === "interactive") {
		return compactArray(Array.isArray(value) ? value : [], keepRecent);
	}
	if (key === "text" && typeof value === "string") {
		return compactMaybeJsonText(value, keepRecent);
	}
	if (typeof value === "string") {
		return truncateText(value, keepRecent ? STRING_VALUE_LIMIT : OLD_STRING_VALUE_LIMIT);
	}
	if (Array.isArray(value)) {
		return compactArray(value, keepRecent);
	}
	if (value && typeof value === "object") {
		return compactUnknown(value, keepRecent);
	}
	return value;
}

function compactMaybeJsonText(text: string, keepRecent: boolean): string {
	const parsed = parseJson(text);
	if (parsed !== undefined && typeof parsed === "object" && parsed !== null) {
		return JSON.stringify(compactUnknown(parsed, keepRecent), null, 2);
	}
	return truncateText(text, keepRecent ? RECENT_TEXT_LIMIT : OLD_TEXT_LIMIT);
}

function compactArray(value: unknown[], keepRecent: boolean): unknown[] {
	const limit = keepRecent ? ARRAY_ITEM_LIMIT : OLD_ARRAY_ITEM_LIMIT;
	const compacted = value.slice(0, limit).map((item) => compactUnknown(item, keepRecent));
	if (value.length > limit) {
		compacted.push({ omittedItems: value.length - limit });
	}
	return compacted;
}

function summarizeRemovedField(value: unknown, field: string): Record<string, unknown> {
	return {
		omitted: true,
		field,
		originalLength: typeof value === "string" ? value.length : undefined,
	};
}

function truncateText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n\n[Token saving mode: truncated ${text.length - limit} characters before sending to the model.]`;
}
