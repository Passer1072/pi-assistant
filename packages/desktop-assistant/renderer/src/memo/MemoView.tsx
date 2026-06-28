import {
	Archive,
	ArrowLeft,
	BellRing,
	Bot,
	CalendarDays,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	Copy,
	File,
	FileImage,
	FilePenLine,
	Folder,
	GripVertical,
	Link,
	ListTodo,
	MoreVertical,
	Paperclip,
	Pin,
	PinOff,
	Plus,
	Trash2,
	X,
} from "lucide-react";
import type { CSSProperties, DragEvent, MouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
	DesktopAssistantSnapshot,
	MemoAttachment,
	MemoItem,
	MemoList,
	MemoPriority,
	MemoRecurrence,
	MemoReorderRequest,
	MemoSortKey,
	MemoStatsResult,
	MemoSubtask,
	WakeWordModelMetadata,
	WindowMode,
} from "../../../src/shared/types.ts";
import { renderAssistantMarkdown } from "../markdown.ts";
import { TitleBar } from "../components/TitleBar.tsx";
import {
	applyFilter,
	buildMemoDocumentText,
	computeProgress,
	type MemoFilter,
	FILTER_LABEL,
	formatDueLabel,
	groupMemos,
	isOnCalendarDay,
	isOverdue,
	isoToLocalInput,
	localInputToIso,
	PRIORITY_LABEL,
	RECURRENCE_LABEL,
	snoozePresets,
	sortForDisplay,
	SORT_LABEL,
} from "./memo-view-model.ts";

const FILTERS: MemoFilter[] = ["all", "today", "upcoming", "overdue", "completed"];
const SORTS: MemoSortKey[] = ["due", "priority", "reminderAt", "created", "manual"];
const PRIORITIES: MemoPriority[] = ["none", "low", "medium", "high"];
const RECURRENCES: MemoRecurrence[] = ["none", "daily", "weekly", "monthly"];
const COLOR_SWATCHES = ["", "#6aa9ff", "#4ade80", "#f5b96f", "#ff7676", "#c39bff"] as const;

interface MemoViewProps {
	snapshot: DesktopAssistantSnapshot;
	onBack: () => void;
	onMenu: () => void;
	wakeModels: WakeWordModelMetadata[];
	windowMode: WindowMode;
	onToggleWindowMode: () => void;
	onOpenSession?: (sessionId: string) => void;
}

interface MemoDraft {
	title: string;
	notes: string;
	priority: MemoPriority;
	dueAt?: string;
	reminderAt?: string;
	recurrence: MemoRecurrence;
	tags: string[];
	subtasks: MemoSubtask[];
	listId?: string;
	progress?: number;
	pinned?: boolean;
	color?: string;
	autoRunAtReminder?: boolean;
	autoRunPrompt?: string;
}

type ModalState =
	| {
			mode: "new";
	  }
	| {
			mode: "edit";
			memo: MemoItem;
	  };

type ViewMode = "list" | "calendar";

const EMPTY_STATS: MemoStatsResult = {
	total: 0,
	active: 0,
	overdue: 0,
	dueToday: 0,
	completedThisWeek: 0,
	completedThisMonth: 0,
	byPriority: { none: 0, low: 0, medium: 0, high: 0 },
	snoozedCount: 0,
};

