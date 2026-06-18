import { randomUUID } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { TimelineItem } from "../shared/types.ts";

let currentAgentTimelineId: string | undefined;
let currentCompactionTimelineId: string | undefined;

export function eventToTimelineItem(event: AgentSessionEvent): TimelineItem | undefined {
	const timestamp = Date.now();
	switch (event.type) {
		case "agent_start": {
			currentAgentTimelineId = randomUUID();
			return {
				id: currentAgentTimelineId,
				kind: "agent",
				title: "Agent started",
				status: "running",
				timestamp,
				order: 0,
			};
		}
		case "agent_end": {
			const id = currentAgentTimelineId ?? randomUUID();
			if (!event.willRetry) {
				currentAgentTimelineId = undefined;
			}
			return {
				id,
				kind: "agent",
				title: event.willRetry ? "Agent will retry" : "Agent finished",
				status: event.willRetry ? "running" : "succeeded",
				timestamp,
				order: 0,
			};
		}
		case "message_update": {
			const assistantEvent = event.assistantMessageEvent;
			if (assistantEvent.type === "thinking_delta") {
				// Use stable ID per content block so it updates in place rather than accumulating.
				return {
					id: `thinking-${assistantEvent.contentIndex}`,
					kind: "thinking_summary",
					title: "Thinking",
					detail: summarizeThinking(assistantEvent.delta),
					status: "running",
					timestamp,
					order: 0,
				};
			}
			// text_delta and toolcall_start events create excessive "running" noise that never
			// transitions to a final state. Skip them; tool_execution_* events are sufficient.
			return undefined;
		}
		case "tool_execution_start":
			return {
				id: event.toolCallId,
				kind: "tool",
				title: `Tool started: ${event.toolName}`,
				detail: JSON.stringify(event.args),
				status: "running",
				timestamp,
				order: 0,
				toolCallId: event.toolCallId,
			};
		case "tool_execution_update":
			return {
				id: event.toolCallId,
				kind: "tool",
				title: `Tool running: ${event.toolName}`,
				detail: JSON.stringify(event.partialResult),
				status: "running",
				timestamp,
				order: 0,
				toolCallId: event.toolCallId,
			};
		case "tool_execution_end":
			return {
				id: event.toolCallId,
				kind: "tool",
				title: `Tool finished: ${event.toolName}`,
				detail: JSON.stringify(event.result),
				status: event.isError ? "failed" : "succeeded",
				timestamp,
				order: 0,
				toolCallId: event.toolCallId,
			};
		case "auto_retry_start":
			return {
				id: randomUUID(),
				kind: "retry",
				title: `Retrying request ${event.attempt}/${event.maxAttempts}`,
				detail: event.errorMessage,
				status: "running",
				timestamp,
				order: 0,
			};
		case "auto_retry_end":
			return {
				id: randomUUID(),
				kind: "retry",
				title: event.success ? "Retry succeeded" : "Retry failed",
				detail: event.finalError,
				status: event.success ? "succeeded" : "failed",
				timestamp,
				order: 0,
			};
		case "compaction_start": {
			currentCompactionTimelineId = randomUUID();
			return {
				id: currentCompactionTimelineId,
				kind: "compaction",
				title: "正在压缩上下文...",
				detail: event.reason,
				status: "running",
				timestamp,
				order: 0,
			};
		}
		case "compaction_end": {
			const id = currentCompactionTimelineId ?? randomUUID();
			currentCompactionTimelineId = undefined;
			return {
				id,
				kind: "compaction",
				title: compactionEndTitle(event),
				detail: event.errorMessage ?? event.reason,
				status: event.aborted ? "blocked" : event.result ? "succeeded" : "failed",
				timestamp,
				order: 0,
			};
		}
		default:
			return undefined;
	}
}

function compactionEndTitle(event: Extract<AgentSessionEvent, { type: "compaction_end" }>): string {
	if (event.reason === "token_saving" && event.result) return "上下文已压缩，继续回答";
	if (event.aborted) return "上下文压缩已取消";
	if (event.result) return "上下文已压缩";
	return "上下文压缩失败";
}

function summarizeThinking(delta: string): string {
	const compact = delta.replace(/\s+/g, " ").trim();
	if (!compact) return "Updating plan";
	return compact.length > 140 ? `${compact.slice(0, 137)}...` : compact;
}
