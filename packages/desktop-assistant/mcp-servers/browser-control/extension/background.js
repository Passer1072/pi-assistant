import {
	compactAxNodes,
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
} from "./lib.mjs";

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:17890";
// Pi assistant accent (renderer --accent) — the virtual cursor halo/ring color.
const CURSOR_THEME = "#6aa9ff";
const POLL_RETRY_MS = 1000;
const CLIENT_STORAGE_KEY = "browserMcpClientId";
const SETTINGS_STORAGE_KEY = "browserMcpSettings";

let polling = false;
let pollAbortController = null;

// --- Persistent debugger + controlled-tab state ------------------------------
// Tabs the AI has taken over keep their debugger attached for the whole control
// session (a "<extension> is debugging this browser" banner stays until release),
// so a stream of synthetic mouseMoved events never flickers attach/detach.
const attachedTabs = new Set();
const enabledDomains = new Map(); // tabId(number) -> Set(domain)
const controlledTabIds = new Set(); // tabs to re-inject cursor/marker into after navigation
const cursorPositions = new Map(); // String(tabId) -> {x,y}
const consoleBuffers = new Map(); // String(tabId) -> [entries]
const networkBuffers = new Map(); // String(tabId) -> [entries]

chrome.debugger.onEvent.addListener((source, method, params) => {
	if (source.tabId == null) return;
	const msg = { method, params };
	if (method === "Runtime.consoleAPICalled" || method === "Log.entryAdded") {
		pushRing(consoleBuffers, source.tabId, normalizeConsoleEvent(msg));
	} else if (method === "Network.responseReceived") {
		pushRing(networkBuffers, source.tabId, normalizeNetworkEvent(msg));
	}
});

