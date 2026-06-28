import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoRepositoryService } from "../src/agent/memo-repository.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "memo-repo-"));
}

describe("MemoRepositoryService", () => {
	it("creates, lists and persists memos to memos.json", () => {
		const dir = tempDir();
		try {
			const repo = new MemoRepositoryService(dir);
			const memo = repo.create({ title: "买牛奶", notes: "超市", tags: ["生活", "生活"] });
			expect(memo.status).toBe("active");
			expect(memo.reminderState).toBe("none");
			expect(memo.tags).toEqual(["生活"]);
			expect(repo.list().memos).toHaveLength(1);

			// A fresh instance reads the persisted file.
			const reloaded = new MemoRepositoryService(dir);
			expect(reloaded.get(memo.id)?.title).toBe("买牛奶");
			expect(existsSync(join(dir, "memos.json"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sets reminderState to pending when a reminder time is given", () => {
		const dir = tempDir();
		try {
			const repo = new MemoRepositoryService(dir);
			const memo = repo.create({ title: "开会", reminderAt: "2026-06-21T09:00:00" });
			expect(memo.reminderState).toBe("pending");
			expect(memo.reminderAt).toBe(new Date("2026-06-21T09:00:00").toISOString());
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists memo auto-run settings and last run state", () => {
		const dir = tempDir();
		try {
			const repo = new MemoRepositoryService(dir);
			const memo = repo.create({
				title: "Auto",
				reminderAt: "2026-06-21T09:00:00",
				autoRunAtReminder: true,
				autoRunPrompt: "Open the report",
			});
			expect(memo.autoRunAtReminder).toBe(true);
			expect(memo.autoRunPrompt).toBe("Open the report");
			repo.markAutoRunStarted(memo.id, "session-1", "2026-06-21T09:00:01.000Z");
			const reloaded = new MemoRepositoryService(dir);
			expect(reloaded.get(memo.id)).toEqual(
				expect.objectContaining({
					autoRunAtReminder: true,
					autoRunPrompt: "Open the report",
					lastAutoRunSessionId: "session-1",
					lastAutoRunAt: "2026-06-21T09:00:01.000Z",
					lastAutoRunStatus: "running",
				}),
			);
			reloaded.markAutoRunSucceeded(memo.id, "2026-06-21T09:05:00.000Z");
			expect(new MemoRepositoryService(dir).get(memo.id)).toEqual(
				expect.objectContaining({
					lastAutoRunStatus: "succeeded",
					lastAutoRunAt: "2026-06-21T09:05:00.000Z",
					lastAutoRunError: undefined,
				}),
			);
			reloaded.markAutoRunFailed(memo.id, "boom", "2026-06-21T09:06:00.000Z");
			expect(new MemoRepositoryService(dir).get(memo.id)).toEqual(
				expect.objectContaining({
					lastAutoRunStatus: "failed",
					lastAutoRunAt: "2026-06-21T09:06:00.000Z",
					lastAutoRunError: "boom",
				}),
			);
			const disabled = reloaded.update({ id: memo.id, autoRunAtReminder: false });
			expect(disabled.autoRunAtReminder).toBe(false);
			expect(disabled.autoRunPrompt).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("normalizes invalid auto-run combinations", () => {
		const dir = tempDir();
		try {
			const repo = new MemoRepositoryService(dir);
			const withoutReminder = repo.create({
				title: "Auto without reminder",
				autoRunAtReminder: true,
				autoRunPrompt: "Open the report",
			});
			expect(withoutReminder.autoRunAtReminder).toBe(false);
			expect(withoutReminder.autoRunPrompt).toBeUndefined();

			const memo = repo.create({
				title: "Auto",
				reminderAt: "2026-06-21T09:00:00.000Z",
				autoRunAtReminder: true,
				autoRunPrompt: "Open the report",
			});
			const clearedByUpdate = repo.update({ id: memo.id, reminderAt: null });
			expect(clearedByUpdate.reminderAt).toBeUndefined();
			expect(clearedByUpdate.autoRunAtReminder).toBe(false);
			expect(clearedByUpdate.autoRunPrompt).toBeUndefined();

			const restored = repo.update({
				id: memo.id,
				reminderAt: "2026-06-22T09:00:00.000Z",
				autoRunAtReminder: true,
				autoRunPrompt: "Open the report again",
			});
			expect(restored.autoRunAtReminder).toBe(true);
			const clearedBySetReminder = repo.setReminder(memo.id, null);
			expect(clearedBySetReminder.reminderAt).toBeUndefined();
			expect(clearedBySetReminder.autoRunAtReminder).toBe(false);
			expect(clearedBySetReminder.autoRunPrompt).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws on an invalid date", () => {
		const dir = tempDir();
		try {
			const repo = new MemoRepositoryService(dir);
			expect(() => repo.create({ title: "x", reminderAt: "明天九点" })).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("completes a one-off memo and re-opens it", () => {
		const dir = tempDir();
		try {
			const repo = new MemoRepositoryService(dir);
			const memo = repo.create({ title: "交报告" });
			const done = repo.complete(memo.id);
			expect(done.status).toBe("completed");
			expect(done.completedAt).toBeTruthy();
			const reopened = repo.complete(memo.id, false);
			expect(reopened.status).toBe("active");
			expect(reopened.completedAt).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rolls a recurring memo forward instead of closing it", () => {
		const dir = tempDir();
		try {
			const repo = new MemoRepositoryService(dir);
			const memo = repo.create({
				title: "每天喝水",
				dueAt: "2026-06-20T09:00:00",
				reminderAt: "2026-06-20T09:00:00",
				recurrence: "daily",
			});
			const next = repo.complete(memo.id);
			expect(next.status).toBe("active");
			expect(new Date(next.dueAt!).toISOString()).toBe(new Date("2026-06-21T09:00:00").toISOString());
			expect(next.reminderState).toBe("pending");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("summarizes overdue and due-today counts", () => {
		const dir = tempDir();
		try {
			const repo = new MemoRepositoryService(dir);
			const now = new Date();
			const yesterday = new Date(now);
			yesterday.setDate(yesterday.getDate() - 1);
			const laterToday = new Date(now);
			laterToday.setHours(23, 0, 0, 0);
			repo.create({ title: "逾期", dueAt: yesterday.toISOString() });
			repo.create({ title: "今天", dueAt: laterToday.toISOString() });
			repo.create({ title: "无日期" });
			const summary = repo.summary();
			expect(summary.overdueCount).toBe(1);
			expect(summary.dueTodayCount).toBe(1);
			expect(summary.activeCount).toBe(3);
			expect(summary.upcoming.length).toBeGreaterThanOrEqual(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("surfaces reminder-only memos in today's summary", () => {
		const dir = tempDir();
		try {
			const repo = new MemoRepositoryService(dir);
			const now = new Date("2026-06-20T10:00:00");
			const laterToday = new Date("2026-06-20T18:00:00");
			const memo = repo.create({ title: "今晚提醒我交电费", reminderAt: laterToday.toISOString() });
			const summary = repo.summary(now);
			expect(summary.dueTodayCount).toBe(1);
			expect(summary.upcoming.some((item) => item.id === memo.id)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("filters by status and searches by text", () => {
		const dir = tempDir();
		try {
			const repo = new MemoRepositoryService(dir);
			const a = repo.create({ title: "写周报", tags: ["工作"] });
			repo.create({ title: "买菜", tags: ["生活"] });
			repo.complete(a.id);
			expect(repo.list({ status: "completed" }).memos).toHaveLength(1);
			expect(repo.list({ status: "active" }).memos).toHaveLength(1);
			expect(repo.list({ query: "周报" }).memos).toHaveLength(1);
			expect(repo.list({ tag: "生活" }).memos).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("deletes a memo", () => {
		const dir = tempDir();
		try {
			const repo = new MemoRepositoryService(dir);
			const memo = repo.create({ title: "临时" });
			expect(repo.delete(memo.id)).toBe(true);
			expect(repo.get(memo.id)).toBeUndefined();
			expect(repo.delete("missing")).toBe(false);
			expect(JSON.parse(readFileSync(join(dir, "memos.json"), "utf-8")).memos).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("migrates legacy stores and persists schema version 2 with lists", () => {
		const dir = tempDir();
		try {
			writeFileSync(
				join(dir, "memos.json"),
				JSON.stringify({
					schemaVersion: 1,
					memos: [{ id: "m1", title: "Legacy", status: "active", priority: "none" }],
				}),
			);
			const repo = new MemoRepositoryService(dir);
			expect(repo.get("m1")?.title).toBe("Legacy");
			const list = repo.createList({ name: "Work", color: "#6aa9ff", icon: "W" });
			const stored = JSON.parse(readFileSync(join(dir, "memos.json"), "utf-8"));
			expect(stored.schemaVersion).toBe(2);
			expect(stored.lists).toEqual([expect.objectContaining({ id: list.id, name: "Work" })]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("filters by listId and sorts reminder-only memos by reminder time", () => {
		const dir = tempDir();
		try {
			const repo = new MemoRepositoryService(dir);
			const list = repo.createList({ name: "Work" });
			const later = repo.create({ title: "Later", listId: list.id, reminderAt: "2026-06-21T12:00:00" });
			const earlier = repo.create({ title: "Earlier", listId: list.id, reminderAt: "2026-06-21T09:00:00" });
			repo.create({ title: "Personal", reminderAt: "2026-06-21T08:00:00" });
			expect(
				repo
					.list({ listId: list.id })
					.memos.map((memo) => memo.id)
					.sort(),
			).toEqual([later.id, earlier.id].sort());
			expect(
				repo
					.list({ sort: "reminderAt" })
					.memos.map((memo) => memo.title)
					.slice(0, 2),
			).toEqual(["Personal", "Earlier"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reorders memos manually and persists the order", () => {
		const dir = tempDir();
		try {
			const repo = new MemoRepositoryService(dir);
			const first = repo.create({ title: "First" });
			repo.create({ title: "Second" });
			const third = repo.create({ title: "Third" });
			expect(repo.list({ sort: "manual" }).memos.map((memo) => memo.title)).toEqual(["First", "Second", "Third"]);

			repo.reorderMemo({ id: third.id, beforeId: first.id });
			expect(repo.list({ sort: "manual" }).memos.map((memo) => memo.title)).toEqual(["Third", "First", "Second"]);
			expect(new MemoRepositoryService(dir).list({ sort: "manual" }).memos.map((memo) => memo.title)).toEqual([
				"Third",
				"First",
				"Second",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("computes stats across active, overdue, completed and snoozed memos", () => {
		const dir = tempDir();
		try {
			const repo = new MemoRepositoryService(dir);
			const now = new Date("2026-06-24T10:00:00");
			repo.create({ title: "Overdue", dueAt: "2026-06-23T10:00:00", priority: "high" });
			repo.create({ title: "Today", dueAt: "2026-06-24T12:00:00", priority: "medium" });
			const done = repo.create({ title: "Done", priority: "low" });
			repo.complete(done.id);
			const snoozed = repo.create({ title: "Snoozed", reminderAt: "2026-06-25T09:00:00" });
			repo.snooze(snoozed.id, "2026-06-25T12:00:00");
			const stats = repo.stats(now);
			expect(stats.total).toBe(4);
			expect(stats.active).toBe(3);
			expect(stats.overdue).toBe(1);
			expect(stats.dueToday).toBe(1);
			expect(stats.completedThisWeek).toBe(1);
			expect(stats.completedThisMonth).toBe(1);
			expect(stats.byPriority.high).toBe(1);
			expect(stats.snoozedCount).toBe(1);
			expect(stats.avgCompletionDays).toBeDefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs batch updates and reports missing ids", () => {
		const dir = tempDir();
		try {
			const repo = new MemoRepositoryService(dir);
			const list = repo.createList({ name: "Work" });
			const one = repo.create({ title: "One" });
			const two = repo.create({ title: "Two" });
			const result = repo.batch({ ids: [one.id, two.id, "missing"], action: "setListId", listId: list.id });
			expect(result).toEqual({ succeeded: [one.id, two.id], failed: ["missing"] });
			expect(repo.list({ listId: list.id }).memos).toHaveLength(2);
			repo.batch({ ids: [one.id], action: "archive" });
			expect(repo.get(one.id)?.status).toBe("archived");
			repo.batch({ ids: [two.id], action: "setPriority", priority: "high" });
			expect(repo.get(two.id)?.priority).toBe("high");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("updates and deletes lists while clearing memo references", () => {
		const dir = tempDir();
		try {
			const repo = new MemoRepositoryService(dir);
			const list = repo.createList({ name: "Work", icon: "W" });
			const memo = repo.create({ title: "Task", listId: list.id });
			expect(repo.updateList({ id: list.id, name: "Focus", icon: null }).icon).toBeUndefined();
			expect(repo.listLists()[0]?.name).toBe("Focus");
			expect(repo.deleteList({ id: list.id })).toBe(true);
			expect(repo.get(memo.id)?.listId).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("copies file attachments and removes their folders", () => {
		const dir = tempDir();
		try {
			const attachmentsDir = join(dir, "attachments");
			const sourcePath = join(dir, "source.txt");
			writeFileSync(sourcePath, "hello");
			const repo = new MemoRepositoryService(dir, attachmentsDir);
			const memo = repo.create({ title: "With file" });
			const attachment = repo.addAttachment({ memoId: memo.id, filePath: sourcePath, name: "note.txt" });
			expect(attachment.type).toBe("file");
			expect(attachment.href).toMatch(/^file:/);
			expect(repo.get(memo.id)?.attachments).toHaveLength(1);
			expect(existsSync(join(attachmentsDir, memo.id, attachment.id, "note.txt"))).toBe(true);
			expect(repo.removeAttachment({ memoId: memo.id, attachmentId: attachment.id })).toBe(true);
			expect(repo.get(memo.id)?.attachments).toHaveLength(0);
			expect(existsSync(join(attachmentsDir, memo.id, attachment.id))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stores URL attachments without copying files", () => {
		const dir = tempDir();
		try {
			const repo = new MemoRepositoryService(dir);
			const memo = repo.create({ title: "With URL" });
			const attachment = repo.addAttachment({ memoId: memo.id, url: "https://example.com/a", name: "Example" });
			expect(attachment).toEqual(
				expect.objectContaining({ type: "url", name: "Example", href: "https://example.com/a" }),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
