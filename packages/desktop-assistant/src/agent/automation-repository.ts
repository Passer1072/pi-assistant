import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
	AutomationCreateRequest,
	AutomationFlow,
	AutomationListResponse,
	AutomationPermissionMode,
	AutomationRunPolicy,
	AutomationRunRecord,
	AutomationRunStatus,
	AutomationRunTrigger,
	AutomationSummary,
	AutomationTrigger,
	AutomationUpdateRequest,
	FlowEdge,
	FlowNode,
	FlowNodeKind,
} from "../shared/types.ts";
import { AUTOMATION_PERMISSION_MODES } from "../shared/types.ts";

const STORE_FILENAME = "automations.json";
const SCHEMA_VERSION = 1;
const MAX_NAME_LEN = 160;
const MAX_DESCRIPTION_LEN = 2000;
const MAX_LABEL_LEN = 120;
const MAX_INSTRUCTION_LEN = 6000;
const MAX_RUNS = 20;
const VALID_NODE_KINDS: FlowNodeKind[] = ["start", "task", "condition", "loop", "wait", "end"];
const DEFAULT_TRIGGER: AutomationTrigger = { kind: "manual" };

interface AutomationStoreFile {
	schemaVersion: number;
	automations: AutomationFlow[];
}

export class AutomationRepositoryService {
	private readonly dir: string;
	private readonly filePath: string;
	private flows: AutomationFlow[] = [];
	private loaded = false;

	constructor(automationDir: string) {
		this.dir = resolve(automationDir);
		this.filePath = join(this.dir, STORE_FILENAME);
	}

	all(): AutomationFlow[] {
		this.ensureLoaded();
		return [...this.flows];
	}

	get(id: string): AutomationFlow | undefined {
		this.ensureLoaded();
		return this.flows.find((flow) => flow.id === id);
	}

	list(): AutomationListResponse {
		const flows = this.all().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
		return { flows, summary: this.summary() };
	}

	create(request: AutomationCreateRequest): AutomationFlow {
		this.ensureLoaded();
		const now = new Date().toISOString();
		const flow: AutomationFlow = {
			id: randomUUID(),
			name: cleanRequired(request.name ?? request.title ?? "New automation", "name", MAX_NAME_LEN),
			description: clampText(request.description ?? "", MAX_DESCRIPTION_LEN),
			enabled: request.enabled === true,
			nodes: normalizeNodes(request.nodes),
			edges: normalizeEdges(request.edges, request.nodes),
			trigger: normalizeTrigger(request.trigger),
			runPolicy: normalizeRunPolicy(request.runPolicy),
			runs: [],
			createdAt: now,
			updatedAt: now,
		};
		this.flows.unshift(flow);
		this.flush();
		return flow;
	}

	update(request: AutomationUpdateRequest): AutomationFlow {
		this.ensureLoaded();
		const flow = this.requireFlow(request.id);
		if (request.name !== undefined) flow.name = cleanRequired(request.name, "name", MAX_NAME_LEN);
		if (request.description !== undefined) flow.description = clampText(request.description, MAX_DESCRIPTION_LEN);
		if (request.enabled !== undefined) flow.enabled = request.enabled === true;
		if (request.nodes !== undefined) flow.nodes = normalizeNodes(request.nodes);
		if (request.edges !== undefined) flow.edges = normalizeEdges(request.edges, flow.nodes);
		if (request.trigger !== undefined) flow.trigger = normalizeTrigger(request.trigger);
		if (request.runPolicy !== undefined)
			flow.runPolicy = normalizeRunPolicy({ ...flow.runPolicy, ...request.runPolicy });
		flow.updatedAt = new Date().toISOString();
		this.flush();
		return flow;
	}

	setEnabled(id: string, enabled: boolean): AutomationFlow {
		this.ensureLoaded();
		const flow = this.requireFlow(id);
		flow.enabled = enabled;
		flow.updatedAt = new Date().toISOString();
		this.flush();
		return flow;
	}

	setNextRunAt(id: string, nextRunAt: string | undefined): AutomationFlow | undefined {
		this.ensureLoaded();
		const flow = this.flows.find((item) => item.id === id);
		if (!flow) return undefined;
		flow.nextRunAt = nextRunAt;
		flow.updatedAt = new Date().toISOString();
		this.flush();
		return flow;
	}

	recordRunStart(id: string, trigger: AutomationRunTrigger, sessionId?: string): AutomationRunRecord {
		this.ensureLoaded();
		const flow = this.requireFlow(id);
		const run: AutomationRunRecord = {
			id: randomUUID(),
			startedAt: new Date().toISOString(),
			status: "running",
			trigger,
			sessionId,
		};
		flow.runs = [run, ...flow.runs.filter((item) => item.id !== run.id)].slice(0, MAX_RUNS);
		flow.lastRun = run;
		flow.updatedAt = new Date().toISOString();
		this.flush();
		return run;
	}

