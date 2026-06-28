import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	app,
	BrowserWindow,
	type Event as ElectronEvent,
	ipcMain,
	net,
	type RenderProcessGoneDetails,
	type WebContentsConsoleMessageEventParams,
} from "electron";

// Override global fetch so ALL main-process requests (OpenAI SDK, deepseek.ts, etc.)
// inherit system proxy settings (VPN proxy mode, PAC scripts) via Chromium's network stack.
// Node.js built-in fetch (undici) ignores system proxy; Electron's net.fetch does not.
globalThis.fetch = (input, init?) => net.fetch(input as string, init as RequestInit);

import { DesktopAgentService } from "../agent/desktop-agent-service.ts";
import { WindowsDesktopAutomationHost } from "../desktop/automation-host.ts";
import { createSerializedDesktopHost, DesktopActionScheduler } from "../desktop/desktop-action-scheduler.ts";
import { PowerShellService } from "../desktop/powershell-service.ts";
import { readInstalledOfficeChatBridgeTokens } from "../plugins/software-plugin-manager.ts";
import type { AppLaunchCacheView } from "../shared/types.ts";
import { DESKTOP_ASSISTANT_CHANNELS } from "../shared/types.ts";
import { KwsService } from "../voice/kws-service.ts";
import { VoiceBridge } from "../voice/voice-bridge.ts";
import { BuiltInBrowserController } from "./built-in-browser-controller.ts";
import { ExternalAppController } from "./external-app-controller.ts";
import { ExternalAppRegistry } from "./external-app-registry.ts";
import { registerDesktopAssistantIpc } from "./ipc.ts";
import { LogStore } from "./log-store.ts";
import { OfficeChatBridge } from "./office-chat-bridge.ts";
import { WakeWordModelStore } from "./wake-word-model-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const windows = new Set<BrowserWindow>();
const preloadPath = join(__dirname, "preload.cjs");
let appLaunchCacheWindow: BrowserWindow | undefined;
let mcpManagerWindow: BrowserWindow | undefined;
let toolsetManagerWindow: BrowserWindow | undefined;
let pluginManagerWindow: BrowserWindow | undefined;
let personalSkillManagerWindow: BrowserWindow | undefined;
let automationEditorWindow: BrowserWindow | undefined;
let serviceLogWindow: BrowserWindow | undefined;
let sandboxSettingsWindow: BrowserWindow | undefined;
let logStore: LogStore;

type DiagnosticLevel = "debug" | "info" | "warning" | "error";

const legacyConsoleLevels: DiagnosticLevel[] = ["debug", "info", "warning", "error"];

let processDiagnosticsInstalled = false;
let isQuitting = false;

function addWindow(window: BrowserWindow, label: string): void {
	windows.add(window);
	attachWindowDiagnostics(window, label);
}

/**
 * Closing the main window shuts down the entire app: force-close every other
 * independent window (「更多应用」external app windows, built-in browser, manager
 * windows) so nothing is left running, then quit. Force `destroy()` instead of
 * `close()` so a remote page's beforeunload handler can't block the shutdown.
 */
function quitEntireApp(): void {
	if (isQuitting) return;
	isQuitting = true;
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) win.destroy();
	}
	app.quit();
}

function attachWindowDiagnostics(window: BrowserWindow, label: string): void {
	const { webContents } = window;
	webContents.on("console-message", (event, legacyLevel, legacyMessage, legacyLine, legacySourceId) => {
		const details = event as ElectronEvent<WebContentsConsoleMessageEventParams>;
		const level = details.level ?? legacyConsoleLevels[legacyLevel] ?? "info";
		const message = details.message || legacyMessage || "(empty console message)";
		const source = details.sourceId || legacySourceId || webContents.getURL();
		const lineNumber = details.lineNumber || legacyLine;
		const detail = source ? `${source}${lineNumber ? `:${lineNumber}` : ""}` : undefined;
		writeDiagnostic(level, `renderer:${label}`, message, detail);
	});
	webContents.on("preload-error", (_event, failedPreloadPath, error) => {
		writeDiagnostic("error", `renderer:${label}`, `Preload failed: ${failedPreloadPath}`, error);
	});
	webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
		if (errorCode === -3) return;
		writeDiagnostic(
			"error",
			`renderer:${label}`,
			`Load failed (${errorCode}): ${errorDescription}`,
			`${validatedURL || webContents.getURL()}${isMainFrame ? " main-frame" : ""}`,
		);
	});
	webContents.on("render-process-gone", (_event, details) => {
		writeRenderProcessGoneDiagnostic(label, details);
	});
	webContents.on("unresponsive", () => {
		writeDiagnostic("warning", `renderer:${label}`, "Window became unresponsive", webContents.getURL());
	});
	webContents.on("responsive", () => {
		writeDiagnostic("info", `renderer:${label}`, "Window became responsive", webContents.getURL());
	});
}

function writeRenderProcessGoneDiagnostic(label: string, details: RenderProcessGoneDetails): void {
	const level: DiagnosticLevel = details.reason === "clean-exit" ? "info" : "error";
	writeDiagnostic(
		level,
		`renderer:${label}`,
		`Render process gone: ${details.reason}`,
		`exitCode=${details.exitCode}`,
	);
}

function installProcessDiagnostics(): void {
	if (processDiagnosticsInstalled) return;
	processDiagnosticsInstalled = true;
	process.on("warning", (warning) => {
		writeDiagnostic("warning", "main", `Process warning: ${warning.name}`, warning);
	});
	process.on("unhandledRejection", (reason) => {
		writeDiagnostic("error", "main", "Unhandled promise rejection", reason);
	});
	process.on("uncaughtExceptionMonitor", (error) => {
		writeDiagnostic("error", "main", "Uncaught exception", error);
	});
}

