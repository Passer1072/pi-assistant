import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AutomationProgressEvent, AutomationRunStatus, DesktopToolResult } from "../shared/types.ts";

export interface AutomationRunToolHost {
	flowId: string;
	runId: string;
	reportProgress(event: Omit<AutomationProgressEvent, "flowId" | "runId" | "timestamp">): void;
	finishRun(status: Exclude<AutomationRunStatus, "running">, summary?: string): void;
}

export const AUTOMATION_RUN_TOOL_NAMES = ["automation_step", "automation_branch", "automation_finish"] as const;

export function createAutomationRunToolDefinitions(host: AutomationRunToolHost): ToolDefinition[] {
	return [
		defineTool({
			name: "automation_step",
			label: "Automation step",
			description: "Report that an automation flow node was entered or completed.",
			parameters: Type.Object({
				nodeId: Type.String(),
				phase: Type.Union([Type.Literal("enter"), Type.Literal("done")]),
			}),
			execute: async (_id, params) =>
				automationResult("Automation step", "automation_step", params.nodeId, () => {
					host.reportProgress({ kind: "step", nodeId: params.nodeId, phase: params.phase });
					return { nodeId: params.nodeId, phase: params.phase };
				}),
		}),
		defineTool({
			name: "automation_branch",
			label: "Automation branch",
			description: "Report which branch a condition node selected.",
			parameters: Type.Object({
				nodeId: Type.String(),
				choice: Type.String(),
			}),
			execute: async (_id, params) =>
				automationResult("Automation branch", "automation_branch", params.nodeId, () => {
					host.reportProgress({ kind: "branch", nodeId: params.nodeId, choice: params.choice });
					return { nodeId: params.nodeId, choice: params.choice };
				}),
		}),
		defineTool({
			name: "automation_finish",
			label: "Automation finish",
			description: "Report the final status and summary of the automation run.",
			parameters: Type.Object({
				status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled")]),
				summary: Type.Optional(Type.String()),
			}),
			execute: async (_id, params) =>
				automationResult("Automation finish", "automation_finish", params.status, () => {
					host.reportProgress({ kind: "finish", status: params.status, summary: params.summary });
					host.finishRun(params.status, params.summary);
					return { status: params.status, summary: params.summary };
				}),
		}),
	];
}

function automationResult(
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
