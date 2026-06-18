import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	evaluateTokenSavingCompactionOutcome,
	TokenSavingTurnCompactionController,
} from "../src/agent/token-saving-turn-compaction.ts";
import type { DesktopToolResult } from "../src/shared/types.ts";

describe("TokenSavingTurnCompactionController", () => {
	it("does not compact when token saving is disabled", () => {
		const controller = new TokenSavingTurnCompactionController();
		const messages = sessionMessages(90_000);
		const decision = controller.evaluate({
			enabled: false,
			messages,
			assistantMessage: assistantMessage(),
			toolResults: [browserToolResult(90_000)],
			lastCompactionBrowserChars: 0,
		});

		expect(decision.shouldCompact).toBe(false);
		expect(decision.skipReason).toBe("token saving disabled");
	});

	it("does not compact moderate browser MCP history during normal browsing", () => {
		const controller = new TokenSavingTurnCompactionController();
		const messages = sessionMessages(90_000);
		const decision = controller.evaluate({
			enabled: true,
			messages,
			assistantMessage: assistantMessage(),
			toolResults: [browserToolResult(90_000)],
			lastCompactionBrowserChars: 0,
			telemetry: {
				originalChars: 90_000,
				compactedChars: 15_000,
				snapshotsCreated: 1,
				unchangedSnapshots: 0,
				browserResultCount: 1,
				totalBrowserChars: 90_000,
			},
		});

		expect(decision.shouldCompact).toBe(false);
		expect(decision.skipReason).toContain("below threshold");
	});

	it("compacts after a turn adds very large browser MCP history", () => {
		const controller = new TokenSavingTurnCompactionController();
		const messages = sessionMessages(520_000);
		const decision = controller.evaluate({
			enabled: true,
			messages,
			assistantMessage: assistantMessage(),
			toolResults: [browserToolResult(520_000)],
			lastCompactionBrowserChars: 0,
			telemetry: {
				originalChars: 520_000,
				compactedChars: 30_000,
				snapshotsCreated: 1,
				unchangedSnapshots: 0,
				browserResultCount: 1,
				totalBrowserChars: 520_000,
			},
		});

		expect(decision.shouldCompact).toBe(true);
		expect(decision.reasons.join(" ")).toContain("new browser MCP history");
	});

	it("keeps compaction decisions driven by context signals instead of time cooldown", () => {
		const controller = new TokenSavingTurnCompactionController();
		const messages = sessionMessages(520_000);
		const input = {
			enabled: true,
			messages,
			assistantMessage: assistantMessage(),
			toolResults: [browserToolResult(520_000)],
			lastCompactionBrowserChars: 0,
			telemetry: {
				originalChars: 520_000,
				compactedChars: 30_000,
				snapshotsCreated: 1,
				unchangedSnapshots: 0,
				browserResultCount: 1,
				totalBrowserChars: 520_000,
			},
		};

		const first = controller.evaluate(input);
		const second = controller.evaluate(input);

		expect(first.shouldCompact).toBe(true);
		expect(second.shouldCompact).toBe(true);
	});

	it("does not compact repeated unchanged snapshots below the conservative size threshold", () => {
		const controller = new TokenSavingTurnCompactionController();
		const messages = sessionMessages(30_000);
		const decision = controller.evaluate({
			enabled: true,
			messages,
			assistantMessage: assistantMessage(),
			toolResults: [browserToolResult(30_000)],
			lastCompactionBrowserChars: 0,
			telemetry: {
				originalChars: 30_000,
				compactedChars: 8_000,
				snapshotsCreated: 3,
				unchangedSnapshots: 2,
				browserResultCount: 3,
				totalBrowserChars: 30_000,
			},
		});

		expect(decision.shouldCompact).toBe(false);
		expect(decision.skipReason).toContain("below threshold");
	});

	it("does not compact repeated unchanged snapshots just because full-page reads accumulated", () => {
		const controller = new TokenSavingTurnCompactionController();
		const messages = sessionMessages(650_000);
		const decision = controller.evaluate({
			enabled: true,
			messages,
			assistantMessage: assistantMessage(),
			toolResults: [browserToolResult(650_000)],
			lastCompactionBrowserChars: 0,
			telemetry: {
				originalChars: 650_000,
				compactedChars: 48_000,
				snapshotsCreated: 4,
				unchangedSnapshots: 3,
				browserResultCount: 4,
				totalBrowserChars: 650_000,
			},
		});

		expect(decision.shouldCompact).toBe(false);
		expect(decision.reasons.join(" ")).toContain("unchanged browser snapshots");
		expect(decision.skipReason).toContain("below threshold");
	});

	it("compacts under high context pressure with enough new browser history", () => {
		const controller = new TokenSavingTurnCompactionController();
		const messages = sessionMessages(320_000);
		const decision = controller.evaluate({
			enabled: true,
			messages,
			assistantMessage: assistantMessage(),
			toolResults: [browserToolResult(320_000)],
			lastCompactionBrowserChars: 0,
			telemetry: {
				originalChars: 320_000,
				compactedChars: 30_000,
				snapshotsCreated: 1,
				unchangedSnapshots: 0,
				browserResultCount: 1,
				totalBrowserChars: 320_000,
			},
			contextPercent: 93,
		});

		expect(decision.shouldCompact).toBe(true);
		expect(decision.reasons.join(" ")).toContain("context pressure");
	});

	it("does not compact old browser history without new browser MCP results", () => {
		const controller = new TokenSavingTurnCompactionController();
		const messages = sessionMessages(90_000);
		const decision = controller.evaluate({
			enabled: true,
			messages,
			assistantMessage: assistantMessage(),
			toolResults: [],
			lastCompactionBrowserChars: 90_000,
		});

		expect(decision.shouldCompact).toBe(false);
		expect(decision.skipReason).toBe("no browser MCP result in current turn");
	});

	it("suppresses another token-saving compaction after a recent ineffective one", () => {
		const controller = new TokenSavingTurnCompactionController();
		const messages = sessionMessages(320_000);
		const decision = controller.evaluate({
			enabled: true,
			messages,
			assistantMessage: assistantMessage(),
			toolResults: [browserToolResult(320_000)],
			lastCompactionBrowserChars: 0,
			telemetry: {
				originalChars: 320_000,
				compactedChars: 30_000,
				snapshotsCreated: 1,
				unchangedSnapshots: 0,
				browserResultCount: 1,
				totalBrowserChars: 320_000,
			},
			recentIneffectiveCompactions: 1,
		});

		expect(decision.shouldCompact).toBe(false);
		expect(decision.skipReason).toContain("recent token-saving compaction was ineffective");
	});

	it("allows compaction after ineffective outcomes when context pressure becomes very high", () => {
		const controller = new TokenSavingTurnCompactionController();
		const messages = sessionMessages(400_000);
		const decision = controller.evaluate({
			enabled: true,
			messages,
			assistantMessage: assistantMessage(),
			toolResults: [browserToolResult(400_000)],
			lastCompactionBrowserChars: 0,
			telemetry: {
				originalChars: 400_000,
				compactedChars: 30_000,
				snapshotsCreated: 1,
				unchangedSnapshots: 0,
				browserResultCount: 1,
				totalBrowserChars: 400_000,
			},
			contextPercent: 91,
			recentIneffectiveCompactions: 1,
		});

		expect(decision.shouldCompact).toBe(true);
		expect(decision.reasons.join(" ")).toContain("context pressure");
	});

	it("marks compaction ineffective when prompt size barely drops and cache hit ratio collapses", () => {
		const outcome = evaluateTokenSavingCompactionOutcome({
			baselinePromptTokens: 93_000,
			baselineCacheHitRatio: 91_000 / 93_000,
			observedPromptTokens: 95_000,
			observedCacheReadTokens: 31_000,
		});

		expect(outcome.effective).toBe(false);
		expect(outcome.reasons.join(" ")).toContain("cache hit ratio dropped");
	});

	it("marks compaction effective when prompt size drops substantially", () => {
		const outcome = evaluateTokenSavingCompactionOutcome({
			baselinePromptTokens: 156_000,
			baselineCacheHitRatio: 155_000 / 156_000,
			observedPromptTokens: 53_000,
			observedCacheReadTokens: 31_000,
		});

		expect(outcome.effective).toBe(true);
		expect(outcome.promptTokenReduction).toBe(103_000);
	});

	it("builds an internal continuation message instead of a visible custom bubble", () => {
		const controller = new TokenSavingTurnCompactionController();
		const message = controller.buildContinuationMessage({
			shouldCompact: true,
			score: 80,
			reasons: ["browser MCP noise"],
			totalBrowserChars: 90_000,
			newBrowserChars: 90_000,
			currentTurnBrowserChars: 90_000,
			currentTurnBrowserResults: 1,
			unchangedSnapshots: 0,
			estimatedSavedChars: 70_000,
			estimatedSavedRatio: 0.7,
		});

		expect(message.role).toBe("user");
		expect(JSON.stringify(message)).toContain("Do not treat this as a new user request");
	});
});

function sessionMessages(browserChars: number): AgentMessage[] {
	return [
		userMessage("task"),
		assistantMessage("working"),
		browserToolResult(browserChars),
		userMessage("continue"),
		assistantMessage("more"),
		assistantMessage("latest"),
	];
}

function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 1,
	};
}

function assistantMessage(text = "done"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function browserToolResult(size: number): ToolResultMessage<DesktopToolResult> {
	const details = browserReadPageDetails({
		stdout: JSON.stringify({ url: "https://example.test", text: "x".repeat(size) }),
	});
	return {
		role: "toolResult",
		toolCallId: `tool-${size}`,
		toolName: "mcp_browser_read_page",
		content: [{ type: "text", text: JSON.stringify(details) }],
		details,
		isError: false,
		timestamp: 1,
	};
}

function browserReadPageDetails(update: Partial<DesktopToolResult>): DesktopToolResult {
	return {
		stepId: "step-1",
		intent: "MCP Browser Control",
		action: "read_page",
		target: "Browser Control",
		status: "succeeded",
		riskLevel: "low",
		requiresConfirmation: false,
		...update,
	};
}