function writeDiagnostic(level: DiagnosticLevel, scope: string, title: string, detail?: unknown): void {
	const normalizedDetail = normalizeDiagnosticDetail(detail);
	const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${title}`;
	if (normalizedDetail) {
		if (level === "error" || level === "warning") {
			console.error(`${line}\n${normalizedDetail}`);
		} else {
			console.log(`${line}\n${normalizedDetail}`);
		}
	} else if (level === "error" || level === "warning") {
		console.error(line);
	} else {
		console.log(line);
	}
	pushDiagnosticLog(level, scope, title, normalizedDetail);
}

function pushDiagnosticLog(level: DiagnosticLevel, scope: string, title: string, detail?: string): void {
	if (typeof logStore === "undefined") return;
	logStore.push({
		id: randomUUID(),
		ts: Date.now(),
		cat: level === "error" ? "error" : "diagnostic",
		title: `[${level}] [${scope}] ${title}`,
		detail,
	});
}

function normalizeDiagnosticDetail(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (value instanceof Error) return value.stack || value.message;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

async function createMainWindow(): Promise<BrowserWindow> {
	const window = new BrowserWindow({
		width: 440,
		height: 820,
		minWidth: 360,
		minHeight: 560,
		maxWidth: 640,
		title: "Pi 桌面助手",
		frame: false,
		transparent: false,
		backgroundColor: "#1c1c20",
		roundedCorners: true,
		hasShadow: true,
		titleBarStyle: "hidden",
		resizable: true,
		show: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: preloadPath,
		},
	});
	addWindow(window, "main");
	window.on("closed", () => {
		windows.delete(window);
		// Main window is the app's lifecycle owner: closing it tears down every
		// other independent window and quits the whole app.
		quitEntireApp();
	});

	const psService = new PowerShellService(
		join(app.getPath("userData"), "powershell-logs"),
		30_000, // default timeout: 30 seconds
	);
	// Serialize world-mutating desktop actions across parallel conversations so two
	// agents can never fight over the single shared mouse / keyboard / foreground window.
	const desktopActionScheduler = new DesktopActionScheduler();
	const agentDir = join(app.getPath("userData"), "agent");
	const service = new DesktopAgentService({
		cwd: process.cwd(),
		saveDir: join(app.getPath("userData"), "conversations"),
		agentDir,
		memoDir: join(app.getPath("userData"), "memos"),
		automationDir: join(app.getPath("userData"), "automations"),
		host: createSerializedDesktopHost(new WindowsDesktopAutomationHost(psService), desktopActionScheduler),
		openMcpManagerWindow: () => openMcpManagerWindow(),
		openPersonalSkillManagerWindow: () => openPersonalSkillManagerWindow(),
		openFlowEditorWindow: (flowId) => openFlowEditorWindow(flowId),
		sandboxRoot: join(app.getPath("userData"), "sandbox"),
		sandboxPaths: {
			home: app.getPath("home"),
			documents: app.getPath("documents"),
			desktop: app.getPath("desktop"),
			downloads: app.getPath("downloads"),
			appResources: app.getAppPath(),
		},
	});
	const builtInBrowserController = new BuiltInBrowserController({
		userDataDir: app.getPath("userData"),
		preloadPath,
		rendererDistDir: join(__dirname, "../../../renderer-dist"),
		devServerUrl: process.env.DESKTOP_ASSISTANT_DEV_SERVER_URL,
		addWindow,
		getSettings: () => service.snapshot().settings,
	});
	// Let the agent's browser_* tools drive the built-in / native browsers, routing through the
	// user's configured default browser unless a one-time override is requested.
	service.setBrowserHost(builtInBrowserController.toolHost(() => service.snapshot().settings.browser.defaultBrowser));
	// 「更多应用」: external local web apps shown in their own windows and driven by the AI.
	const externalAppController = new ExternalAppController({
		registry: new ExternalAppRegistry(agentDir),
		addWindow,
		emit: (event) => {
			for (const win of windows) {
				if (!win.isDestroyed()) win.webContents.send(DESKTOP_ASSISTANT_CHANNELS.moreAppEvent, event);
			}
		},
	});
	service.setExternalAppHost(externalAppController.toolHost());
	app.once("before-quit", () => externalAppController.dispose());
	const officeChatBridge = new OfficeChatBridge({
		port: 49240,
		getTokens: () => readInstalledOfficeChatBridgeTokens(agentDir),
		service,
	});
	void officeChatBridge.listen().catch((error: unknown) => {
		console.error("Office chat bridge failed to start:", error);
		service.reportError(error);
	});
	app.once("before-quit", () => {
		void officeChatBridge.close();
	});
	registerDesktopAssistantIpc({
		ipcMain,
		mainWindow: window,
		getWindows: () => windows,
		service,
		builtInBrowserController,
		externalAppController,
		voiceBridge: new VoiceBridge(),
		logStore,
		wakeWordModelStore: new WakeWordModelStore(join(app.getPath("userData"), "wake-word-models")),
		kwsService: new KwsService({
			modelDir: join(__dirname, "../../../resources/kws"),
			keywordsDir: join(app.getPath("userData"), "kws"),
		}),
		openAppLaunchCacheWindow: () => openAppLaunchCacheWindow(service.getAppLaunchCache()),
		openMcpManagerWindow: () => openMcpManagerWindow(),
		openToolsetManagerWindow: () => openToolsetManagerWindow(),
		openPluginManagerWindow: () => openPluginManagerWindow(),
		openPersonalSkillManagerWindow: () => openPersonalSkillManagerWindow(),
		openFlowEditorWindow: (flowId) => openFlowEditorWindow(flowId),
		openLogWindow: () => openServiceLogWindow(),
		openSandboxSettingsWindow: () => openSandboxSettingsWindow(),
	});

	if (process.env.DESKTOP_ASSISTANT_DEV_SERVER_URL) {
		await window.loadURL(process.env.DESKTOP_ASSISTANT_DEV_SERVER_URL).catch((error: unknown) => {
			void window.loadURL(fallbackDataUrl(error));
		});
	} else {
		await window.loadFile(join(__dirname, "../../../renderer-dist/index.html")).catch((error: unknown) => {
			void window.loadURL(fallbackDataUrl(error));
		});
	}
	window.show();
	void service.initialize().catch((error: unknown) => {
		console.error("Desktop assistant initialization failed:", error);
		service.reportError(error);
	});
	// Launch any "更多应用" apps the user marked auto-start (fire-and-forget).
	void externalAppController.startAutoStartApps().catch((error: unknown) => {
		console.error("Auto-start of more-apps failed:", error);
	});
	return window;
}

async function openMcpManagerWindow(): Promise<void> {
	if (mcpManagerWindow && !mcpManagerWindow.isDestroyed()) {
		mcpManagerWindow.focus();
		return;
	}
	const window = new BrowserWindow({
		width: 900,
		height: 720,
		minWidth: 720,
		minHeight: 560,
		title: "MCP Manager",
		frame: false,
		transparent: false,
		backgroundColor: "#1c1c20",
		roundedCorners: true,
		hasShadow: true,
		titleBarStyle: "hidden",
		resizable: true,
		show: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: preloadPath,
		},
	});
	mcpManagerWindow = window;
	addWindow(window, "mcp");
	window.on("closed", () => {
		windows.delete(window);
		if (mcpManagerWindow === window) mcpManagerWindow = undefined;
	});

	if (process.env.DESKTOP_ASSISTANT_DEV_SERVER_URL) {
		const url = new URL(process.env.DESKTOP_ASSISTANT_DEV_SERVER_URL);
		url.searchParams.set("window", "mcp");
		await window.loadURL(url.toString()).catch((error: unknown) => {
			void window.loadURL(fallbackDataUrl(error));
		});
	} else {
		await window
			.loadFile(join(__dirname, "../../../renderer-dist/index.html"), { query: { window: "mcp" } })
			.catch((error: unknown) => {
				void window.loadURL(fallbackDataUrl(error));
			});
	}
	window.show();
}

async function openToolsetManagerWindow(): Promise<void> {
	if (toolsetManagerWindow && !toolsetManagerWindow.isDestroyed()) {
		toolsetManagerWindow.focus();
		return;
	}
	const window = new BrowserWindow({
		width: 940,
		height: 760,
		minWidth: 760,
		minHeight: 560,
		title: "工具集",
		frame: false,
		transparent: false,
		backgroundColor: "#1c1c20",
		roundedCorners: true,
		hasShadow: true,
		titleBarStyle: "hidden",
		resizable: true,
		show: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: preloadPath,
		},
	});
	toolsetManagerWindow = window;
	addWindow(window, "toolset");
	window.on("closed", () => {
		windows.delete(window);
		if (toolsetManagerWindow === window) toolsetManagerWindow = undefined;
	});

	if (process.env.DESKTOP_ASSISTANT_DEV_SERVER_URL) {
		const url = new URL(process.env.DESKTOP_ASSISTANT_DEV_SERVER_URL);
		url.searchParams.set("window", "toolset");
		await window.loadURL(url.toString()).catch((error: unknown) => {
			void window.loadURL(fallbackDataUrl(error));
		});
	} else {
		await window
			.loadFile(join(__dirname, "../../../renderer-dist/index.html"), { query: { window: "toolset" } })
			.catch((error: unknown) => {
				void window.loadURL(fallbackDataUrl(error));
			});
	}
	window.show();
}

async function openPluginManagerWindow(): Promise<void> {
	if (pluginManagerWindow && !pluginManagerWindow.isDestroyed()) {
		pluginManagerWindow.focus();
		return;
	}
	const window = new BrowserWindow({
		width: 980,
		height: 720,
		minWidth: 760,
		minHeight: 560,
		title: "Plugin Manager",
		frame: false,
		transparent: false,
		backgroundColor: "#1c1c20",
		roundedCorners: true,
		hasShadow: true,
		titleBarStyle: "hidden",
		resizable: true,
		show: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: preloadPath,
		},
	});
	pluginManagerWindow = window;
	addWindow(window, "plugins");
	window.on("closed", () => {
		windows.delete(window);
		if (pluginManagerWindow === window) pluginManagerWindow = undefined;
	});

	if (process.env.DESKTOP_ASSISTANT_DEV_SERVER_URL) {
		const url = new URL(process.env.DESKTOP_ASSISTANT_DEV_SERVER_URL);
		url.searchParams.set("window", "plugins");
		await window.loadURL(url.toString()).catch((error: unknown) => {
			void window.loadURL(fallbackDataUrl(error));
		});
	} else {
		await window
			.loadFile(join(__dirname, "../../../renderer-dist/index.html"), { query: { window: "plugins" } })
			.catch((error: unknown) => {
				void window.loadURL(fallbackDataUrl(error));
			});
	}
	window.show();
}

async function openPersonalSkillManagerWindow(): Promise<void> {
	if (personalSkillManagerWindow && !personalSkillManagerWindow.isDestroyed()) {
		personalSkillManagerWindow.focus();
		return;
	}
	const window = new BrowserWindow({
		width: 940,
		height: 720,
		minWidth: 740,
		minHeight: 560,
		title: "Personal Skill Repository",
		frame: false,
		transparent: false,
		backgroundColor: "#1c1c20",
		roundedCorners: true,
		hasShadow: true,
		titleBarStyle: "hidden",
		resizable: true,
		show: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: preloadPath,
		},
	});
	personalSkillManagerWindow = window;
	addWindow(window, "personal-skills");
	window.on("closed", () => {
		windows.delete(window);
		if (personalSkillManagerWindow === window) personalSkillManagerWindow = undefined;
	});

	if (process.env.DESKTOP_ASSISTANT_DEV_SERVER_URL) {
		const url = new URL(process.env.DESKTOP_ASSISTANT_DEV_SERVER_URL);
		url.searchParams.set("window", "personal-skills");
		await window.loadURL(url.toString()).catch((error: unknown) => {
			void window.loadURL(fallbackDataUrl(error));
		});
	} else {
		await window
			.loadFile(join(__dirname, "../../../renderer-dist/index.html"), { query: { window: "personal-skills" } })
			.catch((error: unknown) => {
				void window.loadURL(fallbackDataUrl(error));
			});
	}
	window.show();
}

async function openFlowEditorWindow(flowId?: string): Promise<void> {
	const loadEditor = async (win: BrowserWindow): Promise<void> => {
		if (process.env.DESKTOP_ASSISTANT_DEV_SERVER_URL) {
			const url = new URL(process.env.DESKTOP_ASSISTANT_DEV_SERVER_URL);
			url.searchParams.set("window", "automation-editor");
			if (flowId) url.searchParams.set("flowId", flowId);
			await win.loadURL(url.toString()).catch((error: unknown) => {
				void win.loadURL(fallbackDataUrl(error));
			});
		} else {
			await win
				.loadFile(join(__dirname, "../../../renderer-dist/index.html"), {
					query: flowId ? { window: "automation-editor", flowId } : { window: "automation-editor" },
				})
				.catch((error: unknown) => {
					void win.loadURL(fallbackDataUrl(error));
				});
		}
	};
	if (automationEditorWindow && !automationEditorWindow.isDestroyed()) {
		automationEditorWindow.focus();
		// Always reload so the editor re-mounts fresh (blank draft + brand-new design chat).
		await loadEditor(automationEditorWindow);
		return;
	}
	const window = new BrowserWindow({
		width: 1200,
		height: 820,
		minWidth: 960,
		minHeight: 640,
		title: "Automation Editor",
		frame: false,
		transparent: false,
		backgroundColor: "#1c1c20",
		roundedCorners: true,
		hasShadow: true,
		titleBarStyle: "hidden",
		resizable: true,
		show: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: preloadPath,
		},
	});
	automationEditorWindow = window;
	addWindow(window, "automation-editor");
	window.on("closed", () => {
		windows.delete(window);
		if (automationEditorWindow === window) automationEditorWindow = undefined;
	});

	await loadEditor(window);
	window.show();
}

async function openAppLaunchCacheWindow(cache: AppLaunchCacheView): Promise<void> {
	if (appLaunchCacheWindow && !appLaunchCacheWindow.isDestroyed()) {
		appLaunchCacheWindow.focus();
		await appLaunchCacheWindow.loadURL(appLaunchCacheDataUrl(cache));
		return;
	}
	const window = new BrowserWindow({
		width: 760,
		height: 680,
		minWidth: 620,
		minHeight: 520,
		title: "App Launch Memory",
		frame: false,
		transparent: false,
		backgroundColor: "#1c1c20",
		roundedCorners: true,
		hasShadow: true,
		titleBarStyle: "hidden",
		resizable: true,
		show: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: preloadPath,
		},
	});
	appLaunchCacheWindow = window;
	addWindow(window, "app-launch-cache");
	window.on("closed", () => {
		windows.delete(window);
		if (appLaunchCacheWindow === window) appLaunchCacheWindow = undefined;
	});
	await window.loadURL(appLaunchCacheDataUrl(cache));
	window.show();
}

async function openSandboxSettingsWindow(): Promise<void> {
	if (sandboxSettingsWindow && !sandboxSettingsWindow.isDestroyed()) {
		sandboxSettingsWindow.focus();
		return;
	}
	const window = new BrowserWindow({
		width: 680,
		height: 780,
		minWidth: 560,
		minHeight: 560,
		title: "沙箱设置",
		frame: false,
		transparent: false,
		backgroundColor: "#1c1c20",
		roundedCorners: true,
		hasShadow: true,
		titleBarStyle: "hidden",
		resizable: true,
		show: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: preloadPath,
		},
	});
	sandboxSettingsWindow = window;
	addWindow(window, "sandbox-settings");
	window.on("closed", () => {
		windows.delete(window);
		if (sandboxSettingsWindow === window) sandboxSettingsWindow = undefined;
	});

	if (process.env.DESKTOP_ASSISTANT_DEV_SERVER_URL) {
		const url = new URL(process.env.DESKTOP_ASSISTANT_DEV_SERVER_URL);
		url.searchParams.set("window", "sandbox");
		await window.loadURL(url.toString()).catch((error: unknown) => {
			void window.loadURL(fallbackDataUrl(error));
		});
	} else {
		await window
			.loadFile(join(__dirname, "../../../renderer-dist/index.html"), { query: { window: "sandbox" } })
			.catch((error: unknown) => {
				void window.loadURL(fallbackDataUrl(error));
			});
	}
	window.show();
}

async function openServiceLogWindow(): Promise<void> {
	if (serviceLogWindow && !serviceLogWindow.isDestroyed()) {
		serviceLogWindow.focus();
		return;
	}
	const win = new BrowserWindow({
		width: 900,
		height: 680,
		minWidth: 640,
		minHeight: 480,
		title: "服务日志",
		frame: false,
		transparent: false,
		backgroundColor: "#1c1c20",
		roundedCorners: true,
		hasShadow: true,
		titleBarStyle: "hidden",
		resizable: true,
		show: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: preloadPath,
		},
	});
	serviceLogWindow = win;
	addWindow(win, "service-log");

	// Push new entries to this window in real time.
	const unsubscribe = logStore.subscribe((entry) => {
		if (!win.isDestroyed()) {
			win.webContents.send(DESKTOP_ASSISTANT_CHANNELS.logEvent, entry);
		}
	});

	win.on("closed", () => {
		unsubscribe();
		windows.delete(win);
		if (serviceLogWindow === win) serviceLogWindow = undefined;
	});
	await win.loadURL(serviceLogDataUrlStable(logStore.logFilePath));
	win.show();
}

function serviceLogDataUrlStable(logFilePath: string): string {
	const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Service Log</title>
<style>
:root {
  --bg: #1c1c20; --bg-soft: rgba(255,255,255,.06); --bg-hover: rgba(255,255,255,.10);
  --stroke: rgba(255,255,255,.08); --fg: #f4f5f7; --fg-dim: #c8c9cf;
  --fg-mute: #8c8d94; --accent: #6aa9ff; --danger: #ff7676; color-scheme: dark;
  font-family: "Segoe UI Variable","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
body{height:100vh;display:flex;flex-direction:column;color:var(--fg);
  background:radial-gradient(circle at 75% 15%,rgba(106,169,255,.14),transparent 30%),
             radial-gradient(circle at 20% 85%,rgba(74,222,128,.10),transparent 28%),
             var(--bg);overflow:hidden}
button{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}
.titlebar{height:46px;display:flex;align-items:center;gap:8px;padding:0 12px;
  border-bottom:1px solid var(--stroke);background:rgba(20,20,24,.82);
  -webkit-app-region:drag;flex-shrink:0}
.title-icon{font-size:14px;color:var(--accent)}
.title-label{font-size:13px;font-weight:600;color:var(--fg-dim);flex:1}
.log-path{font-family:"Cascadia Code",Consolas,monospace;font-size:10px;color:var(--fg-mute);
  max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.count-badge{font-size:11px;font-weight:700;padding:2px 7px;border-radius:999px;
  background:rgba(106,169,255,.18);color:var(--accent);border:1px solid rgba(106,169,255,.28)}
.win-btns{display:flex;gap:4px;-webkit-app-region:no-drag}
.win-btn{width:28px;height:28px;display:grid;place-items:center;border-radius:8px;
  color:var(--fg-mute);font-size:14px}
.win-btn:hover{background:var(--bg-hover);color:var(--fg)}
.win-btn.danger:hover{background:rgba(255,118,118,.18);color:var(--danger)}
.toolbar{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--stroke);flex-shrink:0;flex-wrap:wrap}
.tool-chip{height:26px;padding:0 10px;border-radius:8px;font-size:11px;font-weight:600;color:var(--fg-mute);border:1px solid var(--stroke);letter-spacing:.03em;-webkit-app-region:no-drag}
.tool-chip:hover{background:var(--bg-hover);color:var(--fg)}
.tool-chip.active{background:rgba(106,169,255,.16);color:var(--accent);border-color:rgba(106,169,255,.3)}
.tool-chip.danger{color:var(--danger);border-color:rgba(255,118,118,.28);background:rgba(255,118,118,.10)}
.tool-chip[hidden]{display:none}
.spacer{flex:1}
.pet-panel{display:grid;grid-template-columns:minmax(0,1.4fr) repeat(3,minmax(110px,.6fr));gap:8px;padding:10px 12px;border-bottom:1px solid var(--stroke);background:rgba(0,0,0,.12);flex-shrink:0}
.pet-panel[hidden]{display:none}
.pet-card{border:1px solid var(--stroke);border-radius:8px;background:rgba(255,255,255,.045);padding:8px 10px;min-width:0}
.pet-card span{display:block;font-size:10px;font-weight:700;letter-spacing:.08em;color:var(--fg-mute);text-transform:uppercase;margin-bottom:4px}
.pet-card strong{display:block;font-size:12.5px;color:var(--fg-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pet-card code{font-family:"Cascadia Code",Consolas,monospace;font-size:11px;color:var(--fg-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
.log-wrap{flex:1;overflow-y:auto;padding:8px 10px;display:block}
.empty-hint{color:var(--fg-mute);font-size:13px;text-align:center;padding:40px 0;margin:auto}
.log-row{border-radius:8px;overflow:hidden;margin-bottom:2px;min-height:26px}
.row-main{display:flex;align-items:baseline;gap:8px;padding:5px 8px;border-radius:8px;cursor:default}
.row-main.clickable{cursor:pointer}
.row-main.clickable:hover{background:var(--bg-soft)}
.ts{font-family:"Cascadia Code",Consolas,monospace;font-size:10.5px;color:var(--fg-mute);white-space:nowrap;flex-shrink:0}
.badge{font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px;border:1px solid;white-space:nowrap;flex-shrink:0;letter-spacing:.06em}
.row-title{font-size:12.5px;color:var(--fg-dim);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.expand-icon{font-size:10px;color:var(--fg-mute);flex-shrink:0;width:14px;text-align:center}
.row-detail{padding:4px 8px 8px calc(8px + 14px + 8px + 52px + 8px);display:none}
.row-detail.open{display:block}
.row-detail pre{font-family:"Cascadia Code",Consolas,monospace;font-size:11px;line-height:1.5;color:var(--fg-dim);white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.28);border-radius:6px;padding:8px 10px;border:1px solid var(--stroke);max-height:320px;overflow-y:auto}
.cat-user .badge{color:#6aa9ff;border-color:rgba(106,169,255,.3);background:rgba(106,169,255,.12)}
.cat-ai .badge{color:#4ade80;border-color:rgba(74,222,128,.3);background:rgba(74,222,128,.12)}
.cat-tool_call .badge{color:#fb923c;border-color:rgba(251,146,60,.3);background:rgba(251,146,60,.12)}
.cat-tool_result .badge{color:#a3e635;border-color:rgba(163,230,53,.3);background:rgba(163,230,53,.12)}
.cat-think .badge{color:#c084fc;border-color:rgba(192,132,252,.3);background:rgba(192,132,252,.12)}
.cat-diagnostic .badge{color:#38bdf8;border-color:rgba(56,189,248,.32);background:rgba(56,189,248,.12)}
.cat-system .badge{color:#94a3b8;border-color:rgba(148,163,184,.28);background:rgba(148,163,184,.10)}
.cat-error .badge{color:#ff7676;border-color:rgba(255,118,118,.3);background:rgba(255,118,118,.12)}
.cat-abort .badge{color:#fbbf24;border-color:rgba(251,191,36,.3);background:rgba(251,191,36,.12)}
.cat-retry .badge{color:#f97316;border-color:rgba(249,115,22,.3);background:rgba(249,115,22,.12)}
.cat-pet .badge{color:#f472b6;border-color:rgba(244,114,182,.34);background:rgba(244,114,182,.13)}
</style>
</head>
<body>
<div class="titlebar">
  <span class="title-icon">*</span>
  <span class="title-label">Service Log</span>
  <span class="log-path" title="${escapeHtml(logFilePath)}">${escapeHtml(logFilePath)}</span>
  <span class="count-badge" id="cnt">0</span>
  <div class="win-btns">
    <button class="win-btn" id="autoScrollBtn" title="Auto scroll enabled">A</button>
    <button class="win-btn" onclick="window.desktopAssistant.minimizeWindow()" aria-label="Minimize">-</button>
    <button class="win-btn danger" onclick="window.desktopAssistant.closeWindow()" aria-label="Close">x</button>
  </div>
</div>
<div class="toolbar">
  <button class="tool-chip active" data-f="" onclick="setFilter(this,'')">ALL</button>
  <button class="tool-chip" data-f="user" onclick="setFilter(this,'user')">USER</button>
  <button class="tool-chip" data-f="ai" onclick="setFilter(this,'ai')">AI</button>
  <button class="tool-chip" data-f="tool_call" onclick="setFilter(this,'tool_call')">TOOL&gt;</button>
  <button class="tool-chip" data-f="tool_result" onclick="setFilter(this,'tool_result')">TOOL&lt;</button>
  <button class="tool-chip" data-f="think" onclick="setFilter(this,'think')">THINK</button>
  <button class="tool-chip" data-f="diagnostic" onclick="setFilter(this,'diagnostic')">DIAG</button>
  <button class="tool-chip" data-f="system" onclick="setFilter(this,'system')">SYS</button>
  <button class="tool-chip" data-f="error" onclick="setFilter(this,'error')">ERROR</button>
  <button class="tool-chip" id="petFilterBtn" data-f="pet" onclick="setFilter(this,'pet')" hidden>PET</button>
  <div class="spacer"></div>
  <button class="tool-chip" id="petLogToggle" onclick="togglePetLogs()" aria-pressed="false">CAT LOGS OFF</button>
  <button class="tool-chip danger" onclick="clearLog()">CLEAR</button>
</div>
<div class="pet-panel" id="petPanel" hidden>
  <div class="pet-card"><span>Cat State</span><strong id="petState">Waiting for pet state...</strong></div>
  <div class="pet-card"><span>Reason</span><code id="petReason">-</code></div>
  <div class="pet-card"><span>Target</span><code id="petTarget">-</code></div>
  <div class="pet-card"><span>Position</span><code id="petPosition">-</code></div>
</div>
<div class="log-wrap" id="logWrap"><div class="empty-hint" id="emptyHint">Waiting for events...</div></div>
<script>
// F2: bound the in-window log buffer. The full log is always on disk
// (session-*.ndjson via LogStore); the window only keeps the most recent
// MAX_LOG_ENTRIES and drops the oldest. rerender() rebuilds the DOM from the
// entries array, so capping the array also bounds the rendered node count.
var MAX_LOG_ENTRIES = 2000;
var entries = [];
var filter = '';
var autoScroll = true;
var expandedRows = new Set();
var BOTTOM_FOLLOW_PX = 24;
var PET_LOG_STORAGE_KEY = 'pi-service-log-show-pet';
var showPetLogs = readShowPetLogs();
var catLabel = { user:'USER', ai:'AI', tool_call:'TOOL>', tool_result:'TOOL<', think:'THINK', diagnostic:'DIAG', system:'SYS', error:'ERROR', abort:'ABORT', retry:'RETRY', pet:'PET' };
function readShowPetLogs() {
  try { return localStorage.getItem(PET_LOG_STORAGE_KEY) === 'true'; } catch (_) { return false; }
}
function persistShowPetLogs() {
  try { localStorage.setItem(PET_LOG_STORAGE_KEY, showPetLogs ? 'true' : 'false'); } catch (_) {}
}
function getLogWrap() {
  return document.getElementById('logWrap');
}
function isNearBottom(wrap) {
  if (!wrap) return true;
  return wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight <= BOTTOM_FOLLOW_PX;
}
function scrollToBottom() {
  var wrap = getLogWrap();
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}
function updateAutoScrollButton() {
  if (!autoScrollBtn) return;
  autoScrollBtn.style.color = autoScroll ? '#6aa9ff' : '';
  autoScrollBtn.title = autoScroll ? 'Auto scroll enabled' : 'Auto scroll disabled';
}
function setAutoScroll(enabled) {
  autoScroll = enabled;
  updateAutoScrollButton();
}
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtTime(ts) {
  var d = new Date(ts);
  return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0')+'.'+String(d.getMilliseconds()).padStart(3,'0');
}
function appendThinkingText(current, next) {
  var piece = String(next || '').trim();
  if (!piece) return current;
  if (!current) return piece;
  if (/^[.,;:!?)]/.test(piece) || piece.charAt(0) === '-' || /[(]$/.test(current)) return current + piece;
  return current + ' ' + piece;
}
function compactThinkingTitle(text) {
  var compact = String(text || '').replace(/\\s+/g, ' ').trim();
  if (!compact) return 'Thinking';
  return compact.length > 140 ? compact.slice(0, 137) + '...' : compact;
}
function groupThinkingEntries(list) {
  var grouped = [];
  var active = null;
  function flush() {
    if (!active) return;
    active.title = compactThinkingTitle(active.detail);
    grouped.push(active);
    active = null;
  }
  list.forEach(function(entry) {
    if (entry.cat !== 'think') {
      flush();
      grouped.push(entry);
      return;
    }
    var text = entry.detail || entry.title || '';
    if (!active || entry.ts - active.ts > 3000) {
      flush();
      active = { id: 'think-group-' + entry.id, ts: entry.ts, cat: 'think', title: 'Thinking', detail: '' };
    }
    active.detail = appendThinkingText(active.detail, text);
  });
  flush();
  return grouped;
}
function visibleEntries() {
  var source = showPetLogs ? entries : entries.filter(function(e){ return e.cat !== 'pet'; });
  source = filter ? source.filter(function(e){ return e.cat === filter; }) : source;
  return groupThinkingEntries(source);
}
function renderRow(e) {
  var wrap = document.getElementById('logWrap');
  var hint = document.getElementById('emptyHint');
  if (hint) hint.remove();
  var hasDetail = e.detail && e.detail.trim();
  var eid = 'e_' + String(e.id).replace(/[^a-zA-Z0-9_-]/g, '_');
  var label = catLabel[e.cat] || String(e.cat || 'unknown').toUpperCase();

  var row = document.createElement('div');
  row.className = 'log-row cat-' + e.cat;

  var main = document.createElement('div');
  main.className = 'row-main' + (hasDetail ? ' clickable' : '');

  var ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = fmtTime(e.ts);
  main.appendChild(ts);

  var badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = label;
  main.appendChild(badge);

  var title = document.createElement('span');
  title.className = 'row-title';
  title.textContent = e.title || '(untitled)';
  main.appendChild(title);

  if (hasDetail) {
    var icon = document.createElement('span');
    icon.className = 'expand-icon';
    icon.id = eid + '_ic';
    icon.textContent = expandedRows.has(eid) ? 'v' : '>';
    main.appendChild(icon);
  }
  row.appendChild(main);

  if (hasDetail) {
    var detail = document.createElement('div');
    detail.className = 'row-detail' + (expandedRows.has(eid) ? ' open' : '');
    detail.id = eid;
    var pre = document.createElement('pre');
    pre.textContent = e.detail;
    detail.appendChild(pre);
    row.appendChild(detail);
    main.addEventListener('click', function() { tog(eid); });
  }

  wrap.appendChild(row);
}
function tog(id) {
  var el = document.getElementById(id);
  var ic = document.getElementById(id + '_ic');
  if (!el) return;
  var open = el.classList.toggle('open');
  if (open) expandedRows.add(id);
  else expandedRows.delete(id);
  if (ic) ic.textContent = open ? 'v' : '>';
}
function rerender(forceBottom) {
  var wrap = getLogWrap();
  var previousTop = wrap ? wrap.scrollTop : 0;
  var shouldFollow = Boolean(forceBottom) || (autoScroll && isNearBottom(wrap));
  if (wrap && autoScroll && !shouldFollow) setAutoScroll(false);
  wrap.innerHTML = '';
  var list = visibleEntries();
  document.getElementById('cnt').textContent = String(list.length);
  if (!list.length) {
    wrap.innerHTML = '<div class="empty-hint" id="emptyHint">' + (filter ? 'No matching events.' : 'Waiting for events...') + '</div>';
    return;
  }
  list.forEach(renderRow);
  if (shouldFollow) scrollToBottom();
  else if (wrap) wrap.scrollTop = previousTop;
}
function appendEntry(e) {
  entries.push(e);
  if (entries.length > MAX_LOG_ENTRIES) entries.splice(0, entries.length - MAX_LOG_ENTRIES);
  rerender();
}
function setFilter(btn, f) {
  if (f === 'pet' && !showPetLogs) return;
  filter = f;
  document.querySelectorAll('.tool-chip[data-f]').forEach(function(b){ b.classList.remove('active'); });
  btn.classList.add('active');
  rerender();
}
function clearLog() {
  entries = [];
  expandedRows.clear();
  rerender();
}
function applyPetLogVisibility() {
  var toggle = document.getElementById('petLogToggle');
  var petFilter = document.getElementById('petFilterBtn');
  var petPanel = document.getElementById('petPanel');
  if (toggle) {
    toggle.textContent = showPetLogs ? 'CAT LOGS ON' : 'CAT LOGS OFF';
    toggle.classList.toggle('active', showPetLogs);
    toggle.setAttribute('aria-pressed', showPetLogs ? 'true' : 'false');
  }
  if (petFilter) petFilter.hidden = !showPetLogs;
  if (petPanel) petPanel.hidden = !showPetLogs;
  if (!showPetLogs && filter === 'pet') {
    filter = '';
    document.querySelectorAll('.tool-chip[data-f]').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-f') === ''); });
  }
}
function togglePetLogs() {
  showPetLogs = !showPetLogs;
  persistShowPetLogs();
  applyPetLogVisibility();
  rerender();
  if (showPetLogs) refreshPetDebug();
}
function fmtNumber(value) {
  return typeof value === 'number' && isFinite(value) ? String(Math.round(value * 10) / 10) : '-';
}
function updatePetPanel(snapshot) {
  var state = document.getElementById('petState');
  var reason = document.getElementById('petReason');
  var target = document.getElementById('petTarget');
  var position = document.getElementById('petPosition');
  if (!state || !reason || !target || !position) return;
  if (!snapshot) {
    state.textContent = 'No pet debug data yet';
    reason.textContent = '-';
    target.textContent = '-';
    position.textContent = '-';
    return;
  }
  var staleMs = Date.now() - Number(snapshot.updatedAt || 0);
  var stale = staleMs > 2500 ? ' stale ' + Math.round(staleMs / 1000) + 's' : '';
  state.textContent = snapshot.enabled
    ? '猫：' + (snapshot.behaviorLabel || snapshot.behavior || '未知') + stale
    : '猫：' + (snapshot.behaviorLabel || '已关闭');
  reason.textContent = snapshot.behaviorStartReason || '-';
  target.textContent = snapshot.behaviorTarget || '-';
  var pos = snapshot.position;
  var vel = snapshot.velocity;
  position.textContent = pos
    ? 'x=' + fmtNumber(pos.x) + ', y=' + fmtNumber(pos.y) + '; vx=' + fmtNumber(vel && vel.x) + ', vy=' + fmtNumber(vel && vel.y)
    : '-';
}
function refreshPetDebug() {
  if (!showPetLogs) return;
  if (!window.desktopAssistant || !window.desktopAssistant.getPetDebug) return;
  window.desktopAssistant.getPetDebug().then(updatePetPanel).catch(function(error) {
    updatePetPanel({ enabled: false, updatedAt: Date.now(), behaviorLabel: 'debug load failed', behaviorStartReason: String(error) });
  });
}
var autoScrollBtn = document.getElementById('autoScrollBtn');
autoScrollBtn.addEventListener('click', function() {
  setAutoScroll(!autoScroll);
  if (autoScroll) scrollToBottom();
});
updateAutoScrollButton();
var logWrap = getLogWrap();
if (logWrap) {
  logWrap.addEventListener('scroll', function() {
    setAutoScroll(isNearBottom(logWrap));
  }, { passive: true });
}
applyPetLogVisibility();
if (window.desktopAssistant) {
  if (window.desktopAssistant.getLogEntries) {
    window.desktopAssistant.getLogEntries().then(function(existing) {
      entries = existing.slice();
      rerender(true);
    }).catch(function(error) {
      appendEntry({ id: 'log-load-error', ts: Date.now(), cat: 'error', title: 'Failed to load log entries', detail: String(error) });
    });
  }
  if (window.desktopAssistant.onLogEvent) {
    window.desktopAssistant.onLogEvent(appendEntry);
  }
  refreshPetDebug();
  setInterval(refreshPetDebug, 1000);
  if (window.desktopAssistant.onPetDebugEvent) {
    window.desktopAssistant.onPetDebugEvent(refreshPetDebug);
  }
} else {
  appendEntry({ id: 'missing-api', ts: Date.now(), cat: 'error', title: 'desktopAssistant preload API is unavailable' });
}
</script>
</body>
</html>`;
	return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function _serviceLogDataUrl(logFilePath: string): string {
	const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>服务日志</title>
<style>
:root {
  --bg: #1c1c20; --bg-strong: #24242a; --bg-soft: rgba(255,255,255,.06);
  --bg-hover: rgba(255,255,255,.10); --stroke: rgba(255,255,255,.08);
  --stroke-strong: rgba(255,255,255,.14); --fg: #f4f5f7; --fg-dim: #c8c9cf;
  --fg-mute: #8c8d94; --accent: #6aa9ff; --danger: #ff7676;
  color-scheme: dark;
  font-family: "Segoe UI Variable","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
body{height:100vh;display:flex;flex-direction:column;color:var(--fg);
  background:radial-gradient(circle at 75% 15%,rgba(106,169,255,.14),transparent 30%),
             radial-gradient(circle at 20% 85%,rgba(74,222,128,.10),transparent 28%),
             var(--bg);overflow:hidden}
button{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}

/* Titlebar */
.titlebar{height:46px;display:flex;align-items:center;gap:8px;padding:0 12px;
  border-bottom:1px solid var(--stroke);background:rgba(20,20,24,.82);
  -webkit-app-region:drag;flex-shrink:0}
.title-icon{font-size:14px;color:var(--accent)}
.title-label{font-size:13px;font-weight:600;color:var(--fg-dim);flex:1}
.log-path{font-family:"Cascadia Code",Consolas,monospace;font-size:10px;color:var(--fg-mute);
  max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:default}
.count-badge{font-size:11px;font-weight:700;padding:2px 7px;border-radius:999px;
  background:rgba(106,169,255,.18);color:var(--accent);border:1px solid rgba(106,169,255,.28)}
.win-btns{display:flex;gap:4px;-webkit-app-region:no-drag}
.win-btn{width:28px;height:28px;display:grid;place-items:center;border-radius:8px;
  color:var(--fg-mute);font-size:14px}
.win-btn:hover{background:var(--bg-hover);color:var(--fg)}
.win-btn.danger:hover{background:rgba(255,118,118,.18);color:var(--danger)}
.toolbar{display:flex;align-items:center;gap:6px;padding:8px 12px;
  border-bottom:1px solid var(--stroke);flex-shrink:0;flex-wrap:wrap}
.tool-chip{height:26px;padding:0 10px;border-radius:8px;font-size:11px;font-weight:600;
  color:var(--fg-mute);border:1px solid var(--stroke);letter-spacing:.03em;
  -webkit-app-region:no-drag}
.tool-chip:hover{background:var(--bg-hover);color:var(--fg)}
.tool-chip.active{background:rgba(106,169,255,.16);color:var(--accent);
  border-color:rgba(106,169,255,.3)}
.tool-chip.danger{color:var(--danger);border-color:rgba(255,118,118,.28);
  background:rgba(255,118,118,.10)}
.tool-chip.danger:hover{background:rgba(255,118,118,.20)}
.spacer{flex:1}

/* Log area */
.log-wrap{flex:1;overflow-y:auto;padding:8px 10px;display:flex;flex-direction:column;gap:2px}
.log-wrap::-webkit-scrollbar{width:6px}
.log-wrap::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:999px}
.empty-hint{color:var(--fg-mute);font-size:13px;text-align:center;padding:40px 0;margin:auto}

/* Log row */
.log-row{border-radius:8px;overflow:hidden}
.row-main{display:flex;align-items:baseline;gap:8px;padding:5px 8px;
  border-radius:8px;cursor:default}
.row-main.clickable{cursor:pointer}
.row-main.clickable:hover{background:var(--bg-soft)}
.ts{font-family:"Cascadia Code",Consolas,monospace;font-size:10.5px;
  color:var(--fg-mute);white-space:nowrap;flex-shrink:0}
.badge{font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px;
  border:1px solid;white-space:nowrap;flex-shrink:0;letter-spacing:.06em}
.row-title{font-size:12.5px;color:var(--fg-dim);flex:1;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.expand-icon{font-size:10px;color:var(--fg-mute);flex-shrink:0;width:14px;text-align:center}
.row-detail{padding:4px 8px 8px calc(8px + 14px + 8px + 52px + 8px);display:none}
.row-detail.open{display:block}
.row-detail pre{
  font-family:"Cascadia Code",Consolas,monospace;font-size:11px;
  line-height:1.5;color:var(--fg-dim);white-space:pre-wrap;word-break:break-all;
  background:rgba(0,0,0,.28);border-radius:6px;padding:8px 10px;
  border:1px solid var(--stroke);max-height:320px;overflow-y:auto}
.row-detail pre::-webkit-scrollbar{width:5px}
.row-detail pre::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:999px}

/* Category colors */
.cat-user   .badge{color:#6aa9ff;border-color:rgba(106,169,255,.3);background:rgba(106,169,255,.12)}
.cat-ai     .badge{color:#4ade80;border-color:rgba(74,222,128,.3);background:rgba(74,222,128,.12)}
.cat-tool_call  .badge{color:#fb923c;border-color:rgba(251,146,60,.3);background:rgba(251,146,60,.12)}
.cat-tool_result .badge{color:#a3e635;border-color:rgba(163,230,53,.3);background:rgba(163,230,53,.12)}
.cat-think  .badge{color:#c084fc;border-color:rgba(192,132,252,.3);background:rgba(192,132,252,.12)}
.cat-system .badge{color:#94a3b8;border-color:rgba(148,163,184,.28);background:rgba(148,163,184,.10)}
.cat-error  .badge{color:#ff7676;border-color:rgba(255,118,118,.3);background:rgba(255,118,118,.12)}
.cat-abort  .badge{color:#fbbf24;border-color:rgba(251,191,36,.3);background:rgba(251,191,36,.12)}
.cat-retry  .badge{color:#f97316;border-color:rgba(249,115,22,.3);background:rgba(249,115,22,.12)}
</style>
</head>
<body>
<div class="titlebar">
  <span class="title-icon">◈</span>
  <span class="title-label">服务日志</span>
  <span class="log-path" title="${escapeHtml(logFilePath)}">${escapeHtml(logFilePath)}</span>
  <span class="count-badge" id="cnt">0</span>
  <div class="win-btns">
    <button class="win-btn" id="autoScrollBtn" title="自动滚动到底部（已开启）">↓</button>
    <button class="win-btn" onclick="window.desktopAssistant.minimizeWindow()" aria-label="最小化">−</button>
    <button class="win-btn danger" onclick="window.desktopAssistant.closeWindow()" aria-label="关闭">×</button>
  </div>
</div>

<div class="toolbar">
  <button class="tool-chip active" data-f="" onclick="setFilter(this,'')">全部</button>
  <button class="tool-chip" data-f="user" onclick="setFilter(this,'user')">USER</button>
  <button class="tool-chip" data-f="ai" onclick="setFilter(this,'ai')">AI</button>
  <button class="tool-chip" data-f="tool_call" onclick="setFilter(this,'tool_call')">TOOL→</button>
  <button class="tool-chip" data-f="tool_result" onclick="setFilter(this,'tool_result')">TOOL←</button>
  <button class="tool-chip" data-f="think" onclick="setFilter(this,'think')">THINK</button>
  <button class="tool-chip" data-f="system" onclick="setFilter(this,'system')">SYS</button>
  <button class="tool-chip" data-f="error" onclick="setFilter(this,'error')">ERROR</button>
  <div class="spacer"></div>
  <button class="tool-chip danger" onclick="clearLog()">清空</button>
</div>

<div class="log-wrap" id="logWrap">
  <div class="empty-hint" id="emptyHint">等待事件…</div>
</div>

<script>
// F2: bound the in-window log buffer. The full log is always on disk
// (session-*.ndjson via LogStore); the window keeps only the most recent
// MAX_LOG_ENTRIES. This window appends rows incrementally, so we evict both the
// oldest array entries and the oldest DOM rows. totalCount keeps counting all
// events seen for the header counter.
var MAX_LOG_ENTRIES = 2000;
var entries = [];
var filter = '';
var autoScroll = true;
var totalCount = 0;

var catLabel = {
  user:'USER', ai:'AI', tool_call:'TOOL→', tool_result:'TOOL←',
  think:'THINK', system:'SYS', error:'ERROR', abort:'ABORT', retry:'RETRY'
};

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtTime(ts) {
  var d = new Date(ts);
  var h = String(d.getHours()).padStart(2,'0');
  var m = String(d.getMinutes()).padStart(2,'0');
  var s = String(d.getSeconds()).padStart(2,'0');
  var ms = String(d.getMilliseconds()).padStart(3,'0');
  return h+':'+m+':'+s+'.'+ms;
}

function renderRow(e) {
  var wrap = document.getElementById('logWrap');
  var hint = document.getElementById('emptyHint');
  if (hint) hint.remove();

  var hasDetail = e.detail && e.detail.trim();
  var eid = 'e_'+e.id;
  var label = catLabel[e.cat] || e.cat.toUpperCase();

  var row = document.createElement('div');
  row.className = 'log-row cat-'+e.cat;
  row.innerHTML =
    '<div class="row-main'+(hasDetail?' clickable':'')+'" '+(hasDetail?'onclick="tog(''+eid+'')"':'')+'>'+
      '<span class="ts">'+fmtTime(e.ts)+'</span>'+
      '<span class="badge">'+label+'</span>'+
      '<span class="row-title">'+escHtml(e.title)+'</span>'+
      (hasDetail ? '<span class="expand-icon" id="'+eid+'_ic">▶</span>' : '')+
    '</div>'+
    (hasDetail ? '<div class="row-detail" id="'+eid+'"><pre>'+escHtml(e.detail)+'</pre></div>' : '');
  wrap.appendChild(row);

  if (autoScroll) wrap.scrollTop = wrap.scrollHeight;
}

function tog(id) {
  var el = document.getElementById(id);
  var ic = document.getElementById(id+'_ic');
  if (!el) return;
  var open = el.classList.toggle('open');
  if (ic) ic.textContent = open ? '▼' : '▶';
  if (open && autoScroll) {
    var wrap = document.getElementById('logWrap');
    setTimeout(function(){ wrap.scrollTop = wrap.scrollHeight; }, 50);
  }
}

function appendEntry(e) {
  entries.push(e);
  totalCount++;
  document.getElementById('cnt').textContent = totalCount;
  if (entries.length > MAX_LOG_ENTRIES) entries.splice(0, entries.length - MAX_LOG_ENTRIES);
  if (!filter || e.cat === filter) renderRow(e);
  var wrap = document.getElementById('logWrap');
  if (wrap) {
    while (wrap.childElementCount > MAX_LOG_ENTRIES) wrap.removeChild(wrap.firstElementChild);
  }
}

function setFilter(btn, f) {
  filter = f;
  document.querySelectorAll('.tool-chip[data-f]').forEach(function(b){ b.classList.remove('active'); });
  btn.classList.add('active');
  rerender();
}

function rerender() {
  var wrap = document.getElementById('logWrap');
  wrap.innerHTML = '';
  var list = filter ? entries.filter(function(e){ return e.cat===filter; }) : entries;
  if (!list.length) {
    wrap.innerHTML = '<div class="empty-hint" id="emptyHint">'+(filter?'无匹配事件':'等待事件…')+'</div>';
    return;
  }
  list.forEach(renderRow);
}

function clearLog() {
  entries = [];
  totalCount = 0;
  document.getElementById('cnt').textContent = '0';
  document.getElementById('logWrap').innerHTML = '<div class="empty-hint" id="emptyHint">等待事件…</div>';
}

var autoScrollBtn = document.getElementById('autoScrollBtn');
autoScrollBtn.addEventListener('click', function() {
  autoScroll = !autoScroll;
  autoScrollBtn.style.color = autoScroll ? '#6aa9ff' : '';
  autoScrollBtn.title = autoScroll ? '自动滚动到底部（已开启）' : '自动滚动到底部（已关闭）';
  if (autoScroll) {
    var wrap = document.getElementById('logWrap');
    wrap.scrollTop = wrap.scrollHeight;
  }
});
autoScrollBtn.style.color = '#6aa9ff';

if (window.desktopAssistant) {
  // Load existing entries from the in-memory buffer first, then subscribe to new ones.
  if (window.desktopAssistant.getLogEntries) {
    window.desktopAssistant.getLogEntries().then(function(existing) {
      existing.forEach(appendEntry);
      var wrap = document.getElementById('logWrap');
      if (wrap) wrap.scrollTop = wrap.scrollHeight;
    });
  }
  if (window.desktopAssistant.onLogEvent) {
    window.desktopAssistant.onLogEvent(appendEntry);
  }
}
</script>
</body>
</html>`;
	return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function buildAppLaunchCacheHtml(cache: AppLaunchCacheView): string {
	const entries = Object.entries(cache.aliases).sort(([a], [b]) => a.localeCompare(b));
	const entryCards = entries
		.map(
			([alias, entry]) => `
				<article class="entry">
					<div class="entry-top">
						<div>
							<strong>${escapeHtml(alias)}</strong>
							<span>${escapeHtml(entry.displayName)}</span>
						</div>
						<div class="entry-actions">
							<small>${escapeHtml(entry.targetType)} / ${escapeHtml(entry.kind)}</small>
							<button class="btn danger compact" data-alias="${escapeHtml(alias)}" onclick="deleteEntry(this.dataset.alias)">删除</button>
						</div>
					</div>
					<code>${escapeHtml(entry.launch)}</code>
					<div class="entry-meta">
						<span>成功 ${entry.successCount}</span>
						<span>失败 ${entry.failCount}</span>
						${entry.sourceQueries.length > 0 ? `<span>来源 ${escapeHtml(entry.sourceQueries.join(" / "))}</span>` : ""}
					</div>
				</article>`,
		)
		.join("");
	return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>App Launch Memory</title>
	<style>
		:root {
			--bg-glass: #1c1c20;
			--bg-glass-strong: #24242a;
			--bg-soft: rgba(255, 255, 255, 0.06);
			--bg-soft-hover: rgba(255, 255, 255, 0.10);
			--stroke: rgba(255, 255, 255, 0.08);
			--stroke-strong: rgba(255, 255, 255, 0.14);
			--fg: #f4f5f7;
			--fg-dim: #c8c9cf;
			--fg-mute: #8c8d94;
			--accent: #6aa9ff;
			--danger: #ff7676;
			--success: #4ade80;
			color-scheme: dark;
			font-family: "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif;
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			min-height: 100vh;
			color: var(--fg);
			background:
				radial-gradient(circle at 78% 18%, rgba(255, 118, 118, 0.16), transparent 28%),
				radial-gradient(circle at 82% 82%, rgba(106, 169, 255, 0.18), transparent 30%),
				var(--bg-glass);
			overflow: hidden;
		}
		button { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
		.titlebar {
			height: 50px;
			display: flex;
			align-items: center;
			gap: 10px;
			padding: 0 14px;
			border-bottom: 1px solid var(--stroke);
			background: rgba(20, 20, 24, 0.78);
			-webkit-app-region: drag;
		}
		.title-label { flex: 1; font-size: 13px; font-weight: 600; color: var(--fg-dim); }
		.title-btn {
			width: 30px;
			height: 30px;
			display: grid;
			place-items: center;
			border-radius: 9px;
			color: var(--fg-mute);
			-webkit-app-region: no-drag;
		}
		.title-btn:hover { background: var(--bg-soft-hover); color: var(--fg); }
		.title-btn.danger:hover { background: rgba(255, 118, 118, 0.16); color: var(--danger); }
		main { height: calc(100vh - 50px); padding: 18px; overflow: hidden; }
		.panel {
			height: 100%;
			display: flex;
			flex-direction: column;
			gap: 14px;
			padding: 18px;
			border: 1px solid var(--stroke-strong);
			border-radius: 22px;
			background:
				linear-gradient(145deg, rgba(106, 169, 255, 0.15), transparent 34%),
				rgba(36, 36, 42, 0.84);
			box-shadow: 0 28px 72px rgba(0, 0, 0, 0.42);
			backdrop-filter: blur(24px);
		}
		.header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
		.kicker { color: var(--accent); font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
		h1 { margin: 5px 0 6px; font-size: 24px; line-height: 1.15; }
		p { margin: 0; color: var(--fg-mute); font-size: 13px; line-height: 1.55; }
		.actions { display: flex; gap: 8px; }
		.btn {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			height: 34px;
			padding: 0 12px;
			border-radius: 10px;
			border: 1px solid var(--stroke);
			background: var(--bg-soft);
			color: var(--fg-dim);
			font-size: 12px;
		}
		.btn:hover { background: var(--bg-soft-hover); color: var(--fg); }
		.btn.danger { color: var(--danger); border-color: rgba(255, 118, 118, 0.28); background: rgba(255, 118, 118, 0.10); }
		.summary { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
		.summary > div, .path, .entry, .empty {
			border: 1px solid var(--stroke);
			border-radius: 14px;
			background: rgba(0, 0, 0, 0.16);
		}
		.summary > div { padding: 12px; }
		.summary span, .path span { display: block; color: var(--fg-mute); font-size: 11px; }
		.summary strong { display: block; margin-top: 4px; font-size: 15px; word-break: break-word; }
		.path { padding: 12px; display: grid; gap: 6px; }
		code {
			color: var(--fg-dim);
			font-family: "Cascadia Code", Consolas, ui-monospace, monospace;
			font-size: 11.5px;
			word-break: break-all;
		}
		.entries { flex: 1; min-height: 0; overflow-y: auto; display: grid; gap: 10px; padding-right: 4px; }
		.entry { padding: 12px; display: grid; gap: 9px; }
		.entry-top { display: flex; justify-content: space-between; gap: 10px; }
		.entry-top strong { display: block; font-size: 15px; }
		.entry-top span, .entry-meta { color: var(--fg-mute); font-size: 11px; }
		.entry-actions { display: flex; align-items: flex-start; gap: 8px; }
		.entry-top small {
			padding: 3px 8px;
			border-radius: 999px;
			border: 1px solid rgba(106, 169, 255, 0.26);
			background: rgba(106, 169, 255, 0.10);
			color: var(--accent);
			height: fit-content;
		}
		.btn.compact { height: 24px; padding: 0 8px; font-size: 11px; border-radius: 8px; }
		.entry-meta { display: flex; flex-wrap: wrap; gap: 6px 12px; }
		.empty { padding: 28px 14px; color: var(--fg-mute); text-align: center; font-size: 13px; }
		::-webkit-scrollbar { width: 8px; }
		::-webkit-scrollbar-thumb { background: rgba(255,255,255,.16); border-radius: 999px; }
	</style>
</head>
<body>
	<div class="titlebar">
		<div class="title-label">App Launch Memory</div>
		<button class="title-btn" onclick="window.desktopAssistant.minimizeWindow()" aria-label="最小化">−</button>
		<button class="title-btn danger" onclick="window.desktopAssistant.closeWindow()" aria-label="关闭">×</button>
	</div>
	<main>
		<section class="panel">
			<header class="header">
				<div>
					<div class="kicker">Persistent Launch Cache</div>
					<h1>应用/网站启动记忆</h1>
					<p>这里记录 AI 已经学会的应用别名、网站别名和启动目标。新对话会继续使用这些记忆，不再重复先找本地应用再试网页。</p>
				</div>
				<div class="actions">
					<button class="btn" onclick="refreshCache()">刷新</button>
					<button class="btn danger" onclick="clearCache()">清空记忆</button>
				</div>
			</header>
			<div class="summary">
				<div><span>别名数量</span><strong>${entries.length}</strong></div>
				<div><span>更新时间</span><strong>${cache.updatedAt ? escapeHtml(new Date(cache.updatedAt).toLocaleString("zh-CN")) : "暂无"}</strong></div>
			</div>
			<div class="path"><span>缓存文件</span><code>${escapeHtml(cache.path)}</code></div>
			<div class="entries">${entryCards || '<div class="empty">暂无应用启动记忆。成功打开应用后，这里会自动出现记录。</div>'}</div>
		</section>
	</main>
	<script>
		async function refreshCache() {
			await window.desktopAssistant.openAppLaunchCacheWindow();
		}
		async function clearCache() {
			if (!confirm("确定要清空 app-launch-cache 记忆吗？之后 AI 会重新学习应用路径。")) return;
			await window.desktopAssistant.clearAppLaunchCache();
			await refreshCache();
		}
		async function deleteEntry(alias) {
			if (!alias) return;
			if (!confirm("删除这条启动记忆：" + alias + "？")) return;
			await window.desktopAssistant.deleteAppLaunchCacheEntry({ alias });
			await refreshCache();
		}
	</script>
</body>
</html>`;
}

function appLaunchCacheDataUrl(cache: AppLaunchCacheView): string {
	const html = buildAppLaunchCacheHtml(cache);
	return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => {
		const replacements: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		};
		return replacements[char] ?? char;
	});
}

function fallbackDataUrl(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const escaped = message.replace(/[&<>"']/g, (char) => {
		const replacements: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		};
		return replacements[char] ?? char;
	});
	return `data:text/html;charset=utf-8,${encodeURIComponent(
		`<!doctype html><title>Pi 桌面助手</title><body style="font-family:Segoe UI,sans-serif;padding:32px"><h1>Pi 桌面助手</h1><p>渲染界面加载失败。</p><pre>${escaped}</pre></body>`,
	)}`;
}

/**
 * One-time migration: copy conversations from old cwd-relative save dirs to the
 * stable userData path. Skips any sessionId that already exists in the target.
 * Writes a marker file so the scan only runs once.
 */
async function migrateConversationsToUserData(): Promise<void> {
	const targetConversationsDir = join(app.getPath("userData"), "conversations", "conversations");
	const markerFile = join(app.getPath("userData"), "conversations", ".migrated");
	if (existsSync(markerFile)) return;

	// Candidate old directories: dev package path and any cwd-relative path.
	const packageRoot = resolve(__dirname, "../../..");
	const candidateOldDirs = [
		join(packageRoot, "save", "conversations"),
		join(process.cwd(), "save", "conversations"),
	].filter((d, i, arr) => arr.indexOf(d) === i); // dedupe

	let migrated = 0;
	for (const oldDir of candidateOldDirs) {
		if (!existsSync(oldDir)) continue;
		let entries: string[] = [];
		try {
			entries = readdirSync(oldDir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const src = join(oldDir, entry);
			const dest = join(targetConversationsDir, entry);
			if (existsSync(dest)) continue; // already present, skip
			try {
				mkdirSync(dest, { recursive: true });
				await cp(src, dest, { recursive: true });
				migrated += 1;
			} catch {
				// Best-effort: skip failed entries.
			}
		}
	}

	// Write marker so we never re-scan.
	try {
		mkdirSync(join(app.getPath("userData"), "conversations"), { recursive: true });
		writeFileSync(markerFile, `migrated ${migrated} conversations at ${new Date().toISOString()}\n`, "utf-8");
	} catch {
		// Non-critical.
	}
}

app.whenReady().then(async () => {
	installProcessDiagnostics();
	ensurePreloadFile();
	logStore = new LogStore(join(app.getPath("userData"), "log"));
	await createMainWindow();
	void migrateConversationsToUserData().catch((error: unknown) => {
		console.error("Conversation migration failed:", error);
	});
	app.on("activate", async () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			await createMainWindow();
		}
	});
});

app.on("before-quit", () => {
	logStore?.close();
});

function ensurePreloadFile(): void {
	const src = join(__dirname, "../../../src/main/preload.cjs");
	if (existsSync(src)) {
		// Always overwrite so changes to preload.cjs take effect on next launch.
		copyFileSync(src, preloadPath);
	}
}

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});