export function MemoView({
	snapshot,
	onBack,
	onMenu,
	wakeModels,
	windowMode,
	onToggleWindowMode,
	onOpenSession,
}: MemoViewProps) {
	const [memos, setMemos] = useState<MemoItem[]>([]);
	const [lists, setLists] = useState<MemoList[]>([]);
	const [stats, setStats] = useState<MemoStatsResult>(EMPTY_STATS);
	const [filter, setFilter] = useState<MemoFilter>("all");
	const [sort, setSort] = useState<MemoSortKey>("due");
	const [query, setQuery] = useState("");
	const [quickAdd, setQuickAdd] = useState("");
	const [modal, setModal] = useState<ModalState | null>(null);
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selectedListId, setSelectedListId] = useState<string | undefined>(undefined);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [viewMode, setViewMode] = useState<ViewMode>("list");
	const [dayFilter, setDayFilter] = useState<string | null>(null);
	const [draggingMemoId, setDraggingMemoId] = useState<string | null>(null);
	const [documentMemoId, setDocumentMemoId] = useState<string | null>(null);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

	const listById = useMemo(() => new Map(lists.map((list) => [list.id, list])), [lists]);

	const refresh = async () => {
		if (!window.desktopAssistant) return;
		const [memoResult, listResult, statResult] = await Promise.all([
			window.desktopAssistant.listMemos({}),
			window.desktopAssistant.listMemoLists(),
			window.desktopAssistant.getMemoStats(),
		]);
		setMemos(memoResult.memos);
		setLists(listResult);
		setStats(statResult);
	};

	useEffect(() => {
		if (!window.desktopAssistant) return undefined;
		let cancelled = false;

		const load = async () => {
			setLoading(true);
			try {
				await refresh();
				if (!cancelled) setError(null);
			} catch (loadError) {
				if (!cancelled) setError(describeError(loadError));
			} finally {
				if (!cancelled) setLoading(false);
			}
		};

		void load();
		const unsubscribe = window.desktopAssistant.onEvent((event) => {
			if (event.type === "memo_changed" || event.type === "memo_reminder") {
				void load();
			}
		});

		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);

	const visibleMemos = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		let result = memos;
		if (selectedListId !== undefined) {
			result = result.filter((memo) => (selectedListId ? memo.listId === selectedListId : !memo.listId));
		}
		if (dayFilter) {
			const day = new Date(`${dayFilter}T00:00:00`);
			result = result.filter((memo) => isOnCalendarDay(memo, day));
		}
		if (normalized) {
			result = result.filter((memo) => {
				const listName = memo.listId ? listById.get(memo.listId)?.name ?? "" : "";
				const attachmentText = (memo.attachments ?? []).map((attachment) => attachment.name).join(" ");
				const haystack = [memo.title, memo.notes, memo.tags.join(" "), listName, attachmentText]
					.join(" ")
					.toLowerCase();
				return haystack.includes(normalized);
			});
		}
		return sortForDisplay(applyFilter(result, filter), sort);
	}, [dayFilter, filter, listById, memos, query, selectedListId, sort]);

	const groups = useMemo(() => groupMemos(visibleMemos), [visibleMemos]);
	const selectedCount = selectedIds.size;
	const currentList = selectedListId ? listById.get(selectedListId) : undefined;
	const activeModalMemo = modal?.mode === "edit" ? (memos.find((memo) => memo.id === modal.memo.id) ?? modal.memo) : undefined;
	const documentMemo = documentMemoId ? memos.find((memo) => memo.id === documentMemoId) : undefined;
	const documentList = documentMemo?.listId ? listById.get(documentMemo.listId) : undefined;

	const runAction = async (action: () => Promise<unknown>) => {
		setBusy(true);
		setError(null);
		try {
			await action();
			await refresh();
		} catch (actionError) {
			setError(describeError(actionError));
		} finally {
			setBusy(false);
		}
	};

	const clearSelection = () => setSelectedIds(new Set());

	const changeScope = (nextListId: string | undefined) => {
		setSelectedListId(nextListId);
		setDayFilter(null);
		clearSelection();
	};

	const changeFilter = (nextFilter: MemoFilter) => {
		setFilter(nextFilter);
		clearSelection();
	};

	const saveQuickAdd = async () => {
		const title = quickAdd.trim();
		if (!title || !window.desktopAssistant) return;
		setQuickAdd("");
		await runAction(() =>
			window.desktopAssistant.createMemo({
				title,
				listId: selectedListId || undefined,
				createdBy: "user",
			}),
		);
	};

	const saveDraft = async (draft: MemoDraft, existingId?: string) => {
		if (!window.desktopAssistant) return;
		await runAction(() => {
			if (existingId) {
				return window.desktopAssistant.updateMemo({
					id: existingId,
					title: draft.title,
					notes: draft.notes,
					priority: draft.priority,
					dueAt: draft.dueAt ?? null,
					reminderAt: draft.reminderAt ?? null,
					recurrence: draft.recurrence,
					tags: draft.tags,
					subtasks: draft.subtasks,
					listId: draft.listId ?? null,
					progress: draft.progress ?? null,
					pinned: draft.pinned,
					color: draft.color ?? null,
					autoRunAtReminder: draft.autoRunAtReminder,
					autoRunPrompt: draft.autoRunPrompt ?? null,
				});
			}
			return window.desktopAssistant.createMemo({
				...draft,
				createdBy: "user",
			});
		});
		setModal(null);
	};

	const batch = async (action: "complete" | "delete" | "archive" | "setPriority" | "setListId", extra = {}) => {
		if (!window.desktopAssistant || selectedIds.size === 0) return;
		if (action === "delete" && !window.confirm(`删除选中的 ${selectedIds.size} 条备忘？`)) return;
		const ids = Array.from(selectedIds);
		await runAction(async () => {
			await window.desktopAssistant.batchMemos({ ids, action, ...extra });
		});
		clearSelection();
	};

	const toggleSelected = (id: string) => {
		setSelectedIds((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const selectVisible = () => setSelectedIds(new Set(visibleMemos.map((memo) => memo.id)));

	const reorderMemo = async (sourceId: string, target: MemoItem, position: "before" | "after") => {
		const targetId = target.id;
		if (!window.desktopAssistant || sourceId === targetId) return;
		const source = memos.find((memo) => memo.id === sourceId);
		if (selectedListId === undefined && source?.listId !== target.listId) return;
		setSort("manual");
		const request: MemoReorderRequest =
			position === "before"
				? { id: sourceId, beforeId: targetId }
				: { id: sourceId, afterId: targetId };
		if (selectedListId !== undefined) {
			request.listId = selectedListId === "" ? null : selectedListId;
		}
		await runAction(() => window.desktopAssistant.reorderMemo(request));
	};

	const openDocument = (memo: MemoItem) => {
		setDocumentMemoId(memo.id);
		setCopyState("idle");
	};

	const closeDocument = () => {
		setDocumentMemoId(null);
		setCopyState("idle");
	};

	const copyDocument = async (memo: MemoItem, list?: MemoList) => {
		try {
			await copyTextToClipboard(buildMemoDocumentText(memo, list));
			setCopyState("copied");
			window.setTimeout(() => {
				setCopyState((current) => (current === "copied" ? "idle" : current));
			}, 1400);
		} catch (copyError) {
			setCopyState("failed");
			setError(describeError(copyError));
		}
	};

	return (
		<div className="memo-screen">
			<TitleBar
				onMenu={onMenu}
				title="备忘录"
				webSearchMode={snapshot.settings.webSearch?.mode}
				voiceOverlay={snapshot.voiceOverlay}
				voiceSettings={snapshot.settings.voice}
				wakeModels={wakeModels}
				windowMode={windowMode}
				onToggleWindowMode={onToggleWindowMode}
			/>

			<div className="memo-layout">
				<MemoSidebar
					lists={lists}
					memos={memos}
					selectedListId={selectedListId}
					busy={busy}
					onSelect={changeScope}
					onCreate={(name) => runAction(() => window.desktopAssistant.createMemoList({ name }))}
					onRename={(id, name) => runAction(() => window.desktopAssistant.updateMemoList({ id, name }))}
					onDelete={(id) => runAction(() => window.desktopAssistant.deleteMemoList({ id }))}
					onReorder={(id, direction) => runAction(() => window.desktopAssistant.reorderMemoList({ id, direction }))}
				/>

				<main className="memo-main">
					<header className="memo-head">
						<button className="title-btn" type="button" onClick={onBack} aria-label="返回">
							<ArrowLeft size={16} />
						</button>
						<div className="memo-head-title">
							<span className="memo-head-name">{currentList?.name ?? "备忘录"}</span>
							<span className="memo-head-sub">
								{stats.overdue > 0 ? <span className="memo-chip danger">逾期 {stats.overdue}</span> : null}
								{stats.dueToday > 0 ? <span className="memo-chip warn">今天 {stats.dueToday}</span> : null}
								{dayFilter ? (
									<button type="button" className="memo-day-filter-pill" onClick={() => setDayFilter(null)}>
										{dayFilter}
										<X size={12} />
									</button>
								) : null}
							</span>
						</div>
						<div className="memo-view-tabs" role="tablist" aria-label="备忘录视图">
							<button
								type="button"
								role="tab"
								aria-selected={viewMode === "list"}
								className={`memo-view-tab ${viewMode === "list" ? "active" : ""}`}
								onClick={() => setViewMode("list")}
								title="列表视图"
							>
								<ListTodo size={15} />
							</button>
							<button
								type="button"
								role="tab"
								aria-selected={viewMode === "calendar"}
								className={`memo-view-tab ${viewMode === "calendar" ? "active" : ""}`}
								onClick={() => setViewMode("calendar")}
								title="日历视图"
							>
								<CalendarDays size={15} />
							</button>
						</div>
						<button className="memo-new-btn" type="button" onClick={() => setModal({ mode: "new" })}>
							<Plus size={15} />
							<span>新建</span>
						</button>
					</header>

					{documentMemo ? null : <MemoStatsBar stats={stats} />}

					{documentMemo ? null : (
						<div className="memo-toolbar">
							<div className="memo-quickadd">
								<input
									value={quickAdd}
									placeholder="快速添加备忘…"
									onChange={(event) => setQuickAdd(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") void saveQuickAdd();
									}}
								/>
								<button type="button" onClick={() => void saveQuickAdd()} disabled={!quickAdd.trim()} aria-label="添加备忘">
									<Plus size={16} />
								</button>
							</div>
							<input
								className="memo-search"
								value={query}
								placeholder="搜索"
								onChange={(event) => {
									setQuery(event.target.value);
									clearSelection();
								}}
							/>
							<select className="memo-sort" value={sort} onChange={(event) => setSort(event.target.value as MemoSortKey)}>
								{SORTS.map((option) => (
									<option key={option} value={option}>
										{SORT_LABEL[option]}
									</option>
								))}
							</select>
						</div>
					)}

					{documentMemo ? null : (
						<div className="memo-filters">
							{FILTERS.map((option) => (
								<button
									key={option}
									type="button"
									className={`memo-filter ${filter === option ? "active" : ""}`}
									aria-pressed={filter === option}
									onClick={() => changeFilter(option)}
								>
									{FILTER_LABEL[option]}
								</button>
							))}
						</div>
					)}

					{error ? <div className="memo-error">{error}</div> : null}

					{!documentMemo && selectedCount > 0 ? (
						<BatchBar
							count={selectedCount}
							lists={lists}
							busy={busy}
							onComplete={() => void batch("complete")}
							onArchive={() => void batch("archive")}
							onDelete={() => void batch("delete")}
							onSelectAll={selectVisible}
							onClear={clearSelection}
							onSetPriority={(priority) => void batch("setPriority", { priority })}
							onSetList={(listId) => void batch("setListId", { listId })}
						/>
					) : null}

					{documentMemo ? (
						<MemoDocumentView
							memo={documentMemo}
							list={documentList}
							copyState={copyState}
							onBack={closeDocument}
							onCopy={() => void copyDocument(documentMemo, documentList)}
							onEdit={() => setModal({ mode: "edit", memo: documentMemo })}
							onToggleComplete={() =>
								void runAction(() =>
									window.desktopAssistant.completeMemo({
										id: documentMemo.id,
										completed: documentMemo.status !== "completed",
									}),
								)
							}
							onTogglePin={() =>
								void runAction(() =>
									window.desktopAssistant.updateMemo({
										id: documentMemo.id,
										pinned: !documentMemo.pinned,
									}),
								)
							}
							onDelete={() => {
								if (!window.confirm(`删除备忘「${documentMemo.title}」？`)) return;
								void runAction(() => window.desktopAssistant.deleteMemo({ id: documentMemo.id })).then(closeDocument);
							}}
							onOpenSession={onOpenSession}
						/>
					) : viewMode === "calendar" ? (
						<MemoCalendarView
							memos={visibleMemos}
							selectedDay={dayFilter}
							onSelectDay={(day) => {
								setDayFilter(dayFilter === day ? null : day);
								setViewMode("list");
								clearSelection();
							}}
						/>
					) : (
						<div className="memo-list">
							{loading ? (
								<div className="memo-empty">
									<ListTodo size={36} />
									<p>加载中…</p>
								</div>
							) : groups.length === 0 ? (
								<div className="memo-empty">
									<ListTodo size={36} />
									<p>{memos.length === 0 ? "还没有备忘录" : "此视图下没有备忘录"}</p>
									{memos.length > 0 ? (
										<button type="button" className="memo-btn ghost" onClick={() => setDayFilter(null)}>
											清除筛选
										</button>
									) : null}
								</div>
							) : (
								groups.map((group) => (
									<section key={group.key} className="memo-group">
										<div className={`memo-group-label ${group.key}`}>
											{group.label}
											<span className="memo-group-count">{group.memos.length}</span>
										</div>
										{group.memos.map((memo) => (
											<MemoCard
												key={memo.id}
												memo={memo}
												list={memo.listId ? listById.get(memo.listId) : undefined}
												selected={selectedIds.has(memo.id)}
												dragging={draggingMemoId === memo.id}
												busy={busy}
												onSelect={() => toggleSelected(memo.id)}
												onOpen={() => openDocument(memo)}
												onDragStart={() => setDraggingMemoId(memo.id)}
												onDragEnd={() => setDraggingMemoId(null)}
												onDropMemo={(sourceId, position) => void reorderMemo(sourceId, memo, position)}
												onToggleComplete={() =>
													void runAction(() =>
														window.desktopAssistant.completeMemo({
															id: memo.id,
															completed: memo.status !== "completed",
														}),
													)
												}
												onTogglePin={() =>
													void runAction(() =>
														window.desktopAssistant.updateMemo({
															id: memo.id,
															pinned: !memo.pinned,
														}),
													)
												}
												onEdit={() => setModal({ mode: "edit", memo })}
												onDelete={() =>
													void runAction(() =>
														window.desktopAssistant.deleteMemo({
															id: memo.id,
														}),
													)
												}
												onSnooze={(until) =>
													void runAction(() =>
														window.desktopAssistant.snoozeMemo({
															id: memo.id,
															until,
														}),
													)
												}
												onOpenSession={onOpenSession}
											/>
										))}
									</section>
								))
							)}
						</div>
					)}
				</main>
			</div>

			{modal ? (
				<MemoModal
					initial={activeModalMemo}
					lists={lists}
					defaultListId={selectedListId}
					onCancel={() => setModal(null)}
					onSave={(draft) => void saveDraft(draft, modal.mode === "edit" ? modal.memo.id : undefined)}
					onRunAutoNow={async (id) => {
						await window.desktopAssistant.runMemoAutoTaskNow({ id });
						await refresh();
					}}
					onOpenSession={onOpenSession}
					onAttachmentChanged={() => void refresh()}
				/>
			) : null}
		</div>
	);
}

function MemoStatsBar({ stats }: { stats: MemoStatsResult }) {
	const denominator = stats.active + stats.completedThisWeek;
	const weeklyRate = denominator > 0 ? Math.round((stats.completedThisWeek / denominator) * 100) : 0;
	const maxPriority = Math.max(1, ...PRIORITIES.map((priority) => stats.byPriority[priority]));
	return (
		<div className="memo-stats-bar" aria-live="polite">
			<div className="memo-stat-card danger">
				<span>逾期</span>
				<strong>{stats.overdue}</strong>
			</div>
			<div className="memo-stat-card warn">
				<span>今天</span>
				<strong>{stats.dueToday}</strong>
			</div>
			<div className="memo-stat-card">
				<span>本周完成</span>
				<strong>{weeklyRate}%</strong>
			</div>
			<div className="memo-stat-chart" aria-label="优先级分布">
				{PRIORITIES.map((priority) => (
					<span key={priority} title={`${PRIORITY_LABEL[priority]} ${stats.byPriority[priority]}`}>
						<i style={{ height: `${Math.max(10, (stats.byPriority[priority] / maxPriority) * 100)}%` }} />
					</span>
				))}
			</div>
		</div>
	);
}

interface ListMenuState {
	listId: string;
	x: number;
	y: number;
	canMoveUp: boolean;
	canMoveDown: boolean;
}

function MemoSidebar({
	lists,
	memos,
	selectedListId,
	busy,
	onSelect,
	onCreate,
	onRename,
	onDelete,
	onReorder,
}: {
	lists: MemoList[];
	memos: MemoItem[];
	selectedListId: string | undefined;
	busy: boolean;
	onSelect: (listId: string | undefined) => void;
	onCreate: (name: string) => Promise<unknown>;
	onRename: (id: string, name: string) => Promise<unknown>;
	onDelete: (id: string) => Promise<unknown>;
	onReorder: (id: string, direction: "up" | "down") => Promise<unknown>;
}) {
	const [creating, setCreating] = useState(false);
	const [draftName, setDraftName] = useState("");
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editName, setEditName] = useState("");
	const [menu, setMenu] = useState<ListMenuState | null>(null);

	const openMenu = (event: MouseEvent, list: MemoList, index: number) => {
		event.preventDefault();
		setMenu({
			listId: list.id,
			x: event.clientX,
			y: event.clientY,
			canMoveUp: index > 0,
			canMoveDown: index < lists.length - 1,
		});
	};

	useEffect(() => {
		if (!menu) return undefined;
		const close = () => setMenu(null);
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMenu(null);
		};
		// Defer so the right-click that opened the menu doesn't immediately close it.
		const id = window.setTimeout(() => {
			window.addEventListener("click", close);
			window.addEventListener("contextmenu", close);
			window.addEventListener("resize", close);
			window.addEventListener("blur", close);
		}, 0);
		window.addEventListener("keydown", onKey);
		return () => {
			window.clearTimeout(id);
			window.removeEventListener("click", close);
			window.removeEventListener("contextmenu", close);
			window.removeEventListener("resize", close);
			window.removeEventListener("blur", close);
			window.removeEventListener("keydown", onKey);
		};
	}, [menu]);

	const menuList = menu ? lists.find((list) => list.id === menu.listId) : undefined;
	const startRename = (list: MemoList) => {
		setEditingId(list.id);
		setEditName(list.name);
	};
	const counts = useMemo(() => {
		const map = new Map<string, number>();
		let unassigned = 0;
		for (const memo of memos) {
			if (memo.status === "completed") continue;
			if (memo.listId) map.set(memo.listId, (map.get(memo.listId) ?? 0) + 1);
			else unassigned += 1;
		}
		return { map, unassigned };
	}, [memos]);

	const saveNew = async () => {
		const name = draftName.trim();
		if (!name) return;
		await onCreate(name);
		setDraftName("");
		setCreating(false);
	};

	return (
		<aside className="memo-sidebar">
			<div className="memo-list-nav">
				<button
					type="button"
					className={`memo-list-item ${selectedListId === undefined ? "active" : ""}`}
					aria-current={selectedListId === undefined ? "page" : undefined}
					onClick={() => onSelect(undefined)}
				>
					<ListTodo size={14} />
					<span>全部</span>
					<em>{memos.filter((memo) => memo.status !== "completed").length}</em>
				</button>
				<button
					type="button"
					className={`memo-list-item ${selectedListId === "" ? "active" : ""}`}
					aria-current={selectedListId === "" ? "page" : undefined}
					onClick={() => onSelect("")}
				>
					<Folder size={14} />
					<span>未分类</span>
					<em>{counts.unassigned}</em>
				</button>
				{lists.map((list, index) => {
					const editing = editingId === list.id;
					return (
						<div key={list.id} className={`memo-list-row ${selectedListId === list.id ? "active" : ""}`}>
							{editing ? (
								<input
									value={editName}
									onChange={(event) => setEditName(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											void onRename(list.id, editName.trim()).then(() => setEditingId(null));
										}
										if (event.key === "Escape") setEditingId(null);
									}}
									autoFocus
								/>
							) : (
								<button
									type="button"
									className="memo-list-item"
									aria-current={selectedListId === list.id ? "page" : undefined}
									onClick={() => onSelect(list.id)}
									onContextMenu={(event) => openMenu(event, list, index)}
								>
									<span className="memo-list-dot" style={list.color ? { background: list.color } : undefined} />
									{list.icon ? <span className="memo-list-icon">{list.icon}</span> : null}
									<span>{list.name}</span>
									<em>{counts.map.get(list.id) ?? 0}</em>
								</button>
							)}
						</div>
					);
				})}
			</div>

			{menu && menuList
				? createPortal(
				<div
					className="memo-list-menu"
					style={{
						left: Math.min(menu.x, window.innerWidth - 160),
						top: Math.min(menu.y, window.innerHeight - 170),
					}}
					onClick={(event) => event.stopPropagation()}
					onContextMenu={(event) => event.preventDefault()}
					role="menu"
				>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							startRename(menuList);
							setMenu(null);
						}}
					>
						<FilePenLine size={13} />
						<span>编辑</span>
					</button>
					<button
						type="button"
						role="menuitem"
						disabled={busy || !menu.canMoveUp}
						onClick={() => {
							void onReorder(menu.listId, "up");
							setMenu(null);
						}}
					>
						<ChevronUp size={13} />
						<span>上移</span>
					</button>
					<button
						type="button"
						role="menuitem"
						disabled={busy || !menu.canMoveDown}
						onClick={() => {
							void onReorder(menu.listId, "down");
							setMenu(null);
						}}
					>
						<ChevronDown size={13} />
						<span>下移</span>
					</button>
					<div className="memo-list-menu-sep" />
					<button
						type="button"
						role="menuitem"
						className="danger"
						disabled={busy}
						onClick={() => {
							setMenu(null);
							if (window.confirm(`删除清单「${menuList.name}」？其中的备忘将变为未分类。`)) void onDelete(menuList.id);
						}}
					>
						<Trash2 size={13} />
						<span>删除</span>
					</button>
				</div>,
						document.body,
				  )
				: null}
			<div className="memo-sidebar-create">
				{creating ? (
					<div className="memo-list-create-row">
						<input
							value={draftName}
							placeholder="清单名称"
							onChange={(event) => setDraftName(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") void saveNew();
								if (event.key === "Escape") setCreating(false);
							}}
							autoFocus
						/>
						<button type="button" onClick={() => void saveNew()} disabled={!draftName.trim()}>
							<Check size={13} />
						</button>
					</div>
				) : (
					<button type="button" className="memo-new-list-btn" onClick={() => setCreating(true)}>
						<Plus size={14} />
						<span>新建清单</span>
					</button>
				)}
			</div>
		</aside>
	);
}

