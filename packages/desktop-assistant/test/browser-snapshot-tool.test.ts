import { describe, expect, it } from "vitest";
import { BrowserSnapshotStore } from "../src/agent/browser-snapshot-store.ts";
import {
	BROWSER_SNAPSHOT_READ_TOOL_NAMES,
	createBrowserSnapshotReadTool,
	createBrowserSnapshotReadTools,
} from "../src/agent/browser-snapshot-tool.ts";
import type { DesktopToolResult } from "../src/shared/types.ts";

describe("browser_snapshot_read tool", () => {
	it("reads browser snapshots through the tool", async () => {
		const store = new BrowserSnapshotStore();
		const snapshot = store.create({
			toolName: "mcp_browser_read_page",
			action: "read_page",
			url: "https://example.test",
			stdout: JSON.stringify({ text: "snapshot text", links: [{ text: "Home", href: "/" }] }),
			raw: {},
		});
		const tool = createBrowserSnapshotReadTool(store);

		const result = await tool.execute(
			"tool-1",
			{ snapshotId: snapshot.id, fields: ["text", "links"] },
			undefined,
			undefined,
			{} as Parameters<typeof tool.execute>[4],
		);

		const details = expectDesktopToolResult(result.details);
		expect(details.status).toBe("succeeded");
		expect(details.stdout).toContain("snapshot text");
		expect(details.stdout).toContain("links");
	});

	it("registers the canonical tool plus an mcp_browser_-prefixed alias that both resolve", async () => {
		expect([...BROWSER_SNAPSHOT_READ_TOOL_NAMES]).toEqual(["browser_snapshot_read", "mcp_browser_snapshot_read"]);

		const store = new BrowserSnapshotStore();
		const snapshot = store.create({
			toolName: "mcp_browser_read_page",
			action: "read_page",
			url: "https://example.test",
			stdout: JSON.stringify({ text: "snapshot text" }),
			raw: {},
		});
		const tools = createBrowserSnapshotReadTools(store);
		expect(tools).toHaveLength(2);

		// The exact name the model keeps mis-calling must now resolve instead of
		// erroring with "tool not found".
		for (const tool of tools) {
			const result = await tool.execute(
				"tool-1",
				{ snapshotId: snapshot.id, fields: ["text"] },
				undefined,
				undefined,
				{} as Parameters<typeof tool.execute>[4],
			);
			const details = expectDesktopToolResult(result.details);
			expect(details.status).toBe("succeeded");
			expect(details.stdout).toContain("snapshot text");
		}
	});
});

function expectDesktopToolResult(value: unknown): DesktopToolResult {
	if (typeof value !== "object" || value === null) {
		throw new Error("Expected DesktopToolResult details.");
	}
	const candidate = value as Partial<DesktopToolResult>;
	if (typeof candidate.status !== "string" || typeof candidate.stdout !== "string") {
		throw new Error("Expected DesktopToolResult status and stdout.");
	}
	return candidate as DesktopToolResult;
}