chrome.debugger.onDetach.addListener((source) => {
	if (source.tabId == null) return;
	attachedTabs.delete(Number(source.tabId));
	enabledDomains.delete(Number(source.tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => {
	attachedTabs.delete(tabId);
	enabledDomains.delete(tabId);
	controlledTabIds.delete(tabId);
	cursorPositions.delete(String(tabId));
	consoleBuffers.delete(String(tabId));
	networkBuffers.delete(String(tabId));
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
	// Re-apply the cursor overlay and "AI 操作中" marker after the controlled tab navigates.
	if (info.status === "complete" && controlledTabIds.has(tabId)) {
		injectControlAssets(tabId).catch(() => {});
	}
});

chrome.runtime.onInstalled.addListener(() => {
	chrome.alarms.create("browser-mcp-poll", { periodInMinutes: 0.25 });
	void startPolling();
});

chrome.runtime.onStartup.addListener(() => {
	chrome.alarms.create("browser-mcp-poll", { periodInMinutes: 0.25 });
	void startPolling();
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === "browser-mcp-poll") void startPolling();
});

chrome.action.onClicked.addListener(() => {
	void chrome.runtime.openOptionsPage();
});

void startPolling();

async function startPolling() {
	if (polling) return;
	polling = true;
	try {
		for (;;) {
			try {
				const settings = await getSettings();
				const clientId = await getClientId();
				await register(settings, clientId);
				const job = await nextJob(settings, clientId);
				if (job) {
					await runAndPostResult(settings, clientId, job);
				}
			} catch (error) {
				await sleep(POLL_RETRY_MS);
			}
		}
	} finally {
		polling = false;
	}
}

async function getSettings() {
	const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
	const settings = stored[SETTINGS_STORAGE_KEY] || {};
	return {
		bridgeUrl: String(settings.bridgeUrl || DEFAULT_BRIDGE_URL).replace(/\/+$/, ""),
		token: String(settings.token || ""),
	};
}

async function saveSettings(settings) {
	await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
	if (pollAbortController) pollAbortController.abort();
	void startPolling();
}

async function getClientId() {
	const stored = await chrome.storage.local.get(CLIENT_STORAGE_KEY);
	const existing = stored[CLIENT_STORAGE_KEY];
	if (existing) return existing;
	const clientId = crypto.randomUUID();
	await chrome.storage.local.set({ [CLIENT_STORAGE_KEY]: clientId });
	return clientId;
}

function authHeaders(settings, extra = {}) {
	return {
		...extra,
		...(settings.token ? { "x-browser-mcp-token": settings.token } : {}),
	};
}

async function register(settings, clientId) {
	await fetch(`${settings.bridgeUrl}/extension/register`, {
		method: "POST",
		headers: authHeaders(settings, { "content-type": "application/json" }),
		body: JSON.stringify({
			clientId,
			extensionVersion: chrome.runtime.getManifest().version,
			browser: getBrowserName(),
			userAgent: navigator.userAgent,
		}),
	});
}

async function nextJob(settings, clientId) {
	pollAbortController = new AbortController();
	const url = new URL(`${settings.bridgeUrl}/extension/next`);
	url.searchParams.set("clientId", clientId);
	url.searchParams.set("extensionVersion", chrome.runtime.getManifest().version);
	url.searchParams.set("browser", getBrowserName());
	url.searchParams.set("userAgent", navigator.userAgent);
	try {
		const response = await fetch(url.toString(), {
			headers: authHeaders(settings),
			signal: pollAbortController.signal,
		});
		if (!response.ok) throw new Error(`Bridge returned HTTP ${response.status}`);
		const payload = await response.json();
		return payload.job || null;
	} finally {
		pollAbortController = null;
	}
}

async function runAndPostResult(settings, clientId, job) {
	try {
		const result = await handleJob(job.name, job.params || {});
		await postResult(settings, { clientId, jobId: job.id, ok: true, result });
	} catch (error) {
		await postResult(settings, {
			clientId,
			jobId: job.id,
			ok: false,
			error: {
				message: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			},
		});
	}
}

async function postResult(settings, payload) {
	await fetch(`${settings.bridgeUrl}/extension/result`, {
		method: "POST",
		headers: authHeaders(settings, { "content-type": "application/json" }),
		body: JSON.stringify(payload),
	});
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBrowserName() {
	const ua = navigator.userAgent;
	if (ua.includes("Edg/")) return "Microsoft Edge";
	if (ua.includes("Chrome/")) return "Google Chrome";
	return "Chromium";
}

async function handleJob(name, args) {
	switch (name) {
		case "list_tabs":
			return listTabs();
		case "active_tab":
			return activeTab();
		case "activate_tab":
			return activateTab(args);
		case "open_url":
			return openUrl(args);
		case "close_tab":
			return closeTab(args);
		case "reload":
			return reloadTab(args);
		case "go_back":
		case "go_forward":
		case "read_page":
		case "query_elements":
		case "set_value":
		case "scroll":
		case "select_option":
		case "check":
		case "wait_for":
		case "get_storage":
		case "set_storage":
		case "find_element":
		case "read_main_content":
		case "read_tab":
		case "get_attributes":
		case "set_attributes":
			return executePageCommand(name, args);
		case "take_control":
			return takeControlExt(args);
		case "release_control":
			return releaseControlExt(args);
		case "show_cursor": {
			const tabId = await getTargetTabId(args);
			await ensureCursor(tabId);
			await overlayCall(tabId, "show", []);
			return { ok: true, backend: "extension", tabId };
		}
		case "hide_cursor": {
			const tabId = await getTargetTabId(args);
			await overlayCall(tabId, "hide", []);
			return { ok: true, backend: "extension", tabId };
		}
		case "cursor_move":
		case "cursor_click":
		case "cursor_double_click":
		case "cursor_right_click":
		case "cursor_hover":
			return cursorAction(name, args);
		case "cursor_drag":
			return cursorDrag(args);
		case "cursor_type":
			return cursorType(args);
		case "read_accessibility_tree":
			return readAccessibilityTree(args);
		case "frames":
			return framesList(args);
		case "read_console":
			return readConsole(args);
		case "read_network":
			return readNetwork(args);
		case "click":
			return click(args);
		case "hover":
			return hover(args);
		case "type_text":
			return typeText(args);
		case "press_key":
			return pressKey(args);
		case "screenshot":
			return screenshot(args);
		case "evaluate_js":
			return evaluateJs(args);
		case "run_cdp_command":
			return runCdpCommand(args);
		case "get_cookies":
			return getCookies(args);
		case "set_cookie":
			return setCookie(args);
		case "delete_cookie":
			return deleteCookie(args);
		case "drag_and_drop":
			return dragAndDrop(args);
		default:
			throw new Error(`Unknown browser MCP command: ${name}`);
	}
}

async function listTabs() {
	const tabs = await chrome.tabs.query({});
	return { ok: true, backend: "extension", tabs: tabs.map(publicTab) };
}

async function activeTab() {
	const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
	if (!tab) return { ok: false, backend: "extension", message: "No active tab." };
	return { ok: true, backend: "extension", tab: publicTab(tab) };
}

async function getTargetTabId(args = {}) {
	if (args.tabId !== undefined && args.tabId !== null) return Number(args.tabId);
	// No fallback to the user's active tab — the AI must take_control of a specific
	// tab first (the MCP server resolves and injects its id). This is what lets the
	// user keep using other tabs without interfering with the AI, and vice versa.
	throw new Error("No controlled tab id. Call take_control to choose a tab to operate.");
}

function publicTab(tab) {
	return {
		id: tab.id,
		windowId: tab.windowId,
		title: tab.title,
		url: tab.url,
		active: tab.active,
		audible: tab.audible,
		muted: tab.mutedInfo?.muted,
		pinned: tab.pinned,
		status: tab.status,
		favIconUrl: tab.favIconUrl,
	};
}

async function activateTab(args) {
	const tabId = Number(args.tabId);
	const tab = await chrome.tabs.update(tabId, { active: true });
	if (tab?.windowId) await chrome.windows.update(tab.windowId, { focused: true });
	return { ok: true, backend: "extension", tab: publicTab(tab) };
}

async function openUrl(args) {
	if (args.tabId) {
		const tab = await chrome.tabs.update(Number(args.tabId), { url: args.url, active: args.active !== false });
		return { ok: true, backend: "extension", tab: publicTab(tab) };
	}
	const tab = await chrome.tabs.create({ url: args.url, active: args.active !== false });
	return { ok: true, backend: "extension", tab: publicTab(tab) };
}

async function closeTab(args) {
	await chrome.tabs.remove(Number(args.tabId));
	return { ok: true, backend: "extension", tabId: Number(args.tabId) };
}

async function reloadTab(args) {
	const tabId = await getTargetTabId(args);
	await chrome.tabs.reload(tabId, { bypassCache: args.bypassCache === true });
	return { ok: true, backend: "extension", tabId, action: "reload" };
}

async function executePageCommand(name, args) {
	const tabId = await getTargetTabId(args);
	const [result] = await chrome.scripting.executeScript({
		target: { tabId },
		func: pageCommand,
		args: [name, args],
	});
	return result?.result;
}

async function evaluateJs(args) {
	const tabId = await getTargetTabId(args);
	const world = args.world === "MAIN" ? "MAIN" : "ISOLATED";
	const [result] = await chrome.scripting.executeScript({
		target: { tabId },
		world,
		func: async (expression) => {
			return await (0, eval)(expression);
		},
		args: [args.expression],
	});
	return { ok: true, backend: "extension", result: result?.result };
}

async function clickRaw(args) {
	if (args.method === "dom") return executePageCommand("click", args);
	const tabId = await getTargetTabId(args);
	const target = await elementPoint(tabId, args);
	await sendCdp(tabId, "Input.dispatchMouseEvent", {
		type: "mouseMoved",
		x: target.point.x,
		y: target.point.y,
		button: "none",
	});
	const button = args.button || "left";
	const clickCount = args.clickCount || 1;
	await sendCdp(tabId, "Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: target.point.x,
		y: target.point.y,
		button,
		clickCount,
	});
	await sendCdp(tabId, "Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: target.point.x,
		y: target.point.y,
		button,
		clickCount,
	});
	return { ok: true, backend: "extension", action: "click", element: target.element };
}

/**
 * Default click. If the code-driven (DOM/CDP) click fails, fall back ONCE to the
 * human-like virtual cursor instead of retrying the same failing path — per the
 * "don't hammer code control, switch to the simulated mouse" policy.
 */
async function click(args) {
	try {
		return await clickRaw(args);
	} catch (error) {
		if (args._viaCursor) throw error;
		const name =
			(args.clickCount || 1) >= 2
				? "cursor_double_click"
				: args.button === "right"
					? "cursor_right_click"
					: "cursor_click";
		return cursorAction(name, { ...args, _viaCursor: true });
	}
}

async function hover(args) {
	const tabId = await getTargetTabId(args);
	const target = await elementPoint(tabId, args);
	await sendCdp(tabId, "Input.dispatchMouseEvent", {
		type: "mouseMoved",
		x: target.point.x,
		y: target.point.y,
		button: "none",
	});
	return { ok: true, backend: "extension", action: "hover", element: target.element };
}

async function typeTextRaw(args) {
	const tabId = await getTargetTabId(args);
	if (args.selector || args.elementId || args.text || args.index !== undefined) {
		await click({ ...args, method: args.method === "dom" ? "dom" : "cdp" });
	}
	if (args.method === "dom") return executePageCommand("type_text", args);
	if (args.clear) {
		await pressKey({ tabId, key: "a", modifiers: ["Ctrl"] });
		await pressKey({ tabId, key: "Backspace" });
	}
	await sendCdp(tabId, "Input.insertText", { text: String(args.textToType || "") });
	if (args.submit) await pressKey({ tabId, key: "Enter" });
	return { ok: true, backend: "extension", action: "type_text", length: String(args.textToType || "").length };
}

/** Default typing. Falls back ONCE to the virtual mouse+keyboard (cursor_type) on failure. */
async function typeText(args) {
	try {
		return await typeTextRaw(args);
	} catch (error) {
		if (args._viaCursor) throw error;
		return cursorType({ ...args, _viaCursor: true });
	}
}

async function pressKey(args) {
	const tabId = await getTargetTabId(args);
	const keyInfo = keyDefinition(args.key);
	const modifiers = modifierMask(args.modifiers || []);
	await sendCdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", modifiers, ...keyInfo });
	await sendCdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...keyInfo });
	return { ok: true, backend: "extension", action: "press_key", key: args.key, modifiers: args.modifiers || [] };
}

