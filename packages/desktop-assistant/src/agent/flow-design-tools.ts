import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AutomationDraft, AutomationDraftOperation, DesktopToolResult, FlowNodeKind } from "../shared/types.ts";

export interface FlowDesignToolHost {
	getDraft(): AutomationDraft;
	applyOps(ops: AutomationDraftOperation[]): AutomationDraft;
}

export const FLOW_DESIGN_TOOL_NAMES = [
	"flow_get",
	"flow_set_meta",
	"flow_add_node",
	"flow_update_node",
	"flow_delete_node",
	"flow_connect",
	"flow_disconnect",
	"flow_replace",
] as const;

const NODE_KIND = Type.Union([
	Type.Literal("start"),
	Type.Literal("task"),
	Type.Literal("condition"),
	Type.Literal("loop"),
	Type.Literal("wait"),
	Type.Literal("end"),
]);

export function createFlowDesignToolDefinitions(host: FlowDesignToolHost): ToolDefinition[] {
	return [
		defineTool({
			name: "flow_get",
			label: "Get flow draft",
			description: "Read the current automation flow draft.",
			parameters: Type.Object({}),
			execute: async () => flowResult("Get flow", "flow_get", "draft", () => host.getDraft()),
		}),
		defineTool({
			name: "flow_set_meta",
			label: "Set flow metadata",
			description: "Set the automation flow name and description.",
			parameters: Type.Object({
				name: Type.Optional(Type.String()),
				description: Type.Optional(Type.String()),
			}),
			execute: async (_id, params) =>
				flowResult("Set flow metadata", "flow_set_meta", params.name ?? "draft", () =>
					host.applyOps([{ type: "set_meta", name: params.name, description: params.description }]),
				),
		}),
		defineTool({
			name: "flow_add_node",
			label: "Add flow node",
			description: "Add a node to the current automation draft.",
			parameters: Type.Object({
				kind: NODE_KIND,
				label: Type.String(),
				instruction: Type.Optional(Type.String()),
				x: Type.Optional(Type.Number()),
				y: Type.Optional(Type.Number()),
				waitMs: Type.Optional(Type.Number()),
				loopMaxIterations: Type.Optional(Type.Number()),
			}),
			execute: async (_id, params) =>
				flowResult("Add flow node", "flow_add_node", params.label, () =>
					host.applyOps([
						{
							type: "add_node",
							node: {
								kind: params.kind as FlowNodeKind,
								label: params.label,
								instruction: params.instruction,
								config: { waitMs: params.waitMs, loopMaxIterations: params.loopMaxIterations },
								// Omit position when the model gave none — the draft session places it
								// in a free slot without reflowing the rest of the graph.
								...(params.x !== undefined && params.y !== undefined
									? { position: { x: params.x, y: params.y } }
									: {}),
							},
						},
					]),
				),
		}),
		defineTool({
			name: "flow_update_node",
			label: "Update flow node",
			description: "Update a node in the current automation draft.",
			parameters: Type.Object({
				id: Type.String(),
				label: Type.Optional(Type.String()),
				instruction: Type.Optional(Type.String()),
				x: Type.Optional(Type.Number()),
				y: Type.Optional(Type.Number()),
				waitMs: Type.Optional(Type.Number()),
				loopMaxIterations: Type.Optional(Type.Number()),
			}),
			execute: async (_id, params) =>
				flowResult("Update flow node", "flow_update_node", params.id, () =>
					host.applyOps([
						{
							type: "update_node",
							id: params.id,
							update: {
								label: params.label,
								instruction: params.instruction,
								position:
									params.x !== undefined || params.y !== undefined
										? { x: params.x ?? 0, y: params.y ?? 0 }
										: undefined,
								config: { waitMs: params.waitMs, loopMaxIterations: params.loopMaxIterations },
							},
						},
					]),
				),
		}),
		defineTool({
			name: "flow_delete_node",
			label: "Delete flow node",
			description: "Delete a node and its connected edges from the current automation draft.",
			parameters: Type.Object({ id: Type.String() }),
			execute: async (_id, params) =>
				flowResult("Delete flow node", "flow_delete_node", params.id, () =>
					host.applyOps([{ type: "delete_node", id: params.id }]),
				),
		}),
		defineTool({
			name: "flow_connect",
			label: "Connect flow nodes",
			description: "Connect two nodes in the current automation draft.",
			parameters: Type.Object({
				source: Type.String(),
				target: Type.String(),
				label: Type.Optional(Type.String()),
			}),
			execute: async (_id, params) =>
				flowResult("Connect flow nodes", "flow_connect", `${params.source}->${params.target}`, () =>
					host.applyOps([
						{ type: "connect", edge: { source: params.source, target: params.target, label: params.label } },
					]),
				),
		}),
		defineTool({
			name: "flow_disconnect",
			label: "Disconnect flow edge",
			description: "Delete an edge from the current automation draft.",
			parameters: Type.Object({ id: Type.String() }),
			execute: async (_id, params) =>
				flowResult("Disconnect flow edge", "flow_disconnect", params.id, () =>
					host.applyOps([{ type: "disconnect", id: params.id }]),
				),
		}),
		defineTool({
			name: "flow_replace",
			label: "Replace flow",
			description: "Replace the whole current automation draft graph.",
			parameters: Type.Object({
				name: Type.Optional(Type.String()),
				description: Type.Optional(Type.String()),
				nodes: Type.Array(
					Type.Object({
						id: Type.Optional(Type.String()),
						kind: NODE_KIND,
						label: Type.String(),
						instruction: Type.Optional(Type.String()),
						x: Type.Optional(Type.Number()),
						y: Type.Optional(Type.Number()),
					}),
				),
				edges: Type.Array(
					Type.Object({
						id: Type.Optional(Type.String()),
						source: Type.String(),
						target: Type.String(),
						label: Type.Optional(Type.String()),
					}),
				),
			}),
			execute: async (_id, params) =>
				flowResult("Replace flow", "flow_replace", params.name ?? "draft", () =>
					host.applyOps([
						{
							type: "replace",
							draft: {
								name: params.name,
								description: params.description,
								nodes: params.nodes.map((node) => ({
									id: node.id ?? randomUUID(),
									kind: node.kind as FlowNodeKind,
									label: node.label,
									instruction: node.instruction,
									// Keep explicit coords; nodes without them are placed by layout.
									...(node.x !== undefined && node.y !== undefined
										? { position: { x: node.x, y: node.y } }
										: {}),
								})),
								edges: params.edges.map((edge) => ({ ...edge, id: edge.id ?? randomUUID() })),
							},
						},
					]),
				),
		}),
	];
}

function flowResult(
	intent: string,
	action: string,
	target: string,
	run: () => unknown,
): { content: [{ type: "text"; text: string }]; details: DesktopToolResult } {
	try {
		const payload = run();
		const details = buildDetails(intent, action, target, "succeeded", JSON.stringify(payload, null, 2));
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
