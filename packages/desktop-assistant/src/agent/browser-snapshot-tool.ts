import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DesktopToolResult } from "../shared/types.ts";
import type { BrowserSnapshotStore } from "./browser-snapshot-store.ts";

export const BROWSER_SNAPSHOT_READ_TOOL_NAME = "browser_snapshot_read";
// Models (DeepSeek especially) routinely assume this tool belongs to the
// mcp_browser_* family it appears alongside in tool results and call a
// non-existent "mcp_browser_snapshot_read", which errors with "tool not found".
// Register that guess as an alias so the call resolves to the same tool.
export const BROWSER_SNAPSHOT_READ_TOOL_ALIAS = "mcp_browser_snapshot_read";
export const BROWSER_SNAPSHOT_READ_TOOL_NAMES = [
	BROWSER_SNAPSHOT_READ_TOOL_NAME,
	BROWSER_SNAPSHOT_READ_TOOL_ALIAS,
] as const;

const browserSnapshotReadSchema = Type.Object({
	snapshotId: Type.String({
		description: "The snapshotId from a compacted browser MCP result.",
	}),
	detailLevel: Type.Optional(
		Type.Union([Type.Literal("summary"), Type.Literal("full")], {
			description: "Use summary by default. Use full only when the compacted summary is insufficient.",
		}),
	),
	fields: Type.Optional(
		Type.Array(
			Type.Union([
				Type.Literal("text"),
				Type.Literal("html"),
				Type.Literal("links"),
				Type.Literal("forms"),
				Type.Literal("tables"),
				Type.Literal("interactive"),
				Type.Literal("raw"),
			]),
			{
				description:
					"Optional fields to read from the snapshot. HTML and raw are expensive; request them only when necessary.",
			},
		),
	),
	maxTextLength: Type.Optional(
		Type.Number({
			description: "Maximum characters to return for large text fields.",
		}),
	),
});

/** Canonical tool plus its mcp_browser_-prefixed alias (see the constants above). */
export function createBrowserSnapshotReadTools(snapshotStore: BrowserSnapshotStore): ToolDefinition[] {
	return BROWSER_SNAPSHOT_READ_TOOL_NAMES.map((name) => createBrowserSnapshotReadTool(snapshotStore, name));
}

export function createBrowserSnapshotReadTool(
	snapshotStore: BrowserSnapshotStore,
	name: string = BROWSER_SNAPSHOT_READ_TOOL_NAME,
): ToolDefinition {
	return defineTool({
		name,
		label: "Read browser snapshot",
		description:
			"Read a compacted browser MCP snapshot by snapshotId. Use this only when the summary/changeSummary is insufficient; prefer summary or specific fields over full/raw.",
		promptSnippet: "Read compacted browser MCP snapshot details by snapshotId when the summary is insufficient.",
		promptGuidelines: [
			"When token saving mode returns a browser snapshotId, first use summary/changeSummary.",
			"Call browser_snapshot_read only when you need exact text, HTML, links, forms, tables, or interactive elements.",
			"Do not repeat read_page for the same page when a usable snapshotId is available.",
		],
		parameters: browserSnapshotReadSchema,
		execute: async (_toolCallId, params) => {
			const readResult = snapshotStore.read({
				snapshotId: params.snapshotId,
				detailLevel: params.detailLevel,
				fields: params.fields,
				maxTextLength: params.maxTextLength,
			});
			const details: DesktopToolResult = {
				stepId: randomUUID(),
				intent: "Read browser snapshot",
				action: name,
				target: params.snapshotId,
				status: readResult.ok ? "succeeded" : "failed",
				stdout: JSON.stringify(readResult, null, 2),
				stderr: readResult.error,
				riskLevel: "low",
				requiresConfirmation: false,
			};
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	});
}
