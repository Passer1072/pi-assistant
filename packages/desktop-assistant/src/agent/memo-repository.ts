import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
	MemoCreateRequest,
	MemoItem,
	MemoListRequest,
	MemoListResponse,
	MemoPriority,
	MemoRecurrence,
	MemoSortKey,
	MemoStatus,
	MemoSubtask,
	MemoSummary,
	MemoUpdateRequest,
} from "../shared/types.ts";

const STORE_FILENAME = "memos.json";
const SCHEMA_VERSION = 1;
const MAX_TITLE_LEN = 200;
const MAX_NOTES_LEN = 8000;
const MAX_TAGS = 20;
const MAX_SUBTASKS = 50;
/** How many items the lightweight summary surfaces to the UI strips. */
const UPCOMING_LIMIT = 8;
/** Upcoming window for the summary: active memos due within this many days. */
const UPCOMING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const PRIORITY_RANK: Record<MemoPriority, number> = { high: 0, medium: 1, low: 2, none: 3 };
const VALID_PRIORITIES: MemoPriority[] = ["none", "low", "medium", "high"];
const VALID_RECURRENCE: MemoRecurrence[] = ["none", "daily", "weekly", "monthly"];

interface MemoStoreFile {
	schemaVersion: number;
	memos: MemoItem[];
}

/**
 * File-backed CRUD for memos/to-dos. Mirrors the encapsulation style of
 * {@link ../agent/personal-skill-repository.ts}, but stores structured JSON
 * (one array of memos) so the AI tools, the reminder scheduler, and every
 * window read the same source of truth. Writes are atomic (temp file + rename).
 */
export class MemoRepositoryService {
	private readonly dir: string;
	private readonly filePath: string;
	private memos: MemoItem[];
	private loaded = false;

	constructor(memoDir: string) {
		this.dir = resolve(memoDir);
		this.filePath = join(this.dir, STORE_FILENAME);
		this.memos = [];
	}

	/** All memos, newest-updated first. Loads from disk on first use. */
	all(): MemoItem[] {
		this.ensureLoaded();
		return [...this.memos];
	}

	get(id: string): MemoItem | undefined {
		this.ensureLoaded();
		return this.memos.find((memo) => memo.id === id);
	}

	list(request: MemoListRequest = {}): MemoListResponse {
		this.ensureLoaded();
		let result = [...this.memos];
		if (request.status) {
			result = result.filter((memo) => memo.status === request.status);
		}
		if (request.tag) {
			const tag = request.tag.toLowerCase();
			result = result.filter((memo) => memo.tags.some((value) => value.toLowerCase() === tag));
		}
		const query = request.query?.trim().toLowerCase();
		if (query) {
			const terms = query.split(/\s+/g).filter(Boolean);
			result = result.filter((memo) => {
				const haystack = [memo.title, memo.notes, memo.tags.join(" "), memo.subtasks.map((s) => s.title).join(" ")]
					.join(" ")
					.toLowerCase();
				return terms.every((term) => haystack.includes(term));
			});
		}
		result = sortMemos(result, request.sort ?? "due");
		return { memos: result, summary: this.summary() };
	}

	create(request: MemoCreateRequest): MemoItem {
		this.ensureLoaded();
		const now = new Date().toISOString();
		const reminderAt = normalizeIso(request.reminderAt);
		const memo: MemoItem = {
			id: randomUUID(),
			title: cleanRequired(request.title, "title", MAX_TITLE_LEN),
			notes: clampText(request.notes ?? "", MAX_NOTES_LEN),
			status: "active",
			priority: normalizePriority(request.priority),
			dueAt: normalizeIso(request.dueAt),
			reminderAt,
			recurrence: normalizeRecurrence(request.recurrence),
			tags: normalizeTags(request.tags),
			subtasks: normalizeSubtasks(request.subtasks),
			pinned: request.pinned === true,
			color: cleanOptional(request.color),
			reminderState: reminderAt ? "pending" : "none",
			createdAt: now,
			updatedAt: now,
			createdBy: request.createdBy === "ai" ? "ai" : "user",
			sourceSessionId: cleanOptional(request.sourceSessionId),
		};
		this.memos.unshift(memo);
		this.flush();
		return memo;
	}

