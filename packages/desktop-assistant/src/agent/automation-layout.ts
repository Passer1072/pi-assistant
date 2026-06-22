import type { FlowEdge, FlowNode, FlowNodeInput } from "../shared/types.ts";

const NODE_X_GAP = 260;
const NODE_Y_GAP = 150;

export function autoLayoutFlow(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
	if (nodes.length === 0) return [];
	const incoming = new Map<string, number>();
	const outgoing = new Map<string, FlowEdge[]>();
	for (const node of nodes) {
		incoming.set(node.id, 0);
		outgoing.set(node.id, []);
	}
	for (const edge of edges) {
		if (!incoming.has(edge.target) || !outgoing.has(edge.source)) continue;
		incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
		outgoing.get(edge.source)?.push(edge);
	}
	const starts = nodes.filter((node) => node.kind === "start" || (incoming.get(node.id) ?? 0) === 0);
	const queue = starts.length > 0 ? starts.map((node) => node.id) : [nodes[0].id];
	const depth = new Map<string, number>();
	for (const id of queue) depth.set(id, 0);
	while (queue.length > 0) {
		const id = queue.shift();
		if (!id) continue;
		const nextDepth = (depth.get(id) ?? 0) + 1;
		for (const edge of outgoing.get(id) ?? []) {
			if ((depth.get(edge.target) ?? -1) >= nextDepth) continue;
			depth.set(edge.target, nextDepth);
			queue.push(edge.target);
		}
	}
	for (const node of nodes) {
		if (!depth.has(node.id)) depth.set(node.id, depth.size);
	}
	const groups = new Map<number, FlowNode[]>();
	for (const node of nodes) {
		const level = depth.get(node.id) ?? 0;
		groups.set(level, [...(groups.get(level) ?? []), node]);
	}
	return nodes.map((node) => {
		const level = depth.get(node.id) ?? 0;
		const group = groups.get(level) ?? [node];
		const index = group.findIndex((item) => item.id === node.id);
		const offset = (group.length - 1) / 2;
		return {
			...node,
			position: {
				x: level * NODE_X_GAP,
				y: (index - offset) * NODE_Y_GAP,
			},
		};
	});
}

/** A node has a usable position when both coordinates are present and finite. */
function hasPosition(node: FlowNodeInput): node is FlowNode {
	return !!node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y);
}

/**
 * Assign positions ONLY to nodes that lack one, leaving already-positioned
 * nodes exactly where they are. This is what AI-driven edits use so that adding
 * a node never disturbs the user's manual arrangement. When every node is
 * unplaced (e.g. a fresh whole-graph replace) it falls back to a full layered
 * layout; otherwise missing nodes are stacked in a fresh column to the right of
 * the existing graph's bounding box.
 */
export function placeMissingPositions(nodes: FlowNodeInput[], edges: FlowEdge[]): FlowNode[] {
	const missing = nodes.filter((node) => !hasPosition(node));
	if (missing.length === 0) return nodes.map((node) => node as FlowNode);
	const placed = nodes.filter(hasPosition);
	if (placed.length === 0) {
		return autoLayoutFlow(
			nodes.map((node) => ({ ...node, position: node.position ?? { x: 0, y: 0 } })),
			edges,
		);
	}
	const baseX = Math.max(...placed.map((node) => node.position.x)) + NODE_X_GAP;
	const baseY = Math.min(...placed.map((node) => node.position.y));
	let row = 0;
	return nodes.map((node) => {
		if (hasPosition(node)) return node;
		const position = { x: baseX, y: baseY + row * NODE_Y_GAP };
		row += 1;
		return { ...node, position };
	});
}
