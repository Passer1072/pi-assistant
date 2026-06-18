#!/usr/bin/env node
/**
 * Browser Control MCP server
 * ==========================
 *
 * Two control backends are exposed through one MCP surface:
 *
 * 1. Extension backend (default): controls the user's already-open Chrome/Edge
 *    through a locally loaded extension. This preserves existing sessions,
 *    tabs, logins, and normal browser usage.
 * 2. Debug backend: launches or connects to a dedicated Chrome/Edge instance
 *    with a DevTools Protocol port. This gives the model a separate browser it
 *    may fully control when the user/model explicitly asks for that mode.
 *
 * Runtime: Node >= 22. No extra dependencies beyond @modelcontextprotocol/sdk
 * and zod, which this package already uses.
 *
 * Env vars:
 *   BROWSER_MCP_HOST             default 127.0.0.1
 *   BROWSER_MCP_PORT             extension bridge port, default 17890; 0 = ephemeral
 *   BROWSER_MCP_TIMEOUT_MS       default 45000
 *   BROWSER_MCP_TOKEN            optional shared token for extension bridge
 *   BROWSER_MCP_BACKEND          extension | debug | auto, default extension
 *   BROWSER_MCP_DEBUG_HOST       default 127.0.0.1
 *   BROWSER_MCP_DEBUG_PORT       default 9223
 *   BROWSER_MCP_DEBUG_BROWSER    optional chrome/msedge executable path
 *   BROWSER_MCP_DEBUG_USER_DATA  optional dedicated user-data-dir path
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
	compactAxNodes,
	createTabScheduler,
	cursorDuration,
	cursorOverlayCall,
	cursorPath,
	doubleClickGap,
	flattenFrameTree,
	humanPressDelay,
	humanTypeDelay,
	normalizeConsoleEvent,
	normalizeNetworkEvent,
	pushRing,
	restoreTabMarker,
	setupCursorOverlay,
	setupTabMarker,
} from "./extension/lib.mjs";

const HOST = process.env.BROWSER_MCP_HOST || "127.0.0.1";
const PORT = Number(process.env.BROWSER_MCP_PORT || 17890);
const TOOL_TIMEOUT_MS = normalizeTimeout(process.env.BROWSER_MCP_TIMEOUT_MS, 45000);
const BRIDGE_TOKEN = process.env.BROWSER_MCP_TOKEN || "";
const DEFAULT_BACKEND = normalizeBackend(process.env.BROWSER_MCP_BACKEND || "extension");
const DEBUG_HOST = process.env.BROWSER_MCP_DEBUG_HOST || "127.0.0.1";
const DEBUG_PORT = Number(process.env.BROWSER_MCP_DEBUG_PORT || 9223);
const DEBUG_BROWSER_PATH = process.env.BROWSER_MCP_DEBUG_BROWSER || "";
const DEBUG_USER_DATA_DIR =
	process.env.BROWSER_MCP_DEBUG_USER_DATA || join(tmpdir(), `desktop-assistant-browser-mcp-debug-profile-${DEBUG_PORT}`);
const CLIENT_STALE_MS = 30000;
const POLL_TIMEOUT_MS = 25000;
// Virtual-cursor halo/ring color — defaults to the Pi assistant accent (renderer --accent).
const CURSOR_THEME = process.env.BROWSER_MCP_CURSOR_THEME || "#6aa9ff";

const clients = new Map();
const waitingPolls = new Map();
const pendingJobs = new Map();
const queuedJobs = [];

let bridgeServer;
let bridgeUrl = "";
let debugBrowserProcess;
let debugWs;
let debugWsReady;
let debugNextId = 1;
let debugTargetId;
let debugSessionId;
let debugSessionTargetId;
const debugPending = new Map();
const debugEventBuffers = { console: new Map(), network: new Map() };

// ---------------------------------------------------------------------------
// Controlled-tab model (shared across all MCP sessions in this process)
// ---------------------------------------------------------------------------

/** tabId(string) -> { backend, tabId, label, takenAt }. The AI's "taken over" tabs. */
const controlledTabs = new Map();
/** The implicit target when a tool call omits an explicit tabId. */
let primaryControlledTabId;
/** Per-tab FIFO mutex; one bad action never blocks another tab. */
const scheduler = createTabScheduler();

/** Commands that never need a resolved tab. */
const NO_TAB_COMMANDS = new Set(["list_tabs", "active_tab"]);
/** Commands that target an explicit tab only and may create a new one (never auto-use primary). */
const CREATE_CAPABLE = new Set(["open_url", "take_control"]);
/** Commands that change page/input state — serialized per tab against other sessions. */
const INPUT_MUTATING = new Set([
	"click",
	"double_click",
	"hover",
	"type_text",
	"set_value",
	"press_key",
	"scroll",
	"select_option",
	"check",
	"drag_and_drop",
	"set_attributes",
	"cursor_move",
	"cursor_click",
	"cursor_double_click",
	"cursor_right_click",
	"cursor_hover",
	"cursor_drag",
	"cursor_type",
]);

function resolveControlledTabId(args, { create = false } = {}) {
	if (args.tabId !== undefined && args.tabId !== null) return args.tabId;
	if (primaryControlledTabId !== undefined && primaryControlledTabId !== null) return primaryControlledTabId;
	if (create) return undefined;
	throw new Error("No controlled browser tab. Call take_control with a tabId or url first.");
}

function rememberControlledTab(backend, tabId, { label, makePrimary } = {}) {
	if (tabId === undefined || tabId === null) return;
	const key = String(tabId);
	const prev = controlledTabs.get(key) || {};
	controlledTabs.set(key, {
		backend,
		tabId,
		label: label ?? prev.label,
		takenAt: prev.takenAt || Date.now(),
	});
	if (makePrimary !== false || primaryControlledTabId === undefined || primaryControlledTabId === null) {
		primaryControlledTabId = key;
	}
}

function forgetControlledTab(tabId) {
	const key = String(tabId);
	controlledTabs.delete(key);
	scheduler.delete(key);
	if (String(primaryControlledTabId) === key) {
		const keys = [...controlledTabs.keys()];
		primaryControlledTabId = keys.length ? keys[keys.length - 1] : undefined;
	}
}

function controlledStatus() {
	return {
		ok: true,
		primaryControlledTabId,
		controlledTabs: [...controlledTabs.values()].map((entry) => ({
			tabId: entry.tabId,
			backend: entry.backend,
			label: entry.label,
			primary: String(entry.tabId) === String(primaryControlledTabId),
			takenAt: new Date(entry.takenAt).toISOString(),
		})),
	};
}

function maybeForgetMissingTab(error, tabId) {
	if (tabId === undefined || tabId === null) return;
	const message = error instanceof Error ? error.message : String(error);
	if (/no tab with given id|no tab with id|tab .* (was )?closed|no target with given id|cannot access/i.test(message)) {
		forgetControlledTab(tabId);
	}
}

function normalizeTimeout(value, fallback) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(120000, Math.max(1000, Math.floor(parsed)));
}

function normalizeBackend(value) {
	if (value === "debug" || value === "auto") return value;
	return "extension";
}

function log(message) {
	process.stderr.write(`[browser-mcp] ${message}\n`);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(res, statusCode, payload, origin) {
	if (origin) {
		res.setHeader("Access-Control-Allow-Origin", origin);
		res.setHeader("Access-Control-Allow-Headers", "content-type,x-browser-mcp-token");
		res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
	}
	res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(payload));
}

function isAllowedOrigin(origin) {
	if (!origin) return true;
	return (
		origin.startsWith("chrome-extension://") ||
		origin.startsWith("edge-extension://") ||
		origin.startsWith("moz-extension://")
	);
}

function authorizeExtensionRequest(req, res) {
	const origin = req.headers.origin || "";
	if (!isAllowedOrigin(origin)) {
		jsonResponse(res, 403, { ok: false, message: "Only browser extension origins may use this bridge." });
		return false;
	}
	if (BRIDGE_TOKEN && req.headers["x-browser-mcp-token"] !== BRIDGE_TOKEN) {
		jsonResponse(res, 401, { ok: false, message: "Invalid Browser MCP bridge token." }, origin);
		return false;
	}
	return true;
}

async function readJsonBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	if (chunks.length === 0) return {};
	const text = Buffer.concat(chunks).toString("utf-8");
	return text ? JSON.parse(text) : {};
}

function publicClient(client) {
	return {
		clientId: client.clientId,
		extensionVersion: client.extensionVersion,
		browser: client.browser,
		userAgent: client.userAgent,
		lastSeenAt: new Date(client.lastSeenAt).toISOString(),
		connected: Date.now() - client.lastSeenAt <= CLIENT_STALE_MS,
	};
}

function currentClients() {
	return [...clients.values()].map(publicClient);
}

function activeClients() {
	const now = Date.now();
	return [...clients.values()].filter((client) => now - client.lastSeenAt <= CLIENT_STALE_MS);
}

function refreshClient(payload) {
	const clientId = String(payload.clientId || "").trim() || randomUUID();
	const current = clients.get(clientId) || { clientId };
	const next = {
		...current,
		clientId,
		extensionVersion: payload.extensionVersion || current.extensionVersion || "unknown",
		browser: payload.browser || current.browser || "unknown",
		userAgent: payload.userAgent || current.userAgent || "",
		lastSeenAt: Date.now(),
	};
	clients.set(clientId, next);
	return next;
}

function handleNext(req, res, url) {
	if (!authorizeExtensionRequest(req, res)) return;
	const client = refreshClient({
		clientId: url.searchParams.get("clientId"),
		extensionVersion: url.searchParams.get("extensionVersion"),
		browser: url.searchParams.get("browser"),
		userAgent: url.searchParams.get("userAgent"),
	});
	const origin = req.headers.origin || "";
	const sent = drainQueueForClient(client.clientId, res, origin);
	if (sent) return;

	const timeout = setTimeout(() => {
		waitingPolls.delete(client.clientId);
		jsonResponse(res, 200, { ok: true, job: null }, origin);
	}, POLL_TIMEOUT_MS);
	waitingPolls.set(client.clientId, { res, origin, timeout });
	req.on("close", () => {
		const waiter = waitingPolls.get(client.clientId);
		if (waiter?.res === res) {
			clearTimeout(waiter.timeout);
			waitingPolls.delete(client.clientId);
		}
	});
}

async function handleResult(req, res) {
	if (!authorizeExtensionRequest(req, res)) return;
	const origin = req.headers.origin || "";
	try {
		const payload = await readJsonBody(req);
		refreshClient(payload);
		const jobId = String(payload.jobId || "");
		const pending = pendingJobs.get(jobId);
		if (!pending) {
			jsonResponse(res, 404, { ok: false, message: `Unknown or expired job: ${jobId}` }, origin);
			return;
		}
		pendingJobs.delete(jobId);
		clearTimeout(pending.timeout);
		if (payload.ok === false) {
			const message = payload.error?.message || payload.message || "Browser extension command failed.";
			const error = new Error(message);
			error.details = payload.error;
			pending.reject(error);
		} else {
			pending.resolve(payload.result);
		}
		jsonResponse(res, 200, { ok: true }, origin);
	} catch (error) {
		jsonResponse(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) }, origin);
	}
}