function BatchBar({
	count,
	lists,
	busy,
	onComplete,
	onArchive,
	onDelete,
	onSelectAll,
	onClear,
	onSetPriority,
	onSetList,
}: {
	count: number;
	lists: MemoList[];
	busy: boolean;
	onComplete: () => void;
	onArchive: () => void;
	onDelete: () => void;
	onSelectAll: () => void;
	onClear: () => void;
	onSetPriority: (priority: MemoPriority) => void;
	onSetList: (listId: string) => void;
}) {
	return (
		<div className="memo-batchbar" aria-live="polite">
			<strong>已选 {count} 项</strong>
			<button type="button" onClick={onComplete} disabled={busy}>
				<Check size={14} />
				<span>完成</span>
			</button>
			<button type="button" onClick={onArchive} disabled={busy}>
				<Archive size={14} />
				<span>归档</span>
			</button>
			<button type="button" className="danger" onClick={onDelete} disabled={busy}>
				<Trash2 size={14} />
				<span>删除</span>
			</button>
			<select defaultValue="" onChange={(event) => event.target.value && onSetPriority(event.target.value as MemoPriority)}>
				<option value="">优先级</option>
				{PRIORITIES.map((priority) => (
					<option key={priority} value={priority}>
						{PRIORITY_LABEL[priority]}
					</option>
				))}
			</select>
			<select defaultValue="" onChange={(event) => onSetList(event.target.value === "__none" ? "" : event.target.value)}>
				<option value="">移动到…</option>
				<option value="__none">未分类</option>
				{lists.map((list) => (
					<option key={list.id} value={list.id}>
						{list.name}
					</option>
				))}
			</select>
			<button type="button" onClick={onSelectAll} disabled={busy}>
				全选可见
			</button>
			<button type="button" onClick={onClear}>
				清除
			</button>
		</div>
	);
}