	update(request: MemoUpdateRequest): MemoItem {
		this.ensureLoaded();
		const memo = this.requireMemo(request.id);
		if (request.title !== undefined) memo.title = cleanRequired(request.title, "title", MAX_TITLE_LEN);
		if (request.notes !== undefined) memo.notes = clampText(request.notes, MAX_NOTES_LEN);
		if (request.status !== undefined) memo.status = normalizeStatus(request.status);
		if (request.priority !== undefined) memo.priority = normalizePriority(request.priority);
		if (request.dueAt !== undefined) memo.dueAt = request.dueAt === null ? undefined : normalizeIso(request.dueAt);
		if (request.reminderAt !== undefined) {
			memo.reminderAt = request.reminderAt === null ? undefined : normalizeIso(request.reminderAt);
			memo.reminderState = memo.reminderAt ? "pending" : "none";
			memo.reminderMissed = undefined;
		}
		if (request.recurrence !== undefined) memo.recurrence = normalizeRecurrence(request.recurrence);
		if (request.tags !== undefined) memo.tags = normalizeTags(request.tags);
		if (request.subtasks !== undefined) memo.subtasks = normalizeSubtasks(request.subtasks);
		if (request.pinned !== undefined) memo.pinned = request.pinned === true;
		if (request.color !== undefined) memo.color = request.color === null ? undefined : cleanOptional(request.color);
		memo.updatedAt = new Date().toISOString();
		this.flush();
		return memo;
	}

	/**
	 * Complete or re-open a memo. Completing a recurring memo rolls its dates
	 * forward to the next occurrence and keeps it active instead of closing it.
	 */
	complete(id: string, completed = true): MemoItem {
		this.ensureLoaded();
		const memo = this.requireMemo(id);
		const now = new Date().toISOString();
		if (completed && memo.recurrence !== "none") {
			advanceRecurrence(memo);
			memo.reminderState = memo.reminderAt ? "pending" : "none";
			memo.reminderMissed = undefined;
			memo.status = "active";
			memo.completedAt = undefined;
		} else if (completed) {
			memo.status = "completed";
			memo.completedAt = now;
			memo.reminderState = memo.reminderState === "pending" ? "dismissed" : memo.reminderState;
		} else {
			memo.status = "active";
			memo.completedAt = undefined;
			if (memo.reminderAt) memo.reminderState = "pending";
		}
		memo.updatedAt = now;
		this.flush();
		return memo;
	}

	/** Snooze: push the reminder to a new time and re-arm it. */
	snooze(id: string, until: string): MemoItem {
		this.ensureLoaded();
		const memo = this.requireMemo(id);
		memo.reminderAt = normalizeIso(until);
		memo.reminderState = "snoozed";
		memo.reminderMissed = undefined;
		memo.updatedAt = new Date().toISOString();
		this.flush();
		return memo;
	}

	setReminder(id: string, reminderAt: string | null): MemoItem {
		this.ensureLoaded();
		const memo = this.requireMemo(id);
		memo.reminderAt = reminderAt === null ? undefined : normalizeIso(reminderAt);
		memo.reminderState = memo.reminderAt ? "pending" : "none";
		memo.reminderMissed = undefined;
		memo.updatedAt = new Date().toISOString();
		this.flush();
		return memo;
	}

	/** Mark a reminder as fired (called by the scheduler). `missed` = fired late. */
	markReminderFired(id: string, missed = false): MemoItem | undefined {
		this.ensureLoaded();
		const memo = this.memos.find((value) => value.id === id);
		if (!memo) return undefined;
		memo.reminderState = "fired";
		memo.reminderMissed = missed || undefined;
		memo.updatedAt = new Date().toISOString();
		this.flush();
		return memo;
	}

	delete(id: string): boolean {
		this.ensureLoaded();
		const index = this.memos.findIndex((memo) => memo.id === id);
		if (index < 0) return false;
		this.memos.splice(index, 1);
		this.flush();
		return true;
	}

	search(query: string, limit = 20): MemoItem[] {
		return this.list({ query }).memos.slice(0, Math.max(1, limit));
	}

	/** Active memos with a pending/snoozed reminder in the future — used to arm the scheduler. */
	pendingReminders(): MemoItem[] {
		this.ensureLoaded();
		return this.memos.filter(
			(memo) =>
				memo.status === "active" &&
				!!memo.reminderAt &&
				(memo.reminderState === "pending" || memo.reminderState === "snoozed"),
		);
	}