function handleRegister(req, res) {
	if (!authorizeExtensionRequest(req, res)) return;
	readJsonBody(req)
		.then((payload) => {
			const client = refreshClient(payload);
			jsonResponse(
				res,
				200,
				{
					ok: true,
					clientId: client.clientId,
					server: "browser-control-mcp",
					bridgeUrl,
					tokenRequired: Boolean(BRIDGE_TOKEN),
				},
				req.headers.origin || "",
			);
		})
		.catch((error) => {
			jsonResponse(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
		});
}

function drainQueueForClient(clientId, res, origin) {
	const index = queuedJobs.findIndex((job) => !job.clientId || job.clientId === clientId);
	if (index < 0) return false;
	const [job] = queuedJobs.splice(index, 1);
	jsonResponse(res, 200, { ok: true, job }, origin);
	return true;
}

function drainQueue() {
	for (const [clientId, waiter] of [...waitingPolls.entries()]) {
		const sent = drainQueueForClient(clientId, waiter.res, waiter.origin);
		if (sent) {
			clearTimeout(waiter.timeout);
			waitingPolls.delete(clientId);
		}
	}
}

function enqueueExtensionCommand(name, params = {}, options = {}) {
	const connected = activeClients();
	if (connected.length === 0) {
		throw new Error(
			`Browser extension is not connected to ${bridgeUrl}. Load the extension and keep the browser open, then retry.`,
		);
	}
	const clientId = options.clientId || connected[0]?.clientId;
	const job = { id: randomUUID(), name, params, createdAt: new Date().toISOString(), clientId };
	const timeoutMs = normalizeTimeout(options.timeoutMs, TOOL_TIMEOUT_MS);
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingJobs.delete(job.id);
			const queueIndex = queuedJobs.findIndex((entry) => entry.id === job.id);
			if (queueIndex >= 0) queuedJobs.splice(queueIndex, 1);
			reject(new Error(`Browser extension command timed out: ${name}`));
		}, timeoutMs);
		pendingJobs.set(job.id, { resolve, reject, timeout });
		queuedJobs.push(job);
		drainQueue();
	});
}

function startBridge() {
	return new Promise((resolve, reject) => {
		const httpServer = createServer((req, res) => {
			const origin = req.headers.origin || "";
			if (req.method === "OPTIONS") {
				if (isAllowedOrigin(origin)) {
					res.setHeader("Access-Control-Allow-Origin", origin);
					res.setHeader("Access-Control-Allow-Headers", "content-type,x-browser-mcp-token");
					res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
					res.writeHead(204);
				} else {
					res.writeHead(403);
				}
				res.end();
				return;
			}
			const url = new URL(req.url || "/", `http://${HOST}`);
			if (req.method === "GET" && url.pathname === "/health") {
				jsonResponse(res, 200, {
					ok: true,
					server: "browser-control-mcp",
					bridgeUrl,
					tokenRequired: Boolean(BRIDGE_TOKEN),
					defaultBackend: DEFAULT_BACKEND,
					debug: debugStatus(),
					clients: currentClients(),
					pendingJobs: pendingJobs.size,
					queuedJobs: queuedJobs.length,
				});
				return;
			}
			if (req.method === "POST" && url.pathname === "/extension/register") {
				handleRegister(req, res);
				return;
			}
			if (req.method === "GET" && url.pathname === "/extension/next") {
				handleNext(req, res, url);
				return;
			}
			if (req.method === "POST" && url.pathname === "/extension/result") {
				void handleResult(req, res);
				return;
			}
			jsonResponse(res, 404, { ok: false, message: "Not found." }, origin);
		});
		httpServer.on("error", reject);
		httpServer.listen(PORT, HOST, () => {
			const address = httpServer.address();
			const actualPort = typeof address === "object" && address ? address.port : PORT;
			bridgeUrl = `http://${HOST}:${actualPort}`;
			bridgeServer = httpServer;
			log(`extension bridge listening at ${bridgeUrl}`);
			resolve();
		});
	});
}

async function fetchJson(url, timeoutMs = 3000) {
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	const text = await response.text();
	if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
	return text ? JSON.parse(text) : null;
}

function debugBaseUrl() {
	return `http://${DEBUG_HOST}:${DEBUG_PORT}`;
}

function debugStatus() {
	return {
		host: DEBUG_HOST,
		port: DEBUG_PORT,
		baseUrl: debugBaseUrl(),
		browserPath: DEBUG_BROWSER_PATH || undefined,
		userDataDir: DEBUG_USER_DATA_DIR,
		launchedByServer: Boolean(debugBrowserProcess),
		connected: Boolean(debugWs && debugWs.readyState === WebSocket.OPEN),
		targetId: debugTargetId,
		sessionId: debugSessionId,
	};
}

async function isDebugReachable() {
	try {
		await fetchJson(`${debugBaseUrl()}/json/version`, 1200);
		return true;
	} catch {
		return false;
	}
}

function candidateBrowsers(kind = "auto") {
	if (DEBUG_BROWSER_PATH) return [DEBUG_BROWSER_PATH];
	const local = process.env.LOCALAPPDATA || "";
	const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
	const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
	const edge = [
		join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
		join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
		join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
	];
	const chrome = [
		join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
		join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
		join(local, "Google", "Chrome", "Application", "chrome.exe"),
	];
	if (kind === "edge") return edge;
	if (kind === "chrome") return chrome;
	return [...edge, ...chrome, "msedge", "chrome", "google-chrome", "chromium"];
}

function resolveBrowserPath(kind) {
	const candidates = candidateBrowsers(kind);
	const fileCandidate = candidates.find((candidate) => candidate.includes("\\") && existsSync(candidate));
	const commandCandidate = candidates.find((candidate) => !candidate.includes("\\"));
	if (fileCandidate || commandCandidate) return fileCandidate || commandCandidate;
	throw new Error(`No ${kind || "browser"} executable was found. Set BROWSER_MCP_DEBUG_BROWSER to chrome.exe or msedge.exe.`);
}

