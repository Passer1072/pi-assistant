import type { AutomationFlow, AutomationRunRecord, AutomationRunTrigger, FlowEdge, FlowNode } from "../shared/types.ts";

export interface AutomationRunnerHost {
	recordRunStart(flowId: string, trigger: AutomationRunTrigger, sessionId?: string): AutomationRunRecord;
	recordRunFinish(
		flowId: string,
		runId: string,
		status: "succeeded" | "failed" | "cancelled",
		update?: { summary?: string; error?: string; sessionId?: string },
	): AutomationRunRecord | undefined;
	emitChanged(flowId: string): void;
	emitProgress(flowId: string, runId: string, message: string): void;
	/**
	 * Emit a structured terminal progress event so every window (editor + automation page) can
	 * clear its "running" state, even when the agent itself didn't call automation_finish (e.g. a
	 * failure or an external cancel).
	 */
	emitFinish(flowId: string, runId: string, status: "succeeded" | "failed" | "cancelled", summary?: string): void;
	createBackgroundConversation(
		flow: AutomationFlow,
		run: AutomationRunRecord,
	): Promise<{ sessionId: string; prompt(message: string): Promise<void>; abort(): void; finalize?(): Promise<void> }>;
}

export class AutomationRunner {
	private readonly host: AutomationRunnerHost;
	private readonly activeRuns = new Map<string, { runId: string; abort: () => void }>();

	constructor(host: AutomationRunnerHost) {
		this.host = host;
	}

	/**
	 * Start a run and return the freshly-created (still "running") run record immediately. The
	 * agent conversation then drives the flow in the background, surfacing progress through the
	 * host's emit* callbacks. Resolving up front (instead of awaiting the whole run) is what lets
	 * the UI show a live "running" state, highlight the executing node, and offer a working
	 * interrupt button while the flow is still in progress.
	 */
	async runAutomation(flow: AutomationFlow, options: { trigger: AutomationRunTrigger }): Promise<AutomationRunRecord> {
		if (this.activeRuns.has(flow.id)) throw new Error(`Automation is already running: ${flow.name}`);
		const run = this.host.recordRunStart(flow.id, options.trigger);
		const conversation = await this.host.createBackgroundConversation(flow, run);
		this.activeRuns.set(flow.id, { runId: run.id, abort: conversation.abort });
		this.host.emitChanged(flow.id);
		this.host.emitProgress(flow.id, run.id, `Automation run started: ${flow.name}`);
		void this.executeRun(flow, run.id, conversation);
		return run;
	}

	private async executeRun(
		flow: AutomationFlow,
		runId: string,
		conversation: { sessionId: string; prompt(message: string): Promise<void>; finalize?(): Promise<void> },
	): Promise<void> {
		try {
			await conversation.prompt(serializeFlowToRunbook(flow));
			// recordRunFinish is a no-op once the run already settled (e.g. the agent called
			// automation_finish, or it was cancelled), so a duplicate "succeeded" here is harmless.
			const finished = this.host.recordRunFinish(flow.id, runId, "succeeded", {
				summary: "Automation run completed.",
				sessionId: conversation.sessionId,
			});
			// finished.status is whatever the run actually settled on (e.g. "failed" if the agent
			// itself reported failure via automation_finish), never "running" once settled.
			const status = finished && finished.status !== "running" ? finished.status : "succeeded";
			this.host.emitChanged(flow.id);
			this.host.emitFinish(flow.id, runId, status, finished?.summary);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const finished = this.host.recordRunFinish(flow.id, runId, "failed", {
				error: message,
				sessionId: conversation.sessionId,
			});
			const status = finished && finished.status !== "running" ? finished.status : "failed";
			this.host.emitChanged(flow.id);
			this.host.emitFinish(flow.id, runId, status, finished?.summary ?? message);
		} finally {
			this.activeRuns.delete(flow.id);
			await conversation.finalize?.();
		}
	}

	cancelRun(flowId: string): boolean {
		const active = this.activeRuns.get(flowId);
		if (!active) return false;
		active.abort();
		this.activeRuns.delete(flowId);
		this.host.recordRunFinish(flowId, active.runId, "cancelled", { summary: "Automation run cancelled." });
		this.host.emitChanged(flowId);
		this.host.emitFinish(flowId, active.runId, "cancelled", "Automation run cancelled.");
		return true;
	}
}

export function serializeFlowToRunbook(flow: AutomationFlow): string {
	const ordered = orderNodes(flow.nodes, flow.edges);
	const edgesBySource = groupEdgesBySource(flow.edges);
	const lines = [
		"# Automation runbook",
		"",
		`Flow: ${flow.name}`,
		flow.description ? `Description: ${flow.description}` : "Description: (none)",
		"",
		"Execution rules:",
		'- Before starting a node, call automation_step with phase "enter".',
		'- After completing a node, call automation_step with phase "done".',
		"- For condition nodes, call automation_branch with the chosen outgoing label or target node id.",
		'- When the whole flow finishes, call automation_finish with status "succeeded" and a concise summary.',
		'- If a node cannot be completed, call automation_finish with status "failed" and explain the error.',
		"",
		"Nodes:",
	];
	for (const node of ordered) {
		lines.push(formatNode(node));
		const outgoing = edgesBySource.get(node.id) ?? [];
		for (const edge of outgoing) {
			lines.push(`  -> ${edge.target}${edge.label ? ` when "${edge.label}"` : ""}`);
		}
	}
	return lines.join("\n");
}

function orderNodes(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const outgoing = groupEdgesBySource(edges);
	const incoming = new Map<string, number>();
	for (const node of nodes) incoming.set(node.id, 0);
	for (const edge of edges) {
		if (byId.has(edge.source) && byId.has(edge.target))
			incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
	}
	const queue = nodes.filter((node) => node.kind === "start" || (incoming.get(node.id) ?? 0) === 0);
	if (queue.length === 0 && nodes[0]) queue.push(nodes[0]);
	const seen = new Set<string>();
	const ordered: FlowNode[] = [];
	while (queue.length > 0) {
		const node = queue.shift();
		if (!node || seen.has(node.id)) continue;
		seen.add(node.id);
		ordered.push(node);
		for (const edge of outgoing.get(node.id) ?? []) {
			const target = byId.get(edge.target);
			if (target && !seen.has(target.id)) queue.push(target);
		}
	}
	for (const node of nodes) {
		if (!seen.has(node.id)) ordered.push(node);
	}
	return ordered;
}

function groupEdgesBySource(edges: FlowEdge[]): Map<string, FlowEdge[]> {
	const grouped = new Map<string, FlowEdge[]>();
	for (const edge of edges) grouped.set(edge.source, [...(grouped.get(edge.source) ?? []), edge]);
	return grouped;
}

function formatNode(node: FlowNode): string {
	const pieces = [`- [${node.id}] ${node.kind}: ${node.label}`];
	if (node.instruction) pieces.push(`  Instruction: ${node.instruction}`);
	if (node.kind === "wait" && node.config?.waitMs) pieces.push(`  Wait: ${node.config.waitMs} ms.`);
	if (node.kind === "loop" && node.config?.loopMaxIterations) {
		pieces.push(`  Loop maximum iterations: ${node.config.loopMaxIterations}.`);
	}
	return pieces.join("\n");
}
