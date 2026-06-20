import {
	ArrowLeft,
	BellRing,
	Check,
	FilePenLine,
	ListTodo,
	Pin,
	PinOff,
	Plus,
	Trash2,
	X,
} from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
	DesktopAssistantSnapshot,
	MemoItem,
	MemoPriority,
	MemoRecurrence,
	MemoSortKey,
	MemoSubtask,
	WakeWordModelMetadata,
	WindowMode,
} from "../../../src/shared/types.ts";
import { TitleBar } from "../components/TitleBar.tsx";
import {
	applyFilter,
	type MemoFilter,
	FILTER_LABEL,
	formatDueLabel,
	groupMemos,
	isoToLocalInput,
	localInputToIso,
	PRIORITY_LABEL,
	RECURRENCE_LABEL,
	snoozePresets,
	sortForDisplay,
	SORT_LABEL,
	isOverdue,
} from "./memo-view-model.ts";

const FILTERS: MemoFilter[] = ["all", "today", "upcoming", "overdue", "completed"];
const SORTS: MemoSortKey[] = ["due", "priority", "created", "manual"];
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
	subtasks: Array<{ title: string; done?: boolean }>;
	pinned?: boolean;
	color?: string;
}

type ModalState =
	| {
			mode: "new";
	  }
	| {
			mode: "edit";
			memo: MemoItem;
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
	const [filter, setFilter] = useState<MemoFilter>("all");
	const [sort, setSort] = useState<MemoSortKey>("due");
	const [query, setQuery] = useState("");
	const [quickAdd, setQuickAdd] = useState("");
	const [modal, setModal] = useState<ModalState | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!window.desktopAssistant) return undefined;
		let cancelled = false;

		const refresh = async () => {
			const result = await window.desktopAssistant.listMemos({});
			if (!cancelled) setMemos(result.memos);
		};

		void refresh();
		const unsubscribe = window.desktopAssistant.onEvent((event) => {
			if (event.type === "memo_changed" || event.type === "memo_reminder") {
				void refresh();
			}
		});

		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);

	const visibleMemos = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		const searched = normalized
			? memos.filter((memo) =>
					[memo.title, memo.notes, memo.tags.join(" ")].join(" ").toLowerCase().includes(normalized),
				)
			: memos;
		return sortForDisplay(applyFilter(searched, filter), sort);
	}, [filter, memos, query, sort]);

	const groups = useMemo(() => groupMemos(visibleMemos), [visibleMemos]);
	const stats = useMemo(() => {
		let overdue = 0;
		for (const memo of memos) {
			if (isOverdue(memo)) overdue += 1;
		}
		return {
			overdue,
			today: applyFilter(memos, "today").length,
		};
	}, [memos]);

	const runAction = async (action: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await action();
			const result = await window.desktopAssistant.listMemos({});
			setMemos(result.memos);
		} finally {
			setBusy(false);
		}
	};

	const saveQuickAdd = async () => {
		const title = quickAdd.trim();
		if (!title || !window.desktopAssistant) return;
		setQuickAdd("");
		await runAction(() => window.desktopAssistant.createMemo({ title, createdBy: "user" }));
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
					subtasks: draft.subtasks.map((subtask, index) => ({
						id: `${existingId}-${index}`,
						title: subtask.title,
						done: subtask.done ?? false,
					})),
					pinned: draft.pinned,
					color: draft.color ?? null,
				});
			}
			return window.desktopAssistant.createMemo({
				...draft,
				createdBy: "user",
			});
		});
		setModal(null);
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

			<header className="memo-head">
				<button className="title-btn" type="button" onClick={onBack} aria-label="返回">
					<ArrowLeft size={16} />
				</button>
				<div className="memo-head-title">
					<span className="memo-head-name">备忘录</span>
					<span className="memo-head-sub">
						{stats.overdue > 0 ? <span className="memo-chip danger">逾期 {stats.overdue}</span> : null}
						{stats.today > 0 ? <span className="memo-chip warn">今日 {stats.today}</span> : null}
					</span>
				</div>
				<button className="memo-new-btn" type="button" onClick={() => setModal({ mode: "new" })}>
					<Plus size={15} />
					<span>新建</span>
				</button>
			</header>

			<div className="memo-toolbar">
				<div className="memo-quickadd">
					<input
						value={quickAdd}
						placeholder="快速添加待办，回车保存..."
						onChange={(event) => setQuickAdd(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") void saveQuickAdd();
						}}
					/>
					<button type="button" onClick={() => void saveQuickAdd()} disabled={!quickAdd.trim()} aria-label="添加">
						<Plus size={16} />
					</button>
				</div>
				<input
					className="memo-search"
					value={query}
					placeholder="搜索..."
					onChange={(event) => setQuery(event.target.value)}
				/>
				<select className="memo-sort" value={sort} onChange={(event) => setSort(event.target.value as MemoSortKey)}>
					{SORTS.map((option) => (
						<option key={option} value={option}>
							{SORT_LABEL[option]}
						</option>
					))}
				</select>
			</div>

			<div className="memo-filters">
				{FILTERS.map((option) => (
					<button
						key={option}
						type="button"
						className={`memo-filter ${filter === option ? "active" : ""}`}
						onClick={() => setFilter(option)}
					>
						{FILTER_LABEL[option]}
					</button>
				))}
			</div>

			<div className="memo-list">
				{groups.length === 0 ? (
					<div className="memo-empty">
						<ListTodo size={36} />
						<p>{filter === "completed" ? "还没有已完成的待办" : "没有待办，享受当下"}</p>
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
									busy={busy}
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

			{modal ? (
				<MemoModal
					initial={modal.mode === "edit" ? modal.memo : undefined}
					onCancel={() => setModal(null)}
					onSave={(draft) => void saveDraft(draft, modal.mode === "edit" ? modal.memo.id : undefined)}
				/>
			) : null}
		</div>
	);
}