async function screenshot(args) {
	const tabId = await getTargetTabId(args);
	const params = {
		format: args.format || "png",
		quality: args.format === "jpeg" ? args.quality || 90 : undefined,
		fromSurface: true,
	};
	if (args.fullPage) {
		const metrics = await sendCdp(tabId, "Page.getLayoutMetrics", {});
		const size = metrics.cssContentSize || metrics.contentSize;
		if (size) {
			params.captureBeyondViewport = true;
			params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
		}
	}
	const result = await sendCdp(tabId, "Page.captureScreenshot", params);
	const mimeType = params.format === "jpeg" ? "image/jpeg" : "image/png";
	return { ok: true, backend: "extension", mimeType, dataUrl: `data:${mimeType};base64,${result.data}` };
}

async function runCdpCommand(args) {
	const tabId = await getTargetTabId(args);
	const result = await sendCdp(tabId, args.method, args.params || {});
	return { ok: true, backend: "extension", result };
}

async function getCookies(args) {
	const url = args.url || (await getTabUrl(args));
	const cookies = await chrome.cookies.getAll({ url, name: args.name });
	return { ok: true, backend: "extension", url, cookies };
}

async function setCookie(args) {
	const url = args.url || (await getTabUrl(args));
	const cookie = await chrome.cookies.set({
		url,
		name: args.name,
		value: args.value,
		domain: args.domain,
		path: args.path,
		expirationDate: args.expirationDate,
		secure: args.secure,
		httpOnly: args.httpOnly,
		sameSite: args.sameSite,
	});
	return { ok: true, backend: "extension", url, cookie };
}

async function deleteCookie(args) {
	const url = args.url || (await getTabUrl(args));
	const details = await chrome.cookies.remove({ url, name: args.name });
	return { ok: true, backend: "extension", url, details };
}

async function getTabUrl(args) {
	const tabId = await getTargetTabId(args);
	const tab = await chrome.tabs.get(tabId);
	if (!tab.url) throw new Error("Selected tab has no URL.");
	return tab.url;
}