	summary(now: Date = new Date()): MemoSummary {
		this.ensureLoaded();
		const active = this.memos.filter((memo) => memo.status === "active");
		const endOfToday = endOfDay(now).getTime();
		const startOfToday = startOfDay(now).getTime();
		const horizon = now.getTime() + UPCOMING_WINDOW_MS;
		const timeline = active
			.map((memo) => ({ memo, attentionAt: getSummaryAttentionAt(memo) }))
			.filter((entry): entry is { memo: MemoItem; attentionAt: number } => entry.attentionAt !== undefined);
		let dueTodayCount = 0;
		let overdueCount = 0;
		for (const entry of timeline) {
			if (entry.attentionAt < startOfToday) overdueCount += 1;
			else if (entry.attentionAt <= endOfToday) dueTodayCount += 1;
		}
		const upcoming = timeline
			.filter((entry) => entry.attentionAt <= horizon)
			.sort((left, right) => left.attentionAt - right.attentionAt)
			.slice(0, UPCOMING_LIMIT);
		return {
			total: this.memos.length,
			activeCount: active.length,
			dueTodayCount,
			overdueCount,
			upcoming: upcoming.map((entry) => entry.memo),
		};
	}

	private requireMemo(id: string): MemoItem {
		const memo = this.memos.find((value) => value.id === id);
		if (!memo) throw new Error(`Memo not found: ${id}`);
		return memo;
	}

	private ensureLoaded(): void {
		if (this.loaded) return;
		this.loaded = true;
		try {
			if (!existsSync(this.filePath)) {
				this.memos = [];
				return;
			}
			const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<MemoStoreFile>;
			this.memos = Array.isArray(parsed.memos) ? parsed.memos.map(coerceMemo).filter(Boolean as never) : [];
		} catch {
			this.memos = [];
		}
	}

	private flush(): void {
		mkdirSync(this.dir, { recursive: true });
		const payload: MemoStoreFile = { schemaVersion: SCHEMA_VERSION, memos: this.memos };
		const tmp = `${this.filePath}.${randomUUID().slice(0, 8)}.tmp`;
		writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
		renameSync(tmp, this.filePath);
	}
}

export function sortMemos(memos: MemoItem[], sort: MemoSortKey): MemoItem[] {
	const pinnedFirst = (left: MemoItem, right: MemoItem): number => Number(right.pinned) - Number(left.pinned);
	const byDue = (left: MemoItem, right: MemoItem): number => {
		const l = left.dueAt ? Date.parse(left.dueAt) : Number.POSITIVE_INFINITY;
		const r = right.dueAt ? Date.parse(right.dueAt) : Number.POSITIVE_INFINITY;
		return l - r;
	};
	const byUpdated = (left: MemoItem, right: MemoItem): number => right.updatedAt.localeCompare(left.updatedAt);
	const comparators: Record<MemoSortKey, (l: MemoItem, r: MemoItem) => number> = {
		due: (l, r) => pinnedFirst(l, r) || byDue(l, r) || byUpdated(l, r),
		priority: (l, r) => pinnedFirst(l, r) || PRIORITY_RANK[l.priority] - PRIORITY_RANK[r.priority] || byDue(l, r),
		created: (l, r) => pinnedFirst(l, r) || right_created(l, r),
		manual: (l, r) => pinnedFirst(l, r) || byUpdated(l, r),
	};
	return [...memos].sort(comparators[sort]);
}

function right_created(left: MemoItem, right: MemoItem): number {
	return right.createdAt.localeCompare(left.createdAt);
}

function getSummaryAttentionAt(memo: MemoItem): number | undefined {
	const dueAt = memo.dueAt ? Date.parse(memo.dueAt) : Number.NaN;
	const reminderAt =
		memo.reminderAt && (memo.reminderState === "pending" || memo.reminderState === "snoozed")
			? Date.parse(memo.reminderAt)
			: Number.NaN;
	const hasDueAt = !Number.isNaN(dueAt);
	const hasReminderAt = !Number.isNaN(reminderAt);
	if (hasDueAt && hasReminderAt) return Math.min(dueAt, reminderAt);
	if (hasReminderAt) return reminderAt;
	if (hasDueAt) return dueAt;
	return undefined;
}

