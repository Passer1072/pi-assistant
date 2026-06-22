import type {
	AutomationDraft,
	AutomationDraftOperation,
	AutomationFlow,
	AutomationListResponse,
	AutomationProgressEvent,
	AutomationRunRecord,
	AutomationRunStatus,
	AutomationTrigger,
	TimelineItem,
	FlowEdge,
	FlowNode,
	FlowNodeKind,
} from "../../../src/shared/types.ts";

export type {
	AutomationDraft,
	AutomationDraftOperation,
	AutomationFlow,
	AutomationListResponse,
	AutomationProgressEvent,
	AutomationRunRecord,
	AutomationRunStatus,
	AutomationTrigger,
	TimelineItem,
	FlowEdge,
	FlowNode,
	FlowNodeKind,
};

export interface AutomationDesignChatMessage {
	id: string;
	role: "user" | "assistant" | "system";
	text: string;
	timestamp: number;
}

export interface AutomationEditorLogEntry {
	id: string;
	timestamp: string;
	message: string;
	nodeId?: string;
	status?: AutomationRunStatus | "running";
}

export function createEmptyAutomationDraft(name = "新建自动化"): AutomationDraft {
	const now = new Date().toISOString();
	return {
		name,
		description: "",
		nodes: [
			{ id: "start", kind: "start", label: "开始", position: { x: 60, y: 120 } },
			{
				id: "action",
				kind: "task",
				label: "动作",
				instruction: "描述要执行的桌面操作。",
				position: { x: 320, y: 120 },
			},
			{ id: "end", kind: "end", label: "结束", position: { x: 580, y: 120 } },
		],
		edges: [
			{ id: "start-action", source: "start", target: "action" },
			{ id: "action-end", source: "action", target: "end" },
		],
		trigger: { kind: "manual" },
		runPolicy: { permissionMode: "automatic" },
		dirty: true,
		updatedAt: now,
	};
}

export function triggerSummary(trigger: AutomationTrigger, nextRunAt?: string): string {
	const next = nextRunAt ? `，下次 ${formatDateTime(nextRunAt)}` : "";
	switch (trigger.kind) {
		case "manual":
			return "手动";
		case "once":
			return `一次性 ${formatDateTime(trigger.at)}${next}`;
		case "interval":
			return `每 ${formatDuration(trigger.everyMs)}${next}`;
		case "daily":
			return `每天 ${trigger.time}${next}`;
		case "weekly":
			return `每周 ${weekdaySummary(trigger.weekdays)} ${trigger.time}${next}`;
	}
}

export function formatRunStatus(status: AutomationRunStatus): string {
	switch (status) {
		case "running":
			return "运行中";
		case "succeeded":
			return "成功";
		case "failed":
			return "失败";
		case "cancelled":
			return "已取消";
	}
}

export function flowKindLabel(kind: FlowNodeKind): string {
	switch (kind) {
		case "start":
			return "开始";
		case "task":
			return "任务";
		case "condition":
			return "条件";
		case "loop":
			return "循环";
		case "wait":
			return "等待";
		case "end":
			return "结束";
	}
}

function formatDuration(ms: number): string {
	if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	if (ms % 1_000 === 0) return `${ms / 1_000}s`;
	return `${ms}ms`;
}

function formatDateTime(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString();
}

function weekdaySummary(days: number[]): string {
	if (days.length === 0) return "今天";
	const labels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
	return days.map((day) => labels[day] ?? String(day)).join("、");
}
