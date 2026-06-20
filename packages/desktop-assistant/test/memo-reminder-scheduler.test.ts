import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoReminderScheduler } from "../src/agent/memo-reminder-scheduler.ts";
import type { MemoItem } from "../src/shared/types.ts";

function makeMemo(overrides: Partial<MemoItem> = {}): MemoItem {
	const now = new Date().toISOString();
	return {
		id: overrides.id ?? "memo-1",
		title: "提醒",
		notes: "",
		status: "active",
		priority: "none",
		recurrence: "none",
		tags: [],
		subtasks: [],
		pinned: false,
		reminderState: "pending",
		createdAt: now,
		updatedAt: now,
		createdBy: "user",
		...overrides,
	};
}

describe("MemoReminderScheduler", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-20T10:00:00.000Z"));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("fires after the delay elapses", () => {
		const fired: Array<{ id: string; missed: boolean }> = [];
		const scheduler = new MemoReminderScheduler((id, missed) => fired.push({ id, missed }));
		const memo = makeMemo({ reminderAt: new Date(Date.now() + 60_000).toISOString() });
		scheduler.set(memo);
		expect(scheduler.scheduledIds()).toEqual(["memo-1"]);
		vi.advanceTimersByTime(59_000);
		expect(fired).toHaveLength(0);
		vi.advanceTimersByTime(2_000);
		expect(fired).toEqual([{ id: "memo-1", missed: false }]);
		expect(scheduler.scheduledIds()).toEqual([]);
	});

	it("cancel() prevents a pending reminder from firing", () => {
		const fired: string[] = [];
		const scheduler = new MemoReminderScheduler((id) => fired.push(id));
		const memo = makeMemo({ reminderAt: new Date(Date.now() + 30_000).toISOString() });
		scheduler.set(memo);
		scheduler.cancel(memo.id);
		vi.advanceTimersByTime(60_000);
		expect(fired).toHaveLength(0);
	});

	it("does not arm completed memos or those without a reminder", () => {
		const scheduler = new MemoReminderScheduler(() => {});
		scheduler.set(makeMemo({ id: "a", reminderAt: undefined }));
		scheduler.set(makeMemo({ id: "b", status: "completed", reminderAt: new Date(Date.now() + 1000).toISOString() }));
		expect(scheduler.scheduledIds()).toEqual([]);
	});

	it("rescheduleAll fires missed reminders immediately and arms future ones", () => {
		const fired: Array<{ id: string; missed: boolean }> = [];
		const scheduler = new MemoReminderScheduler((id, missed) => fired.push({ id, missed }));
		const past = makeMemo({ id: "past", reminderAt: new Date(Date.now() - 5_000).toISOString() });
		const future = makeMemo({ id: "future", reminderAt: new Date(Date.now() + 10_000).toISOString() });
		scheduler.rescheduleAll([past, future]);
		// Missed one fires synchronously, flagged missed.
		expect(fired).toEqual([{ id: "past", missed: true }]);
		expect(scheduler.scheduledIds()).toEqual(["future"]);
		vi.advanceTimersByTime(11_000);
		expect(fired).toContainEqual({ id: "future", missed: false });
	});

	it("does not fire prematurely for delays beyond the 32-bit timeout ceiling", () => {
		const fired: string[] = [];
		const scheduler = new MemoReminderScheduler((id) => fired.push(id));
		const memo = makeMemo({ reminderAt: new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString() });
		scheduler.set(memo);
		// Advance past the single-timeout ceiling (~24.8 days) — it should re-arm, not fire.
		vi.advanceTimersByTime(2_147_483_647);
		expect(fired).toHaveLength(0);
		expect(scheduler.scheduledIds()).toEqual(["memo-1"]);
	});
});