	recordRunFinish(
		flowId: string,
		runId: string,
		status: Exclude<AutomationRunStatus, "running">,
		update: { summary?: string; error?: string; sessionId?: string } = {},
	): AutomationRunRecord | undefined {
		this.ensureLoaded();
		const flow = this.flows.find((item) => item.id === flowId);
		if (!flow) return undefined;
		const run = flow.runs.find((item) => item.id === runId);
		if (!run) return undefined;
		if (run.status !== "running") return { ...run };
		run.status = status;
		run.finishedAt = new Date().toISOString();
		run.summary = cleanOptional(update.summary);
		run.error = cleanOptional(update.error);
		run.sessionId = update.sessionId ?? run.sessionId;
		flow.lastRun = { ...run };
		flow.updatedAt = new Date().toISOString();
		this.flush();
		return run;
	}

	clearRuns(id: string): AutomationFlow {
		this.ensureLoaded();
		const flow = this.requireFlow(id);
		flow.runs = flow.runs.filter((run) => run.status === "running");
		flow.lastRun = flow.runs[0];
		flow.updatedAt = new Date().toISOString();
		this.flush();
		return flow;
	}

	delete(id: string): boolean {
		this.ensureLoaded();
		const index = this.flows.findIndex((flow) => flow.id === id);
		if (index < 0) return false;
		this.flows.splice(index, 1);
		this.flush();
		return true;
	}

	summary(): AutomationSummary {
		this.ensureLoaded();
		const enabled = this.flows.filter((flow) => flow.enabled);
		const running = this.flows.filter((flow) => flow.lastRun?.status === "running");
		const nextRunAt = enabled
			.map((flow) => flow.nextRunAt)
			.filter((value): value is string => typeof value === "string")
			.sort()[0];
		const now = Date.now();
		return {
			total: this.flows.length,
			enabledCount: enabled.length,
			runningCount: running.length,
			nextRunAt,
			missedCount: enabled.filter((flow) => flow.nextRunAt && Date.parse(flow.nextRunAt) < now).length,
		};
	}

	private requireFlow(id: string): AutomationFlow {
		const flow = this.flows.find((value) => value.id === id);
		if (!flow) throw new Error(`Automation flow not found: ${id}`);
		return flow;
	}

	private ensureLoaded(): void {
		if (this.loaded) return;
		this.loaded = true;
		try {
			if (!existsSync(this.filePath)) {
				this.flows = [];
				return;
			}
			const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<AutomationStoreFile>;
			this.flows = Array.isArray(parsed.automations)
				? parsed.automations.map(coerceFlow).filter((item): item is AutomationFlow => item !== undefined)
				: [];
		} catch {
			this.flows = [];
		}
	}

	private flush(): void {
		mkdirSync(this.dir, { recursive: true });
		const payload: AutomationStoreFile = { schemaVersion: SCHEMA_VERSION, automations: this.flows };
		const tmp = `${this.filePath}.${randomUUID().slice(0, 8)}.tmp`;
		writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
		renameSync(tmp, this.filePath);
	}
}

export function normalizeTrigger(trigger: AutomationTrigger | undefined): AutomationTrigger {
	if (!trigger || typeof trigger !== "object") return DEFAULT_TRIGGER;
	switch (trigger.kind) {
		case "once":
			return { kind: "once", at: normalizeIso(trigger.at) ?? new Date().toISOString() };
		case "interval":
			return { kind: "interval", everyMs: clampNumber(trigger.everyMs, 60_000, 1_000, 365 * 24 * 60 * 60 * 1000) };
		case "daily":
			return { kind: "daily", time: normalizeTime(trigger.time) };
		case "weekly":
			return {
				kind: "weekly",
				weekdays: normalizeWeekdays(trigger.weekdays),
				time: normalizeTime(trigger.time),
			};
		default:
			return DEFAULT_TRIGGER;
	}
}

export function normalizeRunPolicy(policy: Partial<AutomationRunPolicy> | undefined): AutomationRunPolicy {
	const mode = policy?.permissionMode;
	return {
		permissionMode: AUTOMATION_PERMISSION_MODES.includes(mode as AutomationPermissionMode)
			? (mode as AutomationPermissionMode)
			: "automatic",
		thinkingLevel: normalizeThinkingLevel(policy?.thinkingLevel),
	};
}

export function normalizeNodes(nodes: FlowNode[] | undefined): FlowNode[] {
	if (!Array.isArray(nodes)) return defaultNodes();
	const result = nodes.map(coerceNode).filter((item): item is FlowNode => item !== undefined);
	return result.length > 0 ? result : defaultNodes();
}

export function normalizeEdges(edges: FlowEdge[] | undefined, nodes: FlowNode[] | undefined): FlowEdge[] {
	if (!Array.isArray(edges)) return [];
	const nodeIds = new Set(normalizeNodes(nodes).map((node) => node.id));
	const seen = new Set<string>();
	return edges
		.map((edge) => coerceEdge(edge, nodeIds))
		.filter((item): item is FlowEdge => item !== undefined)
		.filter((edge) => {
			if (seen.has(edge.id)) return false;
			seen.add(edge.id);
			return true;
		});
}

