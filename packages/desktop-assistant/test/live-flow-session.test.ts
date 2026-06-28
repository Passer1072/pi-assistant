import { describe, expect, it } from "vitest";
import { LiveFlowSession } from "../src/agent/live-flow-session.ts";

describe("LiveFlowSession", () => {
	it("has no state until the first plan", () => {
		expect(new LiveFlowSession().getState()).toBeUndefined();
	});

	it("builds nodes + edges from steps and auto-lays out positions", () => {
		const session = new LiveFlowSession();
		session.plan({
			title: "周报",
			steps: [
				{ id: "a", label: "A", kind: "start", next: ["b"] },
				{ id: "b", label: "B", next: ["c"] },
				{ id: "c", label: "C", kind: "end" },
			],
		});
		const state = session.getState();
		expect(state).toBeDefined();
		expect(state?.title).toBe("周报");
		expect(state?.nodes.map((node) => node.id)).toEqual(["a", "b", "c"]);
		expect(state?.edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual(["a->b", "b->c"]);
		// Every node gets a finite auto-laid-out position.
		expect(state?.nodes.every((node) => Number.isFinite(node.position.x) && Number.isFinite(node.position.y))).toBe(
			true,
		);
		// The first plan never flags fresh nodes.
		expect(state?.freshNodeIds).toBeUndefined();
	});

	it("tracks active/done progress and returns the next step on done", () => {
		const session = new LiveFlowSession();
		session.plan({
			steps: [
				{ id: "a", label: "A", next: ["b"] },
				{ id: "b", label: "B", next: ["c"] },
				{ id: "c", label: "C" },
			],
		});
		session.step("a", "enter");
		expect(session.getState()?.activeNodeId).toBe("a");

		const result = session.step("a", "done");
		expect(result.nextNodes.map((node) => node.id)).toEqual(["b"]);
		const state = session.getState();
		expect(state?.doneNodeIds).toContain("a");
		expect(state?.activeNodeId).toBeUndefined();
		expect(state?.currentStep).toContain("B");
	});

	it("preserves done progress and flags freshly added nodes on re-plan (revision)", () => {
		const session = new LiveFlowSession();
		session.plan({
			steps: [
				{ id: "a", label: "A", next: ["b"] },
				{ id: "b", label: "B", next: ["c"] },
				{ id: "c", label: "C" },
			],
		});
		session.step("a", "done");

		// Revision: insert "x" between a and b.
		session.plan({
			steps: [
				{ id: "a", label: "A", next: ["x"] },
				{ id: "x", label: "X", next: ["b"] },
				{ id: "b", label: "B", next: ["c"] },
				{ id: "c", label: "C" },
			],
		});
		const state = session.getState();
		expect(state?.doneNodeIds).toContain("a"); // survives the re-plan
		expect(state?.freshNodeIds).toContain("x"); // newly added → highlighted
		expect(state?.freshNodeIds ?? []).not.toContain("a");
	});

	it("drops progress for nodes removed by a re-plan", () => {
		const session = new LiveFlowSession();
		session.plan({
			steps: [
				{ id: "a", label: "A", next: ["b"] },
				{ id: "b", label: "B" },
			],
		});
		session.step("a", "done");
		session.plan({ steps: [{ id: "b", label: "B" }] }); // "a" removed
		expect(session.getState()?.doneNodeIds).not.toContain("a");
	});

	it("marks every node done on a successful finish", () => {
		const session = new LiveFlowSession();
		session.plan({
			steps: [
				{ id: "a", label: "A", next: ["b"] },
				{ id: "b", label: "B" },
			],
		});
		session.finish("succeeded", "全部完成");
		const state = session.getState();
		expect(state?.status).toBe("succeeded");
		expect(new Set(state?.doneNodeIds)).toEqual(new Set(["a", "b"]));
		expect(state?.activeNodeId).toBeUndefined();
		expect(state?.currentStep).toBe("全部完成");
	});

	it("notifies onChange listeners", () => {
		const session = new LiveFlowSession();
		let changes = 0;
		session.onChange(() => {
			changes += 1;
		});
		session.plan({ steps: [{ id: "a", label: "A" }] });
		session.step("a", "enter");
		expect(changes).toBe(2);
	});
});
