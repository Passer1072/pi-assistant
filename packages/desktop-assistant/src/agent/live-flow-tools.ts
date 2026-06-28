import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DesktopToolResult, FlowNode, FlowNodeKind } from "../shared/types.ts";
import type { LiveFlowSession } from "./live-flow-session.ts";

export const LIVE_FLOW_TOOL_NAMES = ["flow_plan", "flow_step", "flow_finish"] as const;

const NODE_KIND = Type.Union([
	Type.Literal("start"),
	Type.Literal("task"),
	Type.Literal("condition"),
	Type.Literal("loop"),
	Type.Literal("wait"),
	Type.Literal("end"),
]);

/**
 * Tools for the "实时流程化" experiment. They drive a per-conversation
 * {@link LiveFlowSession}: design/redraw the flow (`flow_plan`), report progress
 * (`flow_step` — whose "done" result hands the model the NEXT step so it stays on
 * the flow), and finish (`flow_finish`). Added to a normal chat only when the
 * experiment is enabled.
 */
export function createLiveFlowToolDefinitions(session: LiveFlowSession): ToolDefinition[] {
	return [
		defineTool({
			name: "flow_plan",
			label: "Plan live flow",
			description:
				"为当前多步骤任务设计/重画一张流程图（显示在右下角浮窗）。中途遇到问题想改流程时再次调用即可：整张重发，已完成的步骤会保留，新增的步骤会高亮。steps 里每个节点给唯一 id、label，可选 instruction 和 next（指向后续节点 id 的数组）。",
			parameters: Type.Object({
				title: Type.Optional(Type.String()),
				steps: Type.Array(
					Type.Object({
						id: Type.String(),
						label: Type.String(),
						kind: Type.Optional(NODE_KIND),
						instruction: Type.Optional(Type.String()),
						next: Type.Optional(Type.Array(Type.String())),
					}),
				),
			}),
			execute: async (_id, params) =>
				liveFlowResult("Plan live flow", "flow_plan", params.title ?? "flow", () => {
					const { nodes } = session.plan({
						title: params.title,
						steps: params.steps.map((step) => ({
							id: step.id,
							label: step.label,
							kind: step.kind as FlowNodeKind | undefined,
							instruction: step.instruction,
							next: step.next,
						})),
					});
					return [
						"流程图已更新。节点：",
						...nodes.map((node) => `- [${node.id}] ${node.kind}: ${node.label}`),
						'现在从第一个节点开始：先 flow_step(id, "enter")，执行完该步再 flow_step(id, "done")。',
					].join("\n");
				}),
		}),
		defineTool({
			name: "flow_step",
			label: "Advance live flow",
			description:
				'报告流程图某个节点的进度。开始执行某节点前调用 phase="enter"，完成后调用 phase="done"。done 的返回里会告诉你「下一步」是哪个节点——照着继续，不要跳步。',
			parameters: Type.Object({
				id: Type.String(),
				phase: Type.Union([Type.Literal("enter"), Type.Literal("done")]),
				note: Type.Optional(Type.String()),
			}),
			execute: async (_id, params) =>
				liveFlowResult("Advance live flow", "flow_step", `${params.id}:${params.phase}`, () => {
					const { node, nextNodes } = session.step(params.id, params.phase);
					const label = node?.label ?? params.id;
					if (params.phase === "enter") {
						return `▶ 开始执行：${label}。完成后调用 flow_step("${params.id}", "done")。`;
					}
					if (nextNodes.length === 0) {
						return `✓ 已完成：${label}。没有后续节点——若整个流程结束，请调用 flow_finish；否则用 flow_plan 补充后续步骤。`;
					}
					return [
						`✓ 已完成：${label}`,
						"下一步：",
						...nextNodes.map((next) => formatNextNode(next)),
						'请先 flow_step(下一步id, "enter") 再执行。若这一步做不下去或需要调整流程，用 flow_plan 重画后再继续。',
					].join("\n");
				}),
		}),
		defineTool({
			name: "flow_finish",
			label: "Finish live flow",
			description: "整个流程结束时调用，汇报最终状态与简短总结。",
			parameters: Type.Object({
				status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled")]),
				summary: Type.Optional(Type.String()),
			}),
			execute: async (_id, params) =>
				liveFlowResult("Finish live flow", "flow_finish", params.status, () => {
					session.finish(params.status, params.summary);
					return `流程已结束：${params.status}${params.summary ? ` —— ${params.summary}` : ""}`;
				}),
		}),
	];
}

function formatNextNode(node: FlowNode): string {
	return `- [${node.id}] ${node.label}${node.instruction ? ` —— ${node.instruction}` : ""}`;
}

function liveFlowResult(
	intent: string,
	action: string,
	target: string,
	run: () => string,
): { content: [{ type: "text"; text: string }]; details: DesktopToolResult } {
	try {
		const stdout = run();
		const details = buildDetails(intent, action, target, "succeeded", stdout);
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	} catch (error) {
		const details = buildDetails(
			intent,
			action,
			target,
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
		riskLevel: "low",
		requiresConfirmation: false,
	};
}
