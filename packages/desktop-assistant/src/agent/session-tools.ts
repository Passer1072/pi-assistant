import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DesktopToolResult } from "../shared/types.ts";

/** A single tool-call failure observed in the current turn (user-rejection/abort excluded). */
export interface TurnToolError {
	toolName: string;
	message: string;
}

/**
 * The slice of {@link ../agent/desktop-agent-service.ts} the session tool reads.
 * Mirrors the focused-context accessor style used by the memo/personal-skill tools
 * (e.g. {@link ./memo-tools.ts} `getSourceSessionId`).
 */
export interface SessionToolHost {
	getSourceSessionId(): string | undefined;
	getCurrentTitle(): string | undefined;
	/** Tool failures recorded so far this turn — used by the error-self-summary experiment. */
	getRecentToolErrors(): TurnToolError[];
}

export const SESSION_TOOL_NAMES = ["session_info"] as const;

export function createSessionToolDefinitions(host: SessionToolHost): ToolDefinition[] {
	return [
		defineTool({
			name: "session_info",
			label: "Get current session info",
			description:
				"Return the current conversation's local session id (and short id, title, and any tool errors seen this turn). Use it to reference or label the current session — e.g. to build a memo title for the current conversation.",
			promptSnippet:
				"Read the current session id/title when you need to label something with this conversation (e.g. titling an error-summary memo).",
			parameters: Type.Object({}),
			execute: async () =>
				sessionResult("Get session info", "session_info", "current", () => {
					const sessionId = host.getSourceSessionId();
					return {
						sessionId: sessionId ?? null,
						shortId: sessionId ? sessionId.slice(0, 8) : null,
						title: host.getCurrentTitle() ?? null,
						recentToolErrors: host.getRecentToolErrors(),
					};
				}),
		}),
	];
}

function sessionResult(
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
