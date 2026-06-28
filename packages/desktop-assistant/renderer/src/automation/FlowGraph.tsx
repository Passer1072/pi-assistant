import "@xyflow/react/dist/style.css";

import {
	Background,
	Edge,
	Handle,
	MiniMap,
	Node,
	NodeProps,
	Position,
	ReactFlow,
	ReactFlowProvider,
	useEdgesState,
	useNodesState,
} from "@xyflow/react";
import { useEffect } from "react";
import type { FlowEdge, FlowNode, FlowNodeKind } from "./types.ts";
import { flowKindLabel } from "./types.ts";

export type FlowNodeData = {
	label: string;
	kind: FlowNodeKind;
	instruction?: string;
	config?: FlowNode["config"];
	active?: boolean;
	done?: boolean;
	/** Node added by the most recent live-flow revision → amber highlight. */
	fresh?: boolean;
};

export type FlowGraphNode = Node<FlowNodeData>;
export type FlowGraphEdge = Edge;

/** Shared node renderer used by both the editable editor canvas and the read-only preview. */
export function AutomationGraphNode({ data }: NodeProps<FlowGraphNode>) {
	return (
		<div
			className={`automation-flow-node kind-${data.kind} ${data.active ? "active" : ""} ${data.done ? "done" : ""} ${data.fresh ? "fresh" : ""}`}
		>
			<Handle type="target" position={Position.Left} />
			<div className="automation-flow-node-kind">{flowKindLabel(data.kind)}</div>
			<div className="automation-flow-node-label">{data.label}</div>
			{data.instruction ? <div className="automation-flow-node-detail">{data.instruction}</div> : null}
			<Handle type="source" position={Position.Right} />
		</div>
	);
}

export const FLOW_NODE_TYPES = { automation: AutomationGraphNode };

export function toFlowNodes(
	nodes: FlowNode[],
	activeNodeId: string | undefined,
	doneNodeIds: Set<string>,
	freshNodeIds?: Set<string>,
): FlowGraphNode[] {
	return nodes.map((node) => ({
		id: node.id,
		type: "automation",
		position: node.position,
		data: {
			label: node.label,
			kind: node.kind,
			instruction: node.instruction,
			config: node.config,
			active: activeNodeId === node.id,
			done: doneNodeIds.has(node.id),
			fresh: freshNodeIds?.has(node.id) ?? false,
		},
	}));
}

/**
 * Derive the green path overlay from node progress: an edge is "traversed" (solid
 * green) when both endpoints are done, and the single edge feeding the active node
 * (from a done node) is the "active" edge (green flowing dashes). Shared by the
 * automation flowchart bubble and the live-flow floating window.
 */
export function deriveFlowEdgeProgress(
	edges: FlowEdge[],
	doneNodeIds: Set<string>,
	activeNodeId: string | undefined,
): { traversedEdgeIds: Set<string>; activeEdgeId?: string } {
	const traversedEdgeIds = new Set<string>();
	let activeEdgeId: string | undefined;
	for (const edge of edges) {
		if (doneNodeIds.has(edge.source) && doneNodeIds.has(edge.target)) {
			traversedEdgeIds.add(edge.id);
		} else if (activeNodeId && doneNodeIds.has(edge.source) && edge.target === activeNodeId) {
			activeEdgeId = edge.id;
		}
	}
	return { traversedEdgeIds, activeEdgeId };
}

/** Green used to trace the executed path (matches the `.done` node halo color). */
const TRAVERSED_EDGE_COLOR = "rgba(74, 222, 128, 0.9)";

export interface ToFlowEdgesOptions {
	/** Edges whose run is complete → solid green. */
	traversedEdgeIds?: Set<string>;
	/** The edge feeding the currently-active node → green flowing dashes. */
	activeEdgeId?: string;
}

export function toFlowEdges(edges: FlowEdge[], opts?: ToFlowEdgesOptions): FlowGraphEdge[] {
	const traversed = opts?.traversedEdgeIds;
	const activeEdgeId = opts?.activeEdgeId;
	return edges.map((edge) => {
		const isTraversed = traversed?.has(edge.id) ?? false;
		const isActiveEdge = edge.id === activeEdgeId;
		const isGreen = isTraversed || isActiveEdge;
		return {
			id: edge.id,
			source: edge.source,
			target: edge.target,
			label: edge.label,
			// Keep the editor's flowing-dash look on untraversed/active edges; a fully
			// completed edge becomes a solid green line so the done path reads clearly.
			animated: isTraversed ? false : true,
			style: isGreen ? { stroke: TRAVERSED_EDGE_COLOR, strokeWidth: 2.5 } : undefined,
		};
	});
}