function MemoDocumentView({
	memo,
	list,
	copyState,
	onBack,
	onCopy,
	onEdit,
	onToggleComplete,
	onTogglePin,
	onDelete,
	onOpenSession,
}: {
	memo: MemoItem;
	list?: MemoList;
	copyState: "idle" | "copied" | "failed";
	onBack: () => void;
	onCopy: () => void;
	onEdit: () => void;
	onToggleComplete: () => void;
	onTogglePin: () => void;
	onDelete: () => void;
	onOpenSession?: (sessionId: string) => void;
}) {
	const completed = memo.status === "completed";
	const overdue = isOverdue(memo);
	const progress = computeProgress(memo);
	const documentStatus = completed ? "已完成" : overdue ? "逾期" : memo.status === "archived" ? "已归档" : "进行中";
	return (
		<section className="memo-document-view" aria-label={`备忘录详情：${memo.title}`}>
			<div className="memo-document-toolbar">
				<button type="button" className="memo-document-back" onClick={onBack}>
					<ArrowLeft size={15} />
					<span>返回列表</span>
				</button>
				<div className="memo-document-toolbar-actions">
					<button type="button" className="memo-document-copy" onClick={onCopy} aria-live="polite">
						{copyState === "copied" ? <Check size={15} /> : <Copy size={15} />}
						<span>{copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制全文"}</span>
					</button>
					<button type="button" className="memo-btn ghost" onClick={onEdit}>
						<FilePenLine size={14} />
						<span>编辑</span>
					</button>
				</div>
			</div>

			<div className="memo-document-scroll">
				<div className="memo-document-shell">
					<article className="memo-document-paper">
						<div className="memo-document-type">备忘录</div>
						<div className={`memo-document-stamp ${overdue ? "danger" : completed ? "success" : ""}`}>{documentStatus}</div>
						<h1>{memo.title}</h1>
						<div className="memo-document-rule" />
						<div className="memo-document-meta-grid">
							<MemoDocumentMeta label="清单" value={list?.name ?? "未分类"} />
							<MemoDocumentMeta label="优先级" value={PRIORITY_LABEL[memo.priority]} />
							<MemoDocumentMeta label="创建时间" value={formatDocumentDate(memo.createdAt)} />
							<MemoDocumentMeta label="更新时间" value={formatDocumentDate(memo.updatedAt)} />
							{memo.dueAt ? <MemoDocumentMeta label="截止时间" value={formatDocumentDate(memo.dueAt)} tone={overdue ? "danger" : undefined} /> : null}
							{memo.reminderAt ? <MemoDocumentMeta label="提醒时间" value={formatDocumentDate(memo.reminderAt)} /> : null}
							{memo.recurrence !== "none" ? <MemoDocumentMeta label="重复" value={RECURRENCE_LABEL[memo.recurrence]} /> : null}
							{progress ? <MemoDocumentMeta label="进度" value={progress.label} /> : null}
						</div>

						<section className="memo-document-section">
							<h2>正文</h2>
							{memo.notes ? (
								<MemoMarkdownPreview text={memo.notes} />
							) : (
								<p className="memo-document-empty-text">暂无正文</p>
							)}
						</section>

						{memo.subtasks.length > 0 ? (
							<section className="memo-document-section">
								<h2>办理事项</h2>
								<div className="memo-document-subtasks">
									{memo.subtasks.map((subtask) => (
										<div key={subtask.id} className={`memo-document-subtask ${subtask.done ? "done" : ""}`}>
											<span>{subtask.done ? <Check size={13} /> : null}</span>
											<p>{subtask.title}</p>
										</div>
									))}
								</div>
							</section>
						) : null}

						{memo.tags.length > 0 || memo.attachments?.length ? (
							<section className="memo-document-section">
								<h2>附件与标记</h2>
								{memo.tags.length > 0 ? (
									<div className="memo-document-tags">
										{memo.tags.map((tag) => (
											<span key={tag}>#{tag}</span>
										))}
									</div>
								) : null}
								{memo.attachments?.length ? <AttachmentChips attachments={memo.attachments} /> : null}
							</section>
						) : null}
					</article>

					<aside className="memo-document-aside" aria-label="办理信息">
						<div className="memo-document-aside-block">
							<strong>办理信息</strong>
							<button type="button" onClick={onToggleComplete}>
								<Check size={14} />
								<span>{completed ? "标记未完成" : "标记完成"}</span>
							</button>
							<button type="button" onClick={onTogglePin}>
								{memo.pinned ? <PinOff size={14} /> : <Pin size={14} />}
								<span>{memo.pinned ? "取消置顶" : "置顶"}</span>
							</button>
							<button type="button" className="danger" onClick={onDelete}>
								<Trash2 size={14} />
								<span>删除</span>
							</button>
						</div>

						{memo.createdBy === "ai" || memo.autoRunAtReminder || memo.lastAutoRunStatus ? (
							<div className="memo-document-aside-block">
								<strong>来源与运行</strong>
								{memo.createdBy === "ai" ? <span className="memo-document-note">AI 创建</span> : null}
								{memo.autoRunAtReminder ? <span className="memo-document-note">到提醒时自动运行</span> : null}
								{memo.lastAutoRunStatus ? <span className="memo-document-note">{formatAutoRunStatus(memo.lastAutoRunStatus)}</span> : null}
								{memo.sourceSessionId && onOpenSession ? (
									<button type="button" onClick={() => onOpenSession(memo.sourceSessionId!)}>
										<span>打开来源对话</span>
									</button>
								) : null}
								{memo.lastAutoRunSessionId && onOpenSession ? (
									<button type="button" onClick={() => onOpenSession(memo.lastAutoRunSessionId!)}>
										<span>查看运行结果</span>
									</button>
								) : null}
								{memo.lastAutoRunError ? <p className="memo-document-error">{memo.lastAutoRunError}</p> : null}
							</div>
						) : null}
					</aside>
				</div>
			</div>
		</section>
	);
}

function MemoDocumentMeta({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
	return (
		<div className={`memo-document-meta ${tone ?? ""}`}>
			<span>{label}</span>
			<strong>{value}</strong>
		</div>
	);
}

function MemoCard({
	memo,
	list,
	selected,
	dragging,
	busy,
	onSelect,
	onOpen,
	onDragStart,
	onDragEnd,
	onDropMemo,
	onToggleComplete,
	onTogglePin,
	onEdit,
	onDelete,
	onSnooze,
	onOpenSession,
}: {
	memo: MemoItem;
	list?: MemoList;
	selected: boolean;
	dragging: boolean;
	busy: boolean;
	onSelect: () => void;
	onOpen: () => void;
	onDragStart: () => void;
	onDragEnd: () => void;
	onDropMemo: (sourceId: string, position: "before" | "after") => void;
	onToggleComplete: () => void;
	onTogglePin: () => void;
	onEdit: () => void;
	onDelete: () => void;
	onSnooze: (until: string) => void;
	onOpenSession?: (sessionId: string) => void;
}) {
	const [showSnoozes, setShowSnoozes] = useState(false);
	const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
	const completed = memo.status === "completed";
	const overdue = isOverdue(memo);
	const reminderFired = memo.reminderState === "fired";
	const progress = computeProgress(memo);
	const suppressOpenRef = useRef(false);

	useEffect(() => {
		if (!menuPos) return undefined;
		const close = () => setMenuPos(null);
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMenuPos(null);
		};
		const id = window.setTimeout(() => {
			window.addEventListener("click", close);
			window.addEventListener("contextmenu", close);
			window.addEventListener("resize", close);
			window.addEventListener("blur", close);
		}, 0);
		window.addEventListener("keydown", onKey);
		return () => {
			window.clearTimeout(id);
			window.removeEventListener("click", close);
			window.removeEventListener("contextmenu", close);
			window.removeEventListener("resize", close);
			window.removeEventListener("blur", close);
			window.removeEventListener("keydown", onKey);
		};
	}, [menuPos]);

	const openCardMenu = (event: MouseEvent<HTMLButtonElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		setMenuPos({ x: rect.right, y: rect.bottom + 4 });
	};

	const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
		suppressOpenRef.current = true;
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("text/plain", memo.id);
		event.dataTransfer.setData("application/x-desktop-assistant-memo-id", memo.id);
		onDragStart();
	};

	const handleDragEnd = () => {
		onDragEnd();
		window.setTimeout(() => {
			suppressOpenRef.current = false;
		}, 0);
	};

	const readDraggedMemoId = (event: DragEvent<HTMLDivElement>): string => {
		return (
			event.dataTransfer.getData("application/x-desktop-assistant-memo-id") ||
			event.dataTransfer.getData("text/plain")
		).trim();
	};

	const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
	};

	const handleDrop = (event: DragEvent<HTMLDivElement>) => {
		const sourceId = readDraggedMemoId(event);
		if (!sourceId || sourceId === memo.id) return;
		event.preventDefault();
		event.stopPropagation();
		const rect = event.currentTarget.getBoundingClientRect();
		const position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
		onDropMemo(sourceId, position);
	};

	return (
		<div
			role="button"
			tabIndex={0}
			draggable={!busy}
			className={`memo-card priority-${memo.priority} ${completed ? "done" : ""} ${overdue ? "overdue" : ""} ${memo.pinned ? "pinned" : ""} ${selected ? "selected" : ""} ${dragging ? "dragging" : ""}`}
			style={memo.color ? ({ "--memo-accent": memo.color } as CSSProperties) : undefined}
			onClick={(event) => {
				if (suppressOpenRef.current) {
					event.preventDefault();
					return;
				}
				onOpen();
			}}
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
			onDragOver={handleDragOver}
			onDrop={handleDrop}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onOpen();
				}
			}}
		>
			<div className="memo-card-leftcol">
				<input
					type="checkbox"
					className="memo-card-select"
					checked={selected}
					onClick={(event) => event.stopPropagation()}
					onChange={onSelect}
					aria-label={`选择「${memo.title}」`}
				/>
				<button
					type="button"
					className={`memo-check ${completed ? "checked" : ""}`}
					onClick={(event) => {
						event.stopPropagation();
						onToggleComplete();
					}}
					disabled={busy}
					aria-label={completed ? "标记为未完成" : "标记为完成"}
				>
					{completed ? <Check size={13} /> : null}
				</button>
				<span
					className="memo-drag-handle"
					title="拖动排序"
					onClick={(event) => event.stopPropagation()}
					aria-hidden="true"
				>
					<GripVertical size={14} />
				</span>
			</div>

			<div className="memo-card-body">
				<div className="memo-card-title">
					<span className="memo-card-text">{memo.title}</span>
					{memo.createdBy === "ai" ? <span className="memo-tag-ai">AI</span> : null}
					{list ? (
						<span className="memo-card-list-chip" style={list.color ? ({ "--memo-list-color": list.color } as CSSProperties) : undefined}>
							{list.icon ? <span>{list.icon}</span> : null}
							{list.name}
						</span>
					) : null}
				</div>
				{memo.notes ? <MemoMarkdownPreview text={memo.notes} compact /> : null}
				{progress ? (
					<div className="memo-progress" aria-label={`Progress ${progress.label}`}>
						<div className="memo-progress-bar">
							<span style={{ width: `${progress.percent}%` }} />
						</div>
						<em>{progress.label}</em>
					</div>
				) : null}
				{memo.attachments?.length ? <AttachmentChips attachments={memo.attachments} /> : null}
				<div className="memo-card-meta">
					{memo.dueAt ? (
						<span className={`memo-due ${overdue ? "danger" : ""}`}>{formatDueLabel(memo.dueAt)}</span>
					) : null}
					{memo.reminderAt ? (
						<span className={`memo-reminder ${reminderFired ? "fired" : ""}`}>
							<BellRing size={11} /> {formatDueLabel(memo.reminderAt)}
						</span>
					) : null}
					{memo.autoRunAtReminder ? (
						<span
							className={`memo-reminder ${memo.lastAutoRunError ? "fired" : ""}`}
							title={memo.lastAutoRunError ?? "到点自动运行 AI"}
						>
							<Bot size={11} /> 自动运行
						</span>
					) : null}
					{memo.recurrence === "none" ? null : <span className="memo-recurrence">{RECURRENCE_LABEL[memo.recurrence]}</span>}
					{memo.tags.map((tag) => (
						<span key={tag} className="memo-tag">
							#{tag}
						</span>
					))}
					{memo.createdBy === "ai" && memo.sourceSessionId && onOpenSession ? (
						<button
							type="button"
							className="memo-source"
							onClick={(event) => {
								event.stopPropagation();
								onOpenSession(memo.sourceSessionId!);
							}}
							title="打开来源对话"
						>
							来源
						</button>
					) : null}
					{memo.lastAutoRunSessionId && onOpenSession ? (
						<button
							type="button"
							className="memo-source"
							onClick={(event) => {
								event.stopPropagation();
								onOpenSession(memo.lastAutoRunSessionId!);
							}}
							title="打开最近自动运行会话"
						>
							查看运行结果
						</button>
					) : null}
				</div>
				{reminderFired && !completed ? (
					<div className="memo-snooze-row">
						{showSnoozes ? (
							snoozePresets().map((preset) => (
								<button
									key={preset.label}
									type="button"
									className="memo-snooze-btn"
									onClick={(event) => {
										event.stopPropagation();
										setShowSnoozes(false);
										onSnooze(preset.iso);
									}}
								>
									{preset.label}
								</button>
							))
						) : (
							<button
								type="button"
								className="memo-snooze-btn"
								onClick={(event) => {
									event.stopPropagation();
									setShowSnoozes(true);
								}}
							>
								稍后提醒
							</button>
						)}
					</div>
				) : null}
			</div>

			<div className="memo-card-actions">
				<button
					type="button"
					className={`memo-card-more ${menuPos ? "active" : ""}`}
					onClick={(event) => {
						event.stopPropagation();
						openCardMenu(event);
					}}
					aria-label="更多操作"
					aria-haspopup="menu"
					title="更多操作"
				>
					<MoreVertical size={16} />
				</button>
			</div>

			{menuPos
				? createPortal(
						<div
							className="memo-card-menu"
							style={{
								left: Math.min(menuPos.x, window.innerWidth - 8) - 140,
								top: Math.min(menuPos.y, window.innerHeight - 120),
							}}
							onClick={(event) => event.stopPropagation()}
							onContextMenu={(event) => event.preventDefault()}
							role="menu"
						>
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									setMenuPos(null);
									onTogglePin();
								}}
							>
								{memo.pinned ? <PinOff size={13} /> : <Pin size={13} />}
								<span>{memo.pinned ? "取消置顶" : "置顶"}</span>
							</button>
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									setMenuPos(null);
									onEdit();
								}}
							>
								<FilePenLine size={13} />
								<span>编辑</span>
							</button>
							<button
								type="button"
								role="menuitem"
								className="danger"
								onClick={() => {
									setMenuPos(null);
									onDelete();
								}}
							>
								<Trash2 size={13} />
								<span>删除</span>
							</button>
						</div>,
						document.body,
				  )
				: null}
		</div>
	);
}

