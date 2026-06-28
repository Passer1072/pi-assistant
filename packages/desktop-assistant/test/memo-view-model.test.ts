import { describe, expect, it } from "vitest";
import { buildMemoDocumentText } from "../renderer/src/memo/memo-view-model.ts";
import type { MemoItem, MemoList } from "../src/shared/types.ts";

function makeMemo(overrides: Partial<MemoItem> = {}): MemoItem {
	return {
		id: "memo-1",
		title: "提交周报",
		notes: "完成本周工作总结。",
		status: "active",
		priority: "high",
		dueAt: "2026-06-28T09:30:00",
		reminderAt: "2026-06-28T08:30:00",
		recurrence: "weekly",
		tags: ["工作", "周报"],
		subtasks: [
			{ id: "sub-1", title: "整理数据", done: true },
			{ id: "sub-2", title: "发送邮件", done: false },
		],
		pinned: false,
		progress: 50,
		attachments: [
			{
				id: "att-1",
				type: "url",
				name: "参考链接",
				href: "https://example.com",
				addedAt: "2026-06-27T10:00:00.000Z",
			},
		],
		autoRunAtReminder: true,
		autoRunPrompt: "生成周报草稿",
		lastAutoRunStatus: "succeeded",
		reminderState: "pending",
		createdAt: "2026-06-27T10:00:00",
		updatedAt: "2026-06-27T11:00:00",
		createdBy: "user",
		...overrides,
	};
}

describe("buildMemoDocumentText", () => {
	it("formats the full memo as a stable formal document text", () => {
		const list: MemoList = {
			id: "list-1",
			name: "工作事项",
			createdAt: "2026-06-27T10:00:00.000Z",
			updatedAt: "2026-06-27T10:00:00.000Z",
		};
		expect(buildMemoDocumentText(makeMemo({ listId: list.id }), list)).toMatchInlineSnapshot(`
			"备忘录

			标题：提交周报
			状态：进行中
			清单：工作事项
			优先级：高
			重复：每周
			创建时间：2026-06-27 10:00
			更新时间：2026-06-27 11:00
			截止时间：2026-06-28 09:30
			提醒时间：2026-06-28 08:30
			进度：50%

			正文：
			完成本周工作总结。

			子任务：
			- [x] 整理数据
			- [ ] 发送邮件

			标签：#工作 #周报

			附件：
			- 参考链接：https://example.com

			AI 自动执行：
			- 到提醒时自动运行：是
			- 指令：生成周报草稿
			- 最近状态：已完成"
		`);
	});

	it("uses explicit placeholders for empty optional content", () => {
		expect(
			buildMemoDocumentText(
				makeMemo({
					notes: "",
					priority: "none",
					dueAt: undefined,
					reminderAt: undefined,
					recurrence: "none",
					tags: [],
					subtasks: [],
					progress: undefined,
					attachments: undefined,
					autoRunAtReminder: false,
					autoRunPrompt: undefined,
					lastAutoRunStatus: undefined,
				}),
			),
		).toContain("清单：未分类\n优先级：无优先级");
		expect(
			buildMemoDocumentText(
				makeMemo({
					notes: "",
					tags: [],
					subtasks: [],
					attachments: undefined,
					autoRunAtReminder: false,
					autoRunPrompt: undefined,
					lastAutoRunStatus: undefined,
				}),
			),
		).toContain("正文：\n暂无正文");
	});
});
