import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DesktopToolResult, ExternalAppManifest } from "../shared/types.ts";

/**
 * The slice of {@link ../main/external-app-controller.ts} that AI tools drive.
 * Implemented by ExternalAppController.toolHost(); kept here so both the
 * controller (main) and the tool factories (agent) share one contract.
 */
export interface ExternalAppToolHost {
	/** Effective manifests of all integrated apps. */
	listManifests(): ExternalAppManifest[];
	/** Ensure an app is running and return how to reach it. Throws on failure. */
	ensureRunning(appId: string): Promise<{ manifest: ExternalAppManifest; baseUrl: string }>;
	/**
	 * Base URL of an app ONLY if it is already running — never boots it. Used for
	 * passive glances (e.g. the home welcome's unread count) that must not spin up a
	 * subprocess. Returns undefined when the app is stopped/starting/errored.
	 */
	getRunningBaseUrl?(appId: string): string | undefined;
	/** Open (or focus) the app's window and navigate to a sub-path. */
	openAtPath(appId: string, path: string): Promise<void>;
}

export const APP_BRIDGE_TOOL_NAMES = ["app_list", "app_call", "open_app"] as const;

const MAX_RESPONSE_CHARS = 8_000;

/** Build a tool result in the shared DesktopToolResult shape (see desktop/tools-web.ts). */
export function appToolResult(
	intent: string,
	target: string,
	ok: boolean,
	stdout?: string,
	stderr?: string,
): { content: [{ type: "text"; text: string }]; details: DesktopToolResult } {
	const details: DesktopToolResult = {
		stepId: randomUUID(),
		intent,
		action: "http",
		target,
		status: ok ? "succeeded" : "failed",
		stdout,
		stderr,
		riskLevel: "low",
		requiresConfirmation: false,
	};
	return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

function clip(text: string): string {
	return text.length > MAX_RESPONSE_CHARS
		? `${text.slice(0, MAX_RESPONSE_CHARS)}\n…[截断，共 ${text.length} 字符]`
		: text;
}

function tryParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return clip(text);
	}
}

/** True when `reqPath` falls under one of the app's allowed prefixes. */
function isAllowed(reqPath: string, allowPrefixes: string[]): boolean {
	return allowPrefixes.some((prefix) => reqPath === prefix || reqPath.startsWith(`${prefix}/`));
}

/**
 * Generic bridge to any integrated app's local HTTP API. This is what makes
 * "所有功能都能用 AI 完成" true without enumerating every endpoint as a tool:
 * the model lists apps, then calls whitelisted paths directly.
 */
