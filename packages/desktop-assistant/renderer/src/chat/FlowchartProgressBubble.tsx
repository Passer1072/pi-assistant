import { Ban, Check, Loader2, Workflow, X } from "lucide-react";
import { useMemo } from "react";
import type { FlowGraphTimelineData } from "../../../src/shared/types.ts";
import { deriveFlowEdgeProgress, FlowGraphPreview } from "../automation/FlowGraph.tsx";

const STATUS_META: Record<FlowGraphTimelineData["status"], { label: string; className: string }> = {
	running: { label: "运行中", className: "running" },
	succeeded: { label: "已成功", className: "succeeded" },
	failed: { label: "失败", className: "failed" },
	cancelled: { label: "已取消", className: "cancelled" },
};

function StatusIcon({ status }: { status: FlowGraphTimelineData["status"] }) {
	if (status === "running") return <Loader2 size={12} className="spin" />;
	if (status === "succeeded") return <Check size={12} />;
	if (status === "failed") return <X size={12} />;
	return <Ban size={12} />;
}

/**
 * Pinned flowchart panel for an automation conversation. Reuses the editor's
 * FlowGraphPreview (same node visuals + active/done halos) and traces the executed
 * path with green connector lines, so progress reads at a glance instead of as a
 * wall of automation_* tool text. Driven entirely by the `flowchart` timeline item,
 * which the backend updates in place — so live runs and history replay identically.
 */
export function FlowchartProgressBubble({ data }: { data: FlowGraphTimelineData }) {
	const doneSet = useMemo(() => new Set(data.doneNodeIds), [data.doneNodeIds]);
	const { traversedEdgeIds, activeEdgeId } = useMemo(
		() => deriveFlowEdgeProgress(data.edges, doneSet, data.activeNodeId),
		[data.edges, doneSet, data.activeNodeId],
	);

	const status = STATUS_META[data.status];

	return (
		<div className="flowchart-progress">
			<div className="flowchart-progress-head">
				<Workflow size={15} />
				<span className="flowchart-progress-name">{data.name}</span>
				<span className={`flowchart-progress-pill ${status.className}`}>
					<StatusIcon status={data.status} />
					{status.label} · {data.doneNodeIds.length}/{data.nodes.length}
				</span>
			</div>
			<div className="flowchart-progress-graph">
				{data.nodes.length ? (
					<FlowGraphPreview
						nodes={data.nodes}
						edges={data.edges}
						activeNodeId={data.activeNodeId}
						doneNodeIds={doneSet}
						traversedEdgeIds={traversedEdgeIds}
						activeEdgeId={activeEdgeId}
					/>
				) : (
					<div className="flowchart-progress-empty">这个流程还没有节点。</div>
				)}
			</div>
			<div className="flowchart-progress-legend">
				<span>
					<i className="swatch done" /> 已完成路径
				</span>
				<span>
					<i className="swatch active" /> 进行中
				</span>
				<span>
					<i className="swatch pending" /> 未开始
				</span>
			</div>
		</div>
	);
}
