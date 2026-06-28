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
		autoRunAtReminder: false,
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
		getMemoStats: vi.fn(() => ({
			total: 0,
			active: 0,
			overdue: 0,
			dueToday: 0,
			completedThisWeek: 0,
			completedThisMonth: 0,
			byPriority: { none: 0, low: 0, medium: 0, high: 0 },
			snoozedCount: 0,
		})),
		batchMemos: vi.fn(() => ({ succeeded: [], failed: [] })),
		listMemoLists: vi.fn(() => []),
		createMemoList: vi.fn((request) => ({
			id: "list-1",
			name: request.name,
			color: request.color,
			icon: request.icon,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})),
		updateMemoList: vi.fn((request) => ({
			id: request.id,
			name: request.name ?? "List",
			color: request.color ?? undefined,
			icon: request.icon ?? undefined,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})),
		deleteMemoList: vi.fn(() => true),
		addMemoAttachment: vi.fn((request) => ({
			id: "att-1",
			type: request.url ? ("url" as const) : ("file" as const),
			name: request.name ?? "Attachment",
			href: request.url ?? "file:///tmp/attachment.txt",
			addedAt: new Date().toISOString(),
		})),
		removeMemoAttachment: vi.fn(() => true),
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

	it("passes auto-run settings through create and update", async () => {
		const host = makeHost();
		await runTool(findTool(host, "memo_create"), {
			title: "Auto",
			reminderAt: "2026-06-21T09:00:00.000Z",
			autoRunAtReminder: true,
			autoRunPrompt: "Open report",
		});
		expect(host.createMemo).toHaveBeenCalledWith(
			expect.objectContaining({
				autoRunAtReminder: true,
				autoRunPrompt: "Open report",
			}),
		);
		await runTool(findTool(host, "memo_update"), {
			id: "m1",
			autoRunAtReminder: true,
			autoRunPrompt: "Open report again",
		});
		expect(host.updateMemo).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "m1",
				autoRunAtReminder: true,
				autoRunPrompt: "Open report again",
			}),
		);
		await runTool(findTool(host, "memo_update"), {
			id: "m1",
			autoRunAtReminder: false,
			autoRunPrompt: "",
		});
		expect(host.updateMemo).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "m1",
				autoRunAtReminder: false,
				autoRunPrompt: null,
			}),
		);
	});

	it("rejects auto-run tool calls without a reminder time", async () => {
		const host = makeHost();
		const createResult = await runTool(findTool(host, "memo_create"), {
			title: "Auto",
			autoRunAtReminder: true,
			autoRunPrompt: "Open report",
		});
		expect(createResult.details.status).toBe("failed");
		expect(createResult.details.stderr).toContain("requires reminderAt");
		expect(host.createMemo).not.toHaveBeenCalled();

		const updateResult = await runTool(findTool(host, "memo_update"), {
			id: "m1",
			reminderAt: "",
			autoRunAtReminder: true,
		});
		expect(updateResult.details.status).toBe("failed");
		expect(host.updateMemo).not.toHaveBeenCalled();

		const reminderResult = await runTool(findTool(host, "memo_set_reminder"), {
			id: "m1",
			reminderAt: "",
			autoRunAtReminder: true,
		});
		expect(reminderResult.details.status).toBe("failed");
		expect(host.setMemoReminder).not.toHaveBeenCalled();
	});

	it("maps subtask strings into objects", async () => {
		const host = makeHost();
		const tool = findTool(host, "memo_create");
		await runTool(tool, { title: "搬家", subtasks: ["打包", "租车"] });
		expect(host.createMemo).toHaveBeenCalledWith(
			expect.objectContaining({ subtasks: [{ title: "打包" }, { title: "租车" }] }),
		);
	});

	it("passes listId and progress through create, update and list", async () => {
		const host = makeHost();
		await runTool(findTool(host, "memo_create"), { title: "Plan", listId: "list-1", progress: 45 });
		expect(host.createMemo).toHaveBeenCalledWith(expect.objectContaining({ listId: "list-1", progress: 45 }));
		await runTool(findTool(host, "memo_update"), { id: "m1", listId: "", progress: 80 });
		expect(host.updateMemo).toHaveBeenCalledWith(expect.objectContaining({ id: "m1", listId: null, progress: 80 }));
		await runTool(findTool(host, "memo_list"), { listId: "list-1", sort: "reminderAt" });
		expect(host.listMemos).toHaveBeenCalledWith(expect.objectContaining({ listId: "list-1", sort: "reminderAt" }));
	});

	it("treats an empty reminderAt as a clear request", async () => {
		const host = makeHost();
		const tool = findTool(host, "memo_set_reminder");
		await runTool(tool, { id: "m1", reminderAt: "" });
		expect(host.setMemoReminder).toHaveBeenCalledWith({
			id: "m1",
			reminderAt: null,
			autoRunAtReminder: undefined,
			autoRunPrompt: undefined,
		});
	});

	it("passes auto-run settings through memo_set_reminder", async () => {
		const host = makeHost();
		await runTool(findTool(host, "memo_set_reminder"), {
			id: "m1",
			reminderAt: "2026-06-21T09:00:00.000Z",
			autoRunAtReminder: true,
			autoRunPrompt: "Open report",
		});
		expect(host.setMemoReminder).toHaveBeenCalledWith({
			id: "m1",
			reminderAt: "2026-06-21T09:00:00.000Z",
			autoRunAtReminder: true,
			autoRunPrompt: "Open report",
		});
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

	it("maps stats, batch, list and attachment tools to the host", async () => {
		const host = makeHost();
		await runTool(findTool(host, "memo_stats"), {});
		expect(host.getMemoStats).toHaveBeenCalled();
		await runTool(findTool(host, "memo_batch"), {
			ids: ["m1", "m2"],
			action: "setPriority",
			priority: "high",
		});
		expect(host.batchMemos).toHaveBeenCalledWith({
			ids: ["m1", "m2"],
			action: "setPriority",
			priority: "high",
			listId: undefined,
			tags: undefined,
		});
		await runTool(findTool(host, "memo_list_create"), { name: "Work", color: "#fff", icon: "W" });
		expect(host.createMemoList).toHaveBeenCalledWith({ name: "Work", color: "#fff", icon: "W" });
		await runTool(findTool(host, "memo_list_update"), { id: "list-1", color: "", icon: "" });
		expect(host.updateMemoList).toHaveBeenCalledWith({ id: "list-1", name: undefined, color: null, icon: null });
		await runTool(findTool(host, "memo_list_delete"), { id: "list-1" });
		expect(host.deleteMemoList).toHaveBeenCalledWith({ id: "list-1" });
		await runTool(findTool(host, "memo_attachment_add"), { memoId: "m1", url: "https://example.com", name: "Link" });
		expect(host.addMemoAttachment).toHaveBeenCalledWith({
			memoId: "m1",
			name: "Link",
			filePath: undefined,
			url: "https://example.com",
			type: undefined,
		});
		await runTool(findTool(host, "memo_attachment_remove"), { memoId: "m1", attachmentId: "att-1" });
		expect(host.removeMemoAttachment).toHaveBeenCalledWith({ memoId: "m1", attachmentId: "att-1" });
	});
});
