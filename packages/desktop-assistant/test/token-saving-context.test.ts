import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { BrowserSnapshotStore } from "../src/agent/browser-snapshot-store.ts";
import { compactTokenSavingMessages } from "../src/agent/token-saving-context.ts";
import type { DesktopToolResult } from "../src/shared/types.ts";

describe("token saving context transform", () => {
	it("compacts browser MCP tool result copies without mutating the original message", () => {
		const details = browserReadPageDetails({
			stdout: JSON.stringify(
				{
					content: [
						{
							type: "text",
							text: JSON.stringify({
								ok: true,
								title: "Large page",
								url: "https://example.test",
								text: "a".repeat(15000),
								html: `<main>${"b".repeat(15000)}</main>`,
								links: Array.from({ length: 40 }, (_, index) => ({
									index,
									text: `Link ${index}`,
									href: `https://example.test/${index}`,
								})),
							}),
						},
					],
				},
				null,
				2,
			),
		});
		const original = browserToolResult(details);
		const messages: AgentMessage[] = [original];

		const compacted = compactTokenSavingMessages(messages, { snapshotStore: new BrowserSnapshotStore() });

		expect(compacted[0]).not.toBe(original);
		expect(original.details).toBe(details);
		expect(details.stdout).toContain("b".repeat(15000));
		expect(JSON.stringify(compacted[0])).not.toContain("b".repeat(15000));
		expect(JSON.stringify(compacted[0])).toContain("snapshotId");
		expect(JSON.stringify(compacted[0])).toContain("browser_snapshot_read");
	});

	it("marks repeated page snapshots as unchanged", () => {
		const store = new BrowserSnapshotStore();
		const first = browserToolResult(
			browserReadPageDetails({
				stdout: JSON.stringify({ url: "https://example.test", title: "Example", text: "same" }),
			}),
		);
		const second = browserToolResult(
			browserReadPageDetails({
				stepId: "step-2",
				stdout: JSON.stringify({ url: "https://example.test", title: "Example", text: "same" }),
			}),
			"tool-2",
		);

		const compacted = compactTokenSavingMessages([first, second], { snapshotStore: store });
		const secondCompacted = compacted[1];
		if (!secondCompacted || secondCompacted.role !== "toolResult") {
			throw new Error("Expected second compacted tool result.");
		}

		const details = (secondCompacted as ToolResultMessage<DesktopToolResult>).details;
		if (!details) {
			throw new Error("Expected compacted details.");
		}
		const observedState = details.observedState as { unchanged?: boolean; previousSnapshotId?: string } | undefined;
		expect(observedState?.unchanged).toBe(true);
		expect(observedState?.previousSnapshotId).toBeTruthy();
	});

	it("emits telemetry and auto-compaction signal for large browser history", () => {
		const telemetry: unknown[] = [];
		const reasons: string[] = [];
		const large = Array.from({ length: 15 }, (_, index) =>
			browserToolResult(
				browserReadPageDetails({
					stepId: `step-${index}`,
					stdout: JSON.stringify({ url: `https://example.test/${index}`, text: "x".repeat(15000) }),
				}),
			),
		);

		compactTokenSavingMessages(large, {
			snapshotStore: new BrowserSnapshotStore(),
			onTelemetry: (item) => telemetry.push(item),
			onAutoCompactionNeeded: (reason) => reasons.push(reason),
		});

		expect(telemetry.length).toBeGreaterThan(0);
		expect(reasons[0]).toContain("browser MCP tool history");
	});

	it("keeps non-browser tool results unchanged", () => {
		const original: ToolResultMessage<DesktopToolResult> = {
			role: "toolResult",
			toolCallId: "tool-2",
			toolName: "shell_command_safe",
			content: [{ type: "text", text: "x".repeat(20000) }],
			details: browserReadPageDetails({ action: "shell_command_safe", stdout: "x".repeat(20000) }),
			isError: false,
			timestamp: 1,
		};

		const compacted = compactTokenSavingMessages([original]);

		expect(compacted[0]).toBe(original);
	});

	it("never compacts the snapshot-read tool's own output, including its mcp_browser_ alias", () => {
		const aliasResult: ToolResultMessage<DesktopToolResult> = {
			role: "toolResult",
			toolCallId: "tool-snap",
			toolName: "mcp_browser_snapshot_read",
			content: [{ type: "text", text: "x".repeat(20000) }],
			details: browserReadPageDetails({ action: "mcp_browser_snapshot_read", stdout: "x".repeat(20000) }),
			isError: false,
			timestamp: 1,
		};

		const compacted = compactTokenSavingMessages([aliasResult], { snapshotStore: new BrowserSnapshotStore() });

		expect(compacted[0]).toBe(aliasResult);
	});

	it("replays frozen browser results verbatim even after their snapshot is evicted", () => {
		const makeMsg = (index: number) =>
			browserToolResult(
				browserReadPageDetails({
					stepId: `step-${index}`,
					stdout: JSON.stringify({
						url: `https://example.test/${index}`,
						title: `Page ${index}`,
						text: `${index}-${"a".repeat(9000)}`,
					}),
				}),
				`tool-${index}`,
			);

		// A short flow where message 0 has already left the recent window (the two
		// large later results fill the 24000-char recent budget), so it freezes.
		const flow: AgentMessage[] = [makeMsg(0), makeMsg(1), makeMsg(2)];

		const store = new BrowserSnapshotStore();
		const frozenForms = new Map<string, AgentMessage>();
		const firstPass = compactTokenSavingMessages(flow, { snapshotStore: store, frozenForms });
		const frozenMessage0 = JSON.stringify(firstPass[0]);
		expect(frozenForms.size).toBeGreaterThan(0); // message 0 was frozen

		// Flood the store past MAX_SNAPSHOTS (80) so message 0's snapshot is evicted.
		for (let index = 100; index < 200; index += 1) {
			compactTokenSavingMessages([makeMsg(index)], { snapshotStore: store, frozenForms });
		}

		// Re-process the original flow: message 0 must serialize byte-for-byte the
		// same because it is replayed from the freeze memo, not recomputed.
		const secondPass = compactTokenSavingMessages(flow, { snapshotStore: store, frozenForms });
		expect(JSON.stringify(secondPass[0])).toBe(frozenMessage0);

		// Contrast: without the memo, recomputing after eviction regenerates the
		// snapshot id, changing the bytes — the prefix-cache churn the freeze
		// mechanism is designed to eliminate.
		const noMemoStore = new BrowserSnapshotStore();
		const noMemoFirst = compactTokenSavingMessages(flow, { snapshotStore: noMemoStore });
		const noMemoMessage0 = JSON.stringify(noMemoFirst[0]);
		for (let index = 100; index < 200; index += 1) {
			compactTokenSavingMessages([makeMsg(index)], { snapshotStore: noMemoStore });
		}
		const noMemoSecond = compactTokenSavingMessages(flow, { snapshotStore: noMemoStore });
		expect(JSON.stringify(noMemoSecond[0])).not.toBe(noMemoMessage0);
	});
});

function browserToolResult(details: DesktopToolResult, toolCallId = "tool-1"): ToolResultMessage<DesktopToolResult> {
	return {
		role: "toolResult",
		toolCallId,
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
