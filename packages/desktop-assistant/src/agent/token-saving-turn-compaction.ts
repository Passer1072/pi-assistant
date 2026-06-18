import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { TokenSavingTelemetry } from "./token-saving-context.ts";

const MIN_SESSION_MESSAGES = 6;
const MIN_NEW_BROWSER_CHARS = 450_000;
const FORCE_NEW_BROWSER_CHARS = 900_000;
const MIN_PRESSURE_BROWSER_CHARS = 300_000;
const SCORE_THRESHOLD = 75;
const PRESSURE_SCORE_THRESHOLD = 70;
const MAX_INEFFECTIVE_COMPACTION_LEVEL = 3;
const MIN_EFFECTIVE_PROMPT_TOKEN_REDUCTION = 30_000;
const MIN_EFFECTIVE_PROMPT_TOKEN_REDUCTION_RATIO = 0.25;
const HEALTHY_CACHE_HIT_RATIO = 0.75;
const LOW_CACHE_HIT_RATIO = 0.5;
const BROWSER_TOOL_PREFIXES = ["mcp_browser_", "mcp_browser_control_"] as const;
const BROWSER_HEAVY_ACTIONS = new Set([
	"read_page",
	"query_elements",
	"list_tabs",
	"read_main_content",
	"read_accessibility_tree",
	"read_tab",
	"read_network",
	"read_console",
]);

export interface TokenSavingTurnCompactionInput {
	enabled: boolean;
	messages: AgentMessage[];
	assistantMessage: AssistantMessage;
	toolResults: ToolResultMessage[];
	lastCompactionBrowserChars: number;
	telemetry?: TokenSavingTelemetry;
	contextPercent?: number | null;
	recentIneffectiveCompactions?: number;
}

export interface TokenSavingTurnCompactionDecision {
	shouldCompact: boolean;
	score: number;
	reasons: string[];
	skipReason?: string;
	totalBrowserChars: number;
	newBrowserChars: number;
	currentTurnBrowserChars: number;
	currentTurnBrowserResults: number;
	unchangedSnapshots: number;
	estimatedSavedChars: number;
	estimatedSavedRatio: number;
}

export interface TokenSavingCompactionOutcomeInput {
	baselinePromptTokens?: number;
	baselineCacheHitRatio?: number;
	observedPromptTokens: number;
	observedCacheReadTokens: number;
}

export interface TokenSavingCompactionOutcome {
	effective: boolean;
	reasons: string[];
	baselinePromptTokens?: number;
	observedPromptTokens: number;
	promptTokenReduction?: number;
	promptTokenReductionRatio?: number;
	baselineCacheHitRatio?: number;
	observedCacheHitRatio: number;
}

