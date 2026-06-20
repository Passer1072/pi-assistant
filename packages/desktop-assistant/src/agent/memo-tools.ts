import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
	DesktopToolResult,
	MemoCompleteRequest,
	MemoCreateRequest,
	MemoDeleteRequest,
	MemoItem,
	MemoListRequest,
	MemoListResponse,
	MemoSetReminderRequest,
	MemoUpdateRequest,
} from "../shared/types.ts";

/**
 * The slice of {@link ../agent/desktop-agent-service.ts} that memo tools drive.
 * Tools go through the service (not the repository directly) so the reminder
 * scheduler and renderer "memo_changed" events always stay in sync.
 */
export interface MemoToolHost {
	createMemo(request: MemoCreateRequest): MemoItem;
	updateMemo(request: MemoUpdateRequest): MemoItem;
	completeMemo(request: MemoCompleteRequest): MemoItem;
	deleteMemo(request: MemoDeleteRequest): boolean;
	setMemoReminder(request: MemoSetReminderRequest): MemoItem;
	listMemos(request?: MemoListRequest): MemoListResponse;
	searchMemos(query: string, limit?: number): MemoItem[];
	getSourceSessionId(): string | undefined;
}

export const MEMO_TOOL_NAMES = [
	"memo_create",
	"memo_list",
	"memo_search",
	"memo_update",
	"memo_complete",
	"memo_set_reminder",
	"memo_delete",
] as const;