async function dragAndDrop(args) {
	const tabId = await getTargetTabId(args);
	const source = await elementPoint(tabId, {
		selector: args.sourceSelector,
		elementId: args.sourceElementId,
		text: args.sourceText,
	});
	const target = await elementPoint(tabId, {
		selector: args.targetSelector,
		elementId: args.targetElementId,
		text: args.targetText,
	});
	await sendCdp(tabId, "Input.dispatchMouseEvent", {
		type: "mouseMoved",
		x: source.point.x,
		y: source.point.y,
		button: "none",
	});
	await sendCdp(tabId, "Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: source.point.x,
		y: source.point.y,
		button: "left",
		clickCount: 1,
	});
	await sendCdp(tabId, "Input.dispatchMouseEvent", {
		type: "mouseMoved",
		x: target.point.x,
		y: target.point.y,
		button: "left",
	});
	await sendCdp(tabId, "Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: target.point.x,
		y: target.point.y,
		button: "left",
		clickCount: 1,
	});
	return { ok: true, backend: "extension", source: source.element, target: target.element };
}

async function elementPoint(tabId, args) {
	const [result] = await chrome.scripting.executeScript({
		target: { tabId },
		func: pageCommand,
		args: ["element_point", args],
	});
	const target = result?.result;
	if (!target?.ok) throw new Error(target?.message || "Element not found.");
	return target;
}

// --- Controlled tabs, virtual cursor, and richer reads (extension backend) ---

/** Run a self-contained function in the page (ISOLATED world) and return its result. */
async function injectFunc(tabId, func, args = []) {
	const [result] = await chrome.scripting.executeScript({ target: { tabId: Number(tabId) }, func, args });
	return result?.result;
}

/** Inject (idempotently) the virtual cursor overlay and the "AI 操作中" tab marker. */
async function injectControlAssets(tabId, label) {
	await injectFunc(tabId, setupCursorOverlay, [{ label, theme: CURSOR_THEME }]);
	await injectFunc(tabId, setupTabMarker, [{}]);
}

async function ensureCursor(tabId, label) {
	const opts = { theme: CURSOR_THEME };
	if (label !== undefined) opts.label = label;
	const pos = await injectFunc(tabId, setupCursorOverlay, [opts]);
	if (pos && typeof pos.x === "number") cursorPositions.set(String(tabId), pos);
	return pos;
}

async function overlayCall(tabId, call, callArgs = []) {
	return injectFunc(tabId, cursorOverlayCall, [call, callArgs]);
}

async function cursorResolvePoint(tabId, fields) {
	if (fields.x !== undefined && fields.x !== null && fields.y !== undefined && fields.y !== null) {
		return { point: { x: Number(fields.x), y: Number(fields.y) }, element: undefined };
	}
	return elementPoint(tabId, { selector: fields.selector, elementId: fields.elementId, text: fields.text, index: fields.index });
}

/**
 * Glide the on-page cursor to a point. The overlay self-animates at 60fps in the page
 * (one glideTo call), while we dispatch trusted mouseMoved events along the same eased
 * path/time so hover effects fire and the final position is exact.
 */
async function cursorGlide(tabId, point, button = "none") {
	await ensureCursor(tabId);
	const from = cursorPositions.get(String(tabId));
	const fromPt = from && typeof from.x === "number" ? from : { x: point.x, y: point.y };
	const dist = Math.hypot(point.x - fromPt.x, point.y - fromPt.y);
	const duration = cursorDuration(dist);
	await overlayCall(tabId, "glideTo", [point.x, point.y, duration]);
	const steps = Math.max(10, Math.min(48, Math.round(duration / 18)));
	const path = cursorPath(fromPt, point, { steps });
	const stepDelay = duration / path.length;
	for (const p of path) {
		await sendCdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button });
		await sleep(stepDelay);
	}
	await overlayCall(tabId, "moveTo", [point.x, point.y]);
	cursorPositions.set(String(tabId), point);
}

async function cursorAction(name, args) {
	const tabId = await getTargetTabId(args);
	await ensureCursor(tabId);
	const target = await cursorResolvePoint(tabId, {
		selector: args.selector,
		elementId: args.elementId,
		text: args.text,
		index: args.index,
		x: args.x,
		y: args.y,
	});
	await cursorGlide(tabId, target.point);
	if (name === "cursor_move" || name === "cursor_hover") {
		return { ok: true, backend: "extension", action: name, element: target.element, point: target.point };
	}
	const button = name === "cursor_right_click" ? "right" : args.button || "left";
	const clicks = name === "cursor_double_click" ? 2 : 1;
	const { x, y } = target.point;
	for (let i = 0; i < clicks; i += 1) {
		if (i > 0) await sleep(doubleClickGap());
		await overlayCall(tabId, "press", []);
		await sendCdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i + 1 });
		await sleep(humanPressDelay());
		await sendCdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i + 1 });
		await overlayCall(tabId, "release", []);
	}
	return { ok: true, backend: "extension", action: name, element: target.element, point: target.point };
}

async function cursorDrag(args) {
	const tabId = await getTargetTabId(args);
	await ensureCursor(tabId);
	const source = await cursorResolvePoint(tabId, {
		selector: args.sourceSelector,
		elementId: args.sourceElementId,
		text: args.sourceText,
		x: args.x,
		y: args.y,
	});
	await cursorGlide(tabId, source.point);
	await overlayCall(tabId, "press", []);
	await sendCdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: source.point.x, y: source.point.y, button: "left", clickCount: 1 });
	const target = await cursorResolvePoint(tabId, {
		selector: args.targetSelector,
		elementId: args.targetElementId,
		text: args.targetText,
		x: args.toX,
		y: args.toY,
	});
	await cursorGlide(tabId, target.point, "left");
	await sendCdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: target.point.x, y: target.point.y, button: "left", clickCount: 1 });
	await overlayCall(tabId, "release", []);
	cursorPositions.set(String(tabId), target.point);
	return { ok: true, backend: "extension", source: source.element, target: target.element };
}