export class TokenSavingTurnCompactionController {
	evaluate(input: TokenSavingTurnCompactionInput): TokenSavingTurnCompactionDecision {
		const stats = browserToolStats(input.messages, input.toolResults, input.lastCompactionBrowserChars);
		const telemetry = input.telemetry;
		const estimatedSavedChars = telemetry ? Math.max(0, telemetry.originalChars - telemetry.compactedChars) : 0;
		const estimatedSavedRatio =
			telemetry && telemetry.originalChars > 0 ? estimatedSavedChars / telemetry.originalChars : 0;
		const unchangedSnapshots = telemetry?.unchangedSnapshots ?? 0;
		const base = {
			score: 0,
			reasons: [] as string[],
			totalBrowserChars: stats.totalBrowserChars,
			newBrowserChars: stats.newBrowserChars,
			currentTurnBrowserChars: stats.currentTurnBrowserChars,
			currentTurnBrowserResults: stats.currentTurnBrowserResults,
			unchangedSnapshots,
			estimatedSavedChars,
			estimatedSavedRatio,
		};

		if (!input.enabled) return { ...base, shouldCompact: false, skipReason: "token saving disabled" };
		if (input.messages.length < MIN_SESSION_MESSAGES) {
			return { ...base, shouldCompact: false, skipReason: "session too small" };
		}
		if (input.assistantMessage.stopReason === "error" || input.assistantMessage.stopReason === "aborted") {
			return { ...base, shouldCompact: false, skipReason: `assistant ${input.assistantMessage.stopReason}` };
		}
		if (stats.currentTurnBrowserResults === 0) {
			return { ...base, shouldCompact: false, skipReason: "no browser MCP result in current turn" };
		}
		if (stats.newBrowserChars <= 0) {
			return { ...base, shouldCompact: false, skipReason: "no new browser MCP history since last compaction" };
		}
		const ineffectiveLevel = normalizeIneffectiveLevel(input.recentIneffectiveCompactions);
		if (ineffectiveLevel > 0) {
			const requiredNewBrowserChars = FORCE_NEW_BROWSER_CHARS * (ineffectiveLevel + 1);
			const pressureOverride =
				(input.contextPercent ?? 0) >= 90 &&
				stats.newBrowserChars >= MIN_PRESSURE_BROWSER_CHARS * (ineffectiveLevel + 1);
			const sizeOverride = stats.newBrowserChars >= requiredNewBrowserChars;
			if (!pressureOverride && !sizeOverride) {
				return {
					...base,
					shouldCompact: false,
					skipReason: `recent token-saving compaction was ineffective; waiting for ${requiredNewBrowserChars} new browser MCP chars or very high context pressure`,
				};
			}
		}

		const reasons: string[] = [];
		let score = 0;
		const mostlyUnchangedSnapshots =
			telemetry && telemetry.snapshotsCreated > 0
				? unchangedSnapshots >= 2 && unchangedSnapshots / telemetry.snapshotsCreated >= 0.5
				: unchangedSnapshots >= 2;
		if (stats.newBrowserChars >= FORCE_NEW_BROWSER_CHARS) {
			score += 50;
			reasons.push(`new browser MCP history ${stats.newBrowserChars} chars`);
		} else if (stats.newBrowserChars >= MIN_NEW_BROWSER_CHARS) {
			score += 30;
			reasons.push(`new browser MCP history ${stats.newBrowserChars} chars`);
		}
		if (stats.currentTurnHeavyResults >= 2) {
			score += 20;
			reasons.push(`${stats.currentTurnHeavyResults} heavy browser results in this turn`);
		} else if (stats.currentTurnHeavyResults === 1) {
			score += 10;
			reasons.push("heavy browser result in this turn");
		}
		if (unchangedSnapshots >= 2) {
			score -= 25;
			reasons.push(`${unchangedSnapshots} unchanged browser snapshots`);
		} else if (unchangedSnapshots === 1) {
			score -= 10;
			reasons.push("unchanged browser snapshot");
		}
		if (estimatedSavedRatio >= 0.6) {
			score += 25;
			reasons.push(`estimated send-context saving ${(estimatedSavedRatio * 100).toFixed(0)}%`);
		} else if (estimatedSavedRatio >= 0.35) {
			score += 15;
			reasons.push(`estimated send-context saving ${(estimatedSavedRatio * 100).toFixed(0)}%`);
		}
		if ((input.contextPercent ?? 0) >= 70) {
			score += 20;
			reasons.push(`context pressure ${input.contextPercent?.toFixed(1)}%`);
		} else if ((input.contextPercent ?? 0) >= 55) {
			score += 10;
			reasons.push(`context pressure ${input.contextPercent?.toFixed(1)}%`);
		}
		if (stats.totalBrowserChars >= 160_000) {
			score += 15;
			reasons.push(`total browser MCP history ${stats.totalBrowserChars} chars`);
		}

		const hardPressureTrigger =
			(input.contextPercent ?? 0) >= 92 && stats.newBrowserChars >= MIN_PRESSURE_BROWSER_CHARS;
		const sizeTrigger = !mostlyUnchangedSnapshots && stats.newBrowserChars >= FORCE_NEW_BROWSER_CHARS;
		const scoredTrigger =
			!mostlyUnchangedSnapshots && stats.newBrowserChars >= MIN_NEW_BROWSER_CHARS && score >= SCORE_THRESHOLD;
		const pressureTrigger =
			(input.contextPercent ?? 0) >= 65 &&
			stats.newBrowserChars >= MIN_PRESSURE_BROWSER_CHARS &&
			!mostlyUnchangedSnapshots &&
			score >= PRESSURE_SCORE_THRESHOLD;

		if (!hardPressureTrigger && !sizeTrigger && !scoredTrigger && !pressureTrigger) {
			return {
				...base,
				shouldCompact: false,
				score,
				reasons,
				skipReason: `score ${score} below threshold`,
			};
		}

		return {
			...base,
			shouldCompact: true,
			score,
			reasons,
		};
	}

	buildContinuationMessage(decision: TokenSavingTurnCompactionDecision, now = Date.now()): AgentMessage {
		return {
			role: "user",
			content: [
				{
					type: "text",
					text: [
						"<token_saving_context_compacted>",
						"The desktop assistant compacted older browser/MCP context after the previous assistant turn.",
						"Continue the current task. Do not treat this as a new user request.",
						"Preserve the user goal, current step, current page state, relevant snapshotId values, errors, and pending next actions.",
						"Use summary/changeSummary by default. Call browser_snapshot_read only when exact page text, HTML, links, forms, tables, or interactive elements are required.",
						"Do not repeat read_page for the same page when a usable snapshotId is available.",
						`Trigger score: ${decision.score}. Reasons: ${decision.reasons.join("; ") || "browser MCP noise"}.`,
						"</token_saving_context_compacted>",
					].join("\n"),
				},
			],
			timestamp: now,
		};
	}
}

