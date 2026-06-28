import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
	AutomationCancelRunRequest,
	AutomationCreateRequest,
	AutomationDraftOperation,
	AutomationFlow,
	AutomationGetRequest,
	AutomationListResponse,
	AutomationOpenEditorRequest,
	AutomationRunRecord,
	AutomationRunRequest,
	AutomationRunResponse,
	AutomationSetEnabledRequest,
	AutomationTrigger,
	AutomationUpdateRequest,
	DesktopToolResult,
	FlowEdge,
	FlowNode,
} from "../shared/types.ts";
import { AutomationDraftSession } from "./automation-draft-session.ts";

/**
 * The slice of {@link ../agent/desktop-agent-service.ts} that the automation
 * bridge tools drive. Everything goes through the service (not the repository)
 * so the scheduler stays armed and every window gets its "automation_changed"
 * event. These tools let *normal chat* see and operate the Automation module —
 * the visual flow editor's own assistant keeps its richer `flow_*` tools.
 */
export interface AutomationBridgeToolHost {
	listAutomations(): AutomationListResponse;
	getAutomation(request: AutomationGetRequest): AutomationFlow | undefined;
	runAutomation(request: AutomationRunRequest): Promise<AutomationRunResponse>;
	cancelAutomationRun(request: AutomationCancelRunRequest): boolean;
	setAutomationEnabled(request: AutomationSetEnabledRequest): AutomationFlow;
	createAutomation(request: AutomationCreateRequest): AutomationFlow;
	updateAutomation(request: AutomationUpdateRequest): AutomationFlow;
	openAutomationEditor(request?: AutomationOpenEditorRequest): Promise<void>;
}

export const AUTOMATION_BRIDGE_TOOL_NAMES = [
	"automation_list",
	"automation_get",
	"automation_run",
	"automation_status",
	"automation_cancel",
	"automation_set_enabled",
	"automation_create_draft",
	"automation_edit",
	"automation_open_editor",
] as const;

const LONG_POLL_INTERVAL_MS = 3_000;
const LONG_POLL_TIMEOUT_MS = 60_000;

const AUTOMATION_GUIDELINES = [
	"After automation_run, prefer automation_status with waitForChange=true. If you must check manually, call wait first and do not poll more frequently than about 10-15 seconds.",
	"During long automation waits, do not send repetitive user updates for every status check. Report only meaningful progress, completion, or errors.",
	"这些工具连接『自动化』模块（可视化流程编排）。仅在用户明确想查看 / 运行 / 管理自动化流程时使用。",
	"automation_run 会真正执行流程，可能产生实际副作用（操作软件、文件、网络等）。触发前先与用户确认要运行哪个流程，并复述其名称。",
	"运行是后台异步的：automation_run 立即返回 runId 与 running 状态，之后用 automation_status 轮询进度 / 结果，不要假定已经完成。",
	"用 name 定位时如果有多个匹配，先向用户澄清是哪一个，不要随意挑选。",
	"automation_create_draft 只创建一个停用状态的草稿并打开编辑器，让用户继续细化；它不会自动启用或运行。",
];

const AUTOMATION_TOOL_GUIDELINES = [
	...AUTOMATION_GUIDELINES,
	"Before editing an existing automation, call automation_get to read the full graph and node/edge ids; then use automation_edit. Do not use automation_create_draft as a substitute for editing an existing flow.",
	"automation_edit only saves the flow definition. It does not run the automation and does not enable a disabled automation.",
];

const AUTOMATION_TRIGGER_SCHEMA = Type.Union([
	Type.Object({ kind: Type.Literal("manual") }),
	Type.Object({ kind: Type.Literal("once"), at: Type.String() }),
	Type.Object({ kind: Type.Literal("interval"), everyMs: Type.Number() }),
	Type.Object({ kind: Type.Literal("daily"), time: Type.String() }),
	Type.Object({ kind: Type.Literal("weekly"), weekdays: Type.Array(Type.Number()), time: Type.String() }),
]);