export function createAppBridgeToolDefinitions(host: ExternalAppToolHost): ToolDefinition[] {
	const appListTool = defineTool({
		name: "app_list",
		label: "List apps",
		description:
			"List integrated 「更多应用」 apps that expose an AI-callable HTTP API, with their id, base path, and the path prefixes app_call is allowed to hit.",
		promptSnippet:
			"Discover which local apps (email manager, etc.) the assistant can drive over HTTP, and their allowed API paths.",
		promptGuidelines: [
			"调用 app_call 之前先用 app_list 查看可用应用与其允许的路径前缀。",
			"邮箱相关操作优先用 email_* 便捷工具；电子书操作优先用 ebook_* 便捷工具；app_call 用于便捷工具未覆盖的端点。",
		],
		parameters: Type.Object({}),
		execute: async () => {
			const apps = host
				.listManifests()
				.filter((manifest) => manifest.ai)
				.map((manifest) => ({
					id: manifest.id,
					name: manifest.name,
					description: manifest.description,
					basePath: manifest.ai?.basePath,
					allowPrefixes: manifest.ai?.allowPrefixes,
				}));
			return appToolResult("List apps", "apps", true, JSON.stringify(apps));
		},
	});

	const appCallTool = defineTool({
		name: "app_call",
		label: "Call app API",
		description:
			"Call a running 「更多应用」 app's local HTTP API and return the JSON response. The app is started automatically if needed. `path` is relative to the app's base path (e.g. '/mailboxes' or '/mailboxes/1/messages') and must match one of the app's allowed prefixes (see app_list).",
		promptSnippet: "Drive a local app (e.g. the email manager) by calling its HTTP API directly.",
		promptGuidelines: [
			"path 相对于应用的 basePath，不要重复带 basePath（例如 email-manager 写 '/mailboxes' 而非 '/api/v1/mailboxes'）。",
			"只能调用 app_list 返回的允许前缀内的路径；写操作（POST/PUT/DELETE）需谨慎确认用户意图。",
		],
		parameters: Type.Object({
			appId: Type.String({ description: "App id, e.g. 'email-manager'." }),
			method: Type.Optional(
				Type.Union([Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT"), Type.Literal("DELETE")], {
					description: "HTTP method. Default GET.",
				}),
			),
			path: Type.String({ description: "Path relative to the app's base path, e.g. '/mailboxes'." }),
			query: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Query string parameters." })),
			body: Type.Optional(Type.Unknown()),
		}),
		execute: async (_id, params) => {
			const target = `${params.appId} ${params.method ?? "GET"} ${params.path}`;
			const manifest = host.listManifests().find((entry) => entry.id === params.appId);
			if (!manifest) return appToolResult("App call", target, false, undefined, `未知应用: ${params.appId}`);
			if (!manifest.ai)
				return appToolResult("App call", target, false, undefined, `应用「${manifest.name}」未开放 AI 接口`);

			const reqPath = params.path.startsWith("/") ? params.path : `/${params.path}`;
			if (!isAllowed(reqPath, manifest.ai.allowPrefixes)) {
				return appToolResult(
					"App call",
					target,
					false,
					undefined,
					`路径不在白名单内: ${reqPath}（允许前缀: ${manifest.ai.allowPrefixes.join(", ")}）`,
				);
			}

			try {
				const { baseUrl } = await host.ensureRunning(params.appId);
				const url = new URL(`${baseUrl}${manifest.ai.basePath}${reqPath}`);
				for (const [key, value] of Object.entries(params.query ?? {})) url.searchParams.set(key, value);
				const method = params.method ?? "GET";
				const hasBody = method !== "GET" && params.body !== undefined;
				const res = await fetch(url, {
					method,
					headers: hasBody ? { "Content-Type": "application/json" } : undefined,
					body: hasBody ? JSON.stringify(params.body) : undefined,
					signal: AbortSignal.timeout(30_000),
				});
				const text = await res.text();
				const summary = JSON.stringify({ status: res.status, ok: res.ok, body: tryParse(text) });
				return appToolResult("App call", target, res.ok, summary, res.ok ? undefined : `HTTP ${res.status}`);
			} catch (error) {
				return appToolResult(
					"App call",
					target,
					false,
					undefined,
					error instanceof Error ? error.message : String(error),
				);
			}
		},
	});

	const openAppTool = defineTool({
		name: "open_app",
		label: "Open app window",
		description:
			"Open (or focus) any integrated app's window. Optionally navigate to a specific sub-path within the app (e.g. a book reader page). Starts the app automatically if not yet running.",
		promptSnippet: "Bring an integrated app's window into focus, optionally at a specific page.",
		promptGuidelines: [
			"不确定路径时先用 ebook_list_books / email_list_accounts 等工具取 id，再构造路径。",
			"打开电子书阅读页优先用 ebook_read_book；open_app 用于其他应用或任意路径。",
		],
		parameters: Type.Object({
			appId: Type.String({ description: "App id (from app_list), e.g. 'ebook-library'." }),
			path: Type.Optional(
				Type.String({
					description: "Sub-path to navigate to (e.g. '/books/abc123/read'). Defaults to app root '/'.",
				}),
			),
		}),
		execute: async (_id, params) => {
			const manifest = host.listManifests().find((m) => m.id === params.appId);
			if (!manifest) return appToolResult("Open app", params.appId, false, undefined, `未知应用: ${params.appId}`);
			try {
				await host.openAtPath(params.appId, params.path ?? "/");
				return appToolResult("Open app", params.appId, true, `已开启窗口：${manifest.name}${params.path ?? ""}`);
			} catch (error) {
				return appToolResult(
					"Open app",
					params.appId,
					false,
					undefined,
					error instanceof Error ? error.message : String(error),
				);
			}
		},
	});

	return [appListTool, appCallTool, openAppTool];
}