async function launchDebugBrowser(args = {}) {
	if (await isDebugReachable()) {
		return { ok: true, alreadyRunning: true, ...debugStatus() };
	}
	const browser = resolveBrowserPath(args.browser || "auto");
	const userDataDir = args.userDataDir || DEBUG_USER_DATA_DIR;
	mkdirSync(userDataDir, { recursive: true });
	const launchArgs = [
		`--remote-debugging-port=${DEBUG_PORT}`,
		`--user-data-dir=${userDataDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-popup-blocking",
		args.url || "about:blank",
	];
	try {
		debugBrowserProcess = spawn(browser, launchArgs, { detached: true, stdio: "ignore" });
		debugBrowserProcess.on("error", (error) => log(`debug browser launch error: ${error.message}`));
		debugBrowserProcess.unref();
	} catch (error) {
		throw new Error(`Failed to launch debug browser (${browser}): ${error instanceof Error ? error.message : String(error)}`);
	}
	for (let i = 0; i < 20; i += 1) {
		if (await isDebugReachable()) return { ok: true, launched: true, browser, ...debugStatus() };
		await sleep(500);
	}
	throw new Error(`Debug browser did not expose ${debugBaseUrl()} in time. Browser path: ${browser}`);
}

async function closeDebugBrowser() {
	try {
		if (await isDebugReachable()) {
			await connectDebugBrowser();
			await debugSend("Browser.close", {});
		}
	} catch (error) {
		if (debugBrowserProcess) {
			try {
				debugBrowserProcess.kill();
			} catch {}
		}
		if (error instanceof Error && !/closed/i.test(error.message)) throw error;
	} finally {
		closeDebugSocket();
		debugBrowserProcess = undefined;
	}
	return { ok: true, closed: true, ...debugStatus() };
}

async function connectDebugBrowser() {
	if (debugWs && debugWs.readyState === WebSocket.OPEN) return;
	if (debugWsReady) return debugWsReady;
	debugWsReady = (async () => {
		const version = await fetchJson(`${debugBaseUrl()}/json/version`, 3000);
		const wsUrl = version.webSocketDebuggerUrl;
		if (!wsUrl) throw new Error(`No browser websocket endpoint at ${debugBaseUrl()}.`);
		await new Promise((resolve, reject) => {
			const socket = new WebSocket(wsUrl);
			const timer = setTimeout(() => {
				try {
					socket.close();
				} catch {}
				reject(new Error("Debug browser websocket connect timeout."));
			}, 5000);
			socket.addEventListener("open", () => {
				clearTimeout(timer);
				debugWs = socket;
				resolve();
			});
			socket.addEventListener("error", () => {
				clearTimeout(timer);
				reject(new Error("Debug browser websocket error."));
			});
			socket.addEventListener("close", () => {
				closeDebugSocket();
			});
			socket.addEventListener("message", (event) => {
				let msg;
				try {
					msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
				} catch {
					return;
				}
				if (msg.id && debugPending.has(msg.id)) {
					const pending = debugPending.get(msg.id);
					debugPending.delete(msg.id);
					pending.resolve(msg);
				} else if (msg.method) {
					handleDebugEvent(msg);
				}
			});
		});
	})();
	try {
		await debugWsReady;
	} finally {
		debugWsReady = undefined;
	}
}

function closeDebugSocket() {
	if (debugWs) {
		try {
			debugWs.close();
		} catch {}
	}
	debugWs = undefined;
	debugWsReady = undefined;
	debugTargetId = undefined;
	debugSessionId = undefined;
	debugSessionTargetId = undefined;
	for (const [, pending] of debugPending) pending.reject(new Error("Debug browser websocket closed."));
	debugPending.clear();
}

async function debugSend(method, params = {}, sessionId) {
	await connectDebugBrowser();
	return new Promise((resolve, reject) => {
		const id = debugNextId++;
		const timeout = setTimeout(() => {
			if (debugPending.has(id)) {
				debugPending.delete(id);
				reject(new Error(`CDP method timed out: ${method}`));
			}
		}, TOOL_TIMEOUT_MS);
		debugPending.set(id, {
			resolve: (value) => {
				clearTimeout(timeout);
				if (value.error) {
					reject(new Error(`CDP ${method} error: ${JSON.stringify(value.error)}`));
					return;
				}
				resolve(value.result || {});
			},
			reject,
		});
		debugWs.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
	});
}

async function listDebugTargets() {
	const targets = await fetchJson(`${debugBaseUrl()}/json/list`, 3000);
	return Array.isArray(targets) ? targets.filter((target) => target.type === "page") : [];
}

async function ensureDebugTarget(tabId) {
	if (tabId && String(tabId) !== debugTargetId) {
		debugTargetId = String(tabId);
		debugSessionId = undefined;
		debugSessionTargetId = undefined;
	}
	if (!debugTargetId) {
		const targets = await listDebugTargets();
		const target = targets.find((entry) => entry.url !== "chrome://newtab/") || targets[0];
		if (!target) {
			const created = await debugSend("Target.createTarget", { url: "about:blank" });
			debugTargetId = created.targetId;
		} else {
			debugTargetId = target.id;
		}
	}
	if (!debugSessionId || debugSessionTargetId !== debugTargetId) {
		const attached = await debugSend("Target.attachToTarget", { targetId: debugTargetId, flatten: true });
		debugSessionId = attached.sessionId;
		debugSessionTargetId = debugTargetId;
		await debugSend("Runtime.enable", {}, debugSessionId).catch(() => {});
		await debugSend("Page.enable", {}, debugSessionId).catch(() => {});
		await debugSend("DOM.enable", {}, debugSessionId).catch(() => {});
	}
	return { targetId: debugTargetId, sessionId: debugSessionId };
}

async function debugEvaluate(expression, tabId) {
	const { sessionId } = await ensureDebugTarget(tabId);
	const result = await debugSend(
		"Runtime.evaluate",
		{
			expression,
			returnByValue: true,
			awaitPromise: true,
			allowUnsafeEvalBlockedByCSP: true,
		},
		sessionId,
	);
	if (result.exceptionDetails) {
		throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "JavaScript exception.");
	}
	if (result.result?.subtype === "error") throw new Error(result.result.description || "JavaScript error.");
	return result.result?.value;
}

async function debugCommand(name, args = {}) {
	if (!(await isDebugReachable())) {
		if (args.autoLaunch === false) {
			throw new Error(`Debug browser is not reachable at ${debugBaseUrl()}. Call launch_debug_browser first.`);
		}
		await launchDebugBrowser({ url: args.url });
	}
	switch (name) {
		case "list_tabs": {
			const targets = await listDebugTargets();
			return {
				ok: true,
				backend: "debug",
				tabs: targets.map((target) => ({
					id: target.id,
					title: target.title,
					url: target.url,
					active: target.id === debugTargetId,
					favIconUrl: target.faviconUrl,
				})),
			};
		}
		case "active_tab": {
			const targets = await listDebugTargets();
			const target = targets.find((entry) => entry.id === debugTargetId) || targets[0];
			if (!target) return { ok: false, backend: "debug", message: "No debug browser tab is available." };
			debugTargetId = target.id;
			debugSessionId = undefined;
			return { ok: true, backend: "debug", tab: { id: target.id, title: target.title, url: target.url } };
		}
		case "activate_tab": {
			const tabId = String(args.tabId);
			await debugSend("Target.activateTarget", { targetId: tabId });
			debugTargetId = tabId;
			debugSessionId = undefined;
			return { ok: true, backend: "debug", tabId };
		}
		case "open_url": {
			if (args.tabId) {
				await ensureDebugTarget(String(args.tabId));
				await debugSend("Page.navigate", { url: args.url }, debugSessionId);
			} else {
				const created = await debugSend("Target.createTarget", { url: args.url });
				debugTargetId = created.targetId;
				debugSessionId = undefined;
			}
			await sleep(500);
			return { ok: true, backend: "debug", url: args.url, tabId: debugTargetId };
		}
		case "close_tab": {
			const tabId = String(args.tabId || debugTargetId || "");
			if (!tabId) throw new Error("No debug tab selected.");
			await debugSend("Target.closeTarget", { targetId: tabId });
			if (debugTargetId === tabId) {
				debugTargetId = undefined;
				debugSessionId = undefined;
			}
			return { ok: true, backend: "debug", tabId };
		}
		case "reload": {
			await ensureDebugTarget(args.tabId);
			await debugSend("Page.reload", { ignoreCache: args.bypassCache === true }, debugSessionId);
			return { ok: true, backend: "debug", action: "reload" };
		}
		case "go_back":
			return debugEvaluate("history.back(); ({ok:true, action:'go_back', url: location.href})", args.tabId);
		case "go_forward":
			return debugEvaluate("history.forward(); ({ok:true, action:'go_forward', url: location.href})", args.tabId);
		case "read_page":
			return debugEvaluate(buildReadPageExpression(args), args.tabId);
		case "query_elements":
			return debugEvaluate(buildQueryElementsExpression(args), args.tabId);
		case "click":
			return debugClick(args);
		case "hover":
			return debugMouseMove(args);
		case "type_text":
			return debugTypeText(args);
		case "set_value":
			return debugEvaluate(buildSetValueExpression(args), args.tabId);
		case "press_key":
			return debugPressKey(args);
		case "scroll":
			return debugEvaluate(buildScrollExpression(args), args.tabId);
		case "select_option":
			return debugEvaluate(buildSelectOptionExpression(args), args.tabId);
		case "check":
			return debugEvaluate(buildCheckExpression(args), args.tabId);
		case "wait_for":
			return debugEvaluate(buildWaitForExpression(args), args.tabId);
		case "screenshot":
			return debugScreenshot(args);
		case "evaluate_js":
			return { ok: true, backend: "debug", result: await debugEvaluate(args.expression, args.tabId) };
		case "run_cdp_command": {
			const { sessionId } = await ensureDebugTarget(args.tabId);
			return { ok: true, backend: "debug", result: await debugSend(args.method, args.params || {}, sessionId) };
		}
		case "get_storage":
			return debugEvaluate(buildGetStorageExpression(args), args.tabId);
		case "set_storage":
			return debugEvaluate(buildSetStorageExpression(args), args.tabId);
		case "get_cookies":
			return debugGetCookies(args);
		case "set_cookie":
			return debugSetCookie(args);
		case "delete_cookie":
			return debugDeleteCookie(args);
		case "drag_and_drop":
			return debugDragAndDrop(args);
		case "take_control":
			return debugTakeControl(args);
		case "release_control":
			return debugReleaseControl(args);
		case "show_cursor":
			await debugCursorEnsure(args.tabId);
			await debugOverlayCall(args.tabId, "show", []);
			return { ok: true, backend: "debug", tabId: args.tabId };
		case "hide_cursor":
			await debugOverlayCall(args.tabId, "hide", []);
			return { ok: true, backend: "debug", tabId: args.tabId };
		case "cursor_move":
		case "cursor_click":
		case "cursor_double_click":
		case "cursor_right_click":
		case "cursor_hover":
			return debugCursorAction(name, args);
		case "cursor_drag":
			return debugCursorDrag(args);
		case "cursor_type":
			return debugCursorType(args);
		case "find_element":
			return debugEvaluate(buildFindElementExpression(args), args.tabId);
		case "read_main_content":
			return debugEvaluate(buildMainContentExpression(args), args.tabId);
		case "read_tab":
			return debugReadTab(args);
		case "get_attributes":
			return debugEvaluate(buildGetAttributesExpression(args), args.tabId);
		case "set_attributes":
			return debugEvaluate(buildSetAttributesExpression(args), args.tabId);
		case "read_accessibility_tree":
			return debugAccessibilityTree(args);
		case "frames":
			return debugFrames(args);
		case "read_console":
			return debugReadConsole(args);
		case "read_network":
			return debugReadNetwork(args);
		default:
			throw new Error(`Unsupported debug browser command: ${name}`);
	}
}

function chooseBackend(args = {}) {
	const backend = normalizeBackend(args.backend || DEFAULT_BACKEND);
	if (backend === "auto") return activeClients().length > 0 ? "extension" : "debug";
	return backend;
}

async function command(name, args = {}) {
	const backend = chooseBackend(args);
	let resolved = args;
	// The debug backend keeps a single global CDP session, so every debug command runs
	// serially. The extension backend runs reads in parallel and only serializes input
	// per controlled tab against other sessions.
	let queueKey = backend === "debug" ? "debug" : undefined;
	if (!NO_TAB_COMMANDS.has(name)) {
		if (backend === "extension") {
			if (CREATE_CAPABLE.has(name)) {
				// open_url / take_control target an explicit tab or create a new one — never the primary.
				if (INPUT_MUTATING.has(name) && args.tabId !== undefined && args.tabId !== null) queueKey = String(args.tabId);
			} else {
				const tabId = resolveControlledTabId(args);
				resolved = { ...args, tabId };
				if (INPUT_MUTATING.has(name)) queueKey = String(tabId);
			}
		} else if (!CREATE_CAPABLE.has(name) && args.tabId === undefined && primaryControlledTabId !== undefined && primaryControlledTabId !== null) {
			// debug backend: default to the primary controlled target; otherwise ensureDebugTarget auto-picks.
			resolved = { ...args, tabId: primaryControlledTabId };
		}
	}
	const run = () =>
		backend === "debug"
			? debugCommand(name, resolved)
			: enqueueExtensionCommand(name, resolved, { clientId: resolved.clientId, timeoutMs: resolved.timeoutMs });
	const exec = queueKey !== undefined ? () => scheduler.run(queueKey, run) : run;
	try {
		return await exec();
	} catch (error) {
		maybeForgetMissingTab(error, resolved.tabId);
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Control orchestrators (server-side state + backend browser effects)
// ---------------------------------------------------------------------------

async function takeControl(args = {}) {
	const backend = chooseBackend(args);
	const result = await command("take_control", args);
	const tabId = result?.tabId ?? args.tabId;
	rememberControlledTab(backend, tabId, { label: args.label, makePrimary: args.makePrimary });
	return { ...result, controlledTabs: [...controlledTabs.keys()], primaryControlledTabId };
}

async function releaseControl(args = {}) {
	const tabId = args.tabId ?? primaryControlledTabId;
	if (tabId === undefined || tabId === null) return { ok: true, released: false, message: "No controlled tab to release." };
	try {
		await command("release_control", { ...args, tabId });
	} catch (error) {
		// Tab may already be gone — drop it regardless.
		maybeForgetMissingTab(error, tabId);
	}
	forgetControlledTab(tabId);
	return { ok: true, released: true, tabId, controlledTabs: [...controlledTabs.keys()], primaryControlledTabId };
}

async function transferControl(args = {}) {
	const taken = await takeControl({
		backend: args.backend,
		tabId: args.toTabId,
		url: args.url,
		label: args.label,
		makePrimary: true,
	});
	if (args.fromTabId !== undefined && args.fromTabId !== null && String(args.fromTabId) !== String(taken.tabId)) {
		await releaseControl({ backend: args.backend, tabId: args.fromTabId });
	}
	return { ok: true, ...taken };
}

async function transferCursor(args = {}) {
	const from = primaryControlledTabId;
	const taken = await takeControl({ backend: args.backend, tabId: args.toTabId, url: args.url, makePrimary: true });
	if (from !== undefined && from !== null && String(from) !== String(taken.tabId)) {
		try {
			await command("hide_cursor", { backend: args.backend, tabId: from });
		} catch {}
	}
	try {
		await command("show_cursor", { backend: args.backend, tabId: taken.tabId });
	} catch {}
	return { ok: true, primaryControlledTabId, cursorOn: taken.tabId };
}

function setPrimaryTab(args = {}) {
	const key = String(args.tabId);
	if (!controlledTabs.has(key)) throw new Error("That tab is not controlled. Call take_control first.");
	primaryControlledTabId = key;
	return { ok: true, primaryControlledTabId };
}

/** Route a tool name to its handler (control orchestrators vs. backend commands). */
async function dispatchTool(name, args = {}) {
	switch (name) {
		case "take_control":
			return takeControl(args);
		case "release_control":
			return releaseControl(args);
		case "transfer_control":
			return transferControl(args);
		case "transfer_cursor":
			return transferCursor(args);
		case "controlled_status":
			return controlledStatus();
		case "set_primary_tab":
			return setPrimaryTab(args);
		case "batch":
			return runBatch(args);
		default:
			return command(name, args);
	}
}

/** Run a list of {tool,args} steps sequentially in a single MCP round-trip. */
async function runBatch(args = {}) {
	const steps = Array.isArray(args.steps) ? args.steps : [];
	const stopOnError = args.stopOnError !== false;
	const results = [];
	for (const step of steps) {
		if (!step || typeof step.tool !== "string" || step.tool === "batch") {
			results.push({ tool: step?.tool, ok: false, error: "Invalid batch step." });
			if (stopOnError) break;
			continue;
		}
		const stepArgs = { ...(step.args || {}) };
		if (args.tabId !== undefined && stepArgs.tabId === undefined) stepArgs.tabId = args.tabId;
		if (args.backend !== undefined && stepArgs.backend === undefined) stepArgs.backend = args.backend;
		try {
			const result = await dispatchTool(step.tool, stepArgs);
			results.push({ tool: step.tool, ok: result?.ok !== false, result });
		} catch (error) {
			results.push({ tool: step.tool, ok: false, error: error instanceof Error ? error.message : String(error) });
			if (stopOnError) break;
		}
	}
	return { ok: results.every((entry) => entry.ok), steps: results };
}

function jsString(value) {
	return JSON.stringify(value);
}

function buildReadPageExpression(args) {
	return String.raw`(() => {
  const maxTextLength = ${Number(args.maxTextLength || 100000)};
  const maxHtmlLength = ${Number(args.maxHtmlLength || 250000)};
  const includeHtml = ${args.includeHtml === true ? "true" : "false"};
  const includeHiddenText = ${args.includeHiddenText === true ? "true" : "false"};
  ${PAGE_HELPERS}
  return readPage({ includeHtml, includeHiddenText, maxTextLength, maxHtmlLength, backend: "debug" });
})()`;
}

function buildQueryElementsExpression(args) {
	return String.raw`(() => {
  ${PAGE_HELPERS}
  return queryElements(${jsString({
		selector: args.selector,
		text: args.text,
		role: args.role,
		tag: args.tag,
		includeInvisible: args.includeInvisible,
		limit: args.limit,
		backend: "debug",
	})});
})()`;
}

function buildTargetExpression(args) {
	return String.raw`(() => {
  ${PAGE_HELPERS}
  const target = resolveElement(${jsString(args)});
  if (!target.element) return { ok: false, backend: "debug", message: target.message || "Element not found." };
  target.element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = target.element.getBoundingClientRect();
  return { ok: true, backend: "debug", element: serializeElement(target.element, target.index), point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
})()`;
}

async function debugElementPoint(args) {
	const target = await debugEvaluate(buildTargetExpression(args), args.tabId);
	if (!target?.ok) throw new Error(target?.message || "Element not found.");
	return target;
}

async function debugClickRaw(args) {
	if (args.method === "dom") return debugEvaluate(buildClickExpression(args), args.tabId);
	const target = await debugElementPoint(args);
	const { sessionId } = await ensureDebugTarget(args.tabId);
	const button = args.button || "left";
	const clickCount = args.clickCount || 1;
	await debugSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.point.x, y: target.point.y, button: "none" }, sessionId);
	await debugSend("Input.dispatchMouseEvent", { type: "mousePressed", x: target.point.x, y: target.point.y, button, clickCount }, sessionId);
	await debugSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.point.x, y: target.point.y, button, clickCount }, sessionId);
	return { ok: true, backend: "debug", action: "click", element: target.element };
}

/** Default debug click; on failure falls back ONCE to the human-like virtual cursor. */
async function debugClick(args) {
	try {
		return await debugClickRaw(args);
	} catch (error) {
		if (args._viaCursor) throw error;
		const name =
			(args.clickCount || 1) >= 2
				? "cursor_double_click"
				: args.button === "right"
					? "cursor_right_click"
					: "cursor_click";
		return debugCursorAction(name, { ...args, _viaCursor: true });
	}
}

async function debugMouseMove(args) {
	const target = await debugElementPoint(args);
	const { sessionId } = await ensureDebugTarget(args.tabId);
	await debugSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.point.x, y: target.point.y, button: "none" }, sessionId);
	return { ok: true, backend: "debug", action: "hover", element: target.element };
}

async function debugTypeTextRaw(args) {
	if (args.selector || args.elementId || args.text || args.index !== undefined) {
		await debugClick({ ...args, method: "cdp" });
	}
	if (args.clear) {
		await debugPressKey({ ...args, key: "a", modifiers: ["Ctrl"] });
		await debugPressKey({ ...args, key: "Backspace" });
	}
	const { sessionId } = await ensureDebugTarget(args.tabId);
	await debugSend("Input.insertText", { text: String(args.textToType || "") }, sessionId);
	if (args.submit) await debugPressKey({ ...args, key: "Enter" });
	return { ok: true, backend: "debug", action: "type_text", length: String(args.textToType || "").length };
}

/** Default debug typing; on failure falls back ONCE to the virtual mouse+keyboard. */
async function debugTypeText(args) {
	try {
		return await debugTypeTextRaw(args);
	} catch (error) {
		if (args._viaCursor) throw error;
		return debugCursorType({ ...args, _viaCursor: true });
	}
}

async function debugPressKey(args) {
	const { sessionId } = await ensureDebugTarget(args.tabId);
	const keyInfo = keyDefinition(args.key);
	const modifiers = modifierMask(args.modifiers || []);
	await debugSend("Input.dispatchKeyEvent", { type: "keyDown", modifiers, ...keyInfo }, sessionId);
	await debugSend("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...keyInfo }, sessionId);
	return { ok: true, backend: "debug", action: "press_key", key: args.key, modifiers: args.modifiers || [] };
}

function keyDefinition(key) {
	const named = {
		Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
		Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
		Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
		Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
		Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
		ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
		ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
		ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
		ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
	};
	if (named[key]) return named[key];
	const char = String(key || "");
	const upper = char.length === 1 ? char.toUpperCase() : char;
	return {
		key: char,
		code: char.length === 1 ? `Key${upper}` : upper,
		text: char.length === 1 ? char : undefined,
		windowsVirtualKeyCode: char.length === 1 ? upper.charCodeAt(0) : 0,
		nativeVirtualKeyCode: char.length === 1 ? upper.charCodeAt(0) : 0,
	};
}

function modifierMask(modifiers) {
	let mask = 0;
	if (modifiers.includes("Alt")) mask |= 1;
	if (modifiers.includes("Ctrl")) mask |= 2;
	if (modifiers.includes("Meta")) mask |= 4;
	if (modifiers.includes("Shift")) mask |= 8;
	return mask;
}

async function debugScreenshot(args) {
	const { sessionId } = await ensureDebugTarget(args.tabId);
	const params = {
		format: args.format || "png",
		quality: args.format === "jpeg" ? args.quality || 90 : undefined,
		fromSurface: true,
	};
	if (args.fullPage) {
		const metrics = await debugSend("Page.getLayoutMetrics", {}, sessionId);
		const size = metrics.cssContentSize || metrics.contentSize;
		if (size) {
			params.captureBeyondViewport = true;
			params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
		}
	}
	const result = await debugSend("Page.captureScreenshot", params, sessionId);
	return {
		ok: true,
		backend: "debug",
		mimeType: params.format === "jpeg" ? "image/jpeg" : "image/png",
		dataUrl: `data:${params.format === "jpeg" ? "image/jpeg" : "image/png"};base64,${result.data}`,
	};
}

async function debugGetCookies(args) {
	const { sessionId } = await ensureDebugTarget(args.tabId);
	const tabUrl = args.url || (await debugEvaluate("location.href", args.tabId));
	const result = await debugSend("Network.getCookies", { urls: [tabUrl] }, sessionId);
	const cookies = args.name ? (result.cookies || []).filter((cookie) => cookie.name === args.name) : result.cookies || [];
	return { ok: true, backend: "debug", url: tabUrl, cookies };
}

async function debugSetCookie(args) {
	const { sessionId } = await ensureDebugTarget(args.tabId);
	const tabUrl = args.url || (await debugEvaluate("location.href", args.tabId));
	const params = {
		url: tabUrl,
		name: args.name,
		value: args.value,
		domain: args.domain,
		path: args.path,
		expires: args.expirationDate,
		secure: args.secure,
		httpOnly: args.httpOnly,
		sameSite: args.sameSite,
	};
	const result = await debugSend("Network.setCookie", params, sessionId);
	return { ok: result.success !== false, backend: "debug", url: tabUrl, name: args.name };
}

async function debugDeleteCookie(args) {
	const { sessionId } = await ensureDebugTarget(args.tabId);
	const tabUrl = args.url || (await debugEvaluate("location.href", args.tabId));
	await debugSend("Network.deleteCookies", { url: tabUrl, name: args.name }, sessionId);
	return { ok: true, backend: "debug", url: tabUrl, name: args.name };
}

async function debugDragAndDrop(args) {
	const source = await debugElementPoint({
		tabId: args.tabId,
		selector: args.sourceSelector,
		elementId: args.sourceElementId,
		text: args.sourceText,
	});
	const target = await debugElementPoint({
		tabId: args.tabId,
		selector: args.targetSelector,
		elementId: args.targetElementId,
		text: args.targetText,
	});
	const { sessionId } = await ensureDebugTarget(args.tabId);
	await debugSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: source.point.x, y: source.point.y, button: "none" }, sessionId);
	await debugSend("Input.dispatchMouseEvent", { type: "mousePressed", x: source.point.x, y: source.point.y, button: "left", clickCount: 1 }, sessionId);
	await debugSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.point.x, y: target.point.y, button: "left" }, sessionId);
	await debugSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.point.x, y: target.point.y, button: "left", clickCount: 1 }, sessionId);
	return { ok: true, backend: "debug", source: source.element, target: target.element };
}

// --- Debug backend: controlled tabs, virtual cursor, and richer reads --------

function handleDebugEvent(msg) {
	const key = msg.sessionId || "_";
	if (msg.method === "Runtime.consoleAPICalled" || msg.method === "Log.entryAdded") {
		pushRing(debugEventBuffers.console, key, normalizeConsoleEvent(msg));
	} else if (msg.method === "Network.responseReceived") {
		pushRing(debugEventBuffers.network, key, normalizeNetworkEvent(msg));
	}
}

async function debugOverlayCall(tabId, call, callArgs = []) {
	return debugEvaluate(`(${cursorOverlayCall.toString()})(${jsString(call)}, ${jsString(callArgs)})`, tabId);
}

async function debugCursorEnsure(tabId, opts = {}) {
	return debugEvaluate(`(${setupCursorOverlay.toString()})(${jsString({ theme: CURSOR_THEME, ...opts })})`, tabId);
}

async function debugInjectControlAssets(tabId, label) {
	await debugCursorEnsure(tabId, { label });
	await debugEvaluate(`(${setupTabMarker.toString()})(${jsString({})})`, tabId);
}

async function debugTakeControl(args) {
	let targetId = args.tabId ? String(args.tabId) : undefined;
	if (!targetId) {
		const created = await debugSend("Target.createTarget", { url: args.url || "about:blank" });
		targetId = created.targetId;
		debugTargetId = targetId;
		debugSessionId = undefined;
		await sleep(300);
	} else if (args.url) {
		await ensureDebugTarget(targetId);
		await debugSend("Page.navigate", { url: args.url }, debugSessionId);
		await sleep(300);
	}
	await ensureDebugTarget(targetId);
	await debugInjectControlAssets(targetId, args.label);
	const info = await debugEvaluate("({ title: document.title, url: location.href })", targetId);
	return { ok: true, backend: "debug", tabId: targetId, title: info?.title, url: info?.url };
}

async function debugReleaseControl(args) {
	try {
		await debugEvaluate(`(${restoreTabMarker.toString()})()`, args.tabId);
	} catch {}
	try {
		await debugOverlayCall(args.tabId, "hide", []);
	} catch {}
	return { ok: true, backend: "debug", released: true, tabId: args.tabId };
}

async function debugResolvePoint(args, fields) {
	if (fields.x !== undefined && fields.x !== null && fields.y !== undefined && fields.y !== null) {
		return { point: { x: Number(fields.x), y: Number(fields.y) }, element: undefined };
	}
	return debugElementPoint({
		tabId: args.tabId,
		selector: fields.selector,
		elementId: fields.elementId,
		text: fields.text,
		index: fields.index,
	});
}

async function debugCursorGlide(tabId, point, button = "none") {
	await debugCursorEnsure(tabId);
	const current = await debugOverlayCall(tabId, "getPos", []);
	const from = current && typeof current.x === "number" ? current : { x: point.x, y: point.y };
	const dist = Math.hypot(point.x - from.x, point.y - from.y);
	const duration = cursorDuration(dist);
	await debugOverlayCall(tabId, "glideTo", [point.x, point.y, duration]);
	const steps = Math.max(10, Math.min(48, Math.round(duration / 18)));
	const path = cursorPath(from, point, { steps });
	const stepDelay = duration / path.length;
	const { sessionId } = await ensureDebugTarget(tabId);
	for (const p of path) {
		await debugSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button }, sessionId);
		await sleep(stepDelay);
	}
	await debugOverlayCall(tabId, "moveTo", [point.x, point.y]);
	return { sessionId };
}

async function debugCursorAction(name, args) {
	const target = await debugResolvePoint(args, {
		selector: args.selector,
		elementId: args.elementId,
		text: args.text,
		index: args.index,
		x: args.x,
		y: args.y,
	});
	const { sessionId } = await debugCursorGlide(args.tabId, target.point);
	if (name === "cursor_move" || name === "cursor_hover") {
		return { ok: true, backend: "debug", action: name, element: target.element, point: target.point };
	}
	const button = name === "cursor_right_click" ? "right" : "left";
	const clicks = name === "cursor_double_click" ? 2 : 1;
	const { x, y } = target.point;
	for (let i = 0; i < clicks; i += 1) {
		if (i > 0) await sleep(doubleClickGap());
		await debugOverlayCall(args.tabId, "press", []);
		await debugSend("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i + 1 }, sessionId);
		await sleep(humanPressDelay());
		await debugSend("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i + 1 }, sessionId);
		await debugOverlayCall(args.tabId, "release", []);
	}
	return { ok: true, backend: "debug", action: name, element: target.element, point: target.point };
}

async function debugCursorDrag(args) {
	const source = await debugResolvePoint(args, {
		selector: args.sourceSelector,
		elementId: args.sourceElementId,
		text: args.sourceText,
		x: args.x,
		y: args.y,
	});
	const { sessionId } = await debugCursorGlide(args.tabId, source.point);
	await debugOverlayCall(args.tabId, "press", []);
	await debugSend("Input.dispatchMouseEvent", { type: "mousePressed", x: source.point.x, y: source.point.y, button: "left", clickCount: 1 }, sessionId);
	const target = await debugResolvePoint(args, {
		selector: args.targetSelector,
		elementId: args.targetElementId,
		text: args.targetText,
		x: args.toX,
		y: args.toY,
	});
	await debugCursorGlide(args.tabId, target.point, "left");
	await debugSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.point.x, y: target.point.y, button: "left", clickCount: 1 }, sessionId);
	await debugOverlayCall(args.tabId, "release", []);
	return { ok: true, backend: "debug", source: source.element, target: target.element };
}

async function debugTypeViaKeys(tabId, text) {
	const { sessionId } = await ensureDebugTarget(tabId);
	for (const ch of String(text)) {
		const def = ch === "\n" || ch === "\r" ? keyDefinition("Enter") : keyDefinition(ch);
		await debugSend("Input.dispatchKeyEvent", { type: "keyDown", ...def }, sessionId);
		await debugSend("Input.dispatchKeyEvent", { type: "keyUp", ...def }, sessionId);
		await sleep(humanTypeDelay());
	}
}

async function debugCursorType(args) {
	await debugCursorEnsure(args.tabId);
	if (args.selector || args.elementId || args.text || (args.x !== undefined && args.x !== null && args.y !== undefined && args.y !== null)) {
		await debugCursorAction("cursor_click", args);
	}
	if (args.clear) {
		await debugPressKey({ ...args, key: "a", modifiers: ["Ctrl"] });
		await debugPressKey({ ...args, key: "Delete" });
	}
	await debugTypeViaKeys(args.tabId, args.textToType || "");
	if (args.submit) await debugPressKey({ ...args, key: "Enter" });
	return { ok: true, backend: "debug", action: "cursor_type", length: String(args.textToType || "").length };
}

async function debugReadTab(args) {
	const mode = args.mode || "text";
	if (mode === "outline") return debugEvaluate(buildOutlineExpression(args), args.tabId);
	if (mode === "links") return debugEvaluate(buildReadLinksExpression(args), args.tabId);
	return debugEvaluate(buildReadTextExpression(args), args.tabId);
}

async function debugAccessibilityTree(args) {
	const { sessionId } = await ensureDebugTarget(args.tabId);
	await debugSend("Accessibility.enable", {}, sessionId).catch(() => {});
	const result = await debugSend("Accessibility.getFullAXTree", {}, sessionId);
	return { ok: true, backend: "debug", nodes: compactAxNodes(result.nodes || [], args.maxNodes || 400) };
}

async function debugFrames(args) {
	const { sessionId } = await ensureDebugTarget(args.tabId);
	const tree = await debugSend("Page.getFrameTree", {}, sessionId);
	return { ok: true, backend: "debug", frames: flattenFrameTree(tree.frameTree) };
}

async function debugReadConsole(args) {
	const { sessionId } = await ensureDebugTarget(args.tabId);
	await debugSend("Runtime.enable", {}, sessionId).catch(() => {});
	await debugSend("Log.enable", {}, sessionId).catch(() => {});
	let list = debugEventBuffers.console.get(sessionId) || [];
	if (args.level) list = list.filter((entry) => entry.level === args.level);
	return { ok: true, backend: "debug", entries: list.slice(-Number(args.limit || 50)) };
}

async function debugReadNetwork(args) {
	const { sessionId } = await ensureDebugTarget(args.tabId);
	await debugSend("Network.enable", {}, sessionId).catch(() => {});
	let list = debugEventBuffers.network.get(sessionId) || [];
	if (args.urlContains) list = list.filter((entry) => String(entry.url).includes(args.urlContains));
	return { ok: true, backend: "debug", requests: list.slice(-Number(args.limit || 30)) };
}

function buildFindElementExpression(args) {
	return String.raw`(() => {
  ${PAGE_HELPERS}
  const opts = ${jsString(args)};
  const result = queryElements({ selector: opts.selector, text: opts.text, role: opts.role, includeInvisible: opts.includeInvisible, limit: 200 });
  let elements = result.elements;
  if (opts.name) { const n = String(opts.name).toLowerCase(); elements = elements.filter((e) => (e.name || "").toLowerCase().includes(n)); }
  const nth = Number(opts.nth || 0);
  const data = elements[nth];
  if (!data) return { ok: false, backend: "debug", message: "No element matched the requested target." };
  const el = document.querySelector('[data-browser-mcp-id="' + CSS.escape(String(data.elementId)) + '"]');
  if (el) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = el ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
  return { ok: true, backend: "debug", elementId: data.elementId, role: data.role, name: data.name, selector: data.selector, visible: data.visible, count: elements.length, center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
})()`;
}

function buildMainContentExpression(args) {
	return String.raw`(() => {
  const maxLength = ${Number(args.maxLength || 40000)};
  const BLOCK = "p,li,blockquote,pre,h1,h2,h3,h4,h5,h6";
  const candidates = Array.from(document.querySelectorAll("article, main, [role=main], .article, .post, .post-content, .entry-content, .content, #content, .markdown-body, body"));
  let best = document.body, bestScore = -1;
  for (const c of candidates) {
    const text = (c.innerText || "").trim();
    const links = c.querySelectorAll("a").length;
    const score = text.length - links * 40;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  const parts = [];
  for (const node of best.querySelectorAll(BLOCK)) {
    if (node.closest("nav,aside,footer,header,[role=navigation],[role=banner],[role=contentinfo]")) continue;
    const tag = node.tagName.toLowerCase();
    let line = (node.innerText || "").trim();
    if (!line) continue;
    if (/^h[1-6]$/.test(tag)) line = "#".repeat(Number(tag[1])) + " " + line;
    else if (tag === "li") line = "- " + line;
    else if (tag === "blockquote") line = "> " + line;
    else if (tag === "pre") line = line.split("\n").map((l) => "    " + l).join("\n");
    parts.push(line);
  }
  let md = parts.join("\n\n");
  if (!md) md = (best.innerText || "").trim();
  md = md.slice(0, maxLength);
  const bylineEl = document.querySelector('[rel="author"], .author, .byline');
  const byline = bylineEl ? bylineEl.textContent.trim().slice(0, 120) : undefined;
  return { ok: true, backend: "debug", title: document.title, url: location.href, byline, textMarkdown: md, length: md.length };
})()`;
}

function buildGetAttributesExpression(args) {
	return String.raw`(() => {
  ${PAGE_HELPERS}
  const opts = ${jsString(args)};
  const target = resolveElement(opts);
  if (!target.element) return { ok: false, backend: "debug", message: target.message || "Element not found." };
  const el = target.element;
  const names = opts.names && opts.names.length ? opts.names : el.getAttributeNames();
  const attributes = {};
  for (const n of names) attributes[n] = el.getAttribute(n);
  return { ok: true, backend: "debug", elementId: el.dataset.browserMcpId, attributes };
})()`;
}

function buildSetAttributesExpression(args) {
	return String.raw`(() => {
  ${PAGE_HELPERS}
  const opts = ${jsString(args)};
  const target = resolveElement(opts);
  if (!target.element) return { ok: false, backend: "debug", message: target.message || "Element not found." };
  const el = target.element;
  const attrs = opts.attributes || {};
  for (const [k, v] of Object.entries(attrs)) { if (v === null) el.removeAttribute(k); else el.setAttribute(k, String(v)); }
  return { ok: true, backend: "debug", elementId: el.dataset.browserMcpId, attributes: attrs };
})()`;
}

function buildReadTextExpression(args) {
	return String.raw`(() => {
  const maxTextLength = ${Number(args.maxTextLength || 80000)};
  const text = (document.body && document.body.innerText || "").trim();
  return { ok: true, backend: "debug", title: document.title, url: location.href, readyState: document.readyState, text: text.slice(0, maxTextLength), textLength: text.length };
})()`;
}

function buildReadLinksExpression(args) {
	return String.raw`(() => {
  const limit = ${Number(args.limit || 200)};
  const links = Array.from(document.querySelectorAll("a[href]")).slice(0, limit).map((a, i) => ({ index: i, text: (a.innerText || a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200), href: a.href }));
  return { ok: true, backend: "debug", count: links.length, links };
})()`;
}

function buildOutlineExpression(args) {
	return String.raw`(() => {
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) => ({ level: Number(h.tagName[1]), text: (h.innerText || "").trim().slice(0, 200) })).filter((h) => h.text);
  const landmarks = Array.from(document.querySelectorAll("nav,main,header,footer,aside,[role]")).slice(0, 80).map((el) => ({ role: el.getAttribute("role") || el.tagName.toLowerCase(), label: el.getAttribute("aria-label") || "" }));
  return { ok: true, backend: "debug", title: document.title, url: location.href, headings, landmarks };
})()`;
}

function buildClickExpression(args) {
	return String.raw`(() => {
  ${PAGE_HELPERS}
  const target = resolveElement(${jsString(args)});
  if (!target.element) return { ok: false, backend: "debug", message: target.message || "Element not found." };
  target.element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  target.element.click();
  return { ok: true, backend: "debug", action: "click", element: serializeElement(target.element, target.index) };
})()`;
}

function buildSetValueExpression(args) {
	return String.raw`(() => {
  ${PAGE_HELPERS}
  const target = resolveElement(${jsString(args)});
  if (!target.element) return { ok: false, backend: "debug", message: target.message || "Element not found." };
  setElementValue(target.element, ${jsString(args.value)});
  return { ok: true, backend: "debug", action: "set_value", element: serializeElement(target.element, target.index), value: ${jsString(args.value)} };
})()`;
}

function buildScrollExpression(args) {
	return String.raw`(() => {
  ${PAGE_HELPERS}
  const opts = ${jsString(args)};
  let target = null;
  if (opts.selector || opts.elementId || opts.text || opts.index !== undefined) target = resolveElement(opts).element;
  const dx = Number(opts.x || 0);
  const dy = Number(opts.y || 0);
  const direction = opts.direction || "down";
  const receiver = target || window;
  if (direction === "into_view" && target) target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  else if (direction === "top") receiver.scrollTo ? receiver.scrollTo(0, 0) : window.scrollTo(0, 0);
  else if (direction === "bottom") receiver.scrollTo ? receiver.scrollTo(0, 999999) : window.scrollTo(0, document.body.scrollHeight);
  else {
    const amountX = dx || (direction === "left" ? -600 : direction === "right" ? 600 : 0);
    const amountY = dy || (direction === "up" ? -600 : direction === "down" ? 600 : 0);
    if (receiver === window) window.scrollBy(amountX, amountY);
    else receiver.scrollBy(amountX, amountY);
  }
  return { ok: true, backend: "debug", action: "scroll", scrollX: window.scrollX, scrollY: window.scrollY };
})()`;
}

function buildSelectOptionExpression(args) {
	return String.raw`(() => {
  ${PAGE_HELPERS}
  const target = resolveElement(${jsString(args)});
  if (!target.element) return { ok: false, backend: "debug", message: target.message || "Element not found." };
  const select = target.element;
  if (select.tagName !== "SELECT") return { ok: false, backend: "debug", message: "Target is not a select element." };
  const options = Array.from(select.options);
  let option = null;
  const opts = ${jsString(args)};
  if (opts.value !== undefined) option = options.find((entry) => entry.value === opts.value);
  if (!option && opts.label !== undefined) option = options.find((entry) => entry.label === opts.label || entry.textContent.trim() === opts.label);
  if (!option && opts.optionIndex !== undefined) option = options[opts.optionIndex];
  if (!option) return { ok: false, backend: "debug", message: "Option not found." };
  select.value = option.value;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, backend: "debug", value: select.value, label: option.textContent.trim() };
})()`;
}

function buildCheckExpression(args) {
	return String.raw`(() => {
  ${PAGE_HELPERS}
  const target = resolveElement(${jsString(args)});
  if (!target.element) return { ok: false, backend: "debug", message: target.message || "Element not found." };
  const element = target.element;
  const checked = ${args.checked === undefined ? "true" : args.checked ? "true" : "false"};
  if (!("checked" in element)) return { ok: false, backend: "debug", message: "Target is not checkable." };
  element.checked = checked;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, backend: "debug", checked: element.checked, element: serializeElement(element, target.index) };
})()`;
}

function buildWaitForExpression(args) {
	return String.raw`(async () => {
  ${PAGE_HELPERS}
  const opts = ${jsString(args)};
  const deadline = Date.now() + Number(opts.waitMs || 10000);
  while (Date.now() < deadline) {
    if (opts.state && document.readyState === opts.state) return { ok: true, backend: "debug", state: document.readyState };
    if (opts.urlContains && location.href.includes(opts.urlContains)) return { ok: true, backend: "debug", url: location.href };
    if (opts.selector && document.querySelector(opts.selector)) return { ok: true, backend: "debug", selector: opts.selector };
    if (opts.text && document.body && document.body.innerText.includes(opts.text)) return { ok: true, backend: "debug", text: opts.text };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { ok: false, backend: "debug", message: "Timed out waiting for condition.", url: location.href, state: document.readyState };
})()`;
}

function buildGetStorageExpression(args) {
	return String.raw`(() => {
  const area = ${jsString(args.area || "both")};
  const keys = ${jsString(args.keys || [])};
  const read = (store) => Object.fromEntries((keys.length ? keys : Object.keys(store)).map((key) => [key, store.getItem(key)]));
  return { ok: true, backend: "debug", local: area === "local" || area === "both" ? read(localStorage) : undefined, session: area === "session" || area === "both" ? read(sessionStorage) : undefined };
})()`;
}

function buildSetStorageExpression(args) {
	return String.raw`(() => {
  const store = ${jsString(args.area)} === "session" ? sessionStorage : localStorage;
  const values = ${jsString(args.values || {})};
  for (const [key, value] of Object.entries(values)) store.setItem(key, String(value));
  return { ok: true, backend: "debug", area: ${jsString(args.area)}, keys: Object.keys(values) };
})()`;
}

const PAGE_HELPERS = String.raw`
function ensureElementIds() {
  if (!window.__browserMcpElementSeq) window.__browserMcpElementSeq = 1;
  for (const element of document.querySelectorAll("*")) {
    if (!element.dataset.browserMcpId) element.dataset.browserMcpId = String(window.__browserMcpElementSeq++);
  }
}
function visible(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function accessibleRole(element) {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit" || type === "reset") return "button";
    return "textbox";
  }
  if (/^h[1-6]$/.test(tag)) return "heading";
  return "";
}
function elementName(element) {
  return (
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    element.getAttribute("alt") ||
    element.getAttribute("placeholder") ||
    element.innerText ||
    element.textContent ||
    element.value ||
    ""
  ).trim().replace(/\s+/g, " ");
}
function cssPath(element) {
  if (!element || element === document.documentElement) return "html";
  const parts = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
    const tag = current.tagName.toLowerCase();
    const id = current.id ? "#" + CSS.escape(current.id) : "";
    if (id) {
      parts.unshift(tag + id);
      break;
    }
    const siblings = Array.from(current.parentElement ? current.parentElement.children : []).filter((entry) => entry.tagName === current.tagName);
    const index = siblings.length > 1 ? ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")" : "";
    parts.unshift(tag + index);
    current = current.parentElement;
  }
  return parts.join(" > ");
}
function serializeElement(element, index) {
  ensureElementIds();
  const rect = element.getBoundingClientRect();
  return {
    index,
    elementId: element.dataset.browserMcpId,
    tag: element.tagName.toLowerCase(),
    role: accessibleRole(element),
    name: elementName(element).slice(0, 500),
    text: (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 1000),
    value: element.value,
    href: element.href,
    src: element.src,
    type: element.getAttribute("type"),
    checked: "checked" in element ? element.checked : undefined,
    disabled: element.disabled || element.getAttribute("aria-disabled") === "true",
    visible: visible(element),
    selector: cssPath(element),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}
function queryElements(options) {
  ensureElementIds();
  const limit = Math.min(Number(options.limit || 100), 500);
  let elements;
  if (options.selector) elements = Array.from(document.querySelectorAll(options.selector));
  else elements = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role],[contenteditable=true],summary,label,[onclick],h1,h2,h3,h4,h5,h6"));
  if (options.tag) elements = elements.filter((element) => element.tagName.toLowerCase() === String(options.tag).toLowerCase());
  if (options.role) elements = elements.filter((element) => accessibleRole(element).toLowerCase() === String(options.role).toLowerCase());
  if (options.text) {
    const needle = String(options.text).toLowerCase();
    elements = elements.filter((element) => elementName(element).toLowerCase().includes(needle) || (element.innerText || element.textContent || "").toLowerCase().includes(needle));
  }
  if (!options.includeInvisible) elements = elements.filter(visible);
  return { ok: true, backend: options.backend || "extension", count: elements.length, elements: elements.slice(0, limit).map(serializeElement) };
}
function resolveElement(options) {
  ensureElementIds();
  if (options.elementId) {
    const element = document.querySelector('[data-browser-mcp-id="' + CSS.escape(String(options.elementId)) + '"]');
    if (element) return { element, index: 0 };
  }
  const result = queryElements({ selector: options.selector, text: options.text, includeInvisible: options.includeInvisible, limit: 500 });
  const index = Number(options.index || 0);
  const data = result.elements[index];
  if (!data) return { element: null, index, message: "No element matched the requested target." };
  const element = document.querySelector('[data-browser-mcp-id="' + CSS.escape(String(data.elementId)) + '"]');
  return { element, index };
}
function setElementValue(element, value) {
  if (element.tagName === "SELECT") {
    element.value = String(value);
  } else if (element.type === "checkbox" || element.type === "radio") {
    element.checked = Boolean(value);
  } else if (element.isContentEditable) {
    element.textContent = String(value);
  } else {
    element.value = String(value);
  }
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}
function readPage(options) {
  ensureElementIds();
  const meta = Object.fromEntries(Array.from(document.querySelectorAll("meta[name],meta[property]")).map((entry) => [entry.getAttribute("name") || entry.getAttribute("property"), entry.getAttribute("content") || ""]));
  const textSource = options.includeHiddenText ? document.body.textContent || "" : document.body.innerText || "";
  const text = textSource.trim().replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((entry) => ({ level: Number(entry.tagName.slice(1)), text: elementName(entry) })).filter((entry) => entry.text);
  const links = Array.from(document.querySelectorAll("a[href]")).slice(0, 300).map((entry, index) => ({ index, text: elementName(entry), href: entry.href, elementId: entry.dataset.browserMcpId }));
  const images = Array.from(document.images).slice(0, 200).map((entry, index) => ({ index, alt: entry.alt, src: entry.currentSrc || entry.src, width: entry.naturalWidth, height: entry.naturalHeight, elementId: entry.dataset.browserMcpId }));
  const forms = Array.from(document.forms).slice(0, 50).map((form, index) => ({ index, action: form.action, method: form.method, elements: Array.from(form.elements).slice(0, 100).map((element, elementIndex) => serializeElement(element, elementIndex)) }));
  const interactive = queryElements({ limit: 300, backend: options.backend }).elements;
  const tables = Array.from(document.querySelectorAll("table")).slice(0, 30).map((table, index) => ({ index, caption: table.caption ? table.caption.innerText.trim() : "", rows: Array.from(table.rows).slice(0, 50).map((row) => Array.from(row.cells).map((cell) => cell.innerText.trim())) }));
  return {
    ok: true,
    backend: options.backend || "extension",
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    language: document.documentElement.lang,
    meta,
    text: text.slice(0, options.maxTextLength),
    textLength: text.length,
    headings,
    links,
    images,
    forms,
    interactive,
    tables,
    html: options.includeHtml ? document.documentElement.outerHTML.slice(0, options.maxHtmlLength) : undefined,
    htmlLength: document.documentElement.outerHTML.length,
  };
}
`;

function ok(payload) {
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(error) {
	const message = error instanceof Error ? error.message : String(error);
	return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, message }, null, 2) }] };
}

function tool(server, name, title, description, inputSchema, handler) {
	server.registerTool(name, { title, description, inputSchema }, async (args) => {
		try {
			return ok(await handler(args || {}));
		} catch (error) {
			return fail(error);
		}
	});
}

function backendShape() {
	return {
		backend: z.enum(["extension", "debug", "auto"]).optional(),
		clientId: z.string().optional(),
		timeoutMs: z.number().int().min(1000).max(120000).optional(),
	};
}

function tabParamsShape() {
	return {
		...backendShape(),
		tabId: z.union([z.number().int().positive(), z.string()]).optional(),
	};
}

function elementTargetShape() {
	return {
		...tabParamsShape(),
		selector: z.string().optional(),
		elementId: z.string().optional(),
		text: z.string().optional(),
		index: z.number().int().min(0).optional(),
		includeInvisible: z.boolean().optional(),
	};
}

function cursorTargetShape() {
	return {
		...elementTargetShape(),
		x: z.number().optional(),
		y: z.number().optional(),
	};
}

await startBridge();

const server = new McpServer({ name: "browser-control", version: "1.0.0" });

tool(
	server,
	"bridge_status",
	"Browser bridge status",
	"Read extension bridge status, connected normal browsers, and dedicated debug-browser status.",
	{},
	async () => ({
		ok: true,
		bridgeUrl,
		tokenRequired: Boolean(BRIDGE_TOKEN),
		defaultBackend: DEFAULT_BACKEND,
		extensionConnected: activeClients().length > 0,
		clients: currentClients(),
		debug: debugStatus(),
		pendingJobs: pendingJobs.size,
		queuedJobs: queuedJobs.length,
	}),
);

tool(
	server,
	"launch_debug_browser",
	"Launch dedicated debug browser",
	"Launch or connect to a dedicated Chrome/Edge instance with CDP enabled. Use only when the user/model needs full isolated control.",
	{
		browser: z.enum(["auto", "edge", "chrome"]).optional(),
		url: z.string().optional(),
		userDataDir: z.string().optional(),
	},
	async (args) => launchDebugBrowser(args),
);

tool(
	server,
	"connect_debug_browser",
	"Connect debug browser",
	"Connect to an already-running Chrome/Edge instance exposing the configured CDP port.",
	{},
	async () => {
		await connectDebugBrowser();
		return { ok: true, ...debugStatus() };
	},
);

tool(
	server,
	"close_debug_browser",
	"Close dedicated debug browser",
	"Close the dedicated debug Chrome/Edge instance controlled through CDP.",
	{},
	async () => closeDebugBrowser(),
);

tool(
	server,
	"list_tabs",
	"List browser tabs",
	"List open tabs from the normal-browser extension backend or the dedicated debug backend.",
	backendShape(),
	async (args) => command("list_tabs", args),
);

tool(server, "active_tab", "Get active tab", "Return the active tab.", backendShape(), async (args) =>
	command("active_tab", args),
);

tool(
	server,
	"activate_tab",
	"Activate tab",
	"Focus a browser tab by id.",
	{ ...tabParamsShape(), tabId: z.union([z.number().int().positive(), z.string()]) },
	async (args) => command("activate_tab", args),
);

tool(
	server,
	"open_url",
	"Open URL",
	"Open a URL in a new tab or update an existing tab.",
	{ ...tabParamsShape(), url: z.string(), active: z.boolean().optional(), autoLaunch: z.boolean().optional() },
	async (args) => command("open_url", args),
);

tool(
	server,
	"close_tab",
	"Close tab",
	"Close a browser tab.",
	{ ...tabParamsShape(), tabId: z.union([z.number().int().positive(), z.string()]) },
	async (args) => command("close_tab", args),
);

tool(server, "reload", "Reload tab", "Reload the selected or active tab.", { ...tabParamsShape(), bypassCache: z.boolean().optional() }, async (args) =>
	command("reload", args),
);
tool(server, "go_back", "Go back", "Navigate the selected tab back.", tabParamsShape(), async (args) =>
	command("go_back", args),
);
tool(server, "go_forward", "Go forward", "Navigate the selected tab forward.", tabParamsShape(), async (args) =>
	command("go_forward", args),
);

tool(
	server,
	"read_page",
	"Read page",
	"Read title, URL, visible text, metadata, links, forms, buttons, tables, images, headings, and optional HTML.",
	{
		...tabParamsShape(),
		includeHtml: z.boolean().optional(),
		includeHiddenText: z.boolean().optional(),
		maxTextLength: z.number().int().min(1000).max(500000).optional(),
		maxHtmlLength: z.number().int().min(1000).max(1000000).optional(),
	},
	async (args) => command("read_page", args),
);

tool(
	server,
	"query_elements",
	"Query page elements",
	"Find elements by CSS selector, text, role, tag, or common interactive selectors; returns element ids for later actions.",
	{
		...tabParamsShape(),
		selector: z.string().optional(),
		text: z.string().optional(),
		role: z.string().optional(),
		tag: z.string().optional(),
		includeInvisible: z.boolean().optional(),
		limit: z.number().int().min(1).max(500).optional(),
	},
	async (args) => command("query_elements", args),
);

tool(
	server,
	"click",
	"Click element",
	"Click an element by element id, selector, text, or query index.",
	{
		...elementTargetShape(),
		button: z.enum(["left", "middle", "right"]).optional(),
		clickCount: z.number().int().min(1).max(3).optional(),
		method: z.enum(["auto", "dom", "cdp"]).optional(),
	},
	async (args) => command("click", args),
);

tool(server, "double_click", "Double click element", "Double-click an element.", elementTargetShape(), async (args) =>
	command("click", { ...args, clickCount: 2, method: "cdp" }),
);

tool(server, "hover", "Hover element", "Move the mouse over an element.", elementTargetShape(), async (args) =>
	command("hover", args),
);

tool(
	server,
	"type_text",
	"Type text",
	"Type text into an element or the focused element. Can clear first and submit.",
	{
		...elementTargetShape(),
		textToType: z.string(),
		clear: z.boolean().optional(),
		submit: z.boolean().optional(),
		method: z.enum(["auto", "dom", "cdp"]).optional(),
	},
	async (args) => command("type_text", args),
);

tool(
	server,
	"set_value",
	"Set element value",
	"Set an input, textarea, contenteditable, select, checkbox, or radio value through DOM events.",
	{ ...elementTargetShape(), value: z.union([z.string(), z.boolean(), z.number()]) },
	async (args) => command("set_value", args),
);

tool(
	server,
	"press_key",
	"Press key",
	"Send a keyboard key to the selected tab.",
	{ ...tabParamsShape(), key: z.string(), modifiers: z.array(z.enum(["Alt", "Ctrl", "Meta", "Shift"])).optional() },
	async (args) => command("press_key", args),
);

tool(
	server,
	"scroll",
	"Scroll page or element",
	"Scroll by pixels, to top/bottom, or scroll an element into view.",
	{
		...elementTargetShape(),
		x: z.number().optional(),
		y: z.number().optional(),
		direction: z.enum(["up", "down", "left", "right", "top", "bottom", "into_view"]).optional(),
	},
	async (args) => command("scroll", args),
);

tool(
	server,
	"select_option",
	"Select option",
	"Select an option in a select element by value, label, or index.",
	{ ...elementTargetShape(), value: z.string().optional(), label: z.string().optional(), optionIndex: z.number().int().min(0).optional() },
	async (args) => command("select_option", args),
);

tool(
	server,
	"check",
	"Check element",
	"Check or uncheck a checkbox/radio element.",
	{ ...elementTargetShape(), checked: z.boolean().optional() },
	async (args) => command("check", args),
);

tool(
	server,
	"wait_for",
	"Wait for page condition",
	"Wait for selector, text, URL substring, or page ready state.",
	{
		...tabParamsShape(),
		selector: z.string().optional(),
		text: z.string().optional(),
		urlContains: z.string().optional(),
		state: z.enum(["loading", "interactive", "complete"]).optional(),
		waitMs: z.number().int().min(100).max(120000).optional(),
	},
	async (args) => command("wait_for", args),
);

tool(
	server,
	"screenshot",
	"Capture screenshot",
	"Capture a PNG/JPEG screenshot as a data URL.",
	{ ...tabParamsShape(), fullPage: z.boolean().optional(), format: z.enum(["png", "jpeg"]).optional(), quality: z.number().int().min(1).max(100).optional() },
	async (args) => command("screenshot", args),
);

tool(
	server,
	"evaluate_js",
	"Evaluate JavaScript",
	"Evaluate JavaScript in the selected tab. Use for advanced page extraction or control.",
	{ ...tabParamsShape(), expression: z.string(), world: z.enum(["ISOLATED", "MAIN"]).optional() },
	async (args) => command("evaluate_js", args),
);

tool(
	server,
	"run_cdp_command",
	"Run CDP command",
	"Run an arbitrary Chrome DevTools Protocol command against a tab.",
	{ ...tabParamsShape(), method: z.string(), params: z.record(z.any()).optional() },
	async (args) => command("run_cdp_command", { ...args, backend: args.backend || "debug" }),
);

tool(
	server,
	"get_storage",
	"Get web storage",
	"Read localStorage and/or sessionStorage from the selected page.",
	{ ...tabParamsShape(), area: z.enum(["local", "session", "both"]).optional(), keys: z.array(z.string()).optional() },
	async (args) => command("get_storage", args),
);

tool(
	server,
	"set_storage",
	"Set web storage",
	"Write localStorage or sessionStorage entries in the selected page.",
	{ ...tabParamsShape(), area: z.enum(["local", "session"]), values: z.record(z.string()) },
	async (args) => command("set_storage", args),
);

tool(
	server,
	"get_cookies",
	"Get cookies",
	"Read cookies for a URL or selected tab URL.",
	{ ...tabParamsShape(), url: z.string().optional(), name: z.string().optional() },
	async (args) => command("get_cookies", args),
);

tool(
	server,
	"set_cookie",
	"Set cookie",
	"Set a browser cookie for a URL.",
	{
		...tabParamsShape(),
		url: z.string().optional(),
		name: z.string(),
		value: z.string(),
		domain: z.string().optional(),
		path: z.string().optional(),
		expirationDate: z.number().optional(),
		secure: z.boolean().optional(),
		httpOnly: z.boolean().optional(),
		sameSite: z.enum(["no_restriction", "lax", "strict", "unspecified"]).optional(),
	},
	async (args) => command("set_cookie", args),
);

tool(
	server,
	"delete_cookie",
	"Delete cookie",
	"Delete a browser cookie by name.",
	{ ...tabParamsShape(), url: z.string().optional(), name: z.string() },
	async (args) => command("delete_cookie", args),
);

tool(
	server,
	"drag_and_drop",
	"Drag and drop",
	"Drag one element to another.",
	{
		...tabParamsShape(),
		sourceSelector: z.string().optional(),
		sourceElementId: z.string().optional(),
		sourceText: z.string().optional(),
		targetSelector: z.string().optional(),
		targetElementId: z.string().optional(),
		targetText: z.string().optional(),
	},
	async (args) => command("drag_and_drop", args),
);

// --- Controlled-tab management -----------------------------------------------

tool(
	server,
	"take_control",
	"Take control of a browser tab",
	"Take over a specific tab (by tabId) or open a new one (by url) for AI control. The tab is marked '🟢 AI 操作中' in the tab strip and gets a virtual cursor. All later actions target this tab by id, so the user can keep using other tabs without interfering. DOM/text-based; no screenshots needed.",
	{ ...tabParamsShape(), url: z.string().optional(), label: z.string().optional(), makePrimary: z.boolean().optional(), active: z.boolean().optional() },
	async (args) => takeControl(args),
);

tool(
	server,
	"release_control",
	"Release a controlled tab",
	"Stop controlling a tab: restore its original title, remove the virtual cursor, and (extension backend) detach the debugger. Call when finished so the user fully regains the tab.",
	{ ...backendShape(), tabId: z.union([z.number().int().positive(), z.string()]).optional() },
	async (args) => releaseControl(args),
);

tool(
	server,
	"transfer_control",
	"Transfer control to another tab",
	"Make another tab (toTabId or a new url) the primary controlled tab and release the previous one.",
	{ ...backendShape(), fromTabId: z.union([z.number().int().positive(), z.string()]).optional(), toTabId: z.union([z.number().int().positive(), z.string()]).optional(), url: z.string().optional(), label: z.string().optional() },
	async (args) => transferControl(args),
);

tool(
	server,
	"transfer_cursor",
	"Move the virtual cursor to another tab",
	"Move the on-page virtual mouse to another controlled tab (taking control of it if needed) and hide it on the previous tab. Both tabs stay controlled.",
	{ ...backendShape(), toTabId: z.union([z.number().int().positive(), z.string()]).optional(), url: z.string().optional() },
	async (args) => transferCursor(args),
);

tool(
	server,
	"controlled_status",
	"List controlled tabs",
	"Return the tabs currently under AI control and which one is primary (the default target when tabId is omitted).",
	{},
	async () => controlledStatus(),
);

tool(
	server,
	"set_primary_tab",
	"Set the primary controlled tab",
	"Choose which already-controlled tab is the default target for actions that omit tabId.",
	{ tabId: z.union([z.number().int().positive(), z.string()]) },
	async (args) => setPrimaryTab(args),
);

// --- Virtual cursor (humanized, on-page mouse) -------------------------------

tool(
	server,
	"cursor_move",
	"Move virtual cursor",
	"Smoothly move the on-page virtual cursor to an element (selector/elementId/text) or to x,y viewport coordinates, without clicking. The real OS mouse is never touched.",
	cursorTargetShape(),
	async (args) => command("cursor_move", args),
);

tool(
	server,
	"cursor_click",
	"Virtual cursor click",
	"Move the virtual cursor along a human-like path to the target, then click it with a trusted event. Target by element (selector/elementId/text) or x,y.",
	{ ...cursorTargetShape(), button: z.enum(["left", "middle", "right"]).optional() },
	async (args) => command("cursor_click", args),
);

tool(
	server,
	"cursor_double_click",
	"Virtual cursor double click",
	"Move the virtual cursor to the target and double-click it.",
	cursorTargetShape(),
	async (args) => command("cursor_double_click", args),
);

tool(
	server,
	"cursor_right_click",
	"Virtual cursor right click",
	"Move the virtual cursor to the target and right-click (context menu) it.",
	cursorTargetShape(),
	async (args) => command("cursor_right_click", args),
);

tool(
	server,
	"cursor_hover",
	"Virtual cursor hover",
	"Move the virtual cursor over the target to trigger hover effects, without clicking.",
	cursorTargetShape(),
	async (args) => command("cursor_hover", args),
);

tool(
	server,
	"cursor_drag",
	"Virtual cursor drag",
	"Press at a source element/point, move the virtual cursor along a path, and release at a target element/point (toX/toY).",
	{
		...tabParamsShape(),
		sourceSelector: z.string().optional(),
		sourceElementId: z.string().optional(),
		sourceText: z.string().optional(),
		x: z.number().optional(),
		y: z.number().optional(),
		targetSelector: z.string().optional(),
		targetElementId: z.string().optional(),
		targetText: z.string().optional(),
		toX: z.number().optional(),
		toY: z.number().optional(),
	},
	async (args) => command("cursor_drag", args),
);

tool(
	server,
	"cursor_type",
	"Virtual cursor + keyboard type",
	"Move the virtual cursor to a field (optional element/x,y target), click to focus, then type via trusted per-key events INTO THAT TAB ONLY. These key events never reach the OS, your physical keyboard, or any other tab — so the AI can type into its tab in the background while you type elsewhere with no crosstalk. Set clear to replace existing text, submit to press Enter.",
	{ ...cursorTargetShape(), textToType: z.string(), clear: z.boolean().optional(), submit: z.boolean().optional() },
	async (args) => command("cursor_type", args),
);

// --- Richer DOM / text reads (no images) -------------------------------------

tool(
	server,
	"find_element",
	"Find one element",
	"Find the single best-matching element by text, role, accessible name, or selector. Returns its stable elementId, role, name, selector, and center point — the canonical input for cursor_* tools. Token-frugal.",
	{ ...tabParamsShape(), text: z.string().optional(), role: z.string().optional(), name: z.string().optional(), selector: z.string().optional(), nth: z.number().int().min(0).optional(), includeInvisible: z.boolean().optional() },
	async (args) => command("find_element", args),
);

tool(
	server,
	"read_main_content",
	"Read main content as markdown",
	"Extract the page's primary article/content as compact markdown (headings, lists, quotes), stripping nav/aside/scripts. Preferred cheap read for articles. DOM/text only.",
	{ ...tabParamsShape(), maxLength: z.number().int().min(500).max(200000).optional() },
	async (args) => command("read_main_content", args),
);

tool(
	server,
	"read_tab",
	"Read a tab without focusing it",
	"Read a specific (possibly background) tab without activating it. mode 'text' returns visible text, 'outline' returns headings/landmarks, 'links' returns links.",
	{ ...tabParamsShape(), mode: z.enum(["text", "outline", "links"]).optional(), maxTextLength: z.number().int().min(500).max(500000).optional(), limit: z.number().int().min(1).max(500).optional() },
	async (args) => command("read_tab", args),
);

tool(
	server,
	"read_accessibility_tree",
	"Read accessibility tree",
	"Return a compact accessibility outline (role/name/value/level/childCount). Great structural, token-frugal view for non-visual navigation.",
	{ ...tabParamsShape(), maxNodes: z.number().int().min(20).max(2000).optional(), root: z.string().optional() },
	async (args) => command("read_accessibility_tree", args),
);

tool(
	server,
	"get_attributes",
	"Get element attributes",
	"Read attributes of an element. Pass names[] to limit, or omit to read all.",
	{ ...elementTargetShape(), names: z.array(z.string()).optional() },
	async (args) => command("get_attributes", args),
);

tool(
	server,
	"set_attributes",
	"Set element attributes",
	"Set or remove attributes on an element (value null removes the attribute).",
	{ ...elementTargetShape(), attributes: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])) },
	async (args) => command("set_attributes", args),
);

tool(
	server,
	"frames",
	"List page frames",
	"List the frames/iframes of the tab (frameId, url, name, depth, crossOrigin).",
	tabParamsShape(),
	async (args) => command("frames", args),
);

tool(
	server,
	"read_console",
	"Read console messages",
	"Return recent console/log messages captured for the controlled tab (level, text, ts). Enables CDP Runtime/Log domains on first use.",
	{ ...tabParamsShape(), limit: z.number().int().min(1).max(500).optional(), level: z.string().optional() },
	async (args) => command("read_console", args),
);

tool(
	server,
	"read_network",
	"Read network requests",
	"Return recent network responses captured for the controlled tab (method, url, status, type, mime). Enables the CDP Network domain on first use.",
	{ ...tabParamsShape(), limit: z.number().int().min(1).max(300).optional(), urlContains: z.string().optional() },
	async (args) => command("read_network", args),
);

tool(
	server,
	"batch",
	"Run multiple browser steps",
	"Run several browser-control steps sequentially in one call to cut round-trips and tokens. steps: [{tool, args}]. Same-tab args inherit the batch tabId. stopOnError defaults true.",
	{
		...backendShape(),
		tabId: z.union([z.number().int().positive(), z.string()]).optional(),
		steps: z.array(z.object({ tool: z.string(), args: z.record(z.any()).optional() })),
		stopOnError: z.boolean().optional(),
	},
	async (args) => runBatch(args),
);

process.on("SIGTERM", () => {
	bridgeServer?.close();
	closeDebugSocket();
	process.exit(0);
});

process.on("SIGINT", () => {
	bridgeServer?.close();
	closeDebugSocket();
	process.exit(0);
});

log(`default backend: ${DEFAULT_BACKEND}; debug endpoint: ${debugBaseUrl()}; profile: ${DEBUG_USER_DATA_DIR}`);
log(`server script: ${basename(new URL(import.meta.url).pathname)}`);

await server.connect(new StdioServerTransport());
