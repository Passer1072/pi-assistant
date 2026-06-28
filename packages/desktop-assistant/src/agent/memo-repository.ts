import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	MemoAttachment,
	MemoAttachmentAddRequest,
	MemoAttachmentRemoveRequest,
	MemoAutoRunStatus,
	MemoBatchRequest,
	MemoBatchResult,
	MemoCreateRequest,
	MemoItem,
	MemoList,
	MemoListCreateRequest,
	MemoListDeleteRequest,
	MemoListReorderRequest,
	MemoListRequest,
	MemoListResponse,
	MemoListUpdateRequest,
	MemoPriority,
	MemoRecurrence,
	MemoReorderRequest,
	MemoSortKey,
	MemoStatsResult,
	MemoStatus,
	MemoSubtask,
	MemoSummary,
	MemoUpdateRequest,
} from "../shared/types.ts";

const STORE_FILENAME = "memos.json";
const SCHEMA_VERSION = 2;
const MAX_TITLE_LEN = 200;
const MAX_NOTES_LEN = 8000;
const MAX_AUTO_RUN_PROMPT_LEN = 4000;
const MAX_TAGS = 20;
const MAX_SUBTASKS = 50;
const MAX_LIST_NAME_LEN = 80;
const MAX_ATTACHMENT_NAME_LEN = 160;
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
	lists: MemoList[];
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
	private readonly attachmentsDir: string;
	private memos: MemoItem[];
	private lists: MemoList[];
	private loaded = false;

	constructor(memoDir: string, attachmentsDir?: string) {
		this.dir = resolve(memoDir);
		this.filePath = join(this.dir, STORE_FILENAME);
		this.attachmentsDir = resolve(attachmentsDir ?? join(this.dir, "memo-attachments"));
		this.memos = [];
		this.lists = [];
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
		if (request.listId !== undefined) {
			const listId = cleanOptional(request.listId);
			result = result.filter((memo) => (listId ? memo.listId === listId : !memo.listId));
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
		const autoRunAtReminder = reminderAt ? request.autoRunAtReminder === true : false;
		const listId = normalizeListId(request.listId);
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
			listId,
			order: normalizeOrder(request.order) ?? this.nextMemoOrder(listId),
			progress: normalizeProgress(request.progress),
			pinned: request.pinned === true,
			color: cleanOptional(request.color),
			attachments: [],
			reminderState: reminderAt ? "pending" : "none",
			autoRunAtReminder,
			autoRunPrompt: autoRunAtReminder
				? clampOptionalText(request.autoRunPrompt, MAX_AUTO_RUN_PROMPT_LEN)
				: undefined,
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
		const previousListId = memo.listId;
		let listChanged = false;
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
		if (request.listId !== undefined) {
			const nextListId = request.listId === null ? undefined : normalizeListId(request.listId);
			if (memo.listId !== nextListId) {
				memo.listId = nextListId;
				memo.order = normalizeOrder(request.order) ?? this.nextMemoOrder(nextListId);
				listChanged = true;
			}
		}
		if (request.order !== undefined) memo.order = request.order === null ? undefined : normalizeOrder(request.order);
		if (request.progress !== undefined) memo.progress = normalizeProgress(request.progress);
		if (request.pinned !== undefined) memo.pinned = request.pinned === true;
		if (request.color !== undefined) memo.color = request.color === null ? undefined : cleanOptional(request.color);
		if (request.autoRunAtReminder !== undefined) {
			memo.autoRunAtReminder = request.autoRunAtReminder === true;
			if (!memo.autoRunAtReminder) {
				memo.autoRunPrompt = undefined;
			}
		}
		if (request.autoRunPrompt !== undefined) {
			memo.autoRunPrompt =
				request.autoRunPrompt === null
					? undefined
					: clampOptionalText(request.autoRunPrompt, MAX_AUTO_RUN_PROMPT_LEN);
		}
		normalizeMemoAutoRun(memo);
		const now = new Date().toISOString();
		memo.updatedAt = now;
		if (listChanged) this.reindexMemoScope(previousListId, now);
		this.flush();
		return memo;
	}

	reorderMemo(request: MemoReorderRequest): MemoItem[] {
		this.ensureLoaded();
		const moving = this.requireMemo(request.id);
		const sourceListId = moving.listId;
		const targetListId = request.listId === undefined ? moving.listId : normalizeListId(request.listId ?? undefined);
		const beforeId = cleanOptional(request.beforeId ?? undefined);
		const afterId = cleanOptional(request.afterId ?? undefined);
		moving.listId = targetListId;
		const ordered = this.memos
			.filter((memo) => memo.listId === targetListId)
			.sort(compareMemoOrder)
			.filter((memo) => memo.id !== moving.id);
		let insertIndex = ordered.length;
		if (beforeId) {
			const beforeIndex = ordered.findIndex((memo) => memo.id === beforeId);
			if (beforeIndex >= 0) insertIndex = beforeIndex;
		} else if (afterId) {
			const afterIndex = ordered.findIndex((memo) => memo.id === afterId);
			if (afterIndex >= 0) insertIndex = afterIndex + 1;
		}
		ordered.splice(insertIndex, 0, moving);
		const now = new Date().toISOString();
		this.reindexMemoScope(targetListId, now, ordered);
		if (sourceListId !== targetListId) this.reindexMemoScope(sourceListId, now);
		moving.updatedAt = now;
		this.flush();
		return ordered;
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

	markAutoRunStarting(id: string, at: string = new Date().toISOString()): MemoItem | undefined {
		this.ensureLoaded();
		const memo = this.memos.find((value) => value.id === id);
		if (!memo) return undefined;
		memo.lastAutoRunAt = at;
		memo.lastAutoRunError = undefined;
		memo.lastAutoRunStatus = "running";
		memo.updatedAt = at;
		this.flush();
		return memo;
	}

	markAutoRunStarted(id: string, sessionId: string, at: string = new Date().toISOString()): MemoItem | undefined {
		this.ensureLoaded();
		const memo = this.memos.find((value) => value.id === id);
		if (!memo) return undefined;
		memo.lastAutoRunSessionId = sessionId;
		memo.lastAutoRunAt = at;
		memo.lastAutoRunError = undefined;
		memo.lastAutoRunStatus = "running";
		memo.updatedAt = at;
		this.flush();
		return memo;
	}

	markAutoRunSucceeded(id: string, at: string = new Date().toISOString()): MemoItem | undefined {
		this.ensureLoaded();
		const memo = this.memos.find((value) => value.id === id);
		if (!memo) return undefined;
		memo.lastAutoRunStatus = "succeeded";
		memo.lastAutoRunAt = at;
		memo.lastAutoRunError = undefined;
		memo.updatedAt = at;
		this.flush();
		return memo;
	}

	markAutoRunFailed(id: string, error: string, at: string = new Date().toISOString()): MemoItem | undefined {
		this.ensureLoaded();
		const memo = this.memos.find((value) => value.id === id);
		if (!memo) return undefined;
		memo.lastAutoRunError = clampText(error, 1000);
		memo.lastAutoRunAt = at;
		memo.lastAutoRunStatus = "failed";
		memo.updatedAt = at;
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
		normalizeMemoAutoRun(memo);
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
		rmSync(join(this.attachmentsDir, id), { recursive: true, force: true });
		this.flush();
		return true;
	}

	stats(now: Date = new Date()): MemoStatsResult {
		this.ensureLoaded();
		const startToday = startOfDay(now).getTime();
		const endToday = endOfDay(now).getTime();
		const startWeek = startOfWeek(now).getTime();
		const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
		const byPriority: Record<MemoPriority, number> = { none: 0, low: 0, medium: 0, high: 0 };
		let active = 0;
		let overdue = 0;
		let dueToday = 0;
		let completedThisWeek = 0;
		let completedThisMonth = 0;
		let snoozedCount = 0;
		let completionDaysTotal = 0;
		let completionDaysCount = 0;
		for (const memo of this.memos) {
			// Priority distribution reflects outstanding work only — completed/archived excluded.
			if (memo.status === "active") byPriority[memo.priority] += 1;
			if (memo.status === "active") active += 1;
			if (memo.reminderState === "snoozed") snoozedCount += 1;
			const attentionAt = getSummaryAttentionAt(memo);
			if (memo.status === "active" && attentionAt !== undefined) {
				if (attentionAt < startToday) overdue += 1;
				else if (attentionAt <= endToday) dueToday += 1;
			}
			if (memo.completedAt) {
				const completedAt = Date.parse(memo.completedAt);
				if (!Number.isNaN(completedAt)) {
					if (completedAt >= startWeek) completedThisWeek += 1;
					if (completedAt >= startMonth) completedThisMonth += 1;
					const createdAt = Date.parse(memo.createdAt);
					if (!Number.isNaN(createdAt) && completedAt >= createdAt) {
						completionDaysTotal += (completedAt - createdAt) / 86_400_000;
						completionDaysCount += 1;
					}
				}
			}
		}
		return {
			total: this.memos.length,
			active,
			overdue,
			dueToday,
			completedThisWeek,
			completedThisMonth,
			byPriority,
			snoozedCount,
			avgCompletionDays:
				completionDaysCount > 0 ? Math.round((completionDaysTotal / completionDaysCount) * 10) / 10 : undefined,
		};
	}

	batch(request: MemoBatchRequest): MemoBatchResult {
		this.ensureLoaded();
		const ids = Array.from(new Set(request.ids.map((id) => id.trim()).filter(Boolean)));
		const succeeded: string[] = [];
		const failed: string[] = [];
		const touchedListIds = new Set<string>();
		for (const id of ids) {
			try {
				const memo = this.requireMemo(id);
				switch (request.action) {
					case "complete":
						this.complete(id, true);
						break;
					case "delete":
						if (!this.delete(id)) throw new Error(`Memo not found: ${id}`);
						break;
					case "archive":
						memo.status = "archived";
						memo.updatedAt = new Date().toISOString();
						break;
					case "setTags":
						memo.tags = normalizeTags(request.tags);
						memo.updatedAt = new Date().toISOString();
						break;
					case "setPriority":
						memo.priority = normalizePriority(request.priority);
						memo.updatedAt = new Date().toISOString();
						break;
					case "setListId":
						{
							const previousListId = memo.listId;
							const nextListId = normalizeListId(request.listId);
							if (previousListId !== nextListId) {
								touchedListIds.add(previousListId ?? "");
								touchedListIds.add(nextListId ?? "");
								memo.listId = nextListId;
								memo.order = this.nextMemoOrder(nextListId);
							}
						}
						memo.updatedAt = new Date().toISOString();
						break;
				}
				succeeded.push(id);
			} catch {
				failed.push(id);
			}
		}
		if (touchedListIds.size > 0) {
			const now = new Date().toISOString();
			for (const listId of touchedListIds) {
				this.reindexMemoScope(listId || undefined, now);
			}
		}
		this.flush();
		return { succeeded, failed };
	}

	listLists(): MemoList[] {
		this.ensureLoaded();
		return [...this.lists].sort(compareListOrder);
	}

	createList(request: MemoListCreateRequest): MemoList {
		this.ensureLoaded();
		const now = new Date().toISOString();
		const nextOrder = this.lists.reduce((max, item) => Math.max(max, item.order ?? -1), -1) + 1;
		const list: MemoList = {
			id: randomUUID(),
			name: cleanRequired(request.name, "list name", MAX_LIST_NAME_LEN),
			color: cleanOptional(request.color),
			icon: cleanOptional(request.icon),
			order: nextOrder,
			createdAt: now,
			updatedAt: now,
		};
		this.lists.push(list);
		this.flush();
		return list;
	}

	/** Move a list one slot up or down in the manual display order. */
	reorderList(request: MemoListReorderRequest): MemoList {
		this.ensureLoaded();
		const ordered = [...this.lists].sort(compareListOrder);
		const index = ordered.findIndex((list) => list.id === request.id);
		if (index < 0) throw new Error(`Memo list not found: ${request.id}`);
		const target = request.direction === "up" ? index - 1 : index + 1;
		if (target < 0 || target >= ordered.length) return ordered[index];
		[ordered[index], ordered[target]] = [ordered[target], ordered[index]];
		const now = new Date().toISOString();
		ordered.forEach((list, position) => {
			if (list.order !== position) {
				list.order = position;
				list.updatedAt = now;
			}
		});
		this.flush();
		return ordered[target];
	}

	updateList(request: MemoListUpdateRequest): MemoList {
		this.ensureLoaded();
		const list = this.requireList(request.id);
		if (request.name !== undefined) list.name = cleanRequired(request.name, "list name", MAX_LIST_NAME_LEN);
		if (request.color !== undefined) list.color = request.color === null ? undefined : cleanOptional(request.color);
		if (request.icon !== undefined) list.icon = request.icon === null ? undefined : cleanOptional(request.icon);
		list.updatedAt = new Date().toISOString();
		this.flush();
		return list;
	}

	deleteList(request: MemoListDeleteRequest): boolean {
		this.ensureLoaded();
		const index = this.lists.findIndex((list) => list.id === request.id);
		if (index < 0) return false;
		this.lists.splice(index, 1);
		for (const memo of this.memos) {
			if (memo.listId === request.id) {
				memo.listId = undefined;
				memo.updatedAt = new Date().toISOString();
			}
		}
		this.flush();
		return true;
	}

	addAttachment(request: MemoAttachmentAddRequest): MemoAttachment {
		this.ensureLoaded();
		if (request.url) return this.addUrlAttachment(request.memoId, request.name, request.url);
		const sourcePath = request.filePath?.trim();
		if (!sourcePath) throw new Error("Attachment filePath or url is required.");
		const memo = this.requireMemo(request.memoId);
		const source = resolve(sourcePath);
		if (!existsSync(source)) throw new Error(`Attachment file not found: ${sourcePath}`);
		const attachmentId = randomUUID();
		const name = safeFileName(cleanOptional(request.name) ?? basename(source)).slice(0, MAX_ATTACHMENT_NAME_LEN);
		const targetDir = join(this.attachmentsDir, memo.id, attachmentId);
		const targetPath = join(targetDir, name);
		mkdirSync(targetDir, { recursive: true });
		copyFileSync(source, targetPath);
		const attachment: MemoAttachment = {
			id: attachmentId,
			type: request.type === "image" ? "image" : "file",
			name,
			href: pathToFileURL(targetPath).toString(),
			size: statSync(targetPath).size,
			addedAt: new Date().toISOString(),
		};
		memo.attachments = [...(memo.attachments ?? []), attachment];
		memo.updatedAt = new Date().toISOString();
		this.flush();
		return attachment;
	}

	removeAttachment(request: MemoAttachmentRemoveRequest): boolean {
		this.ensureLoaded();
		const memo = this.requireMemo(request.memoId);
		const attachments = memo.attachments ?? [];
		const index = attachments.findIndex((attachment) => attachment.id === request.attachmentId);
		if (index < 0) return false;
		const [attachment] = attachments.splice(index, 1);
		if (attachment.type !== "url") {
			rmSync(join(this.attachmentsDir, memo.id, attachment.id), { recursive: true, force: true });
		}
		memo.attachments = attachments;
		memo.updatedAt = new Date().toISOString();
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

	private requireList(id: string): MemoList {
		const list = this.lists.find((value) => value.id === id);
		if (!list) throw new Error(`Memo list not found: ${id}`);
		return list;
	}

	private addUrlAttachment(memoId: string, name: string | undefined, url: string): MemoAttachment {
		const memo = this.requireMemo(memoId);
		const href = normalizeUrl(url);
		const attachment: MemoAttachment = {
			id: randomUUID(),
			type: "url",
			name: (cleanOptional(name) ?? href).slice(0, MAX_ATTACHMENT_NAME_LEN),
			href,
			addedAt: new Date().toISOString(),
		};
		memo.attachments = [...(memo.attachments ?? []), attachment];
		memo.updatedAt = new Date().toISOString();
		this.flush();
		return attachment;
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
			this.memos = Array.isArray(parsed.memos)
				? parsed.memos.map(coerceMemo).filter((memo): memo is MemoItem => memo !== undefined)
				: [];
			this.lists = Array.isArray(parsed.lists)
				? parsed.lists.map(coerceList).filter((list): list is MemoList => list !== undefined)
				: [];
			// Backfill manual order for legacy lists (saved before ordering existed),
			// preserving their former alphabetical display so nothing jumps around.
			if (this.lists.some((list) => list.order === undefined)) {
				[...this.lists].sort(compareListOrder).forEach((list, index) => {
					list.order = index;
				});
			}
			if (this.memos.some((memo) => memo.order === undefined)) {
				this.backfillMemoOrder();
			}
		} catch {
			this.memos = [];
			this.lists = [];
		}
	}

	private flush(): void {
		mkdirSync(this.dir, { recursive: true });
		const payload: MemoStoreFile = { schemaVersion: SCHEMA_VERSION, memos: this.memos, lists: this.lists };
		const tmp = `${this.filePath}.${randomUUID().slice(0, 8)}.tmp`;
		writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
		renameSync(tmp, this.filePath);
	}

	private nextMemoOrder(listId: string | undefined): number {
		return (
			this.memos
				.filter((memo) => memo.listId === listId)
				.reduce((max, memo) => Math.max(max, memo.order ?? -1), -1) + 1
		);
	}

	private reindexMemoScope(listId: string | undefined, now: string, ordered?: MemoItem[]): void {
		const scoped = ordered ?? this.memos.filter((memo) => memo.listId === listId).sort(compareMemoOrder);
		scoped.forEach((memo, index) => {
			if (memo.order !== index) {
				memo.order = index;
				memo.updatedAt = now;
			}
		});
	}

	private backfillMemoOrder(): void {
		const groups = new Map<string, MemoItem[]>();
		for (const memo of this.memos) {
			const key = memo.listId ?? "";
			groups.set(key, [...(groups.get(key) ?? []), memo]);
		}
		for (const group of groups.values()) {
			group.forEach((memo, index) => {
				memo.order = index;
			});
		}
		this.flush();
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
		manual: (l, r) => pinnedFirst(l, r) || compareMemoOrder(l, r) || byUpdated(l, r),
		reminderAt: (l, r) => pinnedFirst(l, r) || byReminder(l, r) || byDue(l, r) || byUpdated(l, r),
	};
	return [...memos].sort(comparators[sort]);
}

function compareMemoOrder(left: MemoItem, right: MemoItem): number {
	const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER;
	const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER;
	if (leftOrder !== rightOrder) return leftOrder - rightOrder;
	return left.createdAt.localeCompare(right.createdAt) || right.updatedAt.localeCompare(left.updatedAt);
}

function byReminder(left: MemoItem, right: MemoItem): number {
	const l = left.reminderAt ? Date.parse(left.reminderAt) : Number.POSITIVE_INFINITY;
	const r = right.reminderAt ? Date.parse(right.reminderAt) : Number.POSITIVE_INFINITY;
	return l - r;
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
	const memo: MemoItem = {
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
		listId: typeof raw.listId === "string" && raw.listId.trim() ? raw.listId.trim() : undefined,
		order: normalizeOrder(typeof raw.order === "number" ? raw.order : undefined),
		progress: normalizeProgress(typeof raw.progress === "number" ? raw.progress : undefined),
		attachments: normalizeAttachments(raw.attachments),
		pinned: raw.pinned === true,
		color: typeof raw.color === "string" ? raw.color : undefined,
		autoRunAtReminder: raw.autoRunAtReminder === true,
		autoRunPrompt:
			typeof raw.autoRunPrompt === "string"
				? clampOptionalText(raw.autoRunPrompt, MAX_AUTO_RUN_PROMPT_LEN)
				: undefined,
		lastAutoRunSessionId: typeof raw.lastAutoRunSessionId === "string" ? raw.lastAutoRunSessionId : undefined,
		lastAutoRunAt: typeof raw.lastAutoRunAt === "string" ? raw.lastAutoRunAt : undefined,
		lastAutoRunError: typeof raw.lastAutoRunError === "string" ? raw.lastAutoRunError : undefined,
		lastAutoRunStatus: normalizeAutoRunStatus(raw.lastAutoRunStatus as MemoAutoRunStatus | undefined),
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
	normalizeMemoAutoRun(memo);
	return memo;
}

function coerceList(value: unknown): MemoList | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string" || typeof raw.name !== "string") return undefined;
	const now = new Date().toISOString();
	return {
		id: raw.id,
		name: raw.name.slice(0, MAX_LIST_NAME_LEN),
		color: typeof raw.color === "string" && raw.color.trim() ? raw.color.trim() : undefined,
		icon: typeof raw.icon === "string" && raw.icon.trim() ? raw.icon.trim() : undefined,
		order: typeof raw.order === "number" && Number.isFinite(raw.order) ? raw.order : undefined,
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
	};
}

/** Display order: explicit `order` ascending, falling back to name for ties / legacy. */
function compareListOrder(left: MemoList, right: MemoList): number {
	const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER;
	const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER;
	if (leftOrder !== rightOrder) return leftOrder - rightOrder;
	return left.name.localeCompare(right.name);
}

function normalizeAttachments(value: unknown): MemoAttachment[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item): MemoAttachment | undefined => {
			if (!item || typeof item !== "object") return undefined;
			const raw = item as Record<string, unknown>;
			if (typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.href !== "string")
				return undefined;
			const type = raw.type === "image" || raw.type === "url" ? raw.type : "file";
			return {
				id: raw.id,
				type,
				name: raw.name.slice(0, MAX_ATTACHMENT_NAME_LEN),
				href: raw.href,
				size: typeof raw.size === "number" && Number.isFinite(raw.size) ? raw.size : undefined,
				addedAt: typeof raw.addedAt === "string" ? raw.addedAt : new Date().toISOString(),
			};
		})
		.filter((item): item is MemoAttachment => item !== undefined);
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

