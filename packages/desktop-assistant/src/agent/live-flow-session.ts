import type {
	AutomationRunStatus,
	FlowEdge,
	FlowNode,
	FlowNodeInput,
	FlowNodeKind,
	LiveFlowSnapshot,
} from "../shared/types.ts";
import { placeMissingPositions } from "./automation-layout.ts";

/** One step the model supplies to `flow_plan`. `next` lists the ids it flows into. */
export interface LiveFlowStepInput {
	id: string;
	label: string;
	kind?: FlowNodeKind;
	instruction?: string;
	next?: string[];
}

export interface LiveFlowPlanInput {
	title?: string;
	steps: LiveFlowStepInput[];
}

/**
 * In-memory working flow for the "实时流程化" experiment. The model designs it on the
 * fly in a normal chat (`flow_plan`), then drives it step by step (`flow_step`), and
 * finishes with `flow_finish`. State is kept entirely in memory (never persisted),
 * mirrored onto the session snapshot, and rendered in the floating window.
 *
 * Re-planning (mid-run revision) re-sends the whole step list: progress is preserved
 * by node id, removed nodes drop their progress, and newly-added nodes are flagged
 * `fresh` so the window can highlight them. Deterministic edge ids (`src__tgt`) keep
 * ReactFlow identity stable across re-plans.
 */
export class LiveFlowSession {
	private title = "实时流程";
	private nodes: FlowNode[] = [];
	private edges: FlowEdge[] = [];
	private activeNodeId: string | undefined;
	private readonly done = new Set<string>();
	private fresh = new Set<string>();
	private status: AutomationRunStatus = "running";
	private currentStep: string | undefined;
	private started = false;
	private readonly listeners = new Set<() => void>();

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}

	/** Design or redraw the whole flow. Preserves progress for surviving node ids. */
	plan(input: LiveFlowPlanInput): { nodes: FlowNode[] } {
		const previousIds = new Set(this.nodes.map((node) => node.id));
		const previousPositions = new Map(this.nodes.map((node) => [node.id, node.position]));
		const nodeInputs: FlowNodeInput[] = input.steps.map((step) => ({
			id: step.id,
			kind: step.kind ?? "task",
			label: step.label,
			instruction: step.instruction,
			// Keep an existing node's position so a revision doesn't reshuffle the graph;
			// new nodes (no prior position) get auto-placed by placeMissingPositions.
			position: previousPositions.get(step.id),
		}));
		const stepIds = new Set(input.steps.map((step) => step.id));
		const edges: FlowEdge[] = [];
		const seen = new Set<string>();
		for (const step of input.steps) {
			for (const target of step.next ?? []) {
				if (!stepIds.has(target) || target === step.id) continue;
				const id = `${step.id}__${target}`;
				if (seen.has(id)) continue;
				seen.add(id);
				edges.push({ id, source: step.id, target });
			}
		}
		this.nodes = placeMissingPositions(nodeInputs, edges);
		this.edges = edges;
		if (input.title?.trim()) this.title = input.title.trim();
		const liveIds = new Set(this.nodes.map((node) => node.id));
		for (const id of [...this.done]) if (!liveIds.has(id)) this.done.delete(id);
		if (this.activeNodeId && !liveIds.has(this.activeNodeId)) this.activeNodeId = undefined;
		// Only a revision (not the first plan) highlights freshly added nodes.
		this.fresh = this.started
			? new Set(this.nodes.filter((node) => !previousIds.has(node.id)).map((node) => node.id))
			: new Set();
		this.status = "running";
		this.currentStep = this.fresh.size > 0 ? "已更新流程图" : "已规划流程图";
		this.started = true;
		this.emit();
		return { nodes: this.nodes };
	}

	/** Report a node entering/finishing. On "done", returns the next node(s) to run. */
	step(id: string, phase: "enter" | "done"): { node?: FlowNode; nextNodes: FlowNode[] } {
		const node = this.nodes.find((item) => item.id === id);
		this.started = true;
		this.fresh.delete(id);
		if (phase === "enter") {
			this.activeNodeId = id;
			this.currentStep = `正在执行：${node?.label ?? id}`;
			this.emit();
			return { node, nextNodes: [] };
		}
		this.done.add(id);
		if (this.activeNodeId === id) this.activeNodeId = undefined;
		const nextNodes = this.outgoing(id);
		this.currentStep =
			nextNodes.length > 0 ? `下一步：${nextNodes.map((item) => item.label).join(" / ")}` : "等待收尾";
		this.emit();
		return { node, nextNodes };
	}

	finish(status: AutomationRunStatus, summary?: string): void {
		this.status = status;
		this.activeNodeId = undefined;
		this.fresh = new Set();
		if (status === "succeeded") for (const node of this.nodes) this.done.add(node.id);
		this.currentStep =
			summary?.trim() || (status === "succeeded" ? "已完成" : status === "failed" ? "已失败" : "已取消");
		this.started = true;
		this.emit();
	}

	/** Nodes directly reachable from `id` (the next steps to run). */
	outgoing(id: string): FlowNode[] {
		const targets = this.edges.filter((edge) => edge.source === id).map((edge) => edge.target);
		return targets
			.map((target) => this.nodes.find((node) => node.id === target))
			.filter((node): node is FlowNode => node !== undefined);
	}

	/** Snapshot for the floating window; undefined until the first plan/step. */
	getState(): LiveFlowSnapshot | undefined {
		if (!this.started) return undefined;
		return {
			title: this.title,
			nodes: this.nodes,
			edges: this.edges,
			activeNodeId: this.activeNodeId,
			doneNodeIds: [...this.done],
			freshNodeIds: this.fresh.size > 0 ? [...this.fresh] : undefined,
			status: this.status,
			currentStep: this.currentStep,
			updatedAt: Date.now(),
		};
	}
}
