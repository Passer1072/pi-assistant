import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DesktopToolResult, GlobalMemoryEntry, GlobalMemoryKind, GlobalMemoryScope } from "../shared/types.ts";

export interface MemoryToolHost {
	saveMemory(request: {
		kind: GlobalMemoryKind;
		scope?: GlobalMemoryScope;
		text: string;
		confidence?: number;
		reason?: string;
		tags?: string[];
	}): GlobalMemoryEntry | undefined;
	searchMemories(query: string, limit?: number): GlobalMemoryEntry[];
	forgetMemory(id: string): boolean;
}

export const MEMORY_TOOL_NAMES = ["memory_save", "memory_search", "memory_forget"] as const;

const MEMORY_KIND_ENUM = Type.Union([
	Type.Literal("preference"),
	Type.Literal("profile"),
	Type.Literal("project"),
	Type.Literal("task"),
	Type.Literal("correction"),
	Type.Literal("fact"),
]);
const MEMORY_SCOPE_ENUM = Type.Union([Type.Literal("user"), Type.Literal("workspace")]);

const MEMORY_GUIDELINES = [
	"Use memory tools only when the user explicitly asks you to remember, forget, or recall stable cross-conversation context.",
	"Prefer scope=workspace for project-specific conventions and scope=user for durable personal preferences.",
	"Never save secrets, credentials, API keys, tokens, passwords, or short-lived facts.",
	"Use memory_search before relying on a vague memory. If current user instructions conflict with memory, follow the current message.",
];

export function createMemoryToolDefinitions(host: MemoryToolHost): ToolDefinition[] {
	return [
		defineTool({
			name: "memory_save",
			label: "Save memory",
			description:
				"Save a stable cross-conversation memory. Use only for explicit user requests or durable preferences/facts that should affect future chats.",
			promptSnippet: "Save durable user or workspace context when the user asks you to remember it.",
			promptGuidelines: MEMORY_GUIDELINES,
			parameters: Type.Object({
				kind: MEMORY_KIND_ENUM,
				scope: Type.Optional(MEMORY_SCOPE_ENUM),
				text: Type.String({ description: "Memory text. Do not include secrets or ephemeral details." }),
				confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
				reason: Type.Optional(Type.String({ description: "Short reason this memory is worth keeping." })),
				tags: Type.Optional(Type.Array(Type.String())),
			}),
			execute: async (_id, params) =>
				memoryResult("Save memory", "memory_save", params.kind, () =>
					host.saveMemory({
						kind: params.kind as GlobalMemoryKind,
						scope: params.scope as GlobalMemoryScope | undefined,
						text: params.text,
						confidence: params.confidence,
						reason: params.reason,
						tags: params.tags,
					}),
				),
		}),
		defineTool({
			name: "memory_search",
			label: "Search memory",
			description: "Search local cross-conversation memories by free text.",
			promptSnippet: "Search memory when the user asks what you remember or when a durable preference may matter.",
			promptGuidelines: MEMORY_GUIDELINES,
			parameters: Type.Object({
				query: Type.String(),
				limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
			}),
			execute: async (_id, params) =>
				memoryResult("Search memory", "memory_search", params.query, () =>
					host.searchMemories(params.query, params.limit),
				),
		}),
		defineTool({
			name: "memory_forget",
			label: "Forget memory",
			description: "Permanently delete one cross-conversation memory by id.",
			promptSnippet: "Delete a memory only when the user asks you to forget it.",
			promptGuidelines: MEMORY_GUIDELINES,
			parameters: Type.Object({
				id: Type.String({ description: "Memory id from memory_search or settings." }),
			}),
			execute: async (_id, params) =>
				memoryResult("Forget memory", "memory_forget", params.id, () => ({
					deleted: host.forgetMemory(params.id),
				})),
		}),
	];
}

function memoryResult(
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
