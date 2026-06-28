import {
	ArrowLeft,
	Bot,
	Ban,
	CalendarClock,
	CheckCircle2,
	CircleX,
	Clock3,
	ExternalLink,
	Loader2,
	Play,
	Plus,
	Power,
	PowerOff,
	ScrollText,
	Square,
	Trash2,
	Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
	AutomationFlow,
	AutomationListResponse,
	AutomationProgressEvent,
	AutomationRunPolicy,
	AutomationRunRecord,
	AutomationTrigger,
	DesktopAssistantEvent,
	DesktopAssistantSnapshot,
	WakeWordModelMetadata,
	WindowMode,
} from "../../../src/shared/types.ts";
import { TitleBar } from "../components/TitleBar.tsx";
import { formatTime } from "../formatters.ts";
import { FlowGraphPreview } from "./FlowGraph.tsx";
import { formatRunStatus, triggerSummary } from "./types.ts";

/** Per-flow live execution state derived from automation_progress events. */
interface FlowProgress {
	activeNodeId?: string;
	doneNodeIds: string[];
}

const PERMISSION_LABEL: Record<AutomationRunPolicy["permissionMode"], string> = {
	full_access: "完全控制",
	automatic: "替我审批",
	tiered: "请求批准",
	sandbox: "仅沙盒",
};
const RUN_TRIGGER_LABEL: Record<AutomationRunRecord["trigger"], string> = {
	manual: "手动",
	test: "测试",
	scheduled: "定时",
};
const TRIGGER_KIND_LABEL: Record<AutomationTrigger["kind"], string> = {
	manual: "手动",
	once: "一次性",
	interval: "间隔",
	daily: "每天",
	weekly: "每周",
};

interface AutomationViewProps {
	snapshot: DesktopAssistantSnapshot;
	onBack: () => void;
	onMenu: () => void;
	wakeModels: WakeWordModelMetadata[];
	windowMode: WindowMode;
	onToggleWindowMode: () => void;
	onOpenSession?: (sessionId: string) => void;
}

const DEFAULT_LIST: AutomationListResponse = {
	flows: [],
	summary: {
		total: 0,
		enabledCount: 0,
		runningCount: 0,
		missedCount: 0,
	},
};

const PERMISSION_MODES: AutomationRunPolicy["permissionMode"][] = ["full_access", "automatic", "tiered"];
const WEEKDAYS = [
	{ value: 0, label: "日" },
	{ value: 1, label: "一" },
	{ value: 2, label: "二" },
	{ value: 3, label: "三" },
	{ value: 4, label: "四" },
	{ value: 5, label: "五" },
	{ value: 6, label: "六" },
];