function AttachmentChips({ attachments }: { attachments: MemoAttachment[] }) {
	return (
		<div className="memo-attachments">
			{attachments.map((attachment) => (
				<button
					key={attachment.id}
					type="button"
					className="memo-attachment-chip"
					onClick={(event) => {
						event.stopPropagation();
						void openAttachment(attachment);
					}}
					title={attachment.href}
				>
					{attachment.type === "url" ? <Link size={12} /> : attachment.type === "image" ? <FileImage size={12} /> : <File size={12} />}
					<span>{attachment.name}</span>
				</button>
			))}
		</div>
	);
}

function MemoMarkdownPreview({ text, compact = false }: { text: string; compact?: boolean }) {
	const nodes = useMemo(() => renderAssistantMarkdown(text), [text]);
	function handleClick(event: MouseEvent<HTMLDivElement>) {
		const anchor = (event.target as HTMLElement | null)?.closest("a");
		const href = anchor?.getAttribute("href");
		if (!href) return;
		const normalized = href.trim().toLowerCase();
		if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) return;
		event.preventDefault();
		event.stopPropagation();
		void window.desktopAssistant.openUrlInDefaultBrowser({ url: href });
	}
	return (
		<div className={`memo-notes-preview assistant-markdown ${compact ? "compact" : ""}`} onClick={handleClick}>
			{nodes.map((node, index) => {
				if (node.type === "html") return <div key={`html-${index}`} dangerouslySetInnerHTML={{ __html: node.html }} />;
				if (node.type === "table") {
					return <div key={`table-${index}`} className="md-table-wrapper" dangerouslySetInnerHTML={{ __html: node.html }} />;
				}
				return (
					<pre key={`code-${index}`}>
						<code>{node.code}</code>
					</pre>
				);
			})}
		</div>
	);
}