function MemoCard({
	memo,
	busy,
	onToggleComplete,
	onTogglePin,
	onEdit,
	onDelete,
	onSnooze,
	onOpenSession,
}: {
	memo: MemoItem;
	busy: boolean;
	onToggleComplete: () => void;
	onTogglePin: () => void;
	onEdit: () => void;
	onDelete: () => void;
	onSnooze: (until: string) => void;
	onOpenSession?: (sessionId: string) => void;
}) {
	const [showSnoozes, setShowSnoozes] = useState(false);
	const completed = memo.status === "completed";
	const overdue = isOverdue(memo);
	const finishedSubtasks = memo.subtasks.filter((subtask) => subtask.done).length;
	const reminderFired = memo.reminderState === "fired";

	return (
		<div
			className={`memo-card priority-${memo.priority} ${completed ? "done" : ""} ${overdue ? "overdue" : ""} ${memo.pinned ? "pinned" : ""}`}
			style={memo.color ? ({ "--memo-accent": memo.color } as CSSProperties) : undefined}
		>
			<button
				type="button"
				className={`memo-check ${completed ? "checked" : ""}`}
				onClick={onToggleComplete}
				disabled={busy}
				aria-label={completed ? "标记未完成" : "标记完成"}
			>
				{completed ? <Check size={13} /> : null}
			</button>

			<div className="memo-card-body">
				<div className="memo-card-title">
					<span className="memo-card-text">{memo.title}</span>
					{memo.createdBy === "ai" ? <span className="memo-tag-ai">AI</span> : null}
				</div>
				{memo.notes ? <div className="memo-card-notes">{memo.notes}</div> : null}
				<div className="memo-card-meta">
					{memo.dueAt ? (
						<span className={`memo-due ${overdue ? "danger" : ""}`}>{formatDueLabel(memo.dueAt)}</span>
					) : null}
					{memo.reminderAt ? (
						<span className={`memo-reminder ${reminderFired ? "fired" : ""}`}>
							<BellRing size={11} /> {formatDueLabel(memo.reminderAt)}
						</span>
					) : null}
					{memo.recurrence === "none" ? null : <span className="memo-recurrence">{RECURRENCE_LABEL[memo.recurrence]}</span>}
					{memo.subtasks.length > 0 ? (
						<span className="memo-subprogress">
							{finishedSubtasks}/{memo.subtasks.length}
						</span>
					) : null}
					{memo.tags.map((tag) => (
						<span key={tag} className="memo-tag">
							#{tag}
						</span>
					))}
					{memo.createdBy === "ai" && memo.sourceSessionId && onOpenSession ? (
						<button
							type="button"
							className="memo-source"
							onClick={() => onOpenSession(memo.sourceSessionId!)}
							title="打开来源会话"
						>
							来源会话
						</button>
					) : null}
				</div>
				{reminderFired && !completed ? (
					<div className="memo-snooze-row">
						{showSnoozes
							? snoozePresets().map((preset) => (
									<button
										key={preset.label}
										type="button"
										className="memo-snooze-btn"
										onClick={() => {
											setShowSnoozes(false);
											onSnooze(preset.iso);
										}}
									>
										{preset.label}
									</button>
								))
							: (
								<button type="button" className="memo-snooze-btn" onClick={() => setShowSnoozes(true)}>
									稍后提醒
								</button>
							)}
					</div>
				) : null}
			</div>

			<div className="memo-card-actions">
				<button type="button" onClick={onTogglePin} aria-label={memo.pinned ? "取消置顶" : "置顶"} title="置顶">
					{memo.pinned ? <Pin size={14} /> : <PinOff size={14} />}
				</button>
				<button type="button" onClick={onEdit} aria-label="编辑" title="编辑">
					<FilePenLine size={14} />
				</button>
				<button type="button" className="danger" onClick={onDelete} aria-label="删除" title="删除">
					<Trash2 size={14} />
				</button>
			</div>
		</div>
	);
}