function defaultNodes(): FlowNode[] {
	return [
		{ id: "start", kind: "start", label: "Start", position: { x: 0, y: 0 } },
		{ id: "end", kind: "end", label: "End", position: { x: 360, y: 0 } },
	];
}

function coerceFlow(value: unknown): AutomationFlow | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string" || typeof raw.name !== "string") return undefined;
	const now = new Date().toISOString();
	const nodes = normalizeNodes(raw.nodes as FlowNode[] | undefined);
	return {
		id: raw.id,
		name: cleanRequired(raw.name, "name", MAX_NAME_LEN),
		description: clampText(typeof raw.description === "string" ? raw.description : "", MAX_DESCRIPTION_LEN),
		enabled: raw.enabled === true,
		nodes,
		edges: normalizeEdges(raw.edges as FlowEdge[] | undefined, nodes),
		trigger: normalizeTrigger(raw.trigger as AutomationTrigger | undefined),
		runPolicy: normalizeRunPolicy(raw.runPolicy as Partial<AutomationRunPolicy> | undefined),
		lastRun: coerceRun(raw.lastRun),
		runs: Array.isArray(raw.runs)
			? raw.runs
					.map(coerceRun)
					.filter((item): item is AutomationRunRecord => !!item)
					.slice(0, MAX_RUNS)
			: [],
		nextRunAt: typeof raw.nextRunAt === "string" ? raw.nextRunAt : undefined,
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
	};
}

function coerceNode(value: unknown): FlowNode | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : randomUUID();
	const kind = VALID_NODE_KINDS.includes(raw.kind as FlowNodeKind) ? (raw.kind as FlowNodeKind) : "task";
	const position =
		typeof raw.position === "object" && raw.position !== null ? (raw.position as Record<string, unknown>) : {};
	const config = typeof raw.config === "object" && raw.config !== null ? (raw.config as Record<string, unknown>) : {};
	return {
		id,
		kind,
		label: cleanRequired(typeof raw.label === "string" ? raw.label : kind, "label", MAX_LABEL_LEN),
		instruction:
			clampText(typeof raw.instruction === "string" ? raw.instruction : "", MAX_INSTRUCTION_LEN) || undefined,
		config: {
			waitMs: finiteNumber(config.waitMs),
			loopMaxIterations: finiteNumber(config.loopMaxIterations),
		},
		position: {
			x: finiteNumber(position.x) ?? 0,
			y: finiteNumber(position.y) ?? 0,
		},
	};
}

function coerceEdge(value: unknown, nodeIds: Set<string>): FlowEdge | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const source = typeof raw.source === "string" ? raw.source.trim() : "";
	const target = typeof raw.target === "string" ? raw.target.trim() : "";
	if (!nodeIds.has(source) || !nodeIds.has(target)) return undefined;
	return {
		id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : randomUUID(),
		source,
		target,
		label: cleanOptional(typeof raw.label === "string" ? raw.label : undefined),
	};
}

function coerceRun(value: unknown): AutomationRunRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string" || typeof raw.startedAt !== "string") return undefined;
	const status =
		raw.status === "succeeded" || raw.status === "failed" || raw.status === "cancelled" ? raw.status : "running";
	const trigger = raw.trigger === "test" || raw.trigger === "scheduled" ? raw.trigger : "manual";
	return {
		id: raw.id,
		startedAt: raw.startedAt,
		finishedAt: typeof raw.finishedAt === "string" ? raw.finishedAt : undefined,
		status,
		trigger,
		sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
		summary: typeof raw.summary === "string" ? raw.summary : undefined,
		error: typeof raw.error === "string" ? raw.error : undefined,
	};
}

function normalizeIso(value: string | undefined): string | undefined {
	if (value === undefined || value === null) return undefined;
	const trimmed = String(value).trim();
	if (!trimmed) return undefined;
	const date = new Date(trimmed);
	if (Number.isNaN(date.getTime())) throw new Error(`Invalid date/time: "${value}". Pass an ISO 8601 timestamp.`);
	return date.toISOString();
}

function normalizeTime(value: string | undefined): string {
	const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ""));
	if (!match) return "09:00";
	return `${match[1]}:${match[2]}`;
}

function normalizeWeekdays(value: number[] | undefined): number[] {
	const days = Array.isArray(value) ? value.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6) : [];
	return Array.from(new Set(days)).sort((left, right) => left - right);
}

function normalizeThinkingLevel(value: unknown): AutomationRunPolicy["thinkingLevel"] {
	return value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
		? value
		: undefined;
}

function cleanRequired(value: string, field: string, max: number): string {
	const cleaned = String(value ?? "").trim();
	if (!cleaned) throw new Error(`Automation ${field} is required.`);
	return cleaned.slice(0, max);
}

function clampText(value: string, max: number): string {
	return String(value ?? "")
		.replace(/\r\n/g, "\n")
		.slice(0, max);
}

function cleanOptional(value: string | undefined): string | undefined {
	const cleaned = value?.trim();
	return cleaned ? cleaned : undefined;
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
