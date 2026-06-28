import { describe, expect, it } from "vitest";
import { buildErrorSelfSummaryAppendPrompt } from "../src/agent/error-self-summary.ts";
import {
	createSessionToolDefinitions,
	SESSION_TOOL_NAMES,
	type SessionToolHost,
	type TurnToolError,
} from "../src/agent/session-tools.ts";
import type { DesktopToolResult } from "../src/shared/types.ts";

type ToolReturn = { content: Array<{ type: "text"; text: string }>; details: DesktopToolResult };

function makeHost(overrides: Partial<SessionToolHost> = {}): SessionToolHost {
	return {
		getSourceSessionId: () => "sess-abcdef123456",
		getCurrentTitle: () => "我的会话",
		getRecentToolErrors: () => [],
		...overrides,
	};
}

function runSessionInfo(host: SessionToolHost): Promise<ToolReturn> {
	const tool = createSessionToolDefinitions(host).find((definition) => definition.name === "session_info");
	if (!tool) throw new Error("session_info tool not found");
	const execute = tool.execute as unknown as (id: string, params: Record<string, unknown>) => Promise<ToolReturn>;
	return execute("call", {});
}

describe("session tools", () => {
	it("exposes every named tool", () => {
		const tools = createSessionToolDefinitions(makeHost());
		expect(tools.map((tool) => tool.name).sort()).toEqual([...SESSION_TOOL_NAMES].sort());
	});

	it("session_info returns the session id, short id, title, and recent tool errors", async () => {
		const recentToolErrors: TurnToolError[] = [{ toolName: "open_app", message: "not found" }];
		const result = await runSessionInfo(makeHost({ getRecentToolErrors: () => recentToolErrors }));
		expect(result.details.status).toBe("succeeded");
		const payload = JSON.parse(result.details.stdout ?? "{}");
		expect(payload).toMatchObject({
			sessionId: "sess-abcdef123456",
			shortId: "sess-abc",
			title: "我的会话",
			recentToolErrors,
		});
	});

	it("session_info tolerates a missing session id", async () => {
		const result = await runSessionInfo(makeHost({ getSourceSessionId: () => undefined }));
		const payload = JSON.parse(result.details.stdout ?? "{}");
		expect(payload.sessionId).toBeNull();
		expect(payload.shortId).toBeNull();
	});
});

describe("error self-summary prompt", () => {
	it("instructs the model to title with the session id and use memo_create", () => {
		const prompt = buildErrorSelfSummaryAppendPrompt();
		expect(prompt).toContain("session_info");
		expect(prompt).toContain("memo_create");
		expect(prompt).toContain("会话 <sessionId> 出错总结");
		// User-driven failures are explicitly excluded.
		expect(prompt).toContain("blocked");
	});
});
