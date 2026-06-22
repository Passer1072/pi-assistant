import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
	AiBrowserPreference,
	BrowserClearStorageRequest,
	BrowserCookieRequest,
	BrowserElementActionRequest,
	BrowserKeyRequest,
	BrowserQueryElementsRequest,
	BrowserReadPageRequest,
	BrowserScreenshotRequest,
	BrowserScrollRequest,
	BrowserTabRequest,
	BrowserTarget,
	BrowserVirtualMouseRequest,
	DesktopToolResult,
} from "../shared/types.ts";

export interface BrowserToolHost {
	getDefaultBrowser(): BrowserTarget;
	listTabs(target: BrowserTarget): Promise<unknown>;
	openUrl(target: BrowserTarget, url: string): Promise<unknown>;
	newTab(target: BrowserTarget, url?: string): Promise<unknown>;
	switchTab(target: BrowserTarget, request: BrowserTabRequest): Promise<unknown>;
	closeTab(target: BrowserTarget, request: BrowserTabRequest): Promise<unknown>;
	readPage(target: BrowserTarget, request: BrowserReadPageRequest): Promise<unknown>;
	queryElements(target: BrowserTarget, request: BrowserQueryElementsRequest): Promise<unknown>;
	click(target: BrowserTarget, request: BrowserElementActionRequest): Promise<unknown>;
	typeText(target: BrowserTarget, request: BrowserElementActionRequest): Promise<unknown>;
	pressKey(target: BrowserTarget, request: BrowserKeyRequest): Promise<unknown>;
	scroll(target: BrowserTarget, request: BrowserScrollRequest): Promise<unknown>;
	screenshot(target: BrowserTarget, request: BrowserScreenshotRequest): Promise<unknown>;
	getCookies(target: BrowserTarget, request: BrowserCookieRequest): Promise<unknown>;
	clearStorage(target: BrowserTarget, request: BrowserClearStorageRequest): Promise<unknown>;
	virtualMouse(target: BrowserTarget, request: BrowserVirtualMouseRequest): Promise<unknown>;
}

export const BROWSER_TOOL_NAMES = [
	"browser_list_tabs",
	"browser_open_url",
	"browser_new_tab",
	"browser_switch_tab",
	"browser_close_tab",
	"browser_read_page",
	"browser_query_elements",
	"browser_click",
	"browser_type_text",
	"browser_press_key",
	"browser_scroll",
	"browser_screenshot",
	"browser_get_cookies",
	"browser_clear_storage",
	"browser_virtual_mouse",
] as const;

const STORAGE_SCOPE = Type.Union([
	Type.Literal("cookies"),
	Type.Literal("cache"),
	Type.Literal("site_data"),
	Type.Literal("all"),
]);

const optionalBrowser = Type.Optional(
	Type.Union([Type.Literal("built_in"), Type.Literal("chrome"), Type.Literal("edge")], {
		description: "Optional one-time browser override. Omit to use the user's default browser setting.",
	}),
);

const ROUTING_GUIDELINES = [
	"Omit the browser parameter unless the user explicitly asked for Chrome, Edge, or the built-in browser.",
	"Do not switch browsers casually. If the default browser cannot perform the task, explain the limitation before choosing a fallback.",
	"Use the built-in browser for the richest inspection data when it is the selected/default browser: page text, HTML/source, elements, console, network, cookies, screenshots, and virtual mouse are available.",
	"Chrome and Edge use the assistant's dedicated persistent AI profile, not the user's daily browsing profile.",
];

