import { describe, expect, it } from "vitest";
import { AutomationDraftSession } from "../src/agent/automation-draft-session.ts";
import { createFlowDesignToolDefinitions } from "../src/agent/flow-design-tools.ts";

function setup() {
	const session = new AutomationDraftSession(() => {});
	const tools = createFlowDesignToolDefinitions({
		getDraft: () => session.getDraft(),
		applyOps: (ops) => session.applyOps(ops),
	});
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const run = (name: string, params: Record<string, unknown>) =>
		// The flow_* tools only read (_id, params); the remaining runtime args are unused.
		(byName.get(name) as { execute: (...args: unknown[]) => Promise<unknown> }).execute(
			"t",
			params,
			undefined,
			undefined,
			undefined,
		);
	return { session, run };
}

describe("flow design tools layout", () => {
	it("places a positionless added node in a free slot without moving existing nodes", async () => {
		const { session, run } = setup();
		await run("flow_replace", {
			name: "Test",
			nodes: [
				{ id: "a", kind: "start", label: "A", x: 0, y: 0 },
				{ id: "b", kind: "end", label: "B", x: 300, y: 0 },
			],
			edges: [{ id: "a-b", source: "a", target: "b" }],
		});

		await run("flow_add_node", { kind: "task", label: "C" }); // no x/y supplied

		const after = session.getDraft();
		// Existing nodes are left exactly where they were.
		expect(after.nodes.find((node) => node.id === "a")?.position).toEqual({ x: 0, y: 0 });
		expect(after.nodes.find((node) => node.id === "b")?.position).toEqual({ x: 300, y: 0 });
		// The new node exists, is not piled at the origin, and does not overlap an existing node.
		const added = after.nodes.find((node) => node.label === "C");
		expect(added).toBeDefined();
		const occupied = new Set(["0,0", "300,0"]);
		expect(occupied.has(`${added?.position.x},${added?.position.y}`)).toBe(false);
		expect(added?.position.x).toBeGreaterThan(300);
	});

	it("flow_replace keeps explicitly provided coordinates and only lays out the rest", async () => {
		const { session, run } = setup();
		await run("flow_replace", {
			name: "Explicit",
			nodes: [
				{ id: "a", kind: "start", label: "A", x: 10, y: 20 },
				{ id: "b", kind: "task", label: "B", x: 500, y: 80 },
				{ id: "c", kind: "end", label: "C" }, // no coords -> placed by layout
			],
			edges: [
				{ id: "a-b", source: "a", target: "b" },
				{ id: "b-c", source: "b", target: "c" },
			],
		});

		const draft = session.getDraft();
		expect(draft.nodes.find((node) => node.id === "a")?.position).toEqual({ x: 10, y: 20 });
		expect(draft.nodes.find((node) => node.id === "b")?.position).toEqual({ x: 500, y: 80 });
		const c = draft.nodes.find((node) => node.id === "c");
		expect(c).toBeDefined();
		expect(c?.position.x).toBeGreaterThan(500);
	});
});