export function AutomationView({
	snapshot,
	onBack,
	onMenu,
	wakeModels,
	windowMode,
	onToggleWindowMode,
	onOpenSession,
}: AutomationViewProps) {
	const [list, setList] = useState<AutomationListResponse>(DEFAULT_LIST);
	const [selectedId, setSelectedId] = useState<string | undefined>();
	const [query, setQuery] = useState("");
	const [saving, setSaving] = useState(false);
	const [runningId, setRunningId] = useState<string | undefined>();
	const [statusText, setStatusText] = useState("");
	const [progressByFlow, setProgressByFlow] = useState<Record<string, FlowProgress>>({});
	const [compactPanel, setCompactPanel] = useState<"list" | "detail">("list");
	const [isCompactViewport, setIsCompactViewport] = useState(() =>
		typeof window === "undefined" ? false : window.matchMedia("(max-width: 767px)").matches,
	);

	const loadFlows = async () => {
		if (!window.desktopAssistant?.automationList) return;
		const next = await window.desktopAssistant.automationList();
		setList(next);
		setSelectedId((current) => current ?? next.flows[0]?.id);
	};

	useEffect(() => {
		void loadFlows();
	}, []);

	useEffect(() => {
		if (!window.desktopAssistant?.onEvent) return undefined;
		return window.desktopAssistant.onEvent((event: DesktopAssistantEvent) => {
			if (event.type === "automation_progress" && event.automationProgress) {
				applyFlowProgress(event.automationProgress);
			}
			if (
				event.type === "automation_changed" ||
				event.type === "automation_missed" ||
				event.type === "automation_progress" ||
				event.type === "automation_draft_changed"
			) {
				void loadFlows();
			}
		});
	}, []);

	useEffect(() => {
		const media = window.matchMedia("(max-width: 767px)");
		const syncCompactViewport = () => {
			setIsCompactViewport(media.matches);
			if (!media.matches) setCompactPanel("list");
		};
		syncCompactViewport();
		media.addEventListener("change", syncCompactViewport);
		return () => media.removeEventListener("change", syncCompactViewport);
	}, []);

	// Mirror the editor's live node highlight on the management page: track which node a flow is
	// currently executing (and which it has finished) so the read-only graph can light them up.
	const applyFlowProgress = (progress: AutomationProgressEvent) => {
		setProgressByFlow((current) => {
			const flowId = progress.flowId;
			if (progress.kind === "finish") {
				if (!(flowId in current)) return current;
				const next = { ...current };
				delete next[flowId];
				return next;
			}
			const existing = current[flowId] ?? { doneNodeIds: [] };
			if (progress.kind === "step" && progress.nodeId) {
				if (progress.phase === "enter") {
					return { ...current, [flowId]: { ...existing, activeNodeId: progress.nodeId } };
				}
				if (progress.phase === "done") {
					const doneNodeIds = existing.doneNodeIds.includes(progress.nodeId)
						? existing.doneNodeIds
						: [...existing.doneNodeIds, progress.nodeId];
					const activeNodeId = existing.activeNodeId === progress.nodeId ? undefined : existing.activeNodeId;
					return { ...current, [flowId]: { activeNodeId, doneNodeIds } };
				}
			}
			return current;
		});
	};

	const visibleFlows = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		if (!normalized) return list.flows;
		return list.flows.filter((flow) =>
			[
				flow.name,
				flow.description,
				flow.trigger.kind,
				triggerSummary(flow.trigger, flow.nextRunAt),
				flow.lastRun?.summary ?? "",
				flow.lastRun?.error ?? "",
			]
				.join(" ")
				.toLowerCase()
				.includes(normalized),
		);
	}, [list.flows, query]);

	const selected =
		visibleFlows.find((flow) => flow.id === selectedId) ?? list.flows.find((flow) => flow.id === selectedId) ?? visibleFlows[0];
	const activeRun = selected?.runs.find((run) => run.status === "running");
	const activeCompactPanel = selected ? compactPanel : "list";

	useEffect(() => {
		if (selected && selected.id !== selectedId) setSelectedId(selected.id);
	}, [selected, selectedId]);

	const selectFlow = (id: string) => {
		setSelectedId(id);
		if (isCompactViewport) setCompactPanel("detail");
	};

	const createFlow = async () => {
		if (!window.desktopAssistant?.automationOpenEditor) return;
		// Don't persist anything yet — open a blank editor. The flow only appears in the
		// list once the user edits and saves it (the editor's save creates it).
		setStatusText("");
		await window.desktopAssistant.automationOpenEditor({});
	};

	const updateFlow = async (request: Parameters<NonNullable<typeof window.desktopAssistant>["automationUpdate"]>[0]) => {
		if (!window.desktopAssistant?.automationUpdate) throw new Error("自动化更新接口不可用。");
		const updated = await window.desktopAssistant.automationUpdate(request);
		setList((current) => ({
			...current,
			flows: current.flows.map((flow) => (flow.id === updated.id ? updated : flow)),
		}));
		return updated;
	};

	const saveTrigger = async (flow: AutomationFlow, trigger: AutomationTrigger) => {
		setSaving(true);
		setStatusText("");
		try {
			await updateFlow({ id: flow.id, trigger });
			setStatusText("触发器已更新。");
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	};

	const saveRunPolicy = async (flow: AutomationFlow, runPolicy: AutomationRunPolicy) => {
		setSaving(true);
		setStatusText("");
		try {
			await updateFlow({ id: flow.id, runPolicy });
			setStatusText("运行策略已更新。");
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	};

	const toggleEnabled = async (flow: AutomationFlow) => {
		if (!window.desktopAssistant?.automationSetEnabled) return;
		setSaving(true);
		setStatusText("");
		try {
			const updated = await window.desktopAssistant.automationSetEnabled({ id: flow.id, enabled: !flow.enabled });
			setList((current) => ({
				...current,
				flows: current.flows.map((item) => (item.id === updated.id ? updated : item)),
			}));
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	};

	const openEditor = async (flow: AutomationFlow) => {
		if (!window.desktopAssistant?.automationOpenEditor) return;
		await window.desktopAssistant.automationOpenEditor({ flowId: flow.id });
	};

	const runFlow = async (flow: AutomationFlow) => {
		if (!window.desktopAssistant?.automationRun) return;
		setRunningId(flow.id);
		setStatusText("");
		try {
			const response = await window.desktopAssistant.automationRun({ id: flow.id, trigger: "manual" });
			setList((current) => ({
				...current,
				flows: current.flows.map((item) => (item.id === response.flow.id ? response.flow : item)),
			}));
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setRunningId(undefined);
		}
	};

	const cancelRun = async (flow: AutomationFlow, run: AutomationRunRecord) => {
		if (!window.desktopAssistant?.automationCancelRun) return;
		setRunningId(flow.id);
		setStatusText("");
		try {
			await window.desktopAssistant.automationCancelRun({ flowId: flow.id, runId: run.id });
			await loadFlows();
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setRunningId(undefined);
		}
	};

	const deleteFlow = async (flow: AutomationFlow) => {
		if (!window.desktopAssistant?.automationDelete) return;
		if (!window.confirm(`删除流程"${flow.name}"？`)) return;
		setSaving(true);
		setStatusText("");
		try {
			const next = await window.desktopAssistant.automationDelete({ id: flow.id });
			setList(next);
			setSelectedId((current) => {
				if (current !== flow.id) return current;
				setCompactPanel("list");
				return next.flows[0]?.id;
			});
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="automation-screen">
			<TitleBar
				onMenu={onMenu}
				title="自动化"
				webSearchMode={snapshot.settings.webSearch?.mode}
				voiceOverlay={snapshot.voiceOverlay}
				voiceSettings={snapshot.settings.voice}
				wakeModels={wakeModels}
				windowMode={windowMode}
				onToggleWindowMode={onToggleWindowMode}
			/>

			<div className={`automation-body compact-${activeCompactPanel}`}>
			<header className="automation-head">
				<button className="title-btn" type="button" onClick={onBack} aria-label="返回">
					<ArrowLeft size={16} />
				</button>
				<div className="automation-head-copy">
					<strong>自动化</strong>
					<span>
						共 {list.summary.total} 个流程，{list.summary.enabledCount} 个已启用，{list.summary.runningCount} 个运行中
					</span>
				</div>
				<button className="automation-primary-btn automation-head-new" type="button" onClick={() => void createFlow()} disabled={saving}>
					<Plus size={15} />
					<span>新建</span>
				</button>
			</header>

			<div className="automation-toolbar">
				<input
					className="automation-search"
					type="search"
					value={query}
					placeholder="搜索流程、触发器、运行记录"
					onChange={(event) => setQuery(event.target.value)}
				/>
				<div className="automation-toolbar-note">
					<CalendarClock size={14} />
					<span>{list.summary.nextRunAt ? `下次 ${new Date(list.summary.nextRunAt).toLocaleString()}` : "暂无计划运行"}</span>
				</div>
				{list.summary.missedCount > 0 ? (
					<div className="automation-toolbar-note danger">
						<Clock3 size={14} />
						<span>错过 {list.summary.missedCount} 次</span>
					</div>
				) : null}
			</div>

			<div className={`automation-layout compact-${activeCompactPanel}`}>
				<section className="automation-sidebar">
					{visibleFlows.length ? (
						visibleFlows.map((flow) => {
							const lastRunStatus = flow.lastRun?.status ?? "cancelled";
							return (
								<button
									type="button"
									key={flow.id}
									className={`automation-flow-card ${selected?.id === flow.id ? "active" : ""}`}
									onClick={() => selectFlow(flow.id)}
								>
									<div className="automation-flow-card-top">
										<div>
											<strong>{flow.name}</strong>
											<span>{triggerSummary(flow.trigger, flow.nextRunAt)}</span>
										</div>
										<span className={`automation-status-pill ${flow.enabled ? "live" : "idle"}`}>
											{flow.enabled ? "已启用" : "已停用"}
										</span>
									</div>
									<p>{flow.description.trim() || "暂无描述。"}</p>
									<div className="automation-flow-meta">
										<span>
											<Workflow size={12} />
											{flow.nodes.length} 个节点
										</span>
										<span>
											<Clock3 size={12} />
											{formatTime(Date.parse(flow.updatedAt) || Date.now())}
										</span>
										{flow.lastRun ? (
											<span className={`automation-run-state status-${lastRunStatus}`}>{formatRunStatus(flow.lastRun.status)}</span>
										) : null}
									</div>
								</button>
							);
						})
					) : (
						<div className="automation-empty">
							<Workflow size={34} />
							<p>没有匹配当前筛选的流程。</p>
						</div>
					)}
				</section>

				<section className="automation-detail">
					{selected ? (
						<AutomationDetail
							flow={selected}
							busy={saving || runningId === selected.id}
							activeRun={activeRun}
							progress={progressByFlow[selected.id]}
							statusText={statusText}
							onSaveTrigger={saveTrigger}
							onSaveRunPolicy={saveRunPolicy}
							onToggleEnabled={toggleEnabled}
							onOpenEditor={openEditor}
							onRun={runFlow}
							onCancelRun={cancelRun}
							onDelete={deleteFlow}
							onOpenSession={onOpenSession}
							onBackToList={() => setCompactPanel("list")}
						/>
					) : (
						<div className="automation-empty detail">
							<Bot size={36} />
							<p>选择一个流程来编辑触发器、流程图和运行历史。</p>
						</div>
					)}
				</section>
			</div>
			</div>
		</div>
	);
}

function AutomationDetail({
	flow,
	busy,
	activeRun,
	progress,
	statusText,
	onSaveTrigger,
	onSaveRunPolicy,
	onToggleEnabled,
	onOpenEditor,
	onRun,
	onCancelRun,
	onDelete,
	onOpenSession,
	onBackToList,
}: {
	flow: AutomationFlow;
	busy: boolean;
	activeRun?: AutomationRunRecord;
	progress?: FlowProgress;
	statusText: string;
	onSaveTrigger: (flow: AutomationFlow, trigger: AutomationTrigger) => Promise<void>;
	onSaveRunPolicy: (flow: AutomationFlow, runPolicy: AutomationRunPolicy) => Promise<void>;
	onToggleEnabled: (flow: AutomationFlow) => Promise<void>;
	onOpenEditor: (flow: AutomationFlow) => Promise<void>;
	onRun: (flow: AutomationFlow) => Promise<void>;
	onCancelRun: (flow: AutomationFlow, run: AutomationRunRecord) => Promise<void>;
	onDelete: (flow: AutomationFlow) => Promise<void>;
	onOpenSession?: (sessionId: string) => void;
	onBackToList: () => void;
}) {
	const [trigger, setTrigger] = useState<AutomationTrigger>(flow.trigger);
	const [runPolicy, setRunPolicy] = useState<AutomationRunPolicy>(flow.runPolicy);

	useEffect(() => {
		setTrigger(flow.trigger);
		setRunPolicy(flow.runPolicy);
	}, [flow]);

	return (
		<>
			<button type="button" className="automation-detail-back" onClick={onBackToList}>
				<ArrowLeft size={15} />
				<span>{"\u5168\u90e8\u6d41\u7a0b"}</span>
				<span className={`automation-status-pill ${flow.enabled ? "live" : "idle"}`}>
					{flow.enabled ? "\u5df2\u542f\u7528" : "\u5df2\u505c\u7528"}
				</span>
			</button>
			<div className="automation-detail-head">
				<div className="automation-detail-title">
					<h2>{flow.name}</h2>
					<p>{flow.description.trim() || "描述这个自动化要做什么、何时运行、出错如何恢复。"}</p>
				</div>
				<div className="automation-detail-actions">
					<div className="automation-detail-action-primary">
						<button type="button" className="automation-primary-btn" onClick={() => void onRun(flow)} disabled={busy}>
							<Play size={14} />
							<span>运行</span>
						</button>
						<button type="button" className="automation-ghost-btn" onClick={() => void onOpenEditor(flow)} disabled={busy}>
							<Workflow size={14} />
							<span>编辑流程图</span>
						</button>
					</div>
					<div className="automation-detail-action-secondary">
						<button type="button" className="automation-ghost-btn" onClick={() => void onToggleEnabled(flow)} disabled={busy}>
							{flow.enabled ? <PowerOff size={14} /> : <Power size={14} />}
							<span>{flow.enabled ? "停用" : "启用"}</span>
						</button>
						<button
							type="button"
							className="automation-danger-btn automation-detail-delete"
							onClick={() => void onDelete(flow)}
							disabled={busy}
						>
							<Trash2 size={14} />
							<span>删除</span>
						</button>
					</div>
				</div>
			</div>

			<div className="automation-panels">
				<section className="automation-panel automation-panel-config">
					<div className="automation-panel-title">触发器</div>
					<div className="automation-policy-row">
						<label className="automation-field">
							<span>类型</span>
							<select
								value={trigger.kind}
								onChange={(event) => setTrigger(defaultTrigger(event.target.value as AutomationTrigger["kind"]))}
							>
								{(Object.keys(TRIGGER_KIND_LABEL) as AutomationTrigger["kind"][]).map((k) => (
									<option key={k} value={k}>
										{TRIGGER_KIND_LABEL[k]}
									</option>
								))}
							</select>
						</label>
						<button
							type="button"
							className="automation-primary-btn"
							onClick={() => void onSaveTrigger(flow, trigger)}
							disabled={busy}
						>
							保存
						</button>
					</div>
					<TriggerEditor trigger={trigger} onChange={setTrigger} />
					<div className="automation-panel-title">运行策略</div>
					<div className="automation-policy-row">
						<label className="automation-field">
							<span>权限模式</span>
							<select
								value={runPolicy.permissionMode}
								onChange={(event) =>
									setRunPolicy((current) => ({
										...current,
										permissionMode: event.target.value as AutomationRunPolicy["permissionMode"],
									}))
								}
							>
								{PERMISSION_MODES.map((mode) => (
									<option key={mode} value={mode}>
										{PERMISSION_LABEL[mode]}
									</option>
								))}
							</select>
						</label>
						<button
							type="button"
							className="automation-ghost-btn"
							onClick={() => void onSaveRunPolicy(flow, runPolicy)}
							disabled={busy}
						>
							保存
						</button>
					</div>
				</section>

				<section className="automation-panel automation-panel-graph">
					<div className="automation-panel-title">
						<span>流程图</span>
						{activeRun ? (
							<span className="automation-graph-running">
								<Loader2 size={12} className="spin" />
								运行中
							</span>
						) : null}
					</div>
					<div className="automation-graph-canvas">
						{flow.nodes.length ? (
							<FlowGraphPreview
								nodes={flow.nodes}
								edges={flow.edges}
								activeNodeId={progress?.activeNodeId}
								doneNodeIds={progress ? new Set(progress.doneNodeIds) : undefined}
							/>
						) : (
							<div className="automation-empty compact">
								<Workflow size={28} />
								<p>这个流程还没有节点。打开编辑器添加步骤。</p>
							</div>
						)}
					</div>
					<div className="automation-graph-meta">
						<span>{flow.nodes.length} 个节点</span>
						<span>{flow.edges.length} 条连接</span>
						<span>权限：{PERMISSION_LABEL[flow.runPolicy.permissionMode]}</span>
					</div>
				</section>

			<section className="automation-panel automation-panel-history history">
				<div className="automation-panel-title">
					<span>运行历史</span>
					<span className="automation-history-count">{flow.runs.length} 条记录</span>
				</div>
				{activeRun ? (
					<div className="automation-active-run">
						<div className="automation-active-run-main">
							<span className="automation-run-spinner">
								<Loader2 size={15} className="spin" />
							</span>
							<div className="automation-active-run-copy">
								<strong>
									{progress?.activeNodeId
										? `正在执行：${flow.nodes.find((node) => node.id === progress.activeNodeId)?.label ?? progress.activeNodeId}`
										: activeRun.summary || "流程运行中"}
								</strong>
								<span>
									{RUN_TRIGGER_LABEL[activeRun.trigger]} · 开始于 {new Date(activeRun.startedAt).toLocaleTimeString()}
								</span>
							</div>
						</div>
						<button
							type="button"
							className="automation-danger-btn"
							onClick={() => void onCancelRun(flow, activeRun)}
						>
							<Square size={13} />
							<span>中断</span>
						</button>
					</div>
				) : null}
				<div className="automation-history-list">
					{flow.runs.length ? (
						flow.runs.map((run) => (
							<article key={run.id} className={`automation-history-card status-${run.status}`}>
								<span className={`automation-history-icon status-${run.status}`}>{runStatusIcon(run.status)}</span>
								<div className="automation-history-body">
									<div className="automation-history-card-top">
										<strong>{run.summary || run.error || `${RUN_TRIGGER_LABEL[run.trigger]}运行`}</strong>
										<span className={`automation-run-state status-${run.status}`}>{formatRunStatus(run.status)}</span>
									</div>
									<div className="automation-history-card-meta">
										<span>{RUN_TRIGGER_LABEL[run.trigger]}</span>
										<span>{formatTime(Date.parse(run.startedAt) || Date.now())}</span>
										{run.finishedAt ? <span>耗时 {formatRunDuration(run.startedAt, run.finishedAt)}</span> : null}
									</div>
								</div>
								{run.sessionId && onOpenSession ? (
									<button
										type="button"
										className="automation-icon-btn"
										aria-label="打开运行会话"
										title="打开运行会话"
										onClick={() => onOpenSession(run.sessionId as string)}
									>
										<ExternalLink size={13} />
									</button>
								) : null}
							</article>
						))
					) : (
						<div className="automation-empty compact">
							<ScrollText size={28} />
							<p>暂无运行历史。</p>
						</div>
					)}
				</div>
				{statusText ? <div className="automation-status-text">{statusText}</div> : null}
			</section>
			</div>
		</>
	);
}

function TriggerEditor({
	trigger,
	onChange,
}: {
	trigger: AutomationTrigger;
	onChange: (trigger: AutomationTrigger) => void;
}) {
	const kind = trigger.kind;
	if (kind === "manual") return null;
	return (
		<>
			{trigger.kind === "once" ? (
				<label className="automation-field">
					<span>运行时间</span>
					<input
						type="datetime-local"
						value={toDateTimeLocal(trigger.at)}
						onChange={(event) => onChange({ kind: "once", at: fromDateTimeLocal(event.target.value) })}
					/>
				</label>
			) : null}
			{trigger.kind === "interval" ? (
				<label className="automation-field">
					<span>每隔（分钟）</span>
					<input
						type="number"
						min={1}
						value={Math.max(1, Math.round(trigger.everyMs / 60_000))}
						onChange={(event) => onChange({ kind: "interval", everyMs: Math.max(1, Number(event.target.value) || 1) * 60_000 })}
					/>
				</label>
			) : null}
			{trigger.kind === "daily" ? (
				<label className="automation-field">
					<span>时间</span>
					<input type="time" value={trigger.time} onChange={(event) => onChange({ kind: "daily", time: event.target.value || "09:00" })} />
				</label>
			) : null}
			{trigger.kind === "weekly" ? (
				<>
					<label className="automation-field">
						<span>时间</span>
						<input
							type="time"
							value={trigger.time}
							onChange={(event) => onChange({ ...trigger, time: event.target.value || "09:00" })}
						/>
					</label>
					<div className="automation-weekdays">
						{WEEKDAYS.map((day) => (
							<label key={day.value} className="automation-check-row compact">
								<input
									type="checkbox"
									checked={trigger.weekdays.includes(day.value)}
									onChange={(event) => {
										const next = event.target.checked
											? [...trigger.weekdays, day.value]
											: trigger.weekdays.filter((value) => value !== day.value);
										onChange({ ...trigger, weekdays: [...new Set(next)].sort((left, right) => left - right) });
									}}
								/>
								<span>{day.label}</span>
							</label>
						))}
					</div>
				</>
			) : null}
		</>
	);
}

function runStatusIcon(status: AutomationRunRecord["status"]) {
	switch (status) {
		case "running":
			return <Loader2 size={15} className="spin" />;
		case "succeeded":
			return <CheckCircle2 size={15} />;
		case "failed":
			return <CircleX size={15} />;
		case "cancelled":
			return <Ban size={15} />;
	}
}

function formatRunDuration(startedAt: string, finishedAt: string): string {
	const ms = Date.parse(finishedAt) - Date.parse(startedAt);
	if (!Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest ? `${minutes}m${rest}s` : `${minutes}m`;
}

function defaultTrigger(kind: AutomationTrigger["kind"]): AutomationTrigger {
	switch (kind) {
		case "manual":
			return { kind: "manual" };
		case "once":
			return { kind: "once", at: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
		case "interval":
			return { kind: "interval", everyMs: 60 * 60 * 1000 };
		case "daily":
			return { kind: "daily", time: "09:00" };
		case "weekly":
			return { kind: "weekly", weekdays: [1], time: "09:00" };
	}
}

function toDateTimeLocal(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	const offsetMs = date.getTimezoneOffset() * 60_000;
	return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function fromDateTimeLocal(value: string): string {
	if (!value) return new Date(Date.now() + 60 * 60 * 1000).toISOString();
	return new Date(value).toISOString();
}