/**
 * Type via trusted CDP key events into the controlled tab ONLY. These events go to that
 * tab's renderer over the DevTools protocol — never to the OS, never to the user's
 * physical keyboard, and never to any other tab. So the AI can type into tab A in the
 * background while the user types into tab B (or a chat app) with zero crosstalk.
 */
async function typeViaKeys(tabId, text) {
	for (const ch of String(text)) {
		const def = ch === "\n" || ch === "\r" ? keyDefinition("Enter") : keyDefinition(ch);
		await sendCdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...def });
		await sendCdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...def });
		await sleep(humanTypeDelay());
	}
}

async function cursorType(args) {
	const tabId = await getTargetTabId(args);
	await ensureCursor(tabId);
	// Move the virtual mouse to the field and click to focus it (skip if no target given).
	if (args.selector || args.elementId || args.text || (args.x != null && args.y != null)) {
		await cursorAction("cursor_click", args);
	}
	if (args.clear) {
		await pressKey({ tabId, key: "a", modifiers: ["Ctrl"] });
		await pressKey({ tabId, key: "Delete" });
	}
	await typeViaKeys(tabId, args.textToType || "");
	if (args.submit) await pressKey({ tabId, key: "Enter" });
	return { ok: true, backend: "extension", action: "cursor_type", length: String(args.textToType || "").length };
}

async function waitForTabComplete(tabId, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
		if (!tab || tab.status === "complete" || Date.now() > deadline) return;
		await sleep(200);
	}
}

async function takeControlExt(args) {
	let tabId = args.tabId != null ? Number(args.tabId) : undefined;
	if (tabId == null) {
		const tab = await chrome.tabs.create({ url: args.url || "about:blank", active: args.active === true });
		tabId = tab.id;
		await waitForTabComplete(tabId);
	} else if (args.url) {
		await chrome.tabs.update(tabId, { url: args.url });
		await waitForTabComplete(tabId);
	}
	await ensureAttached(tabId);
	controlledTabIds.add(tabId);
	// Capture console from the start (cheap); Network stays lazy until read_network.
	try {
		await ensureDomain(tabId, "Runtime");
		await ensureDomain(tabId, "Log");
	} catch {}
	await injectControlAssets(tabId, args.label);
	const tab = await chrome.tabs.get(tabId);
	return { ok: true, backend: "extension", tabId, title: tab.title, url: tab.url };
}

async function releaseControlExt(args) {
	const tabId = Number(args.tabId);
	controlledTabIds.delete(tabId);
	cursorPositions.delete(String(tabId));
	try {
		await injectFunc(tabId, restoreTabMarker, []);
	} catch {}
	try {
		await overlayCall(tabId, "hide", []);
	} catch {}
	await detachTab(tabId);
	return { ok: true, backend: "extension", released: true, tabId };
}

async function readAccessibilityTree(args) {
	const tabId = await getTargetTabId(args);
	await ensureDomain(tabId, "Accessibility");
	const result = await sendCdp(tabId, "Accessibility.getFullAXTree", {});
	return { ok: true, backend: "extension", nodes: compactAxNodes(result.nodes || [], args.maxNodes || 400) };
}

async function framesList(args) {
	const tabId = await getTargetTabId(args);
	const tree = await sendCdp(tabId, "Page.getFrameTree", {});
	return { ok: true, backend: "extension", frames: flattenFrameTree(tree.frameTree) };
}

async function readConsole(args) {
	const tabId = await getTargetTabId(args);
	try {
		await ensureDomain(tabId, "Runtime");
		await ensureDomain(tabId, "Log");
	} catch {}
	let list = consoleBuffers.get(String(tabId)) || [];
	if (args.level) list = list.filter((entry) => entry.level === args.level);
	return { ok: true, backend: "extension", entries: list.slice(-Number(args.limit || 50)) };
}

async function readNetwork(args) {
	const tabId = await getTargetTabId(args);
	try {
		await ensureDomain(tabId, "Network");
	} catch {}
	let list = networkBuffers.get(String(tabId)) || [];
	if (args.urlContains) list = list.filter((entry) => String(entry.url).includes(args.urlContains));
	return { ok: true, backend: "extension", requests: list.slice(-Number(args.limit || 30)) };
}

async function ensureAttached(tabId) {
	const id = Number(tabId);
	if (attachedTabs.has(id)) return;
	try {
		await chrome.debugger.attach({ tabId: id }, "1.3");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/already attached/i.test(message)) throw error;
	}
	attachedTabs.add(id);
}

async function detachTab(tabId) {
	const id = Number(tabId);
	if (!attachedTabs.has(id)) return;
	attachedTabs.delete(id);
	enabledDomains.delete(id);
	try {
		await chrome.debugger.detach({ tabId: id });
	} catch {}
}

/** Enable a CDP domain once per tab (lazy — keeps the debug surface minimal). */
async function ensureDomain(tabId, domain) {
	const id = Number(tabId);
	let set = enabledDomains.get(id);
	if (!set) {
		set = new Set();
		enabledDomains.set(id, set);
	}
	if (set.has(domain)) return;
	await sendCdp(id, `${domain}.enable`, {});
	set.add(domain);
}

