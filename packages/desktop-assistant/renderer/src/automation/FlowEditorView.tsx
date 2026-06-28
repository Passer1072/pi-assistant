import "@xyflow/react/dist/style.css";

import type React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Background, Connection, Controls, MiniMap, ReactFlow, useEdgesState, useNodesState } from "@xyflow/react";
import { LayoutGrid, Loader2, Minus, Play, Plus, Save, Send, Square, Trash2, X } from "lucide-react";
import type {
	AutomationDraft,
	AutomationDraftOperation,
	AutomationEditorLogEntry,
	AutomationProgressEvent,
	AutomationRunRecord,
	TimelineItem,
	FlowNode,
	FlowNodeKind,
} from "./types.ts";
import { createEmptyAutomationDraft, flowKindLabel } from "./types.ts";
import {
	type FlowGraphEdge,
	type FlowGraphNode,
	FLOW_NODE_TYPES,
	flowNodeColor,
	toFlowEdges,
	toFlowNodes,
} from "./FlowGraph.tsx";
import type { ChatMessageView } from "../../../src/shared/types.ts";
import { ConversationThread } from "../chat/ConversationThread.tsx";

const WINDOW_PARAMS = new URLSearchParams(window.location.search);
const QUERY_FLOW_ID = WINDOW_PARAMS.get("flowId") ?? undefined;
const NODE_KINDS: FlowNodeKind[] = ["start", "task", "condition", "loop", "wait", "end"];

