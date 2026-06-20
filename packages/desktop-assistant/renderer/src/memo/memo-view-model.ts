import type { MemoItem, MemoPriority, MemoRecurrence, MemoSortKey } from "../../../src/shared/types.ts";

export type MemoFilter = "all" | "today" | "upcoming" | "overdue" | "completed";

export interface MemoGroup {
	key: "overdue" | "today" | "upcoming" | "nodate" | "completed";
	label: string;
	memos: MemoItem[];
}

const PRIORITY_RANK: Record<MemoPriority, number> = { high: 0, medium: 1, low: 2, none: 3 };

export const PRIORITY_LABEL: Record<MemoPriority, string> = {
	none: "无",
	low: "低",
	medium: "中",
	high: "高",
};

export const RECURRENCE_LABEL: Record<MemoRecurrence, string> = {
	none: "不重复",
	daily: "每天",
	weekly: "每周",
	monthly: "每月",
};

export const FILTER_LABEL: Record<MemoFilter, string> = {
	all: "全部",
	today: "今天",
	upcoming: "即将",
	overdue: "已逾期",
	completed: "已完成",
};

export const SORT_LABEL: Record<MemoSortKey, string> = {
	due: "按到期",
	priority: "按优先级",
	created: "按创建",
	manual: "手动",
};

function startOfDay(date: Date): number {
	const copy = new Date(date);
	copy.setHours(0, 0, 0, 0);
	return copy.getTime();
}

function endOfDay(date: Date): number {
	const copy = new Date(date);
	copy.setHours(23, 59, 59, 999);
	return copy.getTime();
}

export function isOverdue(memo: MemoItem, now: Date = new Date()): boolean {
	if (memo.status !== "active" || !memo.dueAt) return false;
	const due = Date.parse(memo.dueAt);
	return !Number.isNaN(due) && due < startOfDay(now);
}

export function isDueToday(memo: MemoItem, now: Date = new Date()): boolean {
	if (memo.status !== "active" || !memo.dueAt) return false;
	const due = Date.parse(memo.dueAt);
	return !Number.isNaN(due) && due >= startOfDay(now) && due <= endOfDay(now);
}

/** Apply the top-level filter tab to a memo list. */
export function applyFilter(memos: MemoItem[], filter: MemoFilter, now: Date = new Date()): MemoItem[] {
	switch (filter) {
		case "completed":
			return memos.filter((memo) => memo.status === "completed");
		case "today":
			return memos.filter((memo) => isDueToday(memo, now) || isOverdue(memo, now));
		case "overdue":
			return memos.filter((memo) => isOverdue(memo, now));
		case "upcoming":
			return memos.filter((memo) => {
				if (memo.status !== "active" || !memo.dueAt) return false;
				const due = Date.parse(memo.dueAt);
				return !Number.isNaN(due) && due > endOfDay(now);
			});
		default:
			return memos.filter((memo) => memo.status !== "completed");
	}
}

/** Group active memos into overdue / today / upcoming / no-date sections (completed last). */
export function groupMemos(memos: MemoItem[], now: Date = new Date()): MemoGroup[] {
	const overdue: MemoItem[] = [];
	const today: MemoItem[] = [];
	const upcoming: MemoItem[] = [];
	const nodate: MemoItem[] = [];
	const completed: MemoItem[] = [];
	for (const memo of memos) {
		if (memo.status === "completed") {
			completed.push(memo);
			continue;
		}
		if (isOverdue(memo, now)) overdue.push(memo);
		else if (isDueToday(memo, now)) today.push(memo);
		else if (memo.dueAt) upcoming.push(memo);
		else nodate.push(memo);
	}
	const groups: MemoGroup[] = [
		{ key: "overdue", label: "已逾期", memos: overdue },
		{ key: "today", label: "今天", memos: today },
		{ key: "upcoming", label: "即将到期", memos: upcoming },
		{ key: "nodate", label: "无日期", memos: nodate },
		{ key: "completed", label: "已完成", memos: completed },
	];
	return groups.filter((group) => group.memos.length > 0);
}

export function sortForDisplay(memos: MemoItem[], sort: MemoSortKey): MemoItem[] {
	const byDue = (l: MemoItem, r: MemoItem): number => {
		const a = l.dueAt ? Date.parse(l.dueAt) : Number.POSITIVE_INFINITY;
		const b = r.dueAt ? Date.parse(r.dueAt) : Number.POSITIVE_INFINITY;
		return a - b;
	};
	const pinned = (l: MemoItem, r: MemoItem): number => Number(r.pinned) - Number(l.pinned);
	const byUpdated = (l: MemoItem, r: MemoItem): number => r.updatedAt.localeCompare(l.updatedAt);
	const comparators: Record<MemoSortKey, (l: MemoItem, r: MemoItem) => number> = {
		due: (l, r) => pinned(l, r) || byDue(l, r) || byUpdated(l, r),
		priority: (l, r) => pinned(l, r) || PRIORITY_RANK[l.priority] - PRIORITY_RANK[r.priority] || byDue(l, r),
		created: (l, r) => pinned(l, r) || r.createdAt.localeCompare(l.createdAt),
		manual: (l, r) => pinned(l, r) || byUpdated(l, r),
	};
	return [...memos].sort(comparators[sort]);
}

/** Human label for a due/reminder time relative to now, e.g. "今天 14:30" / "逾期 2 天". */
export function formatDueLabel(iso: string | undefined, now: Date = new Date()): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const today = startOfDay(now);
	const target = startOfDay(date);
	const dayDiff = Math.round((target - today) / 86_400_000);
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0;
	const clock = hasTime ? ` ${time}` : "";
	if (dayDiff === 0) return `今天${clock}`;
	if (dayDiff === 1) return `明天${clock}`;
	if (dayDiff === -1) return `昨天${clock}`;
	if (dayDiff < 0) return `逾期 ${Math.abs(dayDiff)} 天`;
	if (dayDiff <= 7) return `${dayDiff} 天后${clock}`;
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}${clock}`;
}

/** Convert an ISO string to the value a <input type="datetime-local"> expects. */
export function isoToLocalInput(iso: string | undefined): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
		date.getMinutes(),
	)}`;
}

/** Convert a <input type="datetime-local"> value to an ISO string (local time). */
export function localInputToIso(value: string): string | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return undefined;
	return date.toISOString();
}

/** Snooze presets used by reminder cards. */
export function snoozePresets(now: Date = new Date()): Array<{ label: string; iso: string }> {
	const inMinutes = (mins: number) => new Date(now.getTime() + mins * 60_000).toISOString();
	const tomorrow9 = new Date(now);
	tomorrow9.setDate(tomorrow9.getDate() + 1);
	tomorrow9.setHours(9, 0, 0, 0);
	return [
		{ label: "10 分钟后", iso: inMinutes(10) },
		{ label: "1 小时后", iso: inMinutes(60) },
		{ label: "明天 9:00", iso: tomorrow9.toISOString() },
	];
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}