const PRIORITY_ENUM = Type.Union([
	Type.Literal("none"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
]);
const RECURRENCE_ENUM = Type.Union([
	Type.Literal("none"),
	Type.Literal("daily"),
	Type.Literal("weekly"),
	Type.Literal("monthly"),
]);

const MEMO_GUIDELINES = [
	"备忘录是用户的待办/提醒事项。仅在用户明确要求记录待办、设置提醒或查询待办时使用这些工具。",
	"日期时间必须传 ISO 8601（如 2026-06-20T09:00:00）。先把『明天9点』『30分钟后』『下周一』等相对/口语时间换算成绝对 ISO 时间再调用——以当前本地时间为基准。",
	"reminderAt 是提醒触发时间，dueAt 是截止时间，二者可不同（例如截止前一天提醒）。只设提醒就传 reminderAt。",
	"创建后向用户复述标题与提醒时间确认。除非用户明确要删除，否则用 memo_complete 标记完成而不是 memo_delete。",
];

export function createMemoToolDefinitions(host: MemoToolHost): ToolDefinition[] {
	return [
		defineTool({
			name: "memo_create",
			label: "Create memo",
			description:
				"Create a memo / to-do for the user, optionally with a due date, a reminder time, priority, tags, and subtasks.",
			promptSnippet: "Create a to-do or reminder when the user asks to remember something or be reminded at a time.",
			promptGuidelines: MEMO_GUIDELINES,
			parameters: Type.Object({
				title: Type.String({ description: "Short memo title." }),
				notes: Type.Optional(Type.String({ description: "Optional body / details." })),
				priority: Type.Optional(PRIORITY_ENUM),
				dueAt: Type.Optional(Type.String({ description: "Due time, ISO 8601." })),
				reminderAt: Type.Optional(Type.String({ description: "Reminder time, ISO 8601." })),
				recurrence: Type.Optional(RECURRENCE_ENUM),
				tags: Type.Optional(Type.Array(Type.String())),
				subtasks: Type.Optional(Type.Array(Type.String({ description: "Subtask title." }))),
			}),
			execute: async (_id, params) =>
				memoResult("Create memo", "memo_create", params.title, () =>
					host.createMemo({
						title: params.title,
						notes: params.notes,
						priority: params.priority,
						dueAt: params.dueAt,
						reminderAt: params.reminderAt,
						recurrence: params.recurrence,
						tags: params.tags,
						subtasks: params.subtasks?.map((title) => ({ title })),
						createdBy: "ai",
						sourceSessionId: host.getSourceSessionId(),
					}),
				),
		}),
		defineTool({
			name: "memo_list",
			label: "List memos",
			description: "List the user's memos / to-dos, optionally filtered by status or tag.",
			promptSnippet: "List or summarize the user's to-dos, e.g. when asked what's due today.",
			promptGuidelines: MEMO_GUIDELINES,
			parameters: Type.Object({
				status: Type.Optional(
					Type.Union([Type.Literal("active"), Type.Literal("completed"), Type.Literal("archived")]),
				),
				tag: Type.Optional(Type.String()),
				query: Type.Optional(Type.String({ description: "Free-text filter." })),
				sort: Type.Optional(
					Type.Union([
						Type.Literal("due"),
						Type.Literal("priority"),
						Type.Literal("created"),
						Type.Literal("manual"),
					]),
				),
			}),
			execute: async (_id, params) =>
				memoResult("List memos", "memo_list", params.status ?? "active", () =>
					host.listMemos({ status: params.status, tag: params.tag, query: params.query, sort: params.sort }),
				),
		}),
		defineTool({
			name: "memo_search",
			label: "Search memos",
			description: "Search the user's memos / to-dos by free text.",
			promptSnippet: "Find a specific to-do by keyword.",
			promptGuidelines: MEMO_GUIDELINES,
			parameters: Type.Object({
				query: Type.String(),
				limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
			}),
			execute: async (_id, params) =>
				memoResult("Search memos", "memo_search", params.query, () => host.searchMemos(params.query, params.limit)),
		}),
		defineTool({
			name: "memo_update",
			label: "Update memo",
			description: "Update fields of an existing memo by id. Only provided fields change.",
			promptSnippet: "Edit an existing to-do (title, notes, due/reminder time, priority, tags).",
			promptGuidelines: MEMO_GUIDELINES,
			parameters: Type.Object({
				id: Type.String(),
				title: Type.Optional(Type.String()),
				notes: Type.Optional(Type.String()),
				priority: Type.Optional(PRIORITY_ENUM),
				dueAt: Type.Optional(Type.String({ description: "ISO 8601, or empty string to clear." })),
				reminderAt: Type.Optional(Type.String({ description: "ISO 8601, or empty string to clear." })),
				recurrence: Type.Optional(RECURRENCE_ENUM),
				tags: Type.Optional(Type.Array(Type.String())),
			}),
			execute: async (_id, params) =>
				memoResult("Update memo", "memo_update", params.id, () =>
					host.updateMemo({
						id: params.id,
						title: params.title,
						notes: params.notes,
						priority: params.priority,
						dueAt: params.dueAt === undefined ? undefined : params.dueAt === "" ? null : params.dueAt,
						reminderAt:
							params.reminderAt === undefined ? undefined : params.reminderAt === "" ? null : params.reminderAt,
						recurrence: params.recurrence,
						tags: params.tags,
					}),
				),
		}),
		defineTool({
			name: "memo_complete",
			label: "Complete memo",
			description:
				"Mark a memo as completed (or re-open it with completed=false). Recurring memos roll to the next occurrence.",
			promptSnippet: "Mark a to-do done when the user finished it.",
			promptGuidelines: MEMO_GUIDELINES,
			parameters: Type.Object({
				id: Type.String(),
				completed: Type.Optional(Type.Boolean({ description: "Default true. false re-opens it." })),
			}),
			execute: async (_id, params) =>
				memoResult("Complete memo", "memo_complete", params.id, () =>
					host.completeMemo({ id: params.id, completed: params.completed }),
				),
		}),
		defineTool({
			name: "memo_set_reminder",
			label: "Set memo reminder",
			description: "Set or clear the reminder time of an existing memo.",
			promptSnippet: "Add/change/clear a reminder time on a to-do.",
			promptGuidelines: MEMO_GUIDELINES,
			parameters: Type.Object({
				id: Type.String(),
				reminderAt: Type.String({ description: "Reminder time ISO 8601, or empty string to clear it." }),
			}),
			execute: async (_id, params) =>
				memoResult("Set memo reminder", "memo_set_reminder", params.id, () =>
					host.setMemoReminder({ id: params.id, reminderAt: params.reminderAt === "" ? null : params.reminderAt }),
				),
		}),
		defineTool({
			name: "memo_delete",
			label: "Delete memo",
			description: "Permanently delete a memo by id. Prefer memo_complete unless the user wants it gone.",
			promptSnippet: "Delete a to-do the user no longer wants kept.",
			promptGuidelines: MEMO_GUIDELINES,
			parameters: Type.Object({ id: Type.String() }),
			execute: async (_id, params) =>
				memoResult("Delete memo", "memo_delete", params.id, () => ({
					deleted: host.deleteMemo({ id: params.id }),
				})),
		}),
	];
}

function memoResult(
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
