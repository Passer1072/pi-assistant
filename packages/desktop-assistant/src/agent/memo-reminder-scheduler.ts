import type { MemoItem } from "../shared/types.ts";

/** Node's setTimeout overflows past this; longer waits are split into hops. */
const MAX_TIMEOUT_MS = 2_147_483_647;

interface ScheduledReminder {
	memoId: string;
	/** Target fire time in epoch ms. */
	fireAt: number;
	handle: ReturnType<typeof setTimeout>;
}

/**
 * Fires a callback when each memo's reminder time arrives. One timer per memo,
 * keyed by id, replaceable and cancellable. Very long delays are chunked so they
 * survive Node's 32-bit setTimeout ceiling. On {@link rescheduleAll}, reminders
 * whose time already passed fire immediately, flagged as "missed", so a reminder
 * is never silently lost while the app was closed.
 */
export class MemoReminderScheduler {
	private readonly reminders = new Map<string, ScheduledReminder>();
	private readonly onFire: (memoId: string, missed: boolean) => void;
	private readonly now: () => number;

	constructor(onFire: (memoId: string, missed: boolean) => void, now: () => number = () => Date.now()) {
		this.onFire = onFire;
		this.now = now;
	}

	/** Arm (or re-arm) the reminder for one memo. No-op if it has no reminder time. */
	set(memo: MemoItem): void {
		this.cancel(memo.id);
		if (!memo.reminderAt) return;
		if (memo.status !== "active") return;
		if (memo.reminderState !== "pending" && memo.reminderState !== "snoozed") return;
		const fireAt = Date.parse(memo.reminderAt);
		if (Number.isNaN(fireAt)) return;
		this.arm(memo.id, fireAt, false);
	}

	cancel(memoId: string): void {
		const existing = this.reminders.get(memoId);
		if (existing) {
			clearTimeout(existing.handle);
			this.reminders.delete(memoId);
		}
	}

	/** Replace all timers from a fresh memo list (e.g. on startup or bulk change). */
	rescheduleAll(memos: MemoItem[]): void {
		for (const id of [...this.reminders.keys()]) this.cancel(id);
		const current = this.now();
		for (const memo of memos) {
			if (!memo.reminderAt || memo.status !== "active") continue;
			if (memo.reminderState !== "pending" && memo.reminderState !== "snoozed") continue;
			const fireAt = Date.parse(memo.reminderAt);
			if (Number.isNaN(fireAt)) continue;
			if (fireAt <= current) {
				// Missed while the app was closed — surface it now.
				this.onFire(memo.id, true);
			} else {
				this.arm(memo.id, fireAt, false);
			}
		}
	}

	/** Test/inspection helper: ids with a live timer. */
	scheduledIds(): string[] {
		return [...this.reminders.keys()];
	}

	dispose(): void {
		for (const reminder of this.reminders.values()) clearTimeout(reminder.handle);
		this.reminders.clear();
	}

	private arm(memoId: string, fireAt: number, missed: boolean): void {
		const delay = Math.max(0, fireAt - this.now());
		const chunk = Math.min(delay, MAX_TIMEOUT_MS);
		const handle = setTimeout(() => {
			this.reminders.delete(memoId);
			if (this.now() >= fireAt - 50) {
				this.onFire(memoId, missed);
			} else {
				// Long delay: hop again until the real fire time arrives.
				this.arm(memoId, fireAt, missed);
			}
		}, chunk);
		// Don't keep the process alive solely for a reminder.
		(handle as { unref?: () => void }).unref?.();
		this.reminders.set(memoId, { memoId, fireAt, handle });
	}
}