export function evaluateTokenSavingCompactionOutcome(
	input: TokenSavingCompactionOutcomeInput,
): TokenSavingCompactionOutcome {
	const observedCacheHitRatio =
		input.observedPromptTokens > 0 ? input.observedCacheReadTokens / input.observedPromptTokens : 0;
	const reasons: string[] = [];
	const base = {
		baselinePromptTokens: input.baselinePromptTokens,
		observedPromptTokens: input.observedPromptTokens,
		baselineCacheHitRatio: input.baselineCacheHitRatio,
		observedCacheHitRatio,
	};

	if (!input.baselinePromptTokens || input.baselinePromptTokens <= 0) {
		const effective = observedCacheHitRatio >= HEALTHY_CACHE_HIT_RATIO;
		reasons.push(
			effective
				? "cache hit ratio stayed healthy without a baseline"
				: "no baseline prompt usage available and cache hit ratio is low",
		);
		return { ...base, effective, reasons };
	}

	const promptTokenReduction = input.baselinePromptTokens - input.observedPromptTokens;
	const promptTokenReductionRatio = promptTokenReduction / input.baselinePromptTokens;
	const promptReducedEnough =
		promptTokenReduction >= MIN_EFFECTIVE_PROMPT_TOKEN_REDUCTION ||
		promptTokenReductionRatio >= MIN_EFFECTIVE_PROMPT_TOKEN_REDUCTION_RATIO;
	const cacheWasHealthy = (input.baselineCacheHitRatio ?? 0) >= HEALTHY_CACHE_HIT_RATIO;
	const cacheBecameLow = observedCacheHitRatio < LOW_CACHE_HIT_RATIO;

	if (promptReducedEnough) {
		reasons.push(
			`prompt tokens dropped by ${promptTokenReduction} (${(promptTokenReductionRatio * 100).toFixed(1)}%)`,
		);
		return {
			...base,
			effective: true,
			reasons,
			promptTokenReduction,
			promptTokenReductionRatio,
		};
	}

	reasons.push(
		`prompt token reduction ${promptTokenReduction} (${(promptTokenReductionRatio * 100).toFixed(1)}%) below threshold`,
	);
	if (cacheWasHealthy && cacheBecameLow) {
		reasons.push(
			`cache hit ratio dropped from ${((input.baselineCacheHitRatio ?? 0) * 100).toFixed(1)}% to ${(observedCacheHitRatio * 100).toFixed(1)}%`,
		);
	}
	return {
		...base,
		effective: false,
		reasons,
		promptTokenReduction,
		promptTokenReductionRatio,
	};
}

function normalizeIneffectiveLevel(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.min(MAX_INEFFECTIVE_COMPACTION_LEVEL, Math.max(0, Math.floor(value)));
}

function browserToolStats(
	messages: AgentMessage[],
	toolResults: ToolResultMessage[],
	lastCompactionBrowserChars: number,
): {
	totalBrowserChars: number;
	newBrowserChars: number;
	currentTurnBrowserChars: number;
	currentTurnBrowserResults: number;
	currentTurnHeavyResults: number;
} {
	const totalBrowserChars = estimateBrowserToolHistoryChars(messages);
	let currentTurnBrowserChars = 0;
	let currentTurnBrowserResults = 0;
	let currentTurnHeavyResults = 0;
	for (const result of toolResults) {
		if (!isBrowserToolResultMessage(result)) continue;
		currentTurnBrowserResults += 1;
		currentTurnBrowserChars += JSON.stringify(result).length;
		if (isHeavyBrowserToolResult(result)) currentTurnHeavyResults += 1;
	}
	return {
		totalBrowserChars,
		newBrowserChars: Math.max(0, totalBrowserChars - lastCompactionBrowserChars),
		currentTurnBrowserChars,
		currentTurnBrowserResults,
		currentTurnHeavyResults,
	};
}

export function estimateBrowserToolHistoryChars(messages: unknown[]): number {
	let total = 0;
	for (const message of messages) {
		if (isBrowserToolResultMessage(message)) {
			total += JSON.stringify(message).length;
		}
	}
	return total;
}

function isBrowserToolResultMessage(message: unknown): message is ToolResultMessage {
	if (typeof message !== "object" || message === null) return false;
	const item = message as { role?: unknown; toolName?: unknown };
	if (item.role !== "toolResult" || typeof item.toolName !== "string") return false;
	const toolName = item.toolName;
	// Exclude the snapshot-read tool (and its mcp_browser_ alias) so its own
	// output is not counted as browser history when scoring compaction.
	if (toolName.includes("snapshot_read")) return false;
	return BROWSER_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function isHeavyBrowserToolResult(message: ToolResultMessage): boolean {
	const action = extractBrowserAction(message.details) ?? extractBrowserActionFromText(message.content);
	return typeof action === "string" && BROWSER_HEAVY_ACTIONS.has(action);
}

function extractBrowserAction(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const item = value as { action?: unknown; details?: unknown };
	if (typeof item.action === "string") return item.action;
	return extractBrowserAction(item.details);
}

function extractBrowserActionFromText(content: ToolResultMessage["content"]): string | undefined {
	for (const item of content) {
		if (item.type !== "text") continue;
		try {
			return extractBrowserAction(JSON.parse(item.text) as unknown);
		} catch {}
	}
	return undefined;
}