export function flowNodeColor(kind: FlowNodeKind): string {
	switch (kind) {
		case "start":
			return "rgba(74, 222, 128, 0.7)";
		case "condition":
			return "rgba(245, 185, 107, 0.75)";
		case "loop":
			return "rgba(190, 132, 255, 0.7)";
		case "wait":
			return "rgba(125, 211, 252, 0.7)";
		case "end":
			return "rgba(255, 118, 118, 0.7)";
		case "task":
			return "rgba(106, 169, 255, 0.7)";
	}
}

interface FlowGraphPreviewProps {
	nodes: FlowNode[];
	edges: FlowEdge[];
	activeNodeId?: string;
	doneNodeIds?: Set<string>;
	/** Edges along the executed path → solid green. */
	traversedEdgeIds?: Set<string>;
	/** Edge feeding the active node → green flowing dashes. */
	activeEdgeId?: string;
	/** Nodes added by the most recent live-flow revision → amber highlight. */
	freshNodeIds?: Set<string>;
	/** Show the minimap (off by default — preview panels are small). */
	showMiniMap?: boolean;
}

/**
 * Read-only rendering of a flow graph. Same node visuals as the editor (including the live
 * active/done highlight) but with editing affordances disabled. The graph still pans, zooms,
 * and fits to view so a busy flow stays readable.
 */
export function FlowGraphPreview({
	nodes,
	edges,
	activeNodeId,
	doneNodeIds,
	traversedEdgeIds,
	activeEdgeId,
	freshNodeIds,
	showMiniMap,
}: FlowGraphPreviewProps) {
	const done = doneNodeIds ?? EMPTY_DONE;
	return (
		<ReactFlowProvider>
			<FlowGraphPreviewInner
				nodes={nodes}
				edges={edges}
				activeNodeId={activeNodeId}
				doneNodeIds={done}
				traversedEdgeIds={traversedEdgeIds}
				activeEdgeId={activeEdgeId}
				freshNodeIds={freshNodeIds}
				showMiniMap={showMiniMap}
			/>
		</ReactFlowProvider>
	);
}

const EMPTY_DONE: Set<string> = new Set();

function FlowGraphPreviewInner({
	nodes,
	edges,
	activeNodeId,
	doneNodeIds,
	traversedEdgeIds,
	activeEdgeId,
	freshNodeIds,
	showMiniMap,
}: Required<Pick<FlowGraphPreviewProps, "nodes" | "edges" | "doneNodeIds">> &
	Pick<FlowGraphPreviewProps, "activeNodeId" | "traversedEdgeIds" | "activeEdgeId" | "freshNodeIds" | "showMiniMap">) {
	const [rfNodes, setRfNodes, onRfNodesChange] = useNodesState<FlowGraphNode>([]);
	const [rfEdges, setRfEdges, onRfEdgesChange] = useEdgesState<FlowGraphEdge>([]);

	useEffect(() => {
		setRfNodes(toFlowNodes(nodes, activeNodeId, doneNodeIds, freshNodeIds));
	}, [nodes, activeNodeId, doneNodeIds, freshNodeIds, setRfNodes]);
	useEffect(() => {
		setRfEdges(toFlowEdges(edges, { traversedEdgeIds, activeEdgeId }));
	}, [edges, traversedEdgeIds, activeEdgeId, setRfEdges]);

	return (
		<ReactFlow
			nodes={rfNodes}
			edges={rfEdges}
			nodeTypes={FLOW_NODE_TYPES}
			onNodesChange={onRfNodesChange}
			onEdgesChange={onRfEdgesChange}
			fitView
			fitViewOptions={{ padding: 0.2 }}
			nodesDraggable={false}
			nodesConnectable={false}
			elementsSelectable={false}
			edgesFocusable={false}
			zoomOnDoubleClick={false}
			proOptions={{ hideAttribution: true }}
			defaultEdgeOptions={{ animated: true }}
			colorMode="dark"
		>
			<Background color="rgba(255,255,255,0.06)" gap={22} />
			{showMiniMap ? (
				<MiniMap
					pannable
					maskColor="rgba(8, 10, 16, 0.45)"
					nodeColor={(node) => flowNodeColor((node.data as FlowNodeData).kind)}
					className="automation-editor-minimap"
				/>
			) : null}
		</ReactFlow>
	);
}
