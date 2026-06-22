import { describe, expect, it } from "vitest";
import { serializeFlowToRunbook } from "../src/agent/automation-runner.ts";
import type { AutomationFlow } from "../src/shared/types.ts";

describe("serializeFlowToRunbook", () => {
	it("serializes nodes, branches and progress rules", () => {
		const now = new Date().toISOString();
		const flow: AutomationFlow = {
			id: "flow-1",
			name: "Check inbox",
			description: "Open mail and react to urgent messages",
			enabled: false,
			trigger: { kind: "manual" },
			runPolicy: { permissionMode: "automatic" },
			nodes: [
				{ id: "start", kind: "start", label: "Start", position: { x: 0, y: 0 } },
				{
					id: "condition",
					kind: "condition",
					label: "Urgent?",
					instruction: "Decide whether there are urgent messages.",
					position: { x: 200, y: 0 },
				},
				{ id: "end", kind: "end", label: "Done", position: { x: 400, y: 0 } },
			],
			edges: [
				{ id: "a", source: "start", target: "condition" },
				{ id: "b", source: "condition", target: "end", label: "no urgent mail" },
			],
			runs: [],
			createdAt: now,
			updatedAt: now,
		};
		const runbook = serializeFlowToRunbook(flow);
		expect(runbook).toContain("automation_step");
		expect(runbook).toContain("automation_branch");
		expect(runbook).toContain("[condition] condition: Urgent?");
		expect(runbook).toContain('-> end when "no urgent mail"');
	});
});
