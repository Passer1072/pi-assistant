import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
});