export function createBrowserToolDefinitions(host: BrowserToolHost): ToolDefinition[] {
	return [
		defineTool({
			name: "browser_list_tabs",
			label: "List browser tabs",
			description:
				"List the open tabs in the browser (id, title, url, which is active). Use this to see the current browser state before reading, switching, or acting on a tab.",
			promptSnippet: "List the open browser tabs to see the current state before acting.",
			promptGuidelines: ROUTING_GUIDELINES,
			parameters: Type.Object({
				browser: optionalBrowser,
			}),
			execute: async (_id, params) =>
				browserResult(host, "List browser tabs", "browser_list_tabs", "tabs", params.browser, (target) =>
					host.listTabs(target),
				),
		}),
		defineTool({
			name: "browser_open_url",
			label: "Open browser URL",
			description: "Open a URL in the user's default browser, or in a one-time browser override.",
			promptSnippet: "Open URLs through the configured default browser unless the user explicitly names a browser.",
			promptGuidelines: ROUTING_GUIDELINES,
			parameters: Type.Object({
				url: Type.String({ description: "URL, file path, domain, or about:blank." }),
				browser: optionalBrowser,
			}),
			execute: async (_id, params) =>
				browserResult(host, "Open browser URL", "browser_open_url", params.url, params.browser, (target) =>
					host.openUrl(target, params.url),
				),
		}),
		defineTool({
			name: "browser_new_tab",
			label: "New browser tab",
			description: "Open a new tab in the selected browser.",
			promptSnippet: "Open a new browser tab through the configured default browser.",
			promptGuidelines: ROUTING_GUIDELINES,
			parameters: Type.Object({
				url: Type.Optional(Type.String({ description: "Optional URL for the new tab." })),
				browser: optionalBrowser,
			}),
			execute: async (_id, params) =>
				browserResult(
					host,
					"New browser tab",
					"browser_new_tab",
					params.url ?? "new tab",
					params.browser,
					(target) => host.newTab(target, params.url),
				),
		}),
		defineTool({
			name: "browser_switch_tab",
			label: "Switch browser tab",
			description: "Switch to a browser tab by tabId.",
			promptSnippet: "Switch an existing browser tab by tabId.",
			promptGuidelines: ROUTING_GUIDELINES,
			parameters: Type.Object({
				tabId: Type.Optional(Type.String()),
				browser: optionalBrowser,
			}),
			execute: async (_id, params) =>
				browserResult(
					host,
					"Switch browser tab",
					"browser_switch_tab",
					params.tabId ?? "active",
					params.browser,
					(target) => host.switchTab(target, { tabId: params.tabId }),
				),
		}),
		defineTool({
			name: "browser_close_tab",
			label: "Close browser tab",
			description: "Close a browser tab by tabId.",
			promptSnippet: "Close an existing browser tab by tabId.",
			promptGuidelines: ROUTING_GUIDELINES,
			parameters: Type.Object({
				tabId: Type.Optional(Type.String()),
				browser: optionalBrowser,
			}),
			execute: async (_id, params) =>
				browserResult(
					host,
					"Close browser tab",
					"browser_close_tab",
					params.tabId ?? "active",
					params.browser,
					(target) => host.closeTab(target, { tabId: params.tabId }),
				),
		}),
		defineTool({
			name: "browser_read_page",
			label: "Read browser page",
			description: "Read the current page, with optional HTML/source/elements/network/console details.",
			promptSnippet: "Read page text, source/HTML, elements, console, and network details from the browser.",
			promptGuidelines: ROUTING_GUIDELINES,
			parameters: Type.Object({
				tabId: Type.Optional(Type.String()),
				includeHtml: Type.Optional(Type.Boolean()),
				includeSource: Type.Optional(Type.Boolean()),
				includeElements: Type.Optional(Type.Boolean()),
				includeNetwork: Type.Optional(Type.Boolean()),
				includeConsole: Type.Optional(Type.Boolean()),
				maxChars: Type.Optional(Type.Number({ minimum: 500, maximum: 100000 })),
				browser: optionalBrowser,
			}),
			execute: async (_id, params) =>
				browserResult(
					host,
					"Read browser page",
					"browser_read_page",
					params.tabId ?? "active",
					params.browser,
					(target) =>
						host.readPage(target, {
							tabId: params.tabId,
							includeHtml: params.includeHtml,
							includeSource: params.includeSource,
							includeElements: params.includeElements,
							includeNetwork: params.includeNetwork,
							includeConsole: params.includeConsole,
							maxChars: params.maxChars,
						}),
				),
		}),
		defineTool({
			name: "browser_query_elements",
			label: "Query browser elements",
			description: "Find interactive or matching page elements.",
			promptSnippet: "Find page elements by selector or visible text before clicking or typing.",
			promptGuidelines: ROUTING_GUIDELINES,
			parameters: Type.Object({
				tabId: Type.Optional(Type.String()),
				selector: Type.Optional(Type.String()),
				text: Type.Optional(Type.String()),
				limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
				browser: optionalBrowser,
			}),
			execute: async (_id, params) =>
				browserResult(
					host,
					"Query browser elements",
					"browser_query_elements",
					params.selector ?? params.text ?? "elements",
					params.browser,
					(target) =>
						host.queryElements(target, {
							tabId: params.tabId,
							selector: params.selector,
							text: params.text,
							limit: params.limit,
						}),
				),
		}),
		defineTool({
			name: "browser_click",
			label: "Click browser element",
			description: "Click a page element by CSS selector or elementIndex.",
			promptSnippet: "Click page elements by selector or element index.",
			promptGuidelines: ROUTING_GUIDELINES,
			parameters: Type.Object({
				tabId: Type.Optional(Type.String()),
				selector: Type.Optional(Type.String()),
				elementIndex: Type.Optional(Type.Number({ minimum: 0 })),
				browser: optionalBrowser,
			}),
			execute: async (_id, params) =>
				browserResult(
					host,
					"Click browser element",
					"browser_click",
					params.selector ?? String(params.elementIndex ?? "target"),
					params.browser,
					(target) =>
						host.click(target, {
							tabId: params.tabId,
							selector: params.selector,
							elementIndex: params.elementIndex,
						}),
				),
		}),
		defineTool({
			name: "browser_type_text",
			label: "Type browser text",
			description: "Type text into a page element by CSS selector or elementIndex.",
			promptSnippet: "Type into browser page fields by selector or element index.",
			promptGuidelines: ROUTING_GUIDELINES,
			parameters: Type.Object({
				tabId: Type.Optional(Type.String()),
				selector: Type.Optional(Type.String()),
				elementIndex: Type.Optional(Type.Number({ minimum: 0 })),
				text: Type.String(),
				clearFirst: Type.Optional(Type.Boolean()),
				browser: optionalBrowser,
			}),
			execute: async (_id, params) =>
				browserResult(
					host,
					"Type browser text",
					"browser_type_text",
					params.selector ?? String(params.elementIndex ?? "target"),
					params.browser,
					(target) =>
						host.typeText(target, {
							tabId: params.tabId,
							selector: params.selector,
							elementIndex: params.elementIndex,
							text: params.text,
							clearFirst: params.clearFirst,
						}),
				),
		}),
		defineTool({
			name: "browser_press_key",
			label: "Press browser key",
			description: "Press a key in the active browser tab.",
			promptSnippet: "Press a key in the browser, such as Enter, Escape, Tab, or ArrowDown.",
			promptGuidelines: ROUTING_GUIDELINES,
			parameters: Type.Object({
				tabId: Type.Optional(Type.String()),
				key: Type.String(),
				browser: optionalBrowser,
			}),
			execute: async (_id, params) =>
				browserResult(host, "Press browser key", "browser_press_key", params.key, params.browser, (target) =>
					host.pressKey(target, { tabId: params.tabId, key: params.key }),
				),
		}),
		defineTool({
			name: "browser_scroll",
			label: "Scroll browser",
			description: "Scroll the active browser tab.",
			promptSnippet: "Scroll the browser page by x/y delta.",
			promptGuidelines: ROUTING_GUIDELINES,
			parameters: Type.Object({
				tabId: Type.Optional(Type.String()),
				x: Type.Optional(Type.Number()),
				y: Type.Optional(Type.Number()),
				browser: optionalBrowser,
			}),
			execute: async (_id, params) =>
				browserResult(
					host,
					"Scroll browser",
					"browser_scroll",
					params.tabId ?? "active",
					params.browser,
					(target) => host.scroll(target, { tabId: params.tabId, x: params.x, y: params.y }),
				),
		}),
		defineTool({
			name: "browser_screenshot",
			label: "Browser screenshot",
			description: "Capture a screenshot of the active browser tab.",
			promptSnippet: "Capture a browser screenshot for visual verification.",
			promptGuidelines: ROUTING_GUIDELINES,
			parameters: Type.Object({
				tabId: Type.Optional(Type.String()),
				browser: optionalBrowser,
			}),
			execute: async (_id, params) =>
				browserResult(
					host,
					"Browser screenshot",
					"browser_screenshot",
					params.tabId ?? "active",
					params.browser,
					(target) => host.screenshot(target, { tabId: params.tabId }),
				),
		}),
		defineTool({
			name: "browser_get_cookies",
			label: "Get browser cookies",
			description: "Read cookies for the active page or a specific URL.",
			promptSnippet: "Read cookies from the selected browser profile when needed for browser automation.",
			promptGuidelines: ROUTING_GUIDELINES,
			parameters: Type.Object({
				tabId: Type.Optional(Type.String()),
				url: Type.Optional(Type.String()),
				browser: optionalBrowser,
			}),
			execute: async (_id, params) =>
				browserResult(
					host,
					"Get browser cookies",
					"browser_get_cookies",
					params.url ?? params.tabId ?? "active",
					params.browser,
					(target) => host.getCookies(target, { tabId: params.tabId, url: params.url }),
				),
		}),
		defineTool({
			name: "browser_clear_storage",
			label: "Clear browser storage",
			description: "Clear browser storage. Use only when the user asks or Settings triggers cleanup.",
			promptSnippet: "Clear browser storage only when the user explicitly asks for browser storage cleanup.",
			promptGuidelines: [
				...ROUTING_GUIDELINES,
				"Clearing browser storage is disruptive. Do not call this tool unless the user explicitly asks.",
			],
			parameters: Type.Object({
				scope: STORAGE_SCOPE,
				browser: optionalBrowser,
			}),
			execute: async (_id, params) =>
				browserResult(
					host,
					"Clear browser storage",
					"browser_clear_storage",
					params.scope,
					params.browser,
					(target) => host.clearStorage(target, { scope: params.scope }),
				),
		}),
		defineTool({
			name: "browser_virtual_mouse",
			label: "Browser virtual mouse",
			description: "Move, click, press, release, or double-click the virtual mouse in browser coordinates.",
			promptSnippet:
				"Use the browser virtual mouse for coordinate-level interactions when DOM tools are insufficient.",
			promptGuidelines: ROUTING_GUIDELINES,
			parameters: Type.Object({
				tabId: Type.Optional(Type.String()),
				x: Type.Number(),
				y: Type.Number(),
				action: Type.Optional(
					Type.Union([
						Type.Literal("move"),
						Type.Literal("click"),
						Type.Literal("down"),
						Type.Literal("up"),
						Type.Literal("double_click"),
					]),
				),
				button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")])),
				browser: optionalBrowser,
			}),
			execute: async (_id, params) =>
				browserResult(
					host,
					"Browser virtual mouse",
					"browser_virtual_mouse",
					`${params.x},${params.y}`,
					params.browser,
					(target) =>
						host.virtualMouse(target, {
							tabId: params.tabId,
							x: params.x,
							y: params.y,
							action: params.action,
							button: params.button,
						}),
				),
		}),
	];
}