function MemoModal({
	initial,
	lists,
	defaultListId,
	onCancel,
	onSave,
	onRunAutoNow,
	onOpenSession,
	onAttachmentChanged,
}: {
	initial?: MemoItem;
	lists: MemoList[];
	defaultListId?: string;
	onCancel: () => void;
	onSave: (draft: MemoDraft) => void;
	onRunAutoNow: (id: string) => Promise<unknown>;
	onOpenSession?: (sessionId: string) => void;
	onAttachmentChanged: () => void;
}) {
	const [title, setTitle] = useState(initial?.title ?? "");
	const [notes, setNotes] = useState(initial?.notes ?? "");
	const [previewNotes, setPreviewNotes] = useState(false);
	const [priority, setPriority] = useState<MemoPriority>(initial?.priority ?? "none");
	const [dueAt, setDueAt] = useState(isoToLocalInput(initial?.dueAt));
	const [reminderAt, setReminderAt] = useState(isoToLocalInput(initial?.reminderAt));
	const [autoRunAtReminder, setAutoRunAtReminder] = useState(initial?.autoRunAtReminder ?? false);
	const [autoRunPrompt, setAutoRunPrompt] = useState(initial?.autoRunPrompt ?? "");
	const [recurrence, setRecurrence] = useState<MemoRecurrence>(initial?.recurrence ?? "none");
	const [tagText, setTagText] = useState(initial?.tags.join(", ") ?? "");
	const [color, setColor] = useState(initial?.color ?? "");
	const [listId, setListId] = useState(initial?.listId ?? defaultListId ?? "");
	const [progressText, setProgressText] = useState(initial?.progress === undefined ? "" : String(initial.progress));
	const [subtasks, setSubtasks] = useState<MemoSubtask[]>(initial?.subtasks ?? []);
	const [subtaskDraft, setSubtaskDraft] = useState("");
	const [attachmentUrl, setAttachmentUrl] = useState("");
	const [attachmentBusy, setAttachmentBusy] = useState(false);
	const [modalError, setModalError] = useState<string | null>(null);
	const [autoRunBusy, setAutoRunBusy] = useState(false);
	const titleRef = useRef<HTMLInputElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const hasReminder = reminderAt.trim().length > 0;
	const canRunAutoNow =
		!!initial &&
		!!initial.reminderAt &&
		initial.lastAutoRunStatus !== "running" &&
		(initial.autoRunAtReminder || !!initial.lastAutoRunError);

	useEffect(() => {
		titleRef.current?.focus();
	}, []);

	useEffect(() => {
		if (!hasReminder) {
			setAutoRunAtReminder(false);
		}
	}, [hasReminder]);

	const addSubtask = () => {
		const next = subtaskDraft.trim();
		if (!next) return;
		setSubtasks((current) => [...current, { id: `tmp-${Date.now()}-${current.length}`, title: next, done: false }]);
		setSubtaskDraft("");
	};

	const addFileAttachment = async (file: File) => {
		if (!initial) return;
		setAttachmentBusy(true);
		setModalError(null);
		try {
			const filePath = window.desktopAssistant.getPathForFile(file);
			await window.desktopAssistant.addMemoAttachment({
				memoId: initial.id,
				filePath,
				name: file.name,
				type: file.type.startsWith("image/") ? "image" : "file",
			});
			onAttachmentChanged();
		} catch (error) {
			setModalError(describeError(error));
		} finally {
			setAttachmentBusy(false);
		}
	};

	const addUrlAttachment = async () => {
		if (!initial) return;
		const url = attachmentUrl.trim();
		if (!url) return;
		setAttachmentBusy(true);
		setModalError(null);
		try {
			await window.desktopAssistant.addMemoAttachment({ memoId: initial.id, url, name: url, type: "url" });
			setAttachmentUrl("");
			onAttachmentChanged();
		} catch (error) {
			setModalError(describeError(error));
		} finally {
			setAttachmentBusy(false);
		}
	};

	const removeAttachment = async (attachmentId: string) => {
		if (!initial) return;
		setAttachmentBusy(true);
		setModalError(null);
		try {
			await window.desktopAssistant.removeMemoAttachment({ memoId: initial.id, attachmentId });
			onAttachmentChanged();
		} catch (error) {
			setModalError(describeError(error));
		} finally {
			setAttachmentBusy(false);
		}
	};

	const runAutoNow = async () => {
		if (!initial) return;
		setAutoRunBusy(true);
		setModalError(null);
		try {
			await onRunAutoNow(initial.id);
		} catch (error) {
			setModalError(describeError(error));
		} finally {
			setAutoRunBusy(false);
		}
	};

	return (
		<div className="memo-modal-scrim" onClick={onCancel}>
			<div className="memo-modal" onClick={(event) => event.stopPropagation()}>
				<div className="memo-modal-head">
					<span>{initial ? "编辑备忘" : "新建备忘"}</span>
					<button type="button" className="title-btn" onClick={onCancel} aria-label="关闭">
						<X size={16} />
					</button>
				</div>

				<div className="memo-modal-body">
					{modalError ? <div className="memo-error">{modalError}</div> : null}
					<input
						ref={titleRef}
						className="memo-field-title"
						value={title}
						placeholder="标题"
						onChange={(event) => setTitle(event.target.value)}
					/>
					<div className="memo-field">
						<div className="memo-field-inline-head">
							<span>备注</span>
							<button type="button" className="memo-mini-toggle" onClick={() => setPreviewNotes((current) => !current)}>
								{previewNotes ? "编辑" : "预览"}
							</button>
						</div>
						{previewNotes ? (
							<MemoMarkdownPreview text={notes || "_暂无备注_"} />
						) : (
							<textarea
								className="memo-field-notes"
								value={notes}
								placeholder="支持 Markdown 的备注"
								rows={4}
								onChange={(event) => setNotes(event.target.value)}
							/>
						)}
					</div>

					<div className="memo-field-grid">
						<label className="memo-field">
							<span>截止</span>
							<input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
						</label>
						<label className="memo-field">
							<span>提醒</span>
							<input
								type="datetime-local"
								value={reminderAt}
								onChange={(event) => {
									const nextReminderAt = event.target.value;
									setReminderAt(nextReminderAt);
									if (!nextReminderAt) {
										setAutoRunAtReminder(false);
									}
								}}
							/>
						</label>
						<label className="memo-field memo-field-check">
							<span>AI 自动执行</span>
							<input
								type="checkbox"
								checked={autoRunAtReminder}
								disabled={!hasReminder}
								onChange={(event) => setAutoRunAtReminder(hasReminder && event.target.checked)}
							/>
							<small>到提醒时间自动运行，错过提醒不会自动补跑。</small>
						</label>
						<label className="memo-field">
							<span>优先级</span>
							<select value={priority} onChange={(event) => setPriority(event.target.value as MemoPriority)}>
								{PRIORITIES.map((option) => (
									<option key={option} value={option}>
										{PRIORITY_LABEL[option]}
									</option>
								))}
							</select>
						</label>
						<label className="memo-field">
							<span>重复</span>
							<select value={recurrence} onChange={(event) => setRecurrence(event.target.value as MemoRecurrence)}>
								{RECURRENCES.map((option) => (
									<option key={option} value={option}>
										{RECURRENCE_LABEL[option]}
									</option>
								))}
							</select>
						</label>
						<label className="memo-field">
							<span>清单</span>
							<select value={listId} onChange={(event) => setListId(event.target.value)}>
								<option value="">未分类</option>
								{lists.map((list) => (
									<option key={list.id} value={list.id}>
										{list.name}
									</option>
								))}
							</select>
						</label>
						<label className="memo-field">
							<span>进度</span>
							<input
								type="number"
								min={0}
								max={100}
								value={progressText}
								placeholder="自动"
								onChange={(event) => setProgressText(event.target.value)}
							/>
						</label>
					</div>

					{autoRunAtReminder && hasReminder ? (
						<label className="memo-field">
							<span>AI 执行指令</span>
							<textarea
								className="memo-field-notes"
								value={autoRunPrompt}
								placeholder="留空则按标题和备注执行"
								rows={3}
								onChange={(event) => setAutoRunPrompt(event.target.value)}
							/>
						</label>
					) : null}

					<label className="memo-field">
						<span>标签（用逗号分隔）</span>
						<input value={tagText} placeholder="工作, 家庭" onChange={(event) => setTagText(event.target.value)} />
					</label>

					<div className="memo-field">
						<span>颜色</span>
						<div className="memo-swatches">
							{COLOR_SWATCHES.map((swatch) => (
								<button
									key={swatch || "none"}
									type="button"
									className={`memo-swatch ${color === swatch ? "active" : ""} ${swatch ? "" : "none"}`}
									style={swatch ? { background: swatch } : undefined}
									onClick={() => setColor(swatch)}
									aria-label={swatch || "无颜色"}
								/>
							))}
						</div>
					</div>

					<div className="memo-field">
						<span>子任务</span>
						<div className="memo-subtasks">
							{subtasks.map((subtask, index) => (
								<div key={subtask.id} className="memo-subtask-row">
									<button
										type="button"
										className={`memo-check small ${subtask.done ? "checked" : ""}`}
										onClick={() =>
											setSubtasks((current) =>
												current.map((item, itemIndex) =>
													itemIndex === index ? { ...item, done: !item.done } : item,
												),
											)
										}
										aria-label="切换子任务状态"
									>
										{subtask.done ? <Check size={11} /> : null}
									</button>
									<span className={subtask.done ? "done" : ""}>{subtask.title}</span>
									<button
										type="button"
										className="memo-subtask-del"
										onClick={() => setSubtasks((current) => current.filter((_, itemIndex) => itemIndex !== index))}
										aria-label="删除子任务"
									>
										<X size={12} />
									</button>
								</div>
							))}
							<div className="memo-subtask-add">
								<input
									value={subtaskDraft}
									placeholder="添加子任务…"
									onChange={(event) => setSubtaskDraft(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											addSubtask();
										}
									}}
								/>
								<button type="button" onClick={addSubtask} aria-label="添加子任务">
									<Plus size={14} />
								</button>
							</div>
						</div>
					</div>

					{initial ? (
						<div className="memo-auto-run-panel">
							<div className="memo-auto-run-head">
								<span>AI 自动执行</span>
								{initial.lastAutoRunStatus ? (
									<em className={`memo-auto-run-status ${initial.lastAutoRunStatus}`}>
										{formatAutoRunStatus(initial.lastAutoRunStatus)}
									</em>
								) : null}
							</div>
							<p>到提醒时间自动运行，错过提醒不会自动补跑。</p>
							{initial.lastAutoRunError ? <div className="memo-auto-run-error">{initial.lastAutoRunError}</div> : null}
							<div className="memo-auto-run-actions">
								<button
									type="button"
									className="memo-btn ghost"
									disabled={!canRunAutoNow || autoRunBusy}
									onClick={() => void runAutoNow()}
								>
									<Bot size={14} />
									{autoRunBusy ? "运行中" : "立即重跑"}
								</button>
								{initial.lastAutoRunSessionId && onOpenSession ? (
									<button
										type="button"
										className="memo-btn ghost"
										onClick={() => onOpenSession(initial.lastAutoRunSessionId!)}
									>
										查看运行结果
									</button>
								) : null}
							</div>
						</div>
					) : null}

					<div className="memo-field">
						<span>附件</span>
						{initial ? (
							<div className="memo-modal-attachments">
								<input
									ref={fileInputRef}
									type="file"
									onChange={(event) => {
										const file = event.target.files?.[0];
										if (file) void addFileAttachment(file);
										event.currentTarget.value = "";
									}}
								/>
								<button type="button" className="memo-btn ghost" onClick={() => fileInputRef.current?.click()} disabled={attachmentBusy}>
									<Paperclip size={14} />
									添加文件
								</button>
								<div className="memo-url-add">
									<input value={attachmentUrl} placeholder="https://..." onChange={(event) => setAttachmentUrl(event.target.value)} />
									<button type="button" onClick={() => void addUrlAttachment()} disabled={!attachmentUrl.trim() || attachmentBusy}>
										<Plus size={14} />
									</button>
								</div>
								{initial.attachments?.map((attachment) => (
									<div key={attachment.id} className="memo-attachment-row">
										<button type="button" onClick={() => void openAttachment(attachment)}>
											{attachment.type === "url" ? <Link size={13} /> : <File size={13} />}
											<span>{attachment.name}</span>
										</button>
										<button type="button" onClick={() => void removeAttachment(attachment.id)} aria-label="移除附件">
											<X size={13} />
										</button>
									</div>
								))}
							</div>
						) : (
							<p className="memo-muted">保存备忘后即可添加附件。</p>
						)}
					</div>
				</div>

				<div className="memo-modal-foot">
					<button type="button" className="memo-btn ghost" onClick={onCancel}>
						取消
					</button>
					<button
						type="button"
						className="memo-btn primary"
						onClick={() => {
							const nextTitle = title.trim();
							if (!nextTitle) {
								titleRef.current?.focus();
								return;
							}
							const parsedProgress = progressText.trim() ? Number(progressText) : undefined;
							onSave({
								title: nextTitle,
								notes: notes.trim(),
								priority,
								dueAt: localInputToIso(dueAt),
								reminderAt: localInputToIso(reminderAt),
								recurrence,
								tags: tagText
									.split(/[,，]/)
									.map((tag) => tag.trim())
									.filter(Boolean),
								subtasks: subtasks.map((subtask) => ({
									id: subtask.id,
									title: subtask.title,
									done: subtask.done,
								})),
								listId: listId || undefined,
								progress: parsedProgress === undefined || Number.isNaN(parsedProgress) ? undefined : parsedProgress,
								color: color || undefined,
								autoRunAtReminder: hasReminder && autoRunAtReminder,
								autoRunPrompt: hasReminder && autoRunAtReminder ? autoRunPrompt.trim() || undefined : undefined,
							});
						}}
						disabled={!title.trim()}
					>
						保存
					</button>
				</div>
			</div>
		</div>
	);
}

