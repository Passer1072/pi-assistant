import { describe, expect, it, vi } from "vitest";
import {
	AUTOMATION_BRIDGE_TOOL_NAMES,
	type AutomationBridgeToolHost,
	createAutomationBridgeToolDefinitions,
} from "../src/agent/automation-bridge-tools.ts";
import type { AutomationFlow, DesktopToolResult } from "../src/shared/types.ts";

function sampleFlow(overrides: Partial<AutomationFlow> = {}): AutomationFlow {
	const now = new Date().toISOString();
	return {
		id: "f1",
		name: "每日早报",
		description: "",
		enabled: true,
		nodes: [
			{ id: "start", kind: "start", label: "开始", position: { x: 0, y: 0 } },
			{ id: "end", kind: "end", label: "结束", position: { x: 200, y: 0 } },
		],
		edges: [],
		trigger: { kind: "daily", time: "08:00" },
		runPolicy: { permissionMode: "automatic" },
		runs: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function makeHost(overrides: Partial<AutomationBridgeToolHost> = {}): AutomationBridgeToolHost {
	const flow = sampleFlow();
	return {
		listAutomations: vi.fn(() => ({
			flows: [flow],
			summary: { total: 1, enabledCount: 1, runningCount: 0, missedCount: 0 },
		})),
		getAutomation: vi.fn((request) => (request.id === flow.id ? flow : undefined)),
		runAutomation: vi.fn(async (request) => ({
			flow,
			run: {
				id: "run-1",
				startedAt: new Date().toISOString(),
				status: "running" as const,
				trigger: request.trigger ?? "manual",
			},
		})),
		cancelAutomationRun: vi.fn(() => true),
		setAutomationEnabled: vi.fn((request) => sampleFlow({ enabled: request.enabled })),
		createAutomation: vi.fn((request) => sampleFlow({ id: "created", name: request.name ?? "草稿", enabled: false })),
		updateAutomation: vi.fn((request) => sampleFlow({ ...request, id: request.id, enabled: flow.enabled })),
		openAutomationEditor: vi.fn(async () => undefined),
		...overrides,
	};
}

type ToolReturn = { content: Array<{ type: "text"; text: string }>; details: DesktopToolResult };

function findTool(host: AutomationBridgeToolHost, name: string) {
	const tool = createAutomationBridgeToolDefinitions(host).find((definition) => definition.name === name);
	if (!tool) throw new Error(`tool not found: ${name}`);
	return tool;
}

function runTool(tool: ReturnType<typeof findTool>, params: Record<string, unknown>): Promise<ToolReturn> {
	const execute = tool.execute as unknown as (
		toolCallId: string,
		params: Record<string, unknown>,
	) => Promise<ToolReturn>;
	return execute("call", params);
}

describe("automation bridge tools", () => {
	it("exposes every named tool", () => {
		const tools = createAutomationBridgeToolDefinitions(makeHost());
		expect(tools.map((tool) => tool.name).sort()).toEqual([...AUTOMATION_BRIDGE_TOOL_NAMES].sort());
	});

	it("runs a flow resolved by partial name", async () => {
		const host = makeHost();
		const result = await runTool(findTool(host, "automation_run"), { name: "早报" });
		expect(result.details.status).toBe("succeeded");
		expect(host.runAutomation).toHaveBeenCalledWith({ id: "f1", trigger: "manual" });
		expect(result.details.stdout).toContain("run-1");
	});

	it("gets a full flow graph by partial name", async () => {
		const flow = sampleFlow({
			name: "Daily report",
			edges: [{ id: "start-end", source: "start", target: "end" }],
		});
		const host = makeHost({
			listAutomations: vi.fn(() => ({
				flows: [flow],
				summary: { total: 1, enabledCount: 1, runningCount: 0, missedCount: 0 },
			})),
		});
		const result = await runTool(findTool(host, "automation_get"), { name: "report" });
		expect(result.details.status).toBe("succeeded");
		expect(result.details.stdout).toContain('"nodes"');
		expect(result.details.stdout).toContain('"edges"');
		expect(result.details.stdout).toContain('"start-end"');
	});

	it("fails with available names when the flow can't be found", async () => {
		const host = makeHost();
		const result = await runTool(findTool(host, "automation_run"), { name: "不存在" });
		expect(result.details.status).toBe("failed");
		expect(result.details.stderr).toContain("每日早报");
	});

	it("fails when a partial name matches multiple flows", async () => {
		const flows = [sampleFlow({ id: "f1", name: "Report A" }), sampleFlow({ id: "f2", name: "Report B" })];
		const host = makeHost({
			listAutomations: vi.fn(() => ({
				flows,
				summary: { total: 2, enabledCount: 2, runningCount: 0, missedCount: 0 },
			})),
		});
		const result = await runTool(findTool(host, "automation_get"), { name: "Report" });
		expect(result.details.status).toBe("failed");
		expect(result.details.stderr).toContain("f1");
		expect(result.details.stderr).toContain("f2");
	});

	it("create_draft builds a linear graph and opens the editor", async () => {
		const host = makeHost();
		const result = await runTool(findTool(host, "automation_create_draft"), {
			name: "整理下载",
			steps: ["扫描下载目录", "按类型归档"],
		});
		expect(result.details.status).toBe("succeeded");
		const createArg = (host.createAutomation as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(createArg.enabled).toBe(false);
		// start + 2 tasks + end
		expect(createArg.nodes).toHaveLength(4);
		expect(createArg.edges).toHaveLength(3);
		expect(host.openAutomationEditor).toHaveBeenCalledWith({ flowId: "created" });
	});

	it("create_draft can skip opening the editor", async () => {
		const host = makeHost();
		await runTool(findTool(host, "automation_create_draft"), { name: "x", openEditor: false });
		expect(host.openAutomationEditor).not.toHaveBeenCalled();
	});

	it("edits an existing flow without enabling it or opening the editor by default", async () => {
		const flow = sampleFlow({ name: "Daily report", enabled: false });
		const host = makeHost({
			listAutomations: vi.fn(() => ({
				flows: [flow],
				summary: { total: 1, enabledCount: 0, runningCount: 0, missedCount: 0 },
			})),
			getAutomation: vi.fn((request) => (request.id === flow.id ? flow : undefined)),
			updateAutomation: vi.fn((request) => sampleFlow({ ...request, id: request.id, enabled: flow.enabled })),
		});
		const result = await runTool(findTool(host, "automation_edit"), {
			name: "report",
			ops: [
				{
					type: "add_node",
					node: { id: "task-1", kind: "task", label: "Fetch data", instruction: "Fetch data" },
				},
				{ type: "connect", edge: { id: "start-task", source: "start", target: "task-1" } },
				{ type: "connect", edge: { id: "task-end", source: "task-1", target: "end" } },
			],
		});

		expect(result.details.status).toBe("succeeded");
		expect(host.updateAutomation).toHaveBeenCalledTimes(1);
		const updateArg = (host.updateAutomation as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(updateArg.id).toBe("f1");
		expect(updateArg.nodes).toContainEqual(expect.objectContaining({ id: "task-1", label: "Fetch data" }));
		expect(updateArg.edges).toContainEqual(expect.objectContaining({ id: "start-task" }));
		expect(updateArg).not.toHaveProperty("enabled");
		expect(host.openAutomationEditor).not.toHaveBeenCalled();
		expect(result.details.stdout).toContain('"editorOpened": false');
	});

	it("can open the editor after editing when requested", async () => {
		const host = makeHost();
		await runTool(findTool(host, "automation_edit"), {
			id: "f1",
			ops: [{ type: "set_meta", description: "Updated" }],
			openEditor: true,
		});
		expect(host.updateAutomation).toHaveBeenCalledWith(expect.objectContaining({ id: "f1", description: "Updated" }));
		expect(host.openAutomationEditor).toHaveBeenCalledWith({ flowId: "f1" });
	});

	it("status returns the latest run and recent history", async () => {
		const run = {
			id: "run-9",
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			status: "succeeded" as const,
			trigger: "manual" as const,
			summary: "done",
		};
		const host = makeHost({ getAutomation: vi.fn(() => sampleFlow({ lastRun: run, runs: [run] })) });
		const result = await runTool(findTool(host, "automation_status"), { id: "f1" });
		expect(result.details.status).toBe("succeeded");
		expect(result.details.stdout).toContain("run-9");
	});

	it("status waitForChange waits until the watched run changes", async () => {
		vi.useFakeTimers();
		try {
			let finished = false;
			const runningRun = {
				id: "run-9",
				startedAt: new Date().toISOString(),
				status: "running" as const,
				trigger: "manual" as const,
			};
			const finishedRun = {
				...runningRun,
				finishedAt: new Date().toISOString(),
				status: "succeeded" as const,
				summary: "done",
			};
			const host = makeHost({
				getAutomation: vi.fn(() =>
					sampleFlow({
						lastRun: finished ? finishedRun : runningRun,
						runs: [finished ? finishedRun : runningRun],
					}),
				),
			});
			const promise = runTool(findTool(host, "automation_status"), {
				id: "f1",
				runId: "run-9",
				waitForChange: true,
			});
			await vi.advanceTimersByTimeAsync(1_000);
			finished = true;
			await vi.advanceTimersByTimeAsync(2_000);
			const result = await promise;
			expect(result.details.status).toBe("succeeded");
			expect(result.details.stdout).toContain('"status": "succeeded"');
		} finally {
			vi.useRealTimers();
		}
	});

	it("status waitForChange aborts promptly", async () => {
		vi.useFakeTimers();
		try {
			const runningRun = {
				id: "run-9",
				startedAt: new Date().toISOString(),
				status: "running" as const,
				trigger: "manual" as const,
			};
			const host = makeHost({
				getAutomation: vi.fn(() => sampleFlow({ lastRun: runningRun, runs: [runningRun] })),
			});
			const controller = new AbortController();
			const execute = findTool(host, "automation_status").execute as unknown as (
				toolCallId: string,
				params: Record<string, unknown>,
				signal?: AbortSignal,
			) => Promise<ToolReturn>;
			const promise = execute("call", { id: "f1", runId: "run-9", waitForChange: true }, controller.signal);
			await vi.advanceTimersByTimeAsync(1_000);
			controller.abort();
			const result = await promise;
			expect(result.details.status).toBe("failed");
			expect(result.details.stderr).toContain("Aborted");
		} finally {
			vi.useRealTimers();
		}
	});

	it("set_enabled toggles a flow", async () => {
		const host = makeHost();
		await runTool(findTool(host, "automation_set_enabled"), { id: "f1", enabled: false });
		expect(host.setAutomationEnabled).toHaveBeenCalledWith({ id: "f1", enabled: false });
	});
});