/** Roll a recurring memo's dueAt/reminderAt forward to the next occurrence. */
function advanceRecurrence(memo: MemoItem): void {
	const step = (iso: string | undefined): string | undefined => {
		if (!iso) return iso;
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) return iso;
		switch (memo.recurrence) {
			case "daily":
				date.setDate(date.getDate() + 1);
				break;
			case "weekly":
				date.setDate(date.getDate() + 7);
				break;
			case "monthly":
				date.setMonth(date.getMonth() + 1);
				break;
			default:
				return iso;
		}
		return date.toISOString();
	};
	memo.dueAt = step(memo.dueAt);
	memo.reminderAt = step(memo.reminderAt);
}

function coerceMemo(value: unknown): MemoItem | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string" || typeof raw.title !== "string") return undefined;
	const now = new Date().toISOString();
	return {
		id: raw.id,
		title: raw.title,
		notes: typeof raw.notes === "string" ? raw.notes : "",
		status: normalizeStatus(raw.status as MemoStatus),
		priority: normalizePriority(raw.priority as MemoPriority),
		dueAt: typeof raw.dueAt === "string" ? raw.dueAt : undefined,
		reminderAt: typeof raw.reminderAt === "string" ? raw.reminderAt : undefined,
		recurrence: normalizeRecurrence(raw.recurrence as MemoRecurrence),
		tags: normalizeTags(raw.tags as string[] | undefined),
		subtasks: normalizeSubtasks(raw.subtasks as MemoSubtask[] | undefined),
		pinned: raw.pinned === true,
		color: typeof raw.color === "string" ? raw.color : undefined,
		reminderState: ["none", "pending", "fired", "snoozed", "dismissed"].includes(raw.reminderState as string)
			? (raw.reminderState as MemoItem["reminderState"])
			: raw.reminderAt
				? "pending"
				: "none",
		reminderMissed: raw.reminderMissed === true ? true : undefined,
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
		completedAt: typeof raw.completedAt === "string" ? raw.completedAt : undefined,
		createdBy: raw.createdBy === "ai" ? "ai" : "user",
		sourceSessionId: typeof raw.sourceSessionId === "string" ? raw.sourceSessionId : undefined,
	};
}

function normalizeStatus(value: MemoStatus | undefined): MemoStatus {
	return value === "completed" || value === "archived" ? value : "active";
}

function normalizePriority(value: MemoPriority | undefined): MemoPriority {
	return value && VALID_PRIORITIES.includes(value) ? value : "none";
}

function normalizeRecurrence(value: MemoRecurrence | undefined): MemoRecurrence {
	return value && VALID_RECURRENCE.includes(value) ? value : "none";
}

function normalizeTags(value: string[] | undefined): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, MAX_TAGS);
}

function normalizeSubtasks(value: Array<{ title: string; done?: boolean }> | MemoSubtask[] | undefined): MemoSubtask[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => ({
			id: typeof (item as MemoSubtask).id === "string" ? (item as MemoSubtask).id : randomUUID(),
			title: String(item?.title ?? "").trim(),
			done: item?.done === true,
		}))
		.filter((item) => item.title.length > 0)
		.slice(0, MAX_SUBTASKS);
}

/** Parse a value as a date and return a canonical ISO string, or throw if invalid. */
function normalizeIso(value: string | undefined): string | undefined {
	if (value === undefined || value === null) return undefined;
	const trimmed = String(value).trim();
	if (!trimmed) return undefined;
	const date = new Date(trimmed);
	if (Number.isNaN(date.getTime())) {
		throw new Error(`Invalid date/time: "${value}". Pass an ISO 8601 timestamp.`);
	}
	return date.toISOString();
}

function cleanRequired(value: string, field: string, max: number): string {
	const cleaned = String(value ?? "").trim();
	if (!cleaned) throw new Error(`Memo ${field} is required.`);
	return cleaned.slice(0, max);
}

function clampText(value: string, max: number): string {
	return String(value ?? "")
		.replace(/\r\n/g, "\n")
		.slice(0, max);
}

function cleanOptional(value: string | undefined): string | undefined {
	const cleaned = value?.trim();
	return cleaned ? cleaned : undefined;
}

function startOfDay(date: Date): Date {
	const copy = new Date(date);
	copy.setHours(0, 0, 0, 0);
	return copy;
}

function endOfDay(date: Date): Date {
	const copy = new Date(date);
	copy.setHours(23, 59, 59, 999);
	return copy;
}