function MemoCalendarView({
	memos,
	selectedDay,
	onSelectDay,
}: {
	memos: MemoItem[];
	selectedDay: string | null;
	onSelectDay: (day: string) => void;
}) {
	const [month, setMonth] = useState(() => {
		const now = new Date();
		return new Date(now.getFullYear(), now.getMonth(), 1);
	});
	const days = useMemo(() => buildCalendarDays(month), [month]);
	const byDay = useMemo(() => {
		const map = new Map<string, MemoItem[]>();
		for (const memo of memos) {
			for (const iso of [memo.dueAt, memo.reminderAt]) {
				if (!iso) continue;
				const key = dayKey(new Date(iso));
				map.set(key, [...(map.get(key) ?? []), memo]);
			}
		}
		return map;
	}, [memos]);
	return (
		<div className="memo-calendar">
			<div className="memo-calendar-head">
				<button type="button" onClick={() => setMonth(addMonths(month, -1))} aria-label="上个月">
					<ChevronLeft size={16} />
				</button>
				<strong>
					{month.toLocaleDateString("zh-CN", { month: "long", year: "numeric" })}
				</strong>
				<button type="button" onClick={() => setMonth(addMonths(month, 1))} aria-label="下个月">
					<ChevronRight size={16} />
				</button>
			</div>
			<div className="memo-calendar-weekdays">
				{["日", "一", "二", "三", "四", "五", "六"].map((day) => (
					<span key={day}>{day}</span>
				))}
			</div>
			<div className="memo-calendar-grid">
				{days.map((date) => {
					const key = dayKey(date);
					const dayMemos = byDay.get(key) ?? [];
					const outside = date.getMonth() !== month.getMonth();
					const today = key === dayKey(new Date());
					const active = key === selectedDay;
					return (
						<button
							key={key}
							type="button"
							className={`memo-calendar-day ${outside ? "outside" : ""} ${today ? "today" : ""} ${active ? "active" : ""}`}
							onClick={() => onSelectDay(key)}
						>
							<span>{date.getDate()}</span>
							<div className="memo-calendar-dots">
								{dayMemos.slice(0, 4).map((memo) => (
									<i key={`${memo.id}-${key}`} className={calendarTone(memo, date)} />
								))}
							</div>
						</button>
					);
				})}
			</div>
		</div>
	);
}