export function FlowEditorView() {
	const [flowId, setFlowId] = useState<string | undefined>(QUERY_FLOW_ID);
	const [draft, setDraft] = useState<AutomationDraft>(() => createEmptyAutomationDraft());
	const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);
	const [statusText, setStatusText] = useState("");
	const [chatInput, setChatInput] = useState("");
	const [designMessages, setDesignMessages] = useState<ChatMessageView[]>([]);
	const [designTimeline, setDesignTimeline] = useState<TimelineItem[]>([]);
	const [designSessionId, setDesignSessionId] = useState<string | undefined>();
	const [designBusy, setDesignBusy] = useState(false);
	const [designStreaming, setDesignStreaming] = useState("");
	const [designStreamingThinking, setDesignStreamingThinking] = useState("");
	const chatScrollRef = useRef<HTMLDivElement | null>(null);
	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	// Set when the user interrupts a reply so the in-flight request resolving/rejecting afterward
	// is treated as an intentional stop rather than a real error.
	const designAbortedRef = useRef(false);
	const [runLogs, setRunLogs] = useState<AutomationEditorLogEntry[]>([]);
	const [activeNodeId, setActiveNodeId] = useState<string | undefined>();
	const [doneNodeIds, setDoneNodeIds] = useState<Set<string>>(() => new Set());
	const [activeRun, setActiveRun] = useState<AutomationRunRecord | undefined>();
	// True from the moment a test run is kicked off until the flow reports a terminal status.
	// Drives the Test→Interrupt button toggle and the live "running" canvas badge.
	const [running, setRunning] = useState(false);

	useEffect(() => {
		const load = async () => {
			if (!window.desktopAssistant?.automationDraftGet) return;
			const loaded = await window.desktopAssistant.automationDraftGet({ flowId: QUERY_FLOW_ID });
			applyDraft(loaded);
			// Start a brand-new design session and capture its id up front so the very first
			// reply can stream live. (Each editor open begins a fresh conversation.)
			const state = await window.desktopAssistant.automationDesignState?.();
			if (state) {
				setDesignSessionId(state.sessionId);
				setDesignMessages(state.messages);
				setDesignTimeline(state.timeline);
				setDesignStreaming(state.streamingText);
				setDesignStreamingThinking(state.streamingThinking);
			}
		};
		void load();
	}, []);

	useEffect(() => {
		if (!window.desktopAssistant?.onEvent) return undefined;
		return window.desktopAssistant.onEvent((event) => {
			if (event.type === "automation_draft_changed" && event.automationDraft) {
				if (flowId && event.automationDraft.flowId && event.automationDraft.flowId !== flowId) return;
				applyDraft(event.automationDraft);
				return;
			}
			if (event.type === "automation_progress" && event.automationProgress) {
				if (flowId && event.automationProgress.flowId !== flowId) return;
				applyProgress(event.automationProgress);
				return;
			}
			// Live-stream the design assistant's reply (its events are tagged with its sessionId).
			if (event.type === "streaming_text" && event.sessionId && event.sessionId === designSessionId) {
				setDesignStreaming(event.streamingText ?? "");
				return;
			}
			if (event.type === "streaming_thinking" && event.sessionId && event.sessionId === designSessionId) {
				setDesignStreamingThinking(event.streamingThinking ?? "");
				return;
			}
			if (event.type === "timeline" && event.sessionId && event.sessionId === designSessionId && event.timelineItem) {
				const item = event.timelineItem;
				if (item.kind === "thinking_summary") return;
				setDesignTimeline((current) => [...current.filter((existing) => existing.id !== item.id), item].slice(-200));
			}
		});
	}, [flowId, designSessionId]);

	useEffect(() => {
		const el = chatScrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [designMessages, designTimeline, designStreaming, designStreamingThinking, designBusy]);

	// Composer grows with content up to 5 rows, then scrolls — mirrors the main chat input.
	useLayoutEffect(() => {
		const el = composerRef.current;
		if (!el) return;
		const MAX_ROWS = 5;
		el.style.height = "auto";
		const style = window.getComputedStyle(el);
		const line = parseFloat(style.lineHeight) || 20;
		const max = line * MAX_ROWS + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
		el.style.height = `${Math.min(el.scrollHeight, max)}px`;
		el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
	}, [chatInput]);

	// React Flow owns the live node/edge state so dragging is smooth and never races the
	// async draft round-trip; the main-process draft stays the source of truth for content.
	const [rfNodes, setRfNodes, onRfNodesChange] = useNodesState<FlowGraphNode>([]);
	const [rfEdges, setRfEdges, onRfEdgesChange] = useEdgesState<FlowGraphEdge>([]);
	const selectedNode = draft.nodes.find((node) => node.id === selectedNodeId);

	useEffect(() => {
		setRfNodes(toFlowNodes(draft.nodes, activeNodeId, doneNodeIds));
	}, [draft.nodes, activeNodeId, doneNodeIds, setRfNodes]);
	useEffect(() => {
		setRfEdges(toFlowEdges(draft.edges));
	}, [draft.edges, setRfEdges]);

	const applyDraftOps = async (ops: AutomationDraftOperation[]) => {
		if (!window.desktopAssistant?.automationDraftApply) return;
		const next = await window.desktopAssistant.automationDraftApply({ ops });
		applyDraft(next);
	};

	// Persist node positions to the draft only when a drag finishes (not on every drag tick).
	const persistPositions = (moved: Array<{ id: string; position: { x: number; y: number } }>) => {
		const byId = new Map(draft.nodes.map((node) => [node.id, node]));
		const ops = moved.flatMap<AutomationDraftOperation>((node) => {
			const original = byId.get(node.id);
			if (original && original.position.x === node.position.x && original.position.y === node.position.y) return [];
			return [{ type: "update_node", id: node.id, update: { position: node.position } }];
		});
		if (ops.length > 0) void applyDraftOps(ops);
	};

	const updateMeta = async (patch: { name?: string; description?: string }) => {
		setDraft((current) => ({ ...current, ...patch, dirty: true }));
		await applyDraftOps([{ type: "set_meta", ...patch }]);
	};

	const patchNode = async (id: string, update: Partial<Omit<FlowNode, "id">>) => {
		await applyDraftOps([{ type: "update_node", id, update }]);
	};

	const addNode = async (kind: FlowNodeKind = "task") => {
		const nodeCount = draft.nodes.length;
		await applyDraftOps([
			{
				type: "add_node",
				node: {
					kind,
					label: `${flowKindLabel(kind)} ${nodeCount + 1}`,
					instruction: kind === "task" ? "描述要执行的桌面操作。" : undefined,
					position: { x: 120 + (nodeCount % 3) * 240, y: 140 + Math.floor(nodeCount / 3) * 160 },
				},
			},
		]);
	};

	const removeNode = async () => {
		if (!selectedNodeId) return;
		await applyDraftOps([{ type: "delete_node", id: selectedNodeId }]);
		setSelectedNodeId(undefined);
	};

	const save = async () => {
		if (!window.desktopAssistant?.automationDraftSave) return;
		setBusy(true);
		setStatusText("");
		try {
			const saved = await window.desktopAssistant.automationDraftSave({ flowId });
			setFlowId(saved.flow.id);
			applyDraft(saved.draft);
			setStatusText("草稿已保存。");
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const testRun = async () => {
		if (!window.desktopAssistant?.automationRun || running) return;
		setStatusText("");
		setRunLogs([]);
		setDoneNodeIds(new Set());
		setActiveNodeId(undefined);
		let runFlowId = flowId ?? draft.flowId;
		try {
			setBusy(true);
			if (!runFlowId || draft.dirty) {
				const saved = await window.desktopAssistant.automationDraftSave({ flowId: runFlowId });
				runFlowId = saved.flow.id;
				setFlowId(saved.flow.id);
				applyDraft(saved.draft);
			}
			// runAutomation now resolves as soon as the run starts (status "running"); the flow then
			// executes in the background and streams progress via automation_progress events.
			const response = await window.desktopAssistant.automationRun({ id: runFlowId, trigger: "test" });
			setActiveRun(response.run);
			setRunning(response.run.status === "running");
			addRunLog({
				id: response.run.id,
				timestamp: response.run.startedAt,
				message: response.run.summary ?? "测试运行已开始。",
				status: response.run.status,
			});
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
			setRunning(false);
		} finally {
			setBusy(false);
		}
	};

	const cancelRun = async () => {
		if (!window.desktopAssistant?.automationCancelRun) return;
		const id = flowId ?? draft.flowId;
		if (!id) return;
		setRunning(false);
		setActiveNodeId(undefined);
		try {
			const run = await window.desktopAssistant.automationCancelRun({ flowId: id, runId: activeRun?.id ?? id });
			if (run) setActiveRun(run);
			addRunLog({
				id: `cancel-${Date.now()}`,
				timestamp: new Date().toISOString(),
				message: "测试运行已中断。",
				status: "cancelled",
			});
		} catch (error) {
			setStatusText(error instanceof Error ? error.message : String(error));
		}
	};

	const sendDesignChat = async () => {
		if (!window.desktopAssistant?.automationDesignChat || designBusy) return;
		const message = chatInput.trim();
		if (!message) return;
		const optimisticOrder = Math.max(0, ...designMessages.map((item) => item.order), ...designTimeline.map((item) => item.order)) + 1;
		const optimistic: ChatMessageView = {
			id: `user-${Date.now()}`,
			role: "user",
			text: message,
			timestamp: Date.now(),
			order: optimisticOrder,
		};
		setDesignMessages((current) => [...current, optimistic]);
		setChatInput("");
		setDesignBusy(true);
		setDesignStreaming("");
		setDesignStreamingThinking("");
		setStatusText("");
		designAbortedRef.current = false;
		try {
			const response = await window.desktopAssistant.automationDesignChat({ flowId: flowId ?? draft.flowId, message });
			setDesignSessionId(response.sessionId);
			setDesignMessages(response.messages);
			setDesignTimeline(response.timeline);
			setDesignStreaming(response.streamingText);
			setDesignStreamingThinking(response.streamingThinking);
			applyDraft(response.snapshot);
		} catch (error) {
			// A user-initiated interrupt may surface here as a rejection — that's not a real error.
			if (!designAbortedRef.current) {
				const text = error instanceof Error ? error.message : String(error);
				setStatusText(text);
				setDesignMessages((current) => [
					...current,
					{ id: `error-${Date.now()}`, role: "system", text: `出错：${text}`, timestamp: Date.now(), order: Date.now() },
				]);
			}
		} finally {
			setDesignBusy(false);
			setDesignStreaming("");
			setDesignStreamingThinking("");
			designAbortedRef.current = false;
		}
	};

	// Interrupt the design assistant mid-reply, mirroring the main chat's stop control. The
	// in-flight automationDesignChat promise then resolves with whatever was produced so far.
	const abortDesignChat = async () => {
		if (!window.desktopAssistant?.abort || !designSessionId) return;
		designAbortedRef.current = true;
		try {
			await window.desktopAssistant.abort({ sessionId: designSessionId });
		} catch (error) {
			console.warn("Abort design chat failed:", error);
		}
	};

	const closeEditor = () => {
		if (draft.dirty && !window.confirm("放弃未保存的流程图修改？")) return;
		window.desktopAssistant?.closeWindow?.();
	};

	return (
		<div className="automation-editor-screen">
			<div className="titlebar" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
				<div className="title-label">流程图编辑器</div>
				<div className="title-window-controls" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
					<button className="title-btn" onClick={() => window.desktopAssistant?.minimizeWindow?.()} type="button" aria-label="最小化窗口">
						<Minus size={14} />
					</button>
					<button className="title-btn danger" onClick={closeEditor} type="button" aria-label="关闭编辑器">
						<X size={14} />
					</button>
				</div>
			</div>

			<div className="automation-editor-shell">
				<section className="automation-editor-canvas">
					<div className="automation-editor-toolbar">
						<div className="automation-editor-title-group">
							<input
								type="text"
								value={draft.name}
								className="automation-editor-title"
								placeholder="流程名称"
								onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value, dirty: true }))}
								onBlur={(event) => void updateMeta({ name: event.target.value })}
							/>
							<span>{draft.dirty ? "未保存" : "已保存"}</span>
						</div>
						<div className="automation-editor-toolbar-actions">
							<button type="button" className="automation-ghost-btn" onClick={() => void addNode()}>
								<Plus size={14} />
								<span>添加节点</span>
							</button>
							<button type="button" className="automation-ghost-btn" onClick={() => void applyDraftOps([{ type: "autolayout" }])}>
								<LayoutGrid size={14} />
								<span>自动布局</span>
							</button>
							<button type="button" className="automation-primary-btn" onClick={() => void save()} disabled={busy || !draft.name.trim()}>
								<Save size={14} />
								<span>保存</span>
							</button>
							{running ? (
								<button type="button" className="automation-danger-btn" onClick={() => void cancelRun()}>
									<Square size={14} />
									<span>中断</span>
								</button>
							) : (
								<button
									type="button"
									className="automation-primary-btn"
									onClick={() => void testRun()}
									disabled={busy || !draft.name.trim()}
								>
									<Play size={14} />
									<span>测试</span>
								</button>
							)}
						</div>
					</div>

					<div className="automation-editor-canvas-frame">
						{running ? (
							<div className="automation-run-badge">
								<Loader2 size={13} className="spin" />
								<span>运行中{activeNodeId ? ` · ${draft.nodes.find((node) => node.id === activeNodeId)?.label ?? activeNodeId}` : ""}</span>
							</div>
						) : null}
						<ReactFlow
							nodes={rfNodes}
							edges={rfEdges}
							nodeTypes={FLOW_NODE_TYPES}
							onNodesChange={onRfNodesChange}
							onEdgesChange={onRfEdgesChange}
							onNodeDragStop={(_, node) => persistPositions([node])}
							onSelectionDragStop={(_, draggedNodes) => persistPositions(draggedNodes)}
							onNodesDelete={(deleted) => {
								void applyDraftOps(deleted.map((node) => ({ type: "delete_node", id: node.id })));
							}}
							onEdgesDelete={(deleted) => {
								void applyDraftOps(deleted.map((edge) => ({ type: "disconnect", id: edge.id })));
							}}
							onConnect={(connection: Connection) => {
								if (!connection.source || !connection.target) return;
								void applyDraftOps([
									{ type: "connect", edge: { id: `${connection.source}-${connection.target}-${Date.now()}`, source: connection.source, target: connection.target } },
								]);
							}}
							onSelectionChange={({ nodes: selectedNodes }) => setSelectedNodeId(selectedNodes[0]?.id)}
							onNodeClick={(_, node) => setSelectedNodeId(node.id)}
							fitView
							proOptions={{ hideAttribution: true }}
							defaultEdgeOptions={{ animated: true }}
							colorMode="dark"
						>
							<Background color="rgba(255,255,255,0.08)" gap={24} />
							<MiniMap
								pannable
								zoomable
								maskColor="rgba(8, 10, 16, 0.45)"
								nodeColor={(node) => flowNodeColor((node.data as FlowGraphNode["data"]).kind)}
								className="automation-editor-minimap"
							/>
							<Controls className="automation-editor-controls" />
						</ReactFlow>
					</div>

					<div className={`automation-run-log ${runLogs.length > 0 ? "open" : ""}`}>
						<div className="automation-panel-title">测试日志</div>
						{runLogs.length > 0 ? (
							<div className="automation-run-log-list">
								{runLogs.map((entry) => (
									<div key={entry.id} className={`automation-run-log-entry status-${entry.status ?? "running"}`}>
										<span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
										<strong>{entry.nodeId ?? "运行"}</strong>
										<p>{entry.message}</p>
									</div>
								))}
							</div>
						) : (
							<p>运行测试以查看节点进度和分支选择。</p>
						)}
					</div>
				</section>

				<aside className="automation-editor-sidepanel">
					<section className="automation-editor-panel">
						<div className="automation-panel-title">流程详情</div>
						<label className="automation-field">
							<span>描述</span>
							<textarea
								rows={3}
								value={draft.description}
								onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value, dirty: true }))}
								onBlur={(event) => void updateMeta({ description: event.target.value })}
							/>
						</label>
					</section>

					<section className="automation-editor-panel props">
						<div className="automation-panel-title">节点属性</div>
						{selectedNode ? (
							<>
								<label className="automation-field">
									<span>标签</span>
									<input
										type="text"
										value={selectedNode.label}
										onChange={(event) =>
											setDraft((current) => ({
												...current,
												nodes: current.nodes.map((node) =>
													node.id === selectedNode.id ? { ...node, label: event.target.value } : node,
												),
												dirty: true,
											}))
										}
										onBlur={(event) => void patchNode(selectedNode.id, { label: event.target.value })}
									/>
								</label>
								<label className="automation-field">
									<span>类型</span>
									<select
										value={selectedNode.kind}
										onChange={(event) => void patchNode(selectedNode.id, { kind: event.target.value as FlowNodeKind })}
									>
										{NODE_KINDS.map((kind) => (
											<option key={kind} value={kind}>
												{flowKindLabel(kind)}
											</option>
										))}
									</select>
								</label>
								<label className="automation-field">
									<span>指令</span>
									<textarea
										rows={3}
										value={selectedNode.instruction ?? ""}
										onChange={(event) =>
											setDraft((current) => ({
												...current,
												nodes: current.nodes.map((node) =>
													node.id === selectedNode.id ? { ...node, instruction: event.target.value } : node,
												),
												dirty: true,
											}))
										}
										onBlur={(event) => void patchNode(selectedNode.id, { instruction: event.target.value || undefined })}
									/>
								</label>
								{selectedNode.kind === "wait" ? (
									<label className="automation-field">
										<span>等待（毫秒）</span>
										<input
											type="number"
											min={0}
											value={selectedNode.config?.waitMs ?? ""}
											onChange={(event) =>
												void patchNode(selectedNode.id, {
													config: { ...selectedNode.config, waitMs: Number(event.target.value) || undefined },
												})
											}
										/>
									</label>
								) : null}
								{selectedNode.kind === "loop" ? (
									<label className="automation-field">
										<span>最大循环次数</span>
										<input
											type="number"
											min={1}
											value={selectedNode.config?.loopMaxIterations ?? ""}
											onChange={(event) =>
												void patchNode(selectedNode.id, {
													config: {
														...selectedNode.config,
														loopMaxIterations: Number(event.target.value) || undefined,
													},
												})
											}
										/>
									</label>
								) : null}
								<button type="button" className="automation-danger-btn wide" onClick={() => void removeNode()}>
									<Trash2 size={14} />
									<span>删除节点</span>
								</button>
							</>
						) : (
							<div className="automation-empty compact">
								<LayoutGrid size={28} />
								<p>选择一个节点以编辑属性。</p>
							</div>
						)}
					</section>

					<section className="automation-editor-panel chat">
						<div className="automation-panel-title">AI 设计对话</div>
						<div className="automation-chat-thread" ref={chatScrollRef}>
							{designMessages.length === 0 && !designBusy ? (
								<div className="automation-chat-hint">
									向设计助手描述需求（包含触发频率与具体步骤），它会主动提问澄清，并直接帮你绘制流程图。
								</div>
							) : (
								<ConversationThread
									messages={designMessages}
									timeline={designTimeline}
									isRunning={designBusy}
									streamingText={designStreaming}
									streamingThinking={designStreamingThinking}
								/>
							)}
						</div>
						<form
							className="automation-composer"
							onSubmit={(event) => {
								event.preventDefault();
								void sendDesignChat();
							}}
						>
							<textarea
								ref={composerRef}
								className="automation-composer-input"
								rows={1}
								value={chatInput}
								placeholder="描述需求，让 AI 帮你画流程…"
								onChange={(event) => setChatInput(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey) {
										event.preventDefault();
										void sendDesignChat();
									}
								}}
							/>
							{designBusy ? (
								<button
									type="button"
									className="automation-composer-send stop"
									onClick={() => void abortDesignChat()}
									aria-label="中断回复"
									title="中断回复"
								>
									<Square size={15} />
								</button>
							) : (
								<button
									type="submit"
									className="automation-composer-send"
									disabled={!chatInput.trim()}
									aria-label="发送给设计助手"
									title="发送给设计助手"
								>
									<Send size={16} />
								</button>
							)}
						</form>
					</section>
					{statusText ? <div className="automation-status-text">{statusText}</div> : null}
				</aside>
			</div>
		</div>
	);

	function applyDraft(next: AutomationDraft) {
		setFlowId(next.flowId);
		setDraft(next);
	}

	function addRunLog(entry: AutomationEditorLogEntry) {
		setRunLogs((current) => [entry, ...current].slice(0, 40));
	}

	function applyProgress(progress: AutomationProgressEvent) {
		const status = progress.status ?? "running";
		if (progress.kind === "step" && progress.nodeId) {
			if (progress.phase === "enter") setActiveNodeId(progress.nodeId);
			if (progress.phase === "done") {
				setDoneNodeIds((current) => new Set([...current, progress.nodeId as string]));
			}
		}
		if (progress.kind === "finish" && progress.status) {
			setActiveRun((current) => (current ? { ...current, status: progress.status as AutomationRunRecord["status"], summary: progress.summary } : current));
			setActiveNodeId(undefined);
			setRunning(false);
		}
		addRunLog({
			id: `${progress.kind}-${progress.nodeId ?? progress.runId}-${Date.now()}`,
			timestamp: progress.timestamp,
			nodeId: progress.nodeId,
			status,
			message: progress.summary ?? progress.message ?? progress.choice ?? `${progress.kind} ${progress.phase ?? ""}`.trim(),
		});
	}
}
