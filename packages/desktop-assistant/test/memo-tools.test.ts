import { describe, expect, it, vi } from "vitest";
import { createMemoToolDefinitions, MEMO_TOOL_NAMES, type MemoToolHost } from "../src/agent/memo-tools.ts";
import type { DesktopToolResult, MemoItem } from "../src/shared/types.ts";

function sampleMemo(overrides: Partial<MemoItem> = {}): MemoItem {
	const now = new Date().toISOString();
	return {
		id: "m1",
		title: "t",
		notes: "",
		status: "active",
		priority: "none",
		recurrence: "none",
		tags: [],
		subtasks: [],
		pinned: false,
		reminderState: "none",
		createdAt: now,
		updatedAt: now,
		createdBy: "user",
		...overrides,
	};
}

function makeHost(overrides: Partial<MemoToolHost> = {}): MemoToolHost {
	return {
		createMemo: vi.fn((request) => sampleMemo({ id: "created", title: request.title })),
		updateMemo: vi.fn((request) => sampleMemo({ id: request.id })),
		completeMemo: vi.fn((request) => sampleMemo({ id: request.id, status: "completed" })),
		deleteMemo: vi.fn(() => true),
		setMemoReminder: vi.fn((request) => sampleMemo({ id: request.id })),
		listMemos: vi.fn(() => ({
			memos: [],
			summary: { total: 0, activeCount: 0, dueTodayCount: 0, overdueCount: 0, upcoming: [] },
		})),
		searchMemos: vi.fn(() => []),
		getSourceSessionId: () => "sess-1",
		...overrides,
	};
}

type ToolReturn = { content: Array<{ type: "text"; text: string }>; details: DesktopToolResult };

function findTool(host: MemoToolHost, name: string) {
	const tool = createMemoToolDefinitions(host).find((definition) => definition.name === name);
	if (!tool) throw new Error(`tool not found: ${name}`);
	return tool;
}

// The agent passes more than (toolCallId, params) at runtime; the memo tools only
// read those two, so call through a loosened signature for the unit tests.
function runTool(tool: ReturnType<typeof findTool>, params: Record<string, unknown>): Promise<ToolReturn> {
	const execute = tool.execute as unknown as (
		toolCallId: string,
		params: Record<string, unknown>,
	) => Promise<ToolReturn>;
	return execute("call", params);
}

describe("memo tools", () => {
	it("exposes every named tool", () => {
		const tools = createMemoToolDefinitions(makeHost());
		expect(tools.map((tool) => tool.name).sort()).toEqual([...MEMO_TOOL_NAMES].sort());
	});

	it("memo_create tags AI authorship and source session", async () => {
		const host = makeHost();
		const tool = findTool(host, "memo_create");
		const result = await runTool(tool, { title: "买票" });
		expect(result.details.status).toBe("succeeded");
		expect(host.createMemo).toHaveBeenCalledWith(
			expect.objectContaining({ title: "买票", createdBy: "ai", sourceSessionId: "sess-1" }),
		);
	});

	it("maps subtask strings into objects", async () => {
		const host = makeHost();
		const tool = findTool(host, "memo_create");
		await runTool(tool, { title: "搬家", subtasks: ["打包", "租车"] });
		expect(host.createMemo).toHaveBeenCalledWith(
			expect.objectContaining({ subtasks: [{ title: "打包" }, { title: "租车" }] }),
		);
	});

	it("treats an empty reminderAt as a clear request", async () => {
		const host = makeHost();
		const tool = findTool(host, "memo_set_reminder");
		await runTool(tool, { id: "m1", reminderAt: "" });
		expect(host.setMemoReminder).toHaveBeenCalledWith({ id: "m1", reminderAt: null });
	});

	it("reports a failed status when the host throws", async () => {
		const host = makeHost({
			createMemo: vi.fn(() => {
				throw new Error("Invalid date/time");
			}),
		});
		const tool = findTool(host, "memo_create");
		const result = await runTool(tool, { title: "x", reminderAt: "bad" });
		expect(result.details.status).toBe("failed");
		expect(result.details.stderr).toContain("Invalid date/time");
	});
});