function buildCalendarDays(month: Date): Date[] {
	const first = new Date(month.getFullYear(), month.getMonth(), 1);
	const start = new Date(first);
	start.setDate(first.getDate() - first.getDay());
	return Array.from({ length: 42 }, (_, index) => {
		const day = new Date(start);
		day.setDate(start.getDate() + index);
		return day;
	});
}

function addMonths(date: Date, amount: number): Date {
	return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function dayKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function calendarTone(memo: MemoItem, date: Date): string {
	if (isOverdue(memo, date)) return "danger";
	if (dayKey(date) === dayKey(new Date())) return "warn";
	return "future";
}

async function copyTextToClipboard(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "true");
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	textarea.style.pointerEvents = "none";
	document.body.appendChild(textarea);
	textarea.focus();
	textarea.select();
	try {
		document.execCommand("copy");
	} finally {
		document.body.removeChild(textarea);
	}
}

async function openAttachment(attachment: MemoAttachment): Promise<void> {
	if (attachment.type === "url") {
		await window.desktopAssistant.openUrlInDefaultBrowser({ url: attachment.href });
		return;
	}
	const path = fileHrefToPath(attachment.href);
	if (path) await window.desktopAssistant.openPath({ path });
}

function fileHrefToPath(href: string): string | undefined {
	try {
		const url = new URL(href);
		if (url.protocol !== "file:") return undefined;
		let path = decodeURIComponent(url.pathname);
		if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
		return path.replace(/\//g, "\\");
	} catch {
		return undefined;
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatDocumentDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
		date.getMinutes(),
	)}`;
}

function formatAutoRunStatus(status: MemoItem["lastAutoRunStatus"]): string {
	switch (status) {
		case "running":
			return "运行中";
		case "succeeded":
			return "已完成";
		case "failed":
			return "失败";
		default:
			return "";
	}
}