async function sendCdp(tabId, method, params) {
	await ensureAttached(tabId);
	return chrome.debugger.sendCommand({ tabId: Number(tabId) }, method, params);
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

function pageCommand(command, args) {
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
		)
			.trim()
			.replace(/\s+/g, " ");
	}
	function cssPath(element) {
		if (!element || element === document.documentElement) return "html";
		const parts = [];
		let current = element;
		while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
			const tag = current.tagName.toLowerCase();
			const id = current.id ? `#${CSS.escape(current.id)}` : "";
			if (id) {
				parts.unshift(tag + id);
				break;
			}
			const siblings = Array.from(current.parentElement ? current.parentElement.children : []).filter(
				(entry) => entry.tagName === current.tagName,
			);
			const index = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
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
		if (options.selector) {
			elements = Array.from(document.querySelectorAll(options.selector));
		} else {
			elements = Array.from(
				document.querySelectorAll(
					"a,button,input,textarea,select,[role],[contenteditable=true],summary,label,[onclick],h1,h2,h3,h4,h5,h6",
				),
			);
		}
		if (options.tag) elements = elements.filter((element) => element.tagName.toLowerCase() === String(options.tag).toLowerCase());
		if (options.role) {
			elements = elements.filter((element) => accessibleRole(element).toLowerCase() === String(options.role).toLowerCase());
		}
		if (options.text) {
			const needle = String(options.text).toLowerCase();
			elements = elements.filter(
				(element) =>
					elementName(element).toLowerCase().includes(needle) ||
					(element.innerText || element.textContent || "").toLowerCase().includes(needle),
			);
		}
		if (!options.includeInvisible) elements = elements.filter(visible);
		return {
			ok: true,
			backend: "extension",
			count: elements.length,
			elements: elements.slice(0, limit).map(serializeElement),
		};
	}
	function resolveElement(options) {
		ensureElementIds();
		if (options.elementId) {
			const element = document.querySelector(`[data-browser-mcp-id="${CSS.escape(String(options.elementId))}"]`);
			if (element) return { element, index: 0 };
		}
		const result = queryElements({
			selector: options.selector,
			text: options.text,
			includeInvisible: options.includeInvisible,
			limit: 500,
		});
		const index = Number(options.index || 0);
		const data = result.elements[index];
		if (!data) return { element: null, index, message: "No element matched the requested target." };
		const element = document.querySelector(`[data-browser-mcp-id="${CSS.escape(String(data.elementId))}"]`);
		return { element, index };
	}
	function setElementValue(element, value) {
		if (element.tagName === "SELECT") element.value = String(value);
		else if (element.type === "checkbox" || element.type === "radio") element.checked = Boolean(value);
		else if (element.isContentEditable) element.textContent = String(value);
		else element.value = String(value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
		element.dispatchEvent(new Event("change", { bubbles: true }));
	}
	function readPage(options) {
		ensureElementIds();
		const meta = Object.fromEntries(
			Array.from(document.querySelectorAll("meta[name],meta[property]")).map((entry) => [
				entry.getAttribute("name") || entry.getAttribute("property"),
				entry.getAttribute("content") || "",
			]),
		);
		const textSource = options.includeHiddenText ? document.body.textContent || "" : document.body.innerText || "";
		const text = textSource.trim().replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
		const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
			.map((entry) => ({ level: Number(entry.tagName.slice(1)), text: elementName(entry) }))
			.filter((entry) => entry.text);
		const links = Array.from(document.querySelectorAll("a[href]"))
			.slice(0, 300)
			.map((entry, index) => ({ index, text: elementName(entry), href: entry.href, elementId: entry.dataset.browserMcpId }));
		const images = Array.from(document.images)
			.slice(0, 200)
			.map((entry, index) => ({
				index,
				alt: entry.alt,
				src: entry.currentSrc || entry.src,
				width: entry.naturalWidth,
				height: entry.naturalHeight,
				elementId: entry.dataset.browserMcpId,
			}));
		const forms = Array.from(document.forms)
			.slice(0, 50)
			.map((form, index) => ({
				index,
				action: form.action,
				method: form.method,
				elements: Array.from(form.elements).slice(0, 100).map((element, elementIndex) => serializeElement(element, elementIndex)),
			}));
		const interactive = queryElements({ limit: 300 }).elements;
		const tables = Array.from(document.querySelectorAll("table"))
			.slice(0, 30)
			.map((table, index) => ({
				index,
				caption: table.caption ? table.caption.innerText.trim() : "",
				rows: Array.from(table.rows)
					.slice(0, 50)
					.map((row) => Array.from(row.cells).map((cell) => cell.innerText.trim())),
			}));
		return {
			ok: true,
			backend: "extension",
			title: document.title,
			url: location.href,
			readyState: document.readyState,
			language: document.documentElement.lang,
			meta,
			text: text.slice(0, options.maxTextLength || 100000),
			textLength: text.length,
			headings,
			links,
			images,
			forms,
			interactive,
			tables,
			html: options.includeHtml ? document.documentElement.outerHTML.slice(0, options.maxHtmlLength || 250000) : undefined,
			htmlLength: document.documentElement.outerHTML.length,
		};
	}

	if (command === "read_page") return readPage(args);
	if (command === "query_elements") return queryElements(args);
	if (command === "element_point") {
		const target = resolveElement(args);
		if (!target.element) return { ok: false, backend: "extension", message: target.message || "Element not found." };
		target.element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		const rect = target.element.getBoundingClientRect();
		return {
			ok: true,
			backend: "extension",
			element: serializeElement(target.element, target.index),
			point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
		};
	}
	if (command === "click") {
		const target = resolveElement(args);
		if (!target.element) return { ok: false, backend: "extension", message: target.message || "Element not found." };
		target.element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		target.element.click();
		return { ok: true, backend: "extension", action: "click", element: serializeElement(target.element, target.index) };
	}
	if (command === "type_text") {
		const target = resolveElement(args);
		if (!target.element) return { ok: false, backend: "extension", message: target.message || "Element not found." };
		if (args.clear) setElementValue(target.element, "");
		if (target.element.isContentEditable) target.element.textContent += String(args.textToType || "");
		else target.element.value = `${target.element.value || ""}${String(args.textToType || "")}`;
		target.element.dispatchEvent(new Event("input", { bubbles: true }));
		target.element.dispatchEvent(new Event("change", { bubbles: true }));
		if (args.submit) target.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		return { ok: true, backend: "extension", action: "type_text", element: serializeElement(target.element, target.index) };
	}
	if (command === "set_value") {
		const target = resolveElement(args);
		if (!target.element) return { ok: false, backend: "extension", message: target.message || "Element not found." };
		setElementValue(target.element, args.value);
		return { ok: true, backend: "extension", action: "set_value", element: serializeElement(target.element, target.index), value: args.value };
	}
	if (command === "scroll") {
		let target = null;
		if (args.selector || args.elementId || args.text || args.index !== undefined) target = resolveElement(args).element;
		const receiver = target || window;
		const direction = args.direction || "down";
		if (direction === "into_view" && target) target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		else if (direction === "top") receiver.scrollTo ? receiver.scrollTo(0, 0) : window.scrollTo(0, 0);
		else if (direction === "bottom") receiver.scrollTo ? receiver.scrollTo(0, 999999) : window.scrollTo(0, document.body.scrollHeight);
		else {
			const x = Number(args.x || (direction === "left" ? -600 : direction === "right" ? 600 : 0));
			const y = Number(args.y || (direction === "up" ? -600 : direction === "down" ? 600 : 0));
			if (receiver === window) window.scrollBy(x, y);
			else receiver.scrollBy(x, y);
		}
		return { ok: true, backend: "extension", action: "scroll", scrollX: window.scrollX, scrollY: window.scrollY };
	}
	if (command === "select_option") {
		const target = resolveElement(args);
		if (!target.element) return { ok: false, backend: "extension", message: target.message || "Element not found." };
		const select = target.element;
		if (select.tagName !== "SELECT") return { ok: false, backend: "extension", message: "Target is not a select element." };
		const options = Array.from(select.options);
		let option = null;
		if (args.value !== undefined) option = options.find((entry) => entry.value === args.value);
		if (!option && args.label !== undefined) option = options.find((entry) => entry.label === args.label || entry.textContent.trim() === args.label);
		if (!option && args.optionIndex !== undefined) option = options[args.optionIndex];
		if (!option) return { ok: false, backend: "extension", message: "Option not found." };
		select.value = option.value;
		select.dispatchEvent(new Event("input", { bubbles: true }));
		select.dispatchEvent(new Event("change", { bubbles: true }));
		return { ok: true, backend: "extension", value: select.value, label: option.textContent.trim() };
	}
	if (command === "check") {
		const target = resolveElement(args);
		if (!target.element) return { ok: false, backend: "extension", message: target.message || "Element not found." };
		if (!("checked" in target.element)) return { ok: false, backend: "extension", message: "Target is not checkable." };
		target.element.checked = args.checked === undefined ? true : Boolean(args.checked);
		target.element.dispatchEvent(new Event("input", { bubbles: true }));
		target.element.dispatchEvent(new Event("change", { bubbles: true }));
		return { ok: true, backend: "extension", checked: target.element.checked, element: serializeElement(target.element, target.index) };
	}
	if (command === "wait_for") {
		return new Promise((resolve) => {
			const deadline = Date.now() + Number(args.waitMs || 10000);
			const tick = () => {
				if (args.state && document.readyState === args.state) resolve({ ok: true, backend: "extension", state: document.readyState });
				else if (args.urlContains && location.href.includes(args.urlContains)) resolve({ ok: true, backend: "extension", url: location.href });
				else if (args.selector && document.querySelector(args.selector)) resolve({ ok: true, backend: "extension", selector: args.selector });
				else if (args.text && document.body && document.body.innerText.includes(args.text)) resolve({ ok: true, backend: "extension", text: args.text });
				else if (Date.now() >= deadline) {
					resolve({ ok: false, backend: "extension", message: "Timed out waiting for condition.", url: location.href, state: document.readyState });
				} else {
					setTimeout(tick, 200);
				}
			};
			tick();
		});
	}
	if (command === "get_storage") {
		const area = args.area || "both";
		const keys = args.keys || [];
		const read = (store) => Object.fromEntries((keys.length ? keys : Object.keys(store)).map((key) => [key, store.getItem(key)]));
		return {
			ok: true,
			backend: "extension",
			local: area === "local" || area === "both" ? read(localStorage) : undefined,
			session: area === "session" || area === "both" ? read(sessionStorage) : undefined,
		};
	}
	if (command === "set_storage") {
		const store = args.area === "session" ? sessionStorage : localStorage;
		for (const [key, value] of Object.entries(args.values || {})) store.setItem(key, String(value));
		return { ok: true, backend: "extension", area: args.area, keys: Object.keys(args.values || {}) };
	}
	if (command === "go_back") {
		history.back();
		return { ok: true, backend: "extension", action: "go_back", url: location.href };
	}
	if (command === "go_forward") {
		history.forward();
		return { ok: true, backend: "extension", action: "go_forward", url: location.href };
	}
	if (command === "find_element") {
		const result = queryElements({
			selector: args.selector,
			text: args.text,
			role: args.role,
			includeInvisible: args.includeInvisible,
			limit: 200,
		});
		let elements = result.elements;
		if (args.name) {
			const needle = String(args.name).toLowerCase();
			elements = elements.filter((entry) => (entry.name || "").toLowerCase().includes(needle));
		}
		const data = elements[Number(args.nth || 0)];
		if (!data) return { ok: false, backend: "extension", message: "No element matched the requested target." };
		const element = document.querySelector(`[data-browser-mcp-id="${CSS.escape(String(data.elementId))}"]`);
		if (element) element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		const rect = element ? element.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
		return {
			ok: true,
			backend: "extension",
			elementId: data.elementId,
			role: data.role,
			name: data.name,
			selector: data.selector,
			visible: data.visible,
			count: elements.length,
			center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
		};
	}
	if (command === "get_attributes") {
		const target = resolveElement(args);
		if (!target.element) return { ok: false, backend: "extension", message: target.message || "Element not found." };
		const element = target.element;
		const names = args.names && args.names.length ? args.names : element.getAttributeNames();
		const attributes = {};
		for (const name of names) attributes[name] = element.getAttribute(name);
		return { ok: true, backend: "extension", elementId: element.dataset.browserMcpId, attributes };
	}
	if (command === "set_attributes") {
		const target = resolveElement(args);
		if (!target.element) return { ok: false, backend: "extension", message: target.message || "Element not found." };
		const element = target.element;
		const attrs = args.attributes || {};
		for (const key of Object.keys(attrs)) {
			const value = attrs[key];
			if (value === null) element.removeAttribute(key);
			else element.setAttribute(key, String(value));
		}
		return { ok: true, backend: "extension", elementId: element.dataset.browserMcpId, attributes: attrs };
	}
	if (command === "read_main_content") {
		const maxLength = Number(args.maxLength || 40000);
		const BLOCK = "p,li,blockquote,pre,h1,h2,h3,h4,h5,h6";
		const candidates = Array.from(
			document.querySelectorAll(
				"article, main, [role=main], .article, .post, .post-content, .entry-content, .content, #content, .markdown-body, body",
			),
		);
		let best = document.body;
		let bestScore = -1;
		for (const candidate of candidates) {
			const text = (candidate.innerText || "").trim();
			const links = candidate.querySelectorAll("a").length;
			const score = text.length - links * 40;
			if (score > bestScore) {
				bestScore = score;
				best = candidate;
			}
		}
		const parts = [];
		for (const node of best.querySelectorAll(BLOCK)) {
			if (node.closest("nav,aside,footer,header,[role=navigation],[role=banner],[role=contentinfo]")) continue;
			const tag = node.tagName.toLowerCase();
			let line = (node.innerText || "").trim();
			if (!line) continue;
			if (/^h[1-6]$/.test(tag)) line = `${"#".repeat(Number(tag[1]))} ${line}`;
			else if (tag === "li") line = `- ${line}`;
			else if (tag === "blockquote") line = `> ${line}`;
			else if (tag === "pre") line = line.split("\n").map((part) => `    ${part}`).join("\n");
			parts.push(line);
		}
		let md = parts.join("\n\n");
		if (!md) md = (best.innerText || "").trim();
		md = md.slice(0, maxLength);
		const bylineEl = document.querySelector('[rel="author"], .author, .byline');
		const byline = bylineEl ? bylineEl.textContent.trim().slice(0, 120) : undefined;
		return { ok: true, backend: "extension", title: document.title, url: location.href, byline, textMarkdown: md, length: md.length };
	}
	if (command === "read_tab") {
		const mode = args.mode || "text";
		if (mode === "outline") {
			const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
				.map((entry) => ({ level: Number(entry.tagName[1]), text: (entry.innerText || "").trim().slice(0, 200) }))
				.filter((entry) => entry.text);
			const landmarks = Array.from(document.querySelectorAll("nav,main,header,footer,aside,[role]"))
				.slice(0, 80)
				.map((entry) => ({ role: entry.getAttribute("role") || entry.tagName.toLowerCase(), label: entry.getAttribute("aria-label") || "" }));
			return { ok: true, backend: "extension", title: document.title, url: location.href, headings, landmarks };
		}
		if (mode === "links") {
			const limit = Number(args.limit || 200);
			const links = Array.from(document.querySelectorAll("a[href]"))
				.slice(0, limit)
				.map((entry, index) => ({ index, text: (entry.innerText || entry.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200), href: entry.href }));
			return { ok: true, backend: "extension", count: links.length, links };
		}
		const maxTextLength = Number(args.maxTextLength || 80000);
		const text = ((document.body && document.body.innerText) || "").trim();
		return { ok: true, backend: "extension", title: document.title, url: location.href, readyState: document.readyState, text: text.slice(0, maxTextLength), textLength: text.length };
	}
	return { ok: false, backend: "extension", message: `Unsupported page command: ${command}` };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.type === "browserMcpGetSettings") {
		getSettings().then(sendResponse);
		return true;
	}
	if (message?.type === "browserMcpSaveSettings") {
		saveSettings(message.settings).then(() => sendResponse({ ok: true }));
		return true;
	}
	if (message?.type === "browserMcpStatus") {
		getSettings()
			.then(async (settings) => {
				const clientId = await getClientId();
				sendResponse({ ok: true, settings, clientId, browser: getBrowserName(), polling });
			})
			.catch((error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : String(error) }));
		return true;
	}
	return false;
});