function normalizeListId(value: string | undefined): string | undefined {
	return cleanOptional(value);
}

function normalizeProgress(value: number | undefined | null): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Number.isFinite(value)) return undefined;
	return Math.min(100, Math.max(0, Math.round(value)));
}

function normalizeOrder(value: number | undefined | null): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Number.isFinite(value)) return undefined;
	return Math.max(0, Math.round(value));
}

function normalizeAutoRunStatus(value: MemoAutoRunStatus | undefined): MemoAutoRunStatus | undefined {
	return value === "running" || value === "succeeded" || value === "failed" ? value : undefined;
}

function normalizeMemoAutoRun(memo: MemoItem): void {
	if (!memo.reminderAt || !memo.autoRunAtReminder) {
		memo.autoRunAtReminder = false;
		memo.autoRunPrompt = undefined;
	}
}

function normalizeUrl(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error("Attachment URL is required.");
	const parsed = new URL(trimmed);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "file:") {
		throw new Error("Attachment URL must use http, https, or file.");
	}
	return parsed.toString();
}

function safeFileName(value: string): string {
	return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "attachment";
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

function clampOptionalText(value: string | undefined, max: number): string | undefined {
	const cleaned = clampText(value ?? "", max).trim();
	return cleaned ? cleaned : undefined;
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

function startOfWeek(date: Date): Date {
	const copy = startOfDay(date);
	const day = copy.getDay();
	const diff = day === 0 ? 6 : day - 1;
	copy.setDate(copy.getDate() - diff);
	return copy;
}