function MemoModal({
	initial,
	onCancel,
	onSave,
}: {
	initial?: MemoItem;
	onCancel: () => void;
	onSave: (draft: MemoDraft) => void;
}) {
	const [title, setTitle] = useState(initial?.title ?? "");
	const [notes, setNotes] = useState(initial?.notes ?? "");
	const [priority, setPriority] = useState<MemoPriority>(initial?.priority ?? "none");
	const [dueAt, setDueAt] = useState(isoToLocalInput(initial?.dueAt));
	const [reminderAt, setReminderAt] = useState(isoToLocalInput(initial?.reminderAt));
	const [recurrence, setRecurrence] = useState<MemoRecurrence>(initial?.recurrence ?? "none");
	const [tagText, setTagText] = useState(initial?.tags.join(", ") ?? "");
	const [color, setColor] = useState(initial?.color ?? "");
	const [subtasks, setSubtasks] = useState<MemoSubtask[]>(initial?.subtasks ?? []);
	const [subtaskDraft, setSubtaskDraft] = useState("");
	const titleRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		titleRef.current?.focus();
	}, []);

	const addSubtask = () => {
		const next = subtaskDraft.trim();
		if (!next) return;
		setSubtasks((current) => [...current, { id: `tmp-${current.length}`, title: next, done: false }]);
		setSubtaskDraft("");
	};

	return (
		<div className="memo-modal-scrim" onClick={onCancel}>
			<div className="memo-modal" onClick={(event) => event.stopPropagation()}>
				<div className="memo-modal-head">
					<span>{initial ? "编辑待办" : "新建待办"}</span>
					<button type="button" className="title-btn" onClick={onCancel} aria-label="关闭">
						<X size={16} />
					</button>
				</div>

				<div className="memo-modal-body">
					<input
						ref={titleRef}
						className="memo-field-title"
						value={title}
						placeholder="标题"
						onChange={(event) => setTitle(event.target.value)}
					/>
					<textarea
						className="memo-field-notes"
						value={notes}
						placeholder="备注（可选）"
						rows={3}
						onChange={(event) => setNotes(event.target.value)}
					/>

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
								onChange={(event) => setReminderAt(event.target.value)}
							/>
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
					</div>

					<label className="memo-field">
						<span>标签（逗号分隔）</span>
						<input value={tagText} placeholder="工作, 家庭..." onChange={(event) => setTagText(event.target.value)} />
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
										aria-label="切换子任务"
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
									placeholder="添加子任务..."
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
								subtasks: subtasks.map((subtask) => ({ title: subtask.title, done: subtask.done })),
								color: color || undefined,
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
