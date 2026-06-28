import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppBridgeToolDefinitions, type ExternalAppToolHost } from "../src/agent/app-bridge-tools.ts";
import { createEmailToolDefinitions } from "../src/agent/email-tools.ts";
import type { DesktopToolResult, ExternalAppManifest } from "../src/shared/types.ts";

const emailManifest: ExternalAppManifest = {
	id: "email-manager",
	name: "邮箱管家",
	icon: "📧",
	cwd: "x",
	command: "py",
	args: [],
	urlPattern: "http://127.0.0.1:{port}/",
	healthPath: "/health",
	autoStart: false,
	builtIn: true,
	ai: { basePath: "/api/v1", allowPrefixes: ["/mailboxes", "/groups", "/dashboard"] },
};

const ebookManifest: ExternalAppManifest = {
	id: "ebook-library",
	name: "电子书库",
	icon: "📚",
	cwd: "y",
	command: "py",
	args: ["main.py"],
	urlPattern: "http://127.0.0.1:{port}/",
	healthPath: "/",
	autoStart: false,
	builtIn: true,
	// no ai config
};

type ToolReturn = { content: Array<{ type: "text"; text: string }>; details: DesktopToolResult };
type FetchResponseMock = { ok: boolean; status: number; text: () => Promise<string> };
type FetchMock = ReturnType<typeof vi.fn> & {
	mock: { calls: Array<[URL, RequestInit?]> };
};

function makeHost(overrides: Partial<ExternalAppToolHost> = {}): ExternalAppToolHost {
	return {
		listManifests: () => [emailManifest, ebookManifest],
		ensureRunning: vi.fn(async () => ({ manifest: emailManifest, baseUrl: "http://127.0.0.1:8001" })),
		openAtPath: vi.fn(async () => undefined),
		...overrides,
	};
}

function tool(defs: ReturnType<typeof createAppBridgeToolDefinitions>, name: string) {
	const found = defs.find((d) => d.name === name);
	if (!found) throw new Error(`tool not found: ${name}`);
	return found;
}

function run(t: { execute: unknown }, params: Record<string, unknown>): Promise<ToolReturn> {
	const execute = t.execute as (id: string, params: Record<string, unknown>) => Promise<ToolReturn>;
	return execute("call-1", params);
}

function mockFetchOnce(body: unknown, init: { ok?: boolean; status?: number } = {}) {
	const fetchMock = vi.fn(
		async (): Promise<FetchResponseMock> => ({
			ok: init.ok ?? true,
			status: init.status ?? 200,
			text: async () => JSON.stringify(body),
		}),
	) as FetchMock;
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("app_list", () => {
	it("lists only AI-enabled apps", async () => {
		const defs = createAppBridgeToolDefinitions(makeHost());
		const result = await run(tool(defs, "app_list"), {});
		const apps = JSON.parse(result.details.stdout ?? "[]");
		expect(apps.map((a: { id: string }) => a.id)).toEqual(["email-manager"]);
		expect(apps[0].allowPrefixes).toContain("/mailboxes");
	});
});

describe("app_call", () => {
	it("rejects an unknown app", async () => {
		const defs = createAppBridgeToolDefinitions(makeHost());
		const result = await run(tool(defs, "app_call"), { appId: "ghost", path: "/x" });
		expect(result.details.status).toBe("failed");
		expect(result.details.stderr).toContain("未知应用");
	});

	it("rejects an app without an AI interface", async () => {
		const defs = createAppBridgeToolDefinitions(makeHost());
		const result = await run(tool(defs, "app_call"), { appId: "ebook-library", path: "/x" });
		expect(result.details.status).toBe("failed");
		expect(result.details.stderr).toContain("未开放");
	});

	it("rejects a path outside the whitelist", async () => {
		const defs = createAppBridgeToolDefinitions(makeHost());
		const result = await run(tool(defs, "app_call"), { appId: "email-manager", path: "/secret" });
		expect(result.details.status).toBe("failed");
		expect(result.details.stderr).toContain("白名单");
	});

	it("calls the correct URL for a whitelisted path and starts the app", async () => {
		const fetchMock = mockFetchOnce({ ok: true, data: [] });
		const host = makeHost();
		const defs = createAppBridgeToolDefinitions(host);
		const result = await run(tool(defs, "app_call"), { appId: "email-manager", path: "/mailboxes/1/messages" });
		expect(host.ensureRunning).toHaveBeenCalledWith("email-manager");
		const calledUrl = String(fetchMock.mock.calls[0][0]);
		expect(calledUrl).toBe("http://127.0.0.1:8001/api/v1/mailboxes/1/messages");
		expect(result.details.status).toBe("succeeded");
	});

	it("forwards query params", async () => {
		const fetchMock = mockFetchOnce({ ok: true });
		const defs = createAppBridgeToolDefinitions(makeHost());
		await run(tool(defs, "app_call"), { appId: "email-manager", path: "/mailboxes", query: { search: "foo" } });
		expect(String(fetchMock.mock.calls[0][0])).toContain("search=foo");
	});
});

describe("email tools", () => {
	it("email_verification_code hits the login-code endpoint with refresh", async () => {
		const fetchMock = mockFetchOnce({ ok: true, data: { code: "123456" } });
		const defs = createEmailToolDefinitions(makeHost());
		const verify = defs.find((d) => d.name === "email_verification_code");
		await run(verify as { execute: unknown }, { email: "a@b.com", codeType: "login" });
		const url = String(fetchMock.mock.calls[0][0]);
		expect(url).toContain("/api/v1/mailboxes/by-email/a%40b.com/chatgpt-login-code");
		expect(url).toContain("refresh=true");
	});

	it("email_latest_mail clamps the limit and targets bootstrap", async () => {
		const fetchMock = mockFetchOnce({ ok: true });
		const defs = createEmailToolDefinitions(makeHost());
		const latest = defs.find((d) => d.name === "email_latest_mail");
		await run(latest as { execute: unknown }, { mailboxId: 5, limit: 999 });
		const url = String(fetchMock.mock.calls[0][0]);
		expect(url).toContain("/api/v1/mailboxes/5/mail-viewer-bootstrap");
		expect(url).toContain("limit=50");
	});

	it("email_list_accounts targets /mailboxes", async () => {
		const fetchMock = mockFetchOnce({ ok: true, data: [] });
		const defs = createEmailToolDefinitions(makeHost());
		const list = defs.find((d) => d.name === "email_list_accounts");
		await run(list as { execute: unknown }, {});
		expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:8001/api/v1/mailboxes");
	});
});
