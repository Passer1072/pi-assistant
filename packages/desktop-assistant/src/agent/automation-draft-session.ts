import { randomUUID } from "node:crypto";
import type {
	AutomationDraft,
	AutomationDraftOperation,
	AutomationFlow,
	AutomationRunPolicy,
	AutomationTrigger,
	FlowEdge,
	FlowNode,
} from "../shared/types.ts";
import { autoLayoutFlow, placeMissingPositions } from "./automation-layout.ts";
import { normalizeEdges, normalizeNodes, normalizeRunPolicy, normalizeTrigger } from "./automation-repository.ts";

const DEFAULT_TRIGGER: AutomationTrigger = { kind: "manual" };
const DEFAULT_RUN_POLICY: AutomationRunPolicy = { permissionMode: "automatic" };

export class AutomationDraftSession {
	private draft: AutomationDraft;
	private readonly onChange: (draft: AutomationDraft) => void;

	constructor(onChange: (draft: AutomationDraft) => void) {
		this.onChange = onChange;
		this.draft = createEmptyDraft();
	}

	getDraft(flow?: AutomationFlow): AutomationDraft {
		if (flow && flow.id !== this.draft.flowId) this.loadFromFlow(flow);
		return cloneDraft(this.draft);
	}

	loadFromFlow(flow: AutomationFlow): AutomationDraft {
		this.draft = {
			flowId: flow.id,
			name: flow.name,
			description: flow.description,
			nodes: normalizeNodes(flow.nodes),
			edges: normalizeEdges(flow.edges, flow.nodes),
			trigger: normalizeTrigger(flow.trigger),
			runPolicy: normalizeRunPolicy(flow.runPolicy),
			dirty: false,
			updatedAt: new Date().toISOString(),
		};
		this.onChange(cloneDraft(this.draft));
		return cloneDraft(this.draft);
	}

	reset(): AutomationDraft {
		this.draft = createEmptyDraft();
		this.onChange(cloneDraft(this.draft));
		return cloneDraft(this.draft);
	}

	applyOps(ops: AutomationDraftOperation[]): AutomationDraft {
		for (const op of ops) this.applyOp(op);
		this.draft.nodes = normalizeNodes(this.draft.nodes);
		this.draft.edges = normalizeEdges(this.draft.edges, this.draft.nodes);
		this.draft.updatedAt = new Date().toISOString();
		this.draft.dirty = true;
		this.onChange(cloneDraft(this.draft));
		return cloneDraft(this.draft);
	}

	markSaved(flow: AutomationFlow): AutomationDraft {
		this.draft = {
			flowId: flow.id,
			name: flow.name,
			description: flow.description,
			nodes: normalizeNodes(flow.nodes),
			edges: normalizeEdges(flow.edges, flow.nodes),
			trigger: normalizeTrigger(flow.trigger),
			runPolicy: normalizeRunPolicy(flow.runPolicy),
			dirty: false,
			updatedAt: new Date().toISOString(),
		};
		this.onChange(cloneDraft(this.draft));
		return cloneDraft(this.draft);
	}

	private applyOp(op: AutomationDraftOperation): void {
		switch (op.type) {
			case "replace": {
				// Place only the nodes the caller left unpositioned; keep any explicit coords.
				const placedNodes = placeMissingPositions(op.draft.nodes, op.draft.edges);
				this.draft = {
					...this.draft,
					...op.draft,
					name: op.draft.name ?? this.draft.name,
					description: op.draft.description ?? this.draft.description,
					nodes: placedNodes,
					edges: normalizeEdges(op.draft.edges, placedNodes),
					trigger: normalizeTrigger(op.draft.trigger ?? this.draft.trigger),
					runPolicy: normalizeRunPolicy(op.draft.runPolicy ?? this.draft.runPolicy),
				};
				return;
			}
			case "set_meta":
				if (op.name !== undefined) this.draft.name = op.name;
				if (op.description !== undefined) this.draft.description = op.description;
				if (op.trigger !== undefined) this.draft.trigger = normalizeTrigger(op.trigger);
				if (op.runPolicy !== undefined)
					this.draft.runPolicy = normalizeRunPolicy({ ...this.draft.runPolicy, ...op.runPolicy });
				return;
			case "add_node": {
				// A node without a position is placed in a free slot beside the graph,
				// leaving every existing node (manual or AI-positioned) untouched.
				const newNode = { ...op.node, id: op.node.id ?? randomUUID() };
				this.draft.nodes = placeMissingPositions([...this.draft.nodes, newNode], this.draft.edges);
				return;
			}
			case "update_node":
				this.draft.nodes = this.draft.nodes.map((node) =>
					node.id === op.id
						? { ...node, ...op.update, id: node.id, position: op.update.position ?? node.position }
						: node,
				);
				return;
			case "delete_node":
				this.draft.nodes = this.draft.nodes.filter((node) => node.id !== op.id);
				this.draft.edges = this.draft.edges.filter((edge) => edge.source !== op.id && edge.target !== op.id);
				return;
			case "connect":
				this.draft.edges = [...this.draft.edges, { ...op.edge, id: op.edge.id ?? randomUUID() }];
				return;
			case "disconnect":
				this.draft.edges = this.draft.edges.filter((edge) => edge.id !== op.id);
				return;
			case "autolayout":
				this.draft.nodes = autoLayoutFlow(this.draft.nodes, this.draft.edges);
				return;
		}
	}
}

export function createDraftFromFlow(flow: AutomationFlow): AutomationDraft {
	return {
		flowId: flow.id,
		name: flow.name,
		description: flow.description,
		nodes: normalizeNodes(flow.nodes),
		edges: normalizeEdges(flow.edges, flow.nodes),
		trigger: normalizeTrigger(flow.trigger),
		runPolicy: normalizeRunPolicy(flow.runPolicy),
		dirty: false,
		updatedAt: new Date().toISOString(),
	};
}

function createEmptyDraft(): AutomationDraft {
	const nodes: FlowNode[] = normalizeNodes(undefined);
	const edges: FlowEdge[] = [];
	return {
		name: "New automation",
		description: "",
		nodes,
		edges,
		trigger: DEFAULT_TRIGGER,
		runPolicy: DEFAULT_RUN_POLICY,
		dirty: false,
		updatedAt: new Date().toISOString(),
	};
}

function cloneDraft(draft: AutomationDraft): AutomationDraft {
	return structuredClone(draft);
}