export function buildBrowserRoutingAppendPrompt(
	defaultBrowser: BrowserTarget,
	preference: AiBrowserPreference = "built_in",
): string {
	const common = [
		"NEVER use open_app, app_interaction, shell commands, or keyboard/mouse automation to open a URL or operate web pages — use the browser tools below.",
	];
	if (preference === "external") {
		return [
			"<browser_routing_policy>",
			"The user prefers the EXTERNAL browser (their installed Chrome/Edge).",
			"Use the external browser-control MCP tools (take_control, list_tabs, controlled_status, read_page, find_element, cursor_*, etc.) to open, read, inspect, and control web pages.",
			"The built-in browser_* tools are disabled in this mode; do not expect them.",
			...common,
			"</browser_routing_policy>",
		].join("\n");
	}
	if (preference === "auto") {
		return [
			"<browser_routing_policy>",
			`Two browser control surfaces are available. The user's default browser is ${defaultBrowser}.`,
			"The built-in browser_* tools (browser_open_url, browser_list_tabs, browser_read_page, browser_query_elements, …) control the assistant's own browser.",
			"The external browser-control MCP tools control the user's installed Chrome/Edge via its extension.",
			"Pick ONE surface that fits the task and stick with it; do not mix or switch needlessly. Prefer the built-in browser_* tools unless the user clearly wants their own installed browser.",
			...common,
			"</browser_routing_policy>",
		].join("\n");
	}
	return [
		"<browser_routing_policy>",
		`The user's default browser is ${defaultBrowser}.`,
		"For ANY task involving a website, web page, URL, opening/reading/searching web content in a browser, or browser automation, you MUST use the browser_* tools (e.g. browser_open_url, browser_list_tabs, browser_read_page, browser_query_elements). They are the only correct way to open, read, inspect, and control web content.",
		...common,
		"Do NOT use external browser-control or browser-extension MCP tools (take_control, list_tabs, controlled_status, cursor_*, etc.) — they target a separate external browser that is NOT connected to this assistant's browser. To read tabs or page state, use browser_list_tabs / browser_read_page / browser_query_elements on this browser.",
		"Omit the browser parameter so the browser_* tools use the user's default browser.",
		"Only pass browser when the user explicitly says to use Chrome, Edge, or the built-in browser for this operation.",
		"Do not casually switch browsers. If the default browser is unavailable or lacks a required capability, say so and choose the smallest clear fallback.",
		"The built-in browser is the preferred full-control surface when selected: it supports persistent storage, tabs, source/HTML, element snapshots, console/network data, cookies, screenshots, and virtual mouse.",
		"</browser_routing_policy>",
	].join("\n");
}

function resolveTarget(host: BrowserToolHost, browser?: BrowserTarget): BrowserTarget {
	return browser ?? host.getDefaultBrowser();
}

async function browserResult(
	host: BrowserToolHost,
	intent: string,
	action: string,
	targetLabel: string,
	browser: BrowserTarget | undefined,
	run: (target: BrowserTarget) => Promise<unknown>,
): Promise<{ content: [{ type: "text"; text: string }]; details: DesktopToolResult }> {
	const target = resolveTarget(host, browser);
	try {
		const payload = await run(target);
		const details = buildDetails(
			intent,
			action,
			`${target}:${targetLabel}`,
			"succeeded",
			JSON.stringify({ browser: target, result: payload }, null, 2),
		);
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	} catch (error) {
		const details = buildDetails(
			intent,
			action,
			`${target}:${targetLabel}`,
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
		riskLevel: action === "browser_clear_storage" ? "medium" : "low",
		requiresConfirmation: false,
	};
}