const AUTOMATION_RUN_POLICY_SCHEMA = Type.Object({
	permissionMode: Type.Optional(
		Type.Union([
			Type.Literal("tiered"),
			Type.Literal("automatic"),
			Type.Literal("sandbox"),
			Type.Literal("full_access"),
		]),
	),
	thinkingLevel: Type.Optional(
		Type.Union([
			Type.Literal("off"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("xhigh"),
		]),
	),
});

const NODE_KIND = Type.Union([
	Type.Literal("start"),
	Type.Literal("task"),
	Type.Literal("condition"),
	Type.Literal("loop"),
	Type.Literal("wait"),
	Type.Literal("end"),
]);

const FLOW_POSITION_SCHEMA = Type.Object({ x: Type.Number(), y: Type.Number() });

const FLOW_NODE_CONFIG_SCHEMA = Type.Object({
	waitMs: Type.Optional(Type.Number()),
	loopMaxIterations: Type.Optional(Type.Number()),
});

const FLOW_NODE_INPUT_SCHEMA = Type.Object({
	id: Type.Optional(Type.String()),
	kind: NODE_KIND,
	label: Type.String(),
	instruction: Type.Optional(Type.String()),
	config: Type.Optional(FLOW_NODE_CONFIG_SCHEMA),
	position: Type.Optional(FLOW_POSITION_SCHEMA),
});

const FLOW_NODE_UPDATE_SCHEMA = Type.Object({
	kind: Type.Optional(NODE_KIND),
	label: Type.Optional(Type.String()),
	instruction: Type.Optional(Type.String()),
	config: Type.Optional(FLOW_NODE_CONFIG_SCHEMA),
	position: Type.Optional(FLOW_POSITION_SCHEMA),
});

const FLOW_EDGE_INPUT_SCHEMA = Type.Object({
	id: Type.Optional(Type.String()),
	source: Type.String(),
	target: Type.String(),
	label: Type.Optional(Type.String()),
});

const AUTOMATION_DRAFT_OPERATION_SCHEMA = Type.Union([
	Type.Object({
		type: Type.Literal("replace"),
		draft: Type.Object({
			name: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			nodes: Type.Array(FLOW_NODE_INPUT_SCHEMA),
			edges: Type.Array(FLOW_EDGE_INPUT_SCHEMA),
			trigger: Type.Optional(AUTOMATION_TRIGGER_SCHEMA),
			runPolicy: Type.Optional(AUTOMATION_RUN_POLICY_SCHEMA),
		}),
	}),
	Type.Object({
		type: Type.Literal("set_meta"),
		name: Type.Optional(Type.String()),
		description: Type.Optional(Type.String()),
		trigger: Type.Optional(AUTOMATION_TRIGGER_SCHEMA),
		runPolicy: Type.Optional(AUTOMATION_RUN_POLICY_SCHEMA),
	}),
	Type.Object({ type: Type.Literal("add_node"), node: FLOW_NODE_INPUT_SCHEMA }),
	Type.Object({ type: Type.Literal("update_node"), id: Type.String(), update: FLOW_NODE_UPDATE_SCHEMA }),
	Type.Object({ type: Type.Literal("delete_node"), id: Type.String() }),
	Type.Object({ type: Type.Literal("connect"), edge: FLOW_EDGE_INPUT_SCHEMA }),
	Type.Object({ type: Type.Literal("disconnect"), id: Type.String() }),
	Type.Object({ type: Type.Literal("autolayout") }),
]);

export function createAutomationBridgeToolDefinitions(host: AutomationBridgeToolHost): ToolDefinition[] {
	return [
		defineTool({
			name: "automation_list",
			label: "List automations",
			description:
				"List the user's automation flows with their id, name, enabled state, trigger, last-run status and next scheduled time.",
			promptSnippet: "List or summarize the user's automation flows, e.g. when asked what automations exist.",
			promptGuidelines: AUTOMATION_TOOL_GUIDELINES,
			parameters: Type.Object({}),
			execute: async () =>
				bridgeResult("List automations", "automation_list", "all", "low", () => {
					const { flows, summary } = host.listAutomations();
					return { summary, flows: flows.map(summarizeFlow) };
				}),
		}),
		defineTool({
			name: "automation_get",
			label: "Get automation flow",
			description:
				"Read a full automation flow by id or unique name match, including nodes, edges, trigger and run policy.",
			promptSnippet:
				"Read an existing automation's full graph before editing it, especially to get node and edge ids.",
			promptGuidelines: AUTOMATION_TOOL_GUIDELINES,
			parameters: Type.Object({
				id: Type.Optional(Type.String({ description: "Flow id. Provide id or name." })),
				name: Type.Optional(Type.String({ description: "Flow name (exact or partial). Provide id or name." })),
			}),
			execute: async (_id, params) =>
				bridgeResult("Get automation", "automation_get", params.id ?? params.name ?? "", "low", () => {
					const flow = resolveFlow(host, params);
					return fullFlowSnapshot(flow);
				}),
		}),
		defineTool({
			name: "automation_run",
			label: "Run automation",
			description:
				"Trigger an automation flow to run now, located by id or name. Returns immediately with a runId; the flow then runs in the background.",
			promptSnippet: "Run / trigger / start an automation flow on the user's request.",
			promptGuidelines: AUTOMATION_TOOL_GUIDELINES,
			parameters: Type.Object({
				id: Type.Optional(Type.String({ description: "Flow id. Provide id or name." })),
				name: Type.Optional(Type.String({ description: "Flow name (exact or partial). Provide id or name." })),
			}),
			execute: async (_id, params) =>
				bridgeResult("Run automation", "automation_run", params.id ?? params.name ?? "", "medium", async () => {
					const flow = resolveFlow(host, params);
					const { run } = await host.runAutomation({ id: flow.id, trigger: "manual" });
					return {
						flowId: flow.id,
						name: flow.name,
						runId: run.id,
						status: run.status,
						message: `已在后台启动「${flow.name}」，用 automation_status 查询进度。`,
					};
				}),
		}),
		defineTool({
			name: "automation_status",
			label: "Automation status",
			description:
				"Check an automation's run status — its latest run plus recent run history, or a specific run by runId.",
			promptSnippet: "Check whether an automation finished, succeeded, failed, or is still running.",
			promptGuidelines: AUTOMATION_TOOL_GUIDELINES,
			parameters: Type.Object({
				id: Type.Optional(Type.String({ description: "Flow id. Provide id or name." })),
				name: Type.Optional(Type.String({ description: "Flow name (exact or partial). Provide id or name." })),
				runId: Type.Optional(Type.String({ description: "Specific run id to inspect (optional)." })),
				waitForChange: Type.Optional(
					Type.Boolean({
						description:
							"Block server-side until the watched run changes, finishes, or about 60 seconds. Prefer true for running automations.",
					}),
				),
			}),
			execute: async (_id, params, signal) =>
				bridgeResult("Automation status", "automation_status", params.id ?? params.name ?? "", "low", () => {
					if (params.waitForChange) return waitForAutomationStatusChange(host, params, signal);
					const flow = resolveFlow(host, params);
					if (params.runId) {
						const run = flow.runs.find((item) => item.id === params.runId) ?? flow.lastRun;
						if (!run || run.id !== params.runId) throw new Error(`未找到该流程下的运行记录：${params.runId}`);
						return { flowId: flow.id, name: flow.name, run: summarizeRun(run) };
					}
					return {
						flowId: flow.id,
						name: flow.name,
						enabled: flow.enabled,
						running: flow.lastRun?.status === "running",
						nextRunAt: flow.nextRunAt,
						lastRun: summarizeRun(flow.lastRun),
						recentRuns: flow.runs.slice(0, 5).map(summarizeRun),
					};
				}),
		}),
		defineTool({
			name: "automation_cancel",
			label: "Cancel automation run",
			description: "Cancel the in-progress run of an automation flow, located by id or name.",
			promptSnippet: "Stop / cancel / interrupt a running automation.",
			promptGuidelines: AUTOMATION_TOOL_GUIDELINES,
			parameters: Type.Object({
				id: Type.Optional(Type.String({ description: "Flow id. Provide id or name." })),
				name: Type.Optional(Type.String({ description: "Flow name (exact or partial). Provide id or name." })),
			}),
			execute: async (_id, params) =>
				bridgeResult("Cancel automation run", "automation_cancel", params.id ?? params.name ?? "", "low", () => {
					const flow = resolveFlow(host, params);
					const cancelled = host.cancelAutomationRun({ flowId: flow.id });
					return {
						flowId: flow.id,
						name: flow.name,
						cancelled,
						message: cancelled ? `已取消「${flow.name}」的运行。` : `「${flow.name}」当前没有正在运行的任务。`,
					};
				}),
		}),
		defineTool({
			name: "automation_set_enabled",
			label: "Enable/disable automation",
			description:
				"Enable or disable an automation flow. Disabling stops its scheduled triggers; enabling re-arms them.",
			promptSnippet: "Turn an automation on or off (pause/resume its schedule).",
			promptGuidelines: AUTOMATION_TOOL_GUIDELINES,
			parameters: Type.Object({
				id: Type.Optional(Type.String({ description: "Flow id. Provide id or name." })),
				name: Type.Optional(Type.String({ description: "Flow name (exact or partial). Provide id or name." })),
				enabled: Type.Boolean({ description: "true to enable, false to disable." }),
			}),
			execute: async (_id, params) =>
				bridgeResult(
					params.enabled ? "Enable automation" : "Disable automation",
					"automation_set_enabled",
					params.id ?? params.name ?? "",
					"medium",
					() => {
						const flow = resolveFlow(host, params);
						const updated = host.setAutomationEnabled({ id: flow.id, enabled: params.enabled });
						return summarizeFlow(updated);
					},
				),
		}),
		defineTool({
			name: "automation_create_draft",
			label: "Draft automation",
			description:
				"Create a new disabled draft automation from a name and optional ordered steps, then open the flow editor so the user can refine it. Does not run or enable it.",
			promptSnippet: "Draft / scaffold a new automation flow from a description, to refine in the editor.",
			promptGuidelines: AUTOMATION_TOOL_GUIDELINES,
			parameters: Type.Object({
				name: Type.String({ description: "Automation name." }),
				description: Type.Optional(Type.String({ description: "What the automation should accomplish." })),
				steps: Type.Optional(
					Type.Array(Type.String({ description: "One step instruction." }), {
						description: "Ordered task steps; each becomes a task node chained start -> ... -> end.",
					}),
				),
				openEditor: Type.Optional(Type.Boolean({ description: "Open the editor after creating. Default true." })),
			}),
			execute: async (_id, params) =>
				bridgeResult("Draft automation", "automation_create_draft", params.name, "medium", async () => {
					const { nodes, edges } = buildDraftGraph(params.steps ?? []);
					const flow = host.createAutomation({
						name: params.name,
						description: params.description,
						nodes,
						edges,
						enabled: false,
					});
					const openEditor = params.openEditor !== false;
					if (openEditor) await host.openAutomationEditor({ flowId: flow.id });
					return {
						flowId: flow.id,
						name: flow.name,
						nodeCount: flow.nodes.length,
						editorOpened: openEditor,
						message: openEditor
							? `已创建草稿「${flow.name}」并打开编辑器，请继续细化。`
							: `已创建草稿「${flow.name}」（停用状态）。`,
					};
				}),
		}),
		defineTool({
			name: "automation_edit",
			label: "Edit automation flow",
			description:
				"Edit and save an existing automation flow graph by id or unique name match using AutomationDraftOperation ops. Does not run or enable the flow.",
			promptSnippet:
				"Directly edit an existing automation flow in normal chat after reading its graph with automation_get.",
			promptGuidelines: AUTOMATION_TOOL_GUIDELINES,
			parameters: Type.Object({
				id: Type.Optional(Type.String({ description: "Flow id. Provide id or name." })),
				name: Type.Optional(Type.String({ description: "Flow name (exact or partial). Provide id or name." })),
				ops: Type.Array(AUTOMATION_DRAFT_OPERATION_SCHEMA, {
					description: "Draft operations to apply to the existing flow.",
				}),
				openEditor: Type.Optional(
					Type.Boolean({ description: "Open the visual editor for the edited flow after saving. Default false." }),
				),
			}),
			execute: async (_id, params) =>
				bridgeResult("Edit automation", "automation_edit", params.id ?? params.name ?? "", "medium", async () => {
					const flow = resolveFlow(host, params);
					const draftSession = new AutomationDraftSession(() => undefined);
					draftSession.loadFromFlow(flow);
					const draft = draftSession.applyOps(params.ops as AutomationDraftOperation[]);
					const updated = host.updateAutomation({
						id: flow.id,
						name: draft.name,
						description: draft.description,
						nodes: draft.nodes,
						edges: draft.edges,
						trigger: draft.trigger,
						runPolicy: draft.runPolicy,
					});
					const openEditor = params.openEditor === true;
					if (openEditor) await host.openAutomationEditor({ flowId: updated.id });
					return {
						flowId: updated.id,
						name: updated.name,
						nodeCount: updated.nodes.length,
						edgeCount: updated.edges.length,
						nodes: updated.nodes,
						edges: updated.edges,
						trigger: updated.trigger,
						runPolicy: updated.runPolicy,
						editorOpened: openEditor,
					};
				}),
		}),
		defineTool({
			name: "automation_open_editor",
			label: "Open automation editor",
			description: "Open the visual flow editor — for an existing flow (by id or name) or a blank new flow.",
			promptSnippet: "Open the automation editor so the user can edit a flow visually.",
			promptGuidelines: AUTOMATION_TOOL_GUIDELINES,
			parameters: Type.Object({
				id: Type.Optional(Type.String({ description: "Flow id to open. Omit (with name) for a blank new flow." })),
				name: Type.Optional(Type.String({ description: "Flow name (exact or partial) to open." })),
			}),
			execute: async (_id, params) =>
				bridgeResult(
					"Open automation editor",
					"automation_open_editor",
					params.id ?? params.name ?? "new",
					"low",
					async () => {
						if (!params.id && !params.name) {
							await host.openAutomationEditor({});
							return { editorOpened: true, message: "已打开新建自动化的编辑器。" };
						}
						const flow = resolveFlow(host, params);
						await host.openAutomationEditor({ flowId: flow.id });
						return {
							flowId: flow.id,
							name: flow.name,
							editorOpened: true,
							message: `已打开「${flow.name}」的编辑器。`,
						};
					},
				),
		}),
	];
}

/** Resolve a flow by explicit id, then exact name, then unique partial name; throws a helpful error otherwise. */
function resolveFlow(host: AutomationBridgeToolHost, params: { id?: string; name?: string }): AutomationFlow {
	if (params.id) {
		const flow = host.getAutomation({ id: params.id });
		if (flow) return flow;
		throw new Error(`未找到 id 为 ${params.id} 的自动化流程。`);
	}
	const name = params.name?.trim();
	if (!name) throw new Error("请提供自动化流程的 id 或 name。");
	const flows = host.listAutomations().flows;
	if (flows.length === 0) throw new Error("当前还没有任何自动化流程。");
	const lower = name.toLowerCase();
	const exact = flows.filter((flow) => flow.name.trim().toLowerCase() === lower);
	if (exact.length === 1) return exact[0];
	if (exact.length > 1) throw ambiguous(exact);
	const partial = flows.filter((flow) => flow.name.toLowerCase().includes(lower));
	if (partial.length === 1) return partial[0];
	if (partial.length > 1) throw ambiguous(partial);
	throw new Error(
		`未找到名为「${name}」的自动化流程。现有流程：${flows.map((flow) => flow.name).join("、") || "（无）"}`,
	);
}

function ambiguous(flows: AutomationFlow[]): Error {
	const list = flows.map((flow) => `${flow.name} (${flow.id})`).join("；");
	return new Error(`匹配到多个自动化流程，请用 id 指定其一：${list}`);
}

function fullFlowSnapshot(flow: AutomationFlow) {
	return {
		id: flow.id,
		name: flow.name,
		description: flow.description,
		enabled: flow.enabled,
		trigger: flow.trigger,
		runPolicy: flow.runPolicy,
		nodes: flow.nodes,
		edges: flow.edges,
		nodeCount: flow.nodes.length,
		edgeCount: flow.edges.length,
		running: flow.lastRun?.status === "running",
		nextRunAt: flow.nextRunAt,
		lastRun: summarizeRun(flow.lastRun),
		createdAt: flow.createdAt,
		updatedAt: flow.updatedAt,
	};
}

function delayAbortable(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new Error("Aborted"));
	return new Promise((resolve, reject) => {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => {
			finish();
			reject(new Error("Aborted"));
		};
		const finish = () => {
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		};
		timeout = setTimeout(() => {
			finish();
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function automationStatusSnapshot(
	flow: AutomationFlow,
	params: { runId?: string },
): {
	flowId: string;
	name: string;
	enabled?: boolean;
	running?: boolean;
	nextRunAt?: string;
	lastRun?: ReturnType<typeof summarizeRun>;
	recentRuns?: Array<ReturnType<typeof summarizeRun>>;
	run?: ReturnType<typeof summarizeRun>;
} {
	if (params.runId) {
		const run = flow.runs.find((item) => item.id === params.runId) ?? flow.lastRun;
		if (!run || run.id !== params.runId) throw new Error(`Run not found in this automation: ${params.runId}`);
		return { flowId: flow.id, name: flow.name, run: summarizeRun(run) };
	}
	return {
		flowId: flow.id,
		name: flow.name,
		enabled: flow.enabled,
		running: flow.lastRun?.status === "running",
		nextRunAt: flow.nextRunAt,
		lastRun: summarizeRun(flow.lastRun),
		recentRuns: flow.runs.slice(0, 5).map(summarizeRun),
	};
}

function automationStatusKey(snapshot: ReturnType<typeof automationStatusSnapshot>): string {
	return JSON.stringify(snapshot);
}

function isAutomationTerminal(snapshot: ReturnType<typeof automationStatusSnapshot>): boolean {
	const status = snapshot.run?.status ?? snapshot.lastRun?.status;
	return status === "succeeded" || status === "failed" || status === "cancelled";
}

async function waitForAutomationStatusChange(
	host: AutomationBridgeToolHost,
	params: { id?: string; name?: string; runId?: string },
	signal: AbortSignal | undefined,
) {
	const startedAt = Date.now();
	let flow = resolveFlow(host, params);
	const initial = automationStatusSnapshot(flow, params);
	const initialKey = automationStatusKey(initial);
	if (isAutomationTerminal(initial)) return initial;
	while (Date.now() - startedAt < LONG_POLL_TIMEOUT_MS) {
		await delayAbortable(LONG_POLL_INTERVAL_MS, signal);
		flow = resolveFlow(host, params);
		const current = automationStatusSnapshot(flow, params);
		if (automationStatusKey(current) !== initialKey || isAutomationTerminal(current)) return current;
	}
	return automationStatusSnapshot(flow, params);
}

function summarizeFlow(flow: AutomationFlow) {
	return {
		id: flow.id,
		name: flow.name,
		description: flow.description || undefined,
		enabled: flow.enabled,
		trigger: describeTrigger(flow.trigger),
		running: flow.lastRun?.status === "running",
		nodeCount: flow.nodes.length,
		nextRunAt: flow.nextRunAt,
		lastRun: summarizeRun(flow.lastRun),
	};
}

function summarizeRun(run: AutomationRunRecord | undefined) {
	if (!run) return undefined;
	return {
		id: run.id,
		status: run.status,
		trigger: run.trigger,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		summary: run.summary,
		error: run.error,
	};
}

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function describeTrigger(trigger: AutomationTrigger): string {
	switch (trigger.kind) {
		case "manual":
			return "手动触发";
		case "once":
			return `一次性 @ ${trigger.at}`;
		case "interval":
			return `每 ${Math.round(trigger.everyMs / 60_000)} 分钟`;
		case "daily":
			return `每天 ${trigger.time}`;
		case "weekly":
			return `每周 ${trigger.weekdays.map((day) => WEEKDAY_LABELS[day] ?? day).join("、")} ${trigger.time}`;
		default:
			return "未知";
	}
}

/** Build a linear start -> task* -> end graph for a draft, with simple left-to-right placement. */
function buildDraftGraph(steps: string[]): { nodes: FlowNode[]; edges: FlowEdge[] } {
	const gapX = 260;
	const nodes: FlowNode[] = [{ id: "start", kind: "start", label: "开始", position: { x: 0, y: 0 } }];
	const taskIds: string[] = [];
	steps.forEach((step, index) => {
		const text = step.trim();
		if (!text) return;
		const id = `task-${index + 1}`;
		taskIds.push(id);
		nodes.push({
			id,
			kind: "task",
			label: text.length > 40 ? `${text.slice(0, 40)}…` : text,
			instruction: text,
			position: { x: taskIds.length * gapX, y: 0 },
		});
	});
	const endNode: FlowNode = {
		id: "end",
		kind: "end",
		label: "结束",
		position: { x: (taskIds.length + 1) * gapX, y: 0 },
	};
	nodes.push(endNode);

	const chain = ["start", ...taskIds, "end"];
	const edges: FlowEdge[] = [];
	for (let i = 0; i < chain.length - 1; i += 1) {
		edges.push({ id: randomUUID(), source: chain[i], target: chain[i + 1] });
	}
	return { nodes, edges };
}

async function bridgeResult(
	intent: string,
	action: string,
	target: string,
	riskLevel: DesktopToolResult["riskLevel"],
	run: () => unknown | Promise<unknown>,
): Promise<{ content: [{ type: "text"; text: string }]; details: DesktopToolResult }> {
	try {
		const payload = await run();
		const details = buildDetails(intent, action, target, riskLevel, "succeeded", JSON.stringify(payload, null, 2));
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	} catch (error) {
		const details = buildDetails(
			intent,
			action,
			target,
			riskLevel,
			"failed",
			undefined,
			error instanceof Error ? error.message : String(error),
		);
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	}
}

function buildDetails(
	intent: string,
	action: string,
	target: string,
	riskLevel: DesktopToolResult["riskLevel"],
	status: DesktopToolResult["status"],
	stdout?: string,
	stderr?: string,
): DesktopToolResult {
	return {
		stepId: randomUUID(),
		intent,
		action,
		target,
		status,
		stdout,
		stderr,
		riskLevel,
		requiresConfirmation: false,
	};
}
