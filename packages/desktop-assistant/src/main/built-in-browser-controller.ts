import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	BrowserWindow,
	type Cookie,
	type Event as ElectronEvent,
	type OnCompletedListenerDetails,
	type OnErrorOccurredListenerDetails,
	type Rectangle,
	type Session,
	session,
	type WebContents,
	type WebContentsConsoleMessageEventParams,
	WebContentsView,
} from "electron";
import type { BrowserToolHost } from "../agent/browser-tools.ts";
import type {
	BrowserClearStorageRequest,
	BrowserClearStorageResponse,
	BrowserConsoleEntry,
	BrowserCookieRequest,
	BrowserCookieView,
	BrowserElementActionRequest,
	BrowserElementSnapshot,
	BrowserHistoryEntry,
	BrowserKeyRequest,
	BrowserNativeAppStatus,
	BrowserNativeStatus,
	BrowserNavigateRequest,
	BrowserNetworkEntry,
	BrowserPageSnapshot,
	BrowserQueryElementsRequest,
	BrowserReadPageRequest,
	BrowserScreenshotRequest,
	BrowserScreenshotResponse,
	BrowserScrollRequest,
	BrowserSetBoundsRequest,
	BrowserTabRequest,
	BrowserTabView,
	BrowserTarget,
	BrowserVirtualMouseRequest,
	BuiltInBrowserEvent,
	BuiltInBrowserStatus,
	DesktopAssistantSettings,
} from "../shared/types.ts";
import { DESKTOP_ASSISTANT_CHANNELS } from "../shared/types.ts";

type NativeTarget = "chrome" | "edge";
type CdpMouseButton = "left" | "middle" | "right" | "none";

interface BrowserTabState {
	id: string;
	view: WebContentsView;
	title: string;
	url: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	faviconUrl?: string;
	error?: string;
	/** True while this tab shows the custom home page (its WebContentsView stays detached). */
	homePage: boolean;
}

interface BuiltInBrowserControllerOptions {
	userDataDir: string;
	preloadPath: string;
	rendererDistDir: string;
	devServerUrl?: string;
	addWindow: (window: BrowserWindow, label: string) => void;
	getSettings: () => DesktopAssistantSettings;
}

interface NativeLaunchState {
	port: number;
	launchedAt: number;
	lastError?: string;
}

interface RawPageSnapshot {
	title?: unknown;
	url?: unknown;
	text?: unknown;
	html?: unknown;
	source?: unknown;
	elements?: unknown;
}

interface CdpTargetInfo {
	id: string;
	type?: string;
	title?: string;
	url?: string;
	webSocketDebuggerUrl?: string;
}

interface WebSocketLike {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "open" | "message" | "error" | "close", listener: (event: unknown) => void): void;
	removeEventListener(type: "open" | "message" | "error" | "close", listener: (event: unknown) => void): void;
}

type WebSocketConstructor = new (url: string) => WebSocketLike;

const MAX_LOG_ENTRIES = 250;
const DEFAULT_PAGE_TEXT_LIMIT = 12000;
const NATIVE_DEBUG_TIMEOUT_MS = 8000;
const MAX_HISTORY_ENTRIES = 200;
const MAX_RECENT_SITES = 12;
const HISTORY_WRITE_DEBOUNCE_MS = 1000;

export class BuiltInBrowserController {
	private options: BuiltInBrowserControllerOptions;
	private profilePath: string;
	private browserSession: Session;
	private window: BrowserWindow | undefined;
	private tabs: BrowserTabState[] = [];
	private activeTabId: string | undefined;
	private contentBounds: Rectangle = { x: 0, y: 86, width: 1024, height: 640 };
	private consoleEntries: BrowserConsoleEntry[] = [];
	private networkEntries: BrowserNetworkEntry[] = [];
	private nativeLaunches = new Map<NativeTarget, NativeLaunchState>();
	private historyPath: string;
	private history: BrowserHistoryEntry[] = [];
	private historyWriteTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: BuiltInBrowserControllerOptions) {
		this.options = options;
		this.profilePath = join(options.userDataDir, "browser-profile", "built-in");
		this.historyPath = join(this.profilePath, "history.json");
		this.history = this.loadHistory();
		this.browserSession = session.fromPath(this.profilePath);
		this.browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
		this.installNetworkTracking();
	}

	async open(request: { url?: string } = {}): Promise<BuiltInBrowserStatus> {
		await this.ensureWindow();
		const status = await this.ensureTab(request.url);
		this.window?.show();
		this.window?.focus();
		return status;
	}

	async listBrowserTabs(target: BrowserTarget): Promise<unknown> {
		if (target === "built_in") {
			const status = this.buildStatusSync();
			return { browser: target, tabs: status.tabs, activeTabId: status.activeTabId };
		}
		return this.withNativeCdp(target, async (client) => {
			const pages = await client.listPages();
			return { browser: target, tabs: pages.map((page) => cdpPageToTabView(page, false)) };
		});
	}

	async openUrl(target: BrowserTarget, url: string): Promise<unknown> {
		if (target === "built_in") return this.open({ url });
		return this.openNative(target, url);
	}

	async newBrowserTab(target: BrowserTarget, url?: string): Promise<unknown> {
		if (target === "built_in") return this.newTab(url);
		return this.openNative(target, url);
	}

	async switchBrowserTab(target: BrowserTarget, request: BrowserTabRequest): Promise<unknown> {
		if (target === "built_in") return this.switchTab(request);
		return this.withNativeCdp(target, async (client) => {
			const page = await client.resolvePage(request.tabId);
			await client.activateTarget(page.id);
			return this.nativeStatusWithActiveTab(target, page.id);
		});
	}

	async closeBrowserTab(target: BrowserTarget, request: BrowserTabRequest): Promise<unknown> {
		if (target === "built_in") return this.closeTab(request);
		return this.withNativeCdp(target, async (client) => {
			const page = await client.resolvePage(request.tabId);
			await client.closeTarget(page.id);
			return this.nativeStatusWithActiveTab(target);
		});
	}

	async readBrowserPage(target: BrowserTarget, request: BrowserReadPageRequest = {}): Promise<unknown> {
		if (target === "built_in") return this.readPage(request);
		return this.withNativePage(target, request.tabId, async (client) => {
			const raw = normalizeRawPageSnapshot(
				await client.evaluate(pageSnapshotScript(request.includeElements ?? true)),
			);
			const maxChars = clampInteger(request.maxChars, 500, 100000, DEFAULT_PAGE_TEXT_LIMIT);
			const fullText = safeString(raw.text);
			const html = request.includeHtml ? safeString(raw.html) : undefined;
			const source = request.includeSource ? safeString(raw.source ?? raw.html) : undefined;
			const truncated =
				fullText.length > maxChars || (html?.length ?? 0) > maxChars || (source?.length ?? 0) > maxChars;
			const tab = await client.currentTabView();
			return {
				tab,
				title: safeString(raw.title),
				url: safeString(raw.url) || tab.url,
				text: trimChars(fullText, maxChars),
				html: html === undefined ? undefined : trimChars(html, maxChars),
				source: source === undefined ? undefined : trimChars(source, maxChars),
				elements: request.includeElements === false ? undefined : normalizeElements(raw.elements),
				console: request.includeConsole === false ? undefined : [],
				network: request.includeNetwork === false ? undefined : [],
				truncated,
			};
		});
	}

	async queryBrowserElements(target: BrowserTarget, request: BrowserQueryElementsRequest = {}): Promise<unknown> {
		if (target === "built_in") return this.queryElements(request);
		return this.withNativePage(target, request.tabId, async (client) => {
			const limit = clampInteger(request.limit, 1, 200, 50);
			const result = await client.evaluate(
				queryElementsScript({
					selector: request.selector,
					text: request.text,
					limit,
				}),
			);
			return normalizeElements(result);
		});
	}

	async clickBrowser(target: BrowserTarget, request: BrowserElementActionRequest): Promise<unknown> {
		if (target === "built_in") return this.click(request);
		return this.withNativePage(target, request.tabId, async (client) => {
			await client.evaluate(elementActionScript("click", request));
			return this.readBrowserPage(target, {
				tabId: request.tabId,
				includeConsole: true,
				includeElements: true,
				includeNetwork: true,
			});
		});
	}

	async typeBrowserText(target: BrowserTarget, request: BrowserElementActionRequest): Promise<unknown> {
		if (target === "built_in") return this.typeText(request);
		return this.withNativePage(target, request.tabId, async (client) => {
			await client.evaluate(elementActionScript("type", request));
			return this.readBrowserPage(target, {
				tabId: request.tabId,
				includeConsole: true,
				includeElements: true,
				includeNetwork: true,
			});
		});
	}

	async pressBrowserKey(target: BrowserTarget, request: BrowserKeyRequest): Promise<unknown> {
		if (target === "built_in") return this.pressKey(request);
		return this.withNativePage(target, request.tabId, async (client) => {
			await client.pressKey(request.key);
			return this.nativeStatusWithActiveTab(target, client.targetId);
		});
	}

	async scrollBrowser(target: BrowserTarget, request: BrowserScrollRequest = {}): Promise<unknown> {
		if (target === "built_in") return this.scroll(request);
		return this.withNativePage(target, request.tabId, async (client) => {
			await client.evaluate(
				`window.scrollBy(${JSON.stringify(request.x ?? 0)}, ${JSON.stringify(request.y ?? 700)})`,
			);
			return this.readBrowserPage(target, {
				tabId: request.tabId,
				includeConsole: true,
				includeElements: true,
				includeNetwork: true,
			});
		});
	}

	async browserScreenshot(target: BrowserTarget, request: BrowserScreenshotRequest = {}): Promise<unknown> {
		if (target === "built_in") return this.screenshot(request);
		return this.withNativePage(target, request.tabId, async (client) => {
			const result = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
			const data = readRecordString(result, "data");
			if (!data) throw new Error("Native browser screenshot failed.");
			const layout = await client.send("Page.getLayoutMetrics");
			const viewport = readRecord(layout, "cssVisualViewport");
			return {
				tabId: client.targetId,
				dataUrl: `data:image/png;base64,${data}`,
				width: readRecordNumber(viewport, "clientWidth") ?? 0,
				height: readRecordNumber(viewport, "clientHeight") ?? 0,
			};
		});
	}

	async getBrowserCookies(target: BrowserTarget, request: BrowserCookieRequest = {}): Promise<unknown> {
		if (target === "built_in") return this.getCookies(request);
		return this.withNativePage(target, request.tabId, (client) => client.getCookies(request.url));
	}

	async clearBrowserStorage(target: BrowserTarget, request: BrowserClearStorageRequest): Promise<unknown> {
		if (target === "built_in") return this.clearStorage(request);
		return this.withNativePage(target, undefined, async (client) => {
			if (request.scope === "cookies" || request.scope === "all") {
				await client.send("Network.clearBrowserCookies");
			}
			if (request.scope === "cache" || request.scope === "all") {
				await client.send("Network.clearBrowserCache");
			}
			if (request.scope === "site_data" || request.scope === "all") {
				await client.send("Storage.clearDataForOrigin", {
					origin: new URL(client.pageUrl).origin,
					storageTypes:
						"appcache,cache_storage,cookies,file_systems,indexeddb,local_storage,service_workers,websql",
				});
			}
			const profilePath = this.resolveNativeAppStatus(target).profilePath;
			return {
				ok: true,
				scope: request.scope,
				profilePath,
				profileSizeBytes: directorySize(profilePath),
			};
		});
	}

	async virtualBrowserMouse(target: BrowserTarget, request: BrowserVirtualMouseRequest): Promise<unknown> {
		if (target === "built_in") return this.virtualMouse(request);
		return this.withNativePage(target, request.tabId, async (client) => {
			await client.mouse(request);
			return this.nativeStatusWithActiveTab(target, client.targetId);
		});
	}

	async status(): Promise<BuiltInBrowserStatus> {
		return this.buildStatus();
	}

	/**
	 * Adapt this controller to the BrowserToolHost interface used by the agent's browser_* tools.
	 * The unified, target-aware methods are mapped to the host's shorter tool-facing names, and
	 * getDefaultBrowser is supplied by the caller (from the live settings snapshot).
	 */
	toolHost(getDefaultBrowser: () => BrowserTarget): BrowserToolHost {
		return {
			getDefaultBrowser,
			listTabs: (target) => this.listBrowserTabs(target),
			openUrl: (target, url) => this.openUrl(target, url),
			newTab: (target, url) => this.newBrowserTab(target, url),
			switchTab: (target, request) => this.switchBrowserTab(target, request),
			closeTab: (target, request) => this.closeBrowserTab(target, request),
			readPage: (target, request) => this.readBrowserPage(target, request),
			queryElements: (target, request) => this.queryBrowserElements(target, request),
			click: (target, request) => this.clickBrowser(target, request),
			typeText: (target, request) => this.typeBrowserText(target, request),
			pressKey: (target, request) => this.pressBrowserKey(target, request),
			scroll: (target, request) => this.scrollBrowser(target, request),
			screenshot: (target, request) => this.browserScreenshot(target, request),
			getCookies: (target, request) => this.getBrowserCookies(target, request),
			clearStorage: (target, request) => this.clearBrowserStorage(target, request),
			virtualMouse: (target, request) => this.virtualBrowserMouse(target, request),
		};
	}

	async navigate(request: BrowserNavigateRequest): Promise<BuiltInBrowserStatus> {
		const tab = await this.ensureTargetTab(request.tabId);
		// Leaving the home page: attach the WebContentsView back over the content area before loading.
		if (tab.homePage) {
			tab.homePage = false;
			if (tab.id === this.activeTabId) this.attachActiveView();
		}
		await this.safeLoadUrl(tab, normalizeNavigationUrl(request.url));
		this.updateTabState(tab);
		this.emitStatus();
		return this.buildStatus();
	}

	async newTab(url?: string): Promise<BuiltInBrowserStatus> {
		await this.ensureWindow();
		const maxTabs = this.maxTabs();
		if (this.tabs.length >= maxTabs) {
			throw new Error(`Built-in browser allows at most ${maxTabs} tabs.`);
		}
		const tab = this.createTab();
		this.tabs.push(tab);
		// A bare "new tab" opens the custom home page (rendered by the renderer while the
		// WebContentsView is kept detached). Passing a url opens a normal page instead.
		if (url === undefined) {
			tab.homePage = true;
			await this.switchTab({ tabId: tab.id });
			return this.buildStatus();
		}
		await this.switchTab({ tabId: tab.id });
		await this.safeLoadUrl(tab, normalizeNavigationUrl(url));
		return this.buildStatus();
	}

	/**
	 * Load a URL without letting a navigation failure reject the calling operation.
	 * webContents.loadURL rejects on aborted/failed navigations (redirects, ERR_CONNECTION_CLOSED,
	 * etc.), but the tab is already created and the failure is surfaced through the did-fail-load
	 * handler into tab.error. Swallow it here so opening/navigating a tab still resolves with status.
	 */
	private async safeLoadUrl(tab: BrowserTabState, url: string): Promise<void> {
		try {
			await tab.view.webContents.loadURL(url);
		} catch (error) {
			const code = (error as { code?: string }).code;
			// ERR_ABORTED fires when a newer navigation supersedes this one; not a real failure.
			if (code !== "ERR_ABORTED" && !tab.error) {
				tab.error = error instanceof Error ? error.message : String(error);
			}
		}
	}

	async switchTab(request: BrowserTabRequest): Promise<BuiltInBrowserStatus> {
		const tab = this.resolveTab(request.tabId);
		if (!tab) throw new Error("Built-in browser tab was not found.");
		this.detachActiveView();
		this.activeTabId = tab.id;
		this.attachActiveView();
		this.updateTabState(tab);
		this.emitStatus();
		return this.buildStatus();
	}

	async closeTab(request: BrowserTabRequest): Promise<BuiltInBrowserStatus> {
		const tab = this.resolveTab(request.tabId);
		if (!tab) return this.buildStatus();
		const wasActive = tab.id === this.activeTabId;
		if (wasActive) this.detachActiveView();
		tab.view.webContents.close();
		this.tabs = this.tabs.filter((item) => item.id !== tab.id);
		if (this.tabs.length === 0) {
			this.activeTabId = undefined;
			await this.newTab();
			return this.buildStatus();
		}
		if (wasActive) {
			const next = this.tabs[Math.max(0, this.tabs.length - 1)];
			this.activeTabId = next?.id;
			this.attachActiveView();
		}
		this.emitStatus();
		return this.buildStatus();
	}

	async goBack(request: BrowserTabRequest): Promise<BuiltInBrowserStatus> {
		const tab = await this.ensureTargetTab(request.tabId);
		if (tab.view.webContents.canGoBack()) tab.view.webContents.goBack();
		this.updateTabState(tab);
		this.emitStatus();
		return this.buildStatus();
	}

	async goForward(request: BrowserTabRequest): Promise<BuiltInBrowserStatus> {
		const tab = await this.ensureTargetTab(request.tabId);
		if (tab.view.webContents.canGoForward()) tab.view.webContents.goForward();
		this.updateTabState(tab);
		this.emitStatus();
		return this.buildStatus();
	}

	async reload(request: BrowserTabRequest): Promise<BuiltInBrowserStatus> {
		const tab = await this.ensureTargetTab(request.tabId);
		tab.view.webContents.reload();
		this.updateTabState(tab);
		this.emitStatus();
		return this.buildStatus();
	}

	async stop(request: BrowserTabRequest): Promise<BuiltInBrowserStatus> {
		const tab = await this.ensureTargetTab(request.tabId);
		tab.view.webContents.stop();
		this.updateTabState(tab);
		this.emitStatus();
		return this.buildStatus();
	}

	setContentBounds(request: BrowserSetBoundsRequest): BuiltInBrowserStatus {
		this.contentBounds = {
			x: Math.max(0, Math.round(request.x)),
			y: Math.max(0, Math.round(request.y)),
			width: Math.max(1, Math.round(request.width)),
			height: Math.max(1, Math.round(request.height)),
		};
		this.activeTab()?.view.setBounds(this.contentBounds);
		return this.buildStatusSync();
	}

	async clearStorage(request: BrowserClearStorageRequest): Promise<BrowserClearStorageResponse> {
		if (request.scope === "cookies") {
			await this.browserSession.clearStorageData({ storages: ["cookies"] });
		} else if (request.scope === "cache") {
			await this.browserSession.clearCache();
		} else if (request.scope === "site_data") {
			await this.browserSession.clearStorageData({
				storages: [
					"filesystem",
					"indexdb",
					"localstorage",
					"shadercache",
					"websql",
					"serviceworkers",
					"cachestorage",
				],
			});
		} else {
			await this.browserSession.clearData();
			await this.browserSession.clearCache();
		}
		await this.browserSession.cookies.flushStore();
		const profileSizeBytes = directorySize(this.profilePath);
		this.emitStatus();
		return {
			ok: true,
			scope: request.scope,
			profilePath: this.profilePath,
			profileSizeBytes,
		};
	}

	getNativeStatus(): BrowserNativeStatus {
		return this.resolveNativeStatus();
	}

	async openNative(target: NativeTarget, url?: string): Promise<BrowserNativeAppStatus> {
		const status = this.resolveNativeAppStatus(target);
		if (!status.available || !status.executablePath) {
			throw new Error(
				`${status.label} was not found. Switch the default browser in Settings or install ${status.label}.`,
			);
		}
		const port = target === "chrome" ? 49221 : 49222;
		const profilePath = status.profilePath;
		await mkdir(profilePath, { recursive: true });
		const launchUrl = normalizeNavigationUrl(url ?? this.options.getSettings().browser.homeUrl);
		const launch = this.nativeLaunches.get(target);
		if (launch && (await isNativeDebugPortReady(launch.port))) {
			const client = new NativeBrowserCdpClient(launch.port);
			await client.createPage(launchUrl);
			this.nativeLaunches.set(target, { ...launch, lastError: undefined });
			return { ...status, aiProfileRunning: true, lastError: undefined };
		}
		const spawned = spawn(
			status.executablePath,
			[
				`--user-data-dir=${profilePath}`,
				`--remote-debugging-port=${port}`,
				"--no-first-run",
				"--no-default-browser-check",
				launchUrl,
			],
			{
				detached: true,
				stdio: "ignore",
			},
		);
		spawned.unref();
		this.nativeLaunches.set(target, { port, launchedAt: Date.now() });
		await waitForNativeDebugPort(port);
		return { ...status, aiProfileRunning: true };
	}

	async readPage(request: BrowserReadPageRequest = {}): Promise<BrowserPageSnapshot> {
		const tab = await this.ensureTargetTab(request.tabId);
		const maxChars = clampInteger(request.maxChars, 500, 100000, DEFAULT_PAGE_TEXT_LIMIT);
		const page = (await tab.view.webContents.executeJavaScript(
			pageSnapshotScript(request.includeElements ?? true),
			true,
		)) as RawPageSnapshot;
		const fullText = safeString(page.text);
		const html = request.includeHtml ? safeString(page.html) : undefined;
		const source = request.includeSource ? safeString(page.source ?? page.html) : undefined;
		const truncated =
			fullText.length > maxChars || (html?.length ?? 0) > maxChars || (source?.length ?? 0) > maxChars;
		return {
			tab: this.tabView(tab),
			title: safeString(page.title),
			url: safeString(page.url) || tab.url,
			text: trimChars(fullText, maxChars),
			html: html === undefined ? undefined : trimChars(html, maxChars),
			source: source === undefined ? undefined : trimChars(source, maxChars),
			elements: request.includeElements === false ? undefined : normalizeElements(page.elements),
			console: request.includeConsole === false ? undefined : this.recentConsole(tab.id),
			network: request.includeNetwork === false ? undefined : this.recentNetwork(tab.id),
			truncated,
		};
	}

	async queryElements(request: BrowserQueryElementsRequest = {}): Promise<BrowserElementSnapshot[]> {
		const tab = await this.ensureTargetTab(request.tabId);
		const limit = clampInteger(request.limit, 1, 200, 50);
		const result = (await tab.view.webContents.executeJavaScript(
			queryElementsScript({
				selector: request.selector,
				text: request.text,
				limit,
			}),
			true,
		)) as unknown;
		return normalizeElements(result);
	}

	async click(request: BrowserElementActionRequest): Promise<BrowserPageSnapshot> {
		const tab = await this.ensureTargetTab(request.tabId);
		await tab.view.webContents.executeJavaScript(elementActionScript("click", request), true);
		return this.readPage({ tabId: tab.id, includeElements: true, includeNetwork: true, includeConsole: true });
	}

	async typeText(request: BrowserElementActionRequest): Promise<BrowserPageSnapshot> {
		const tab = await this.ensureTargetTab(request.tabId);
		await tab.view.webContents.executeJavaScript(elementActionScript("type", request), true);
		return this.readPage({ tabId: tab.id, includeElements: true, includeNetwork: true, includeConsole: true });
	}

	async pressKey(request: BrowserKeyRequest): Promise<BuiltInBrowserStatus> {
		const tab = await this.ensureTargetTab(request.tabId);
		sendKey(tab.view.webContents, request.key);
		return this.buildStatus();
	}

	async scroll(request: BrowserScrollRequest): Promise<BrowserPageSnapshot> {
		const tab = await this.ensureTargetTab(request.tabId);
		tab.view.webContents.sendInputEvent({
			type: "mouseWheel",
			x: 10,
			y: 10,
			deltaX: request.x ?? 0,
			deltaY: request.y ?? 700,
		});
		return this.readPage({ tabId: tab.id, includeElements: true, includeNetwork: true, includeConsole: true });
	}

	async screenshot(request: BrowserScreenshotRequest = {}): Promise<BrowserScreenshotResponse> {
		const tab = await this.ensureTargetTab(request.tabId);
		const image = await tab.view.webContents.capturePage();
		const size = image.getSize();
		return {
			tabId: tab.id,
			dataUrl: image.toDataURL(),
			width: size.width,
			height: size.height,
		};
	}

	async getCookies(request: BrowserCookieRequest = {}): Promise<BrowserCookieView[]> {
		const tab = await this.ensureTargetTab(request.tabId);
		const url = request.url ?? tab.url;
		const cookies = await this.browserSession.cookies.get(url ? { url } : {});
		return cookies.map(cookieToView);
	}

	async virtualMouse(request: BrowserVirtualMouseRequest): Promise<BuiltInBrowserStatus> {
		const tab = await this.ensureTargetTab(request.tabId);
		const action = request.action ?? "click";
		const button = request.button ?? "left";
		if (action === "move") {
			tab.view.webContents.sendInputEvent({ type: "mouseMove", x: request.x, y: request.y, button });
		} else if (action === "down") {
			tab.view.webContents.sendInputEvent({ type: "mouseDown", x: request.x, y: request.y, button, clickCount: 1 });
		} else if (action === "up") {
			tab.view.webContents.sendInputEvent({ type: "mouseUp", x: request.x, y: request.y, button, clickCount: 1 });
		} else {
			const clickCount = action === "double_click" ? 2 : 1;
			tab.view.webContents.sendInputEvent({ type: "mouseMove", x: request.x, y: request.y, button });
			tab.view.webContents.sendInputEvent({ type: "mouseDown", x: request.x, y: request.y, button, clickCount });
			tab.view.webContents.sendInputEvent({ type: "mouseUp", x: request.x, y: request.y, button, clickCount });
		}
		return this.buildStatus();
	}

	private async ensureWindow(): Promise<void> {
		if (this.window && !this.window.isDestroyed()) return;
		const win = new BrowserWindow({
			width: 1200,
			height: 820,
			minWidth: 860,
			minHeight: 560,
			title: "Built-in Browser",
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
				preload: this.options.preloadPath,
			},
		});
		this.window = win;
		this.options.addWindow(win, "browser");
		win.on("closed", () => {
			if (this.window === win) this.window = undefined;
		});
		await loadRendererWindow(win, this.options.devServerUrl, this.options.rendererDistDir, "browser");
	}

	private async ensureTab(url?: string): Promise<BuiltInBrowserStatus> {
		if (this.tabs.length === 0) {
			await this.newTab(url ?? this.options.getSettings().browser.homeUrl);
			return this.buildStatus();
		}
		if (url) {
			await this.navigate({ url });
		}
		return this.buildStatus();
	}

	private createTab(): BrowserTabState {
		const view = new WebContentsView({
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				session: this.browserSession,
			},
		});
		const tab: BrowserTabState = {
			id: randomUUID(),
			view,
			title: "New tab",
			url: "about:blank",
			loading: false,
			canGoBack: false,
			canGoForward: false,
			homePage: false,
		};
		this.attachTabEvents(tab);
		return tab;
	}

	private attachTabEvents(tab: BrowserTabState): void {
		const wc = tab.view.webContents;
		// Links with target="_blank" and window.open() default to spawning a separate native
		// BrowserWindow. Deny that and open the URL as a new tab inside the built-in browser instead.
		wc.setWindowOpenHandler((details) => {
			const url = details.url;
			if (url && url !== "about:blank") {
				void this.newTab(url).catch(() => {
					/* surfaced via tab.error / did-fail-load */
				});
			}
			return { action: "deny" };
		});
		wc.on("page-title-updated", (_event, title) => {
			tab.title = title || tab.title;
			this.recordHistory(tab);
			this.emitStatus();
		});
		wc.on("page-favicon-updated", (_event, favicons) => {
			tab.faviconUrl = favicons[0];
			this.recordHistory(tab);
			this.emitStatus();
		});
		wc.on("did-start-loading", () => {
			tab.loading = true;
			tab.error = undefined;
			this.updateTabState(tab);
			this.emitStatus();
		});
		wc.on("did-stop-loading", () => {
			tab.loading = false;
			this.updateTabState(tab);
			this.emitStatus();
		});
		wc.on("did-navigate", (_event, url) => {
			tab.url = url;
			tab.error = undefined;
			this.updateTabState(tab);
			this.recordHistory(tab);
			this.emitStatus();
		});
		wc.on("did-navigate-in-page", (_event, url) => {
			tab.url = url;
			this.updateTabState(tab);
			this.emitStatus();
		});
		wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
			if (errorCode === -3) return;
			if (isMainFrame) {
				tab.error = `${errorDescription} (${errorCode})`;
				tab.url = validatedURL || tab.url;
			}
			this.updateTabState(tab);
			this.emitStatus();
		});
		wc.on("console-message", (event, legacyLevel, legacyMessage, legacyLine, legacySourceId) => {
			const details = event as ElectronEvent<WebContentsConsoleMessageEventParams>;
			this.pushConsole({
				id: randomUUID(),
				ts: Date.now(),
				level: normalizeConsoleLevel(details.level ?? legacyConsoleLevel(legacyLevel)),
				message: details.message || legacyMessage || "",
				source: details.sourceId || legacySourceId || undefined,
				lineNumber: details.lineNumber || legacyLine || undefined,
				tabId: tab.id,
			});
		});
	}

	private installNetworkTracking(): void {
		this.browserSession.webRequest.onCompleted((details) => {
			this.pushNetwork(networkEntryFromCompleted(details, this.tabIdForWebContents(details.webContentsId)));
		});
		this.browserSession.webRequest.onErrorOccurred((details) => {
			this.pushNetwork(networkEntryFromError(details, this.tabIdForWebContents(details.webContentsId)));
		});
	}

	private tabIdForWebContents(webContentsId?: number): string | undefined {
		if (webContentsId === undefined) return undefined;
		return this.tabs.find((tab) => tab.view.webContents.id === webContentsId)?.id;
	}

	private detachActiveView(): void {
		const win = this.window;
		const active = this.activeTab();
		if (!win || win.isDestroyed() || !active) return;
		try {
			win.contentView.removeChildView(active.view);
		} catch {
			// Already detached.
		}
	}

	private attachActiveView(): void {
		const win = this.window;
		const active = this.activeTab();
		if (!win || win.isDestroyed() || !active) return;
		// Home-page tabs are rendered by the renderer in the content area; keep the WebContentsView
		// detached so it does not cover the React home page.
		if (active.homePage) {
			this.detachActiveView();
			return;
		}
		win.contentView.addChildView(active.view);
		active.view.setBounds(this.contentBounds);
	}

	private updateTabState(tab: BrowserTabState): void {
		if (tab.homePage) {
			tab.loading = false;
			tab.canGoBack = false;
			tab.canGoForward = false;
			return;
		}
		const wc = tab.view.webContents;
		tab.title = wc.getTitle() || tab.title;
		tab.url = wc.getURL() || tab.url;
		tab.loading = wc.isLoading();
		tab.canGoBack = wc.canGoBack();
		tab.canGoForward = wc.canGoForward();
	}

	private activeTab(): BrowserTabState | undefined {
		return this.resolveTab(this.activeTabId);
	}

	private resolveTab(tabId?: string): BrowserTabState | undefined {
		if (tabId) return this.tabs.find((tab) => tab.id === tabId);
		return this.tabs.find((tab) => tab.id === this.activeTabId) ?? this.tabs[0];
	}

	private async ensureTargetTab(tabId?: string): Promise<BrowserTabState> {
		await this.ensureWindow();
		if (this.tabs.length === 0) await this.newTab("about:blank");
		const tab = this.resolveTab(tabId);
		if (!tab) throw new Error("Built-in browser tab was not found.");
		return tab;
	}

	private maxTabs(): number {
		const value = this.options.getSettings().browser.maxTabs;
		return Number.isFinite(value) ? Math.max(1, Math.min(32, Math.round(value))) : 12;
	}

	private async buildStatus(): Promise<BuiltInBrowserStatus> {
		return this.buildStatusSync();
	}

	private buildStatusSync(): BuiltInBrowserStatus {
		for (const tab of this.tabs) this.updateTabState(tab);
		return {
			tabs: this.tabs.map((tab) => this.tabView(tab)),
			activeTabId: this.activeTabId,
			profilePath: this.profilePath,
			profileSizeBytes: directorySize(this.profilePath),
			maxTabs: this.maxTabs(),
			aiControlEnabled: this.options.getSettings().browser.allowAiControl,
			native: this.resolveNativeStatus(),
			recent: this.recentSites(),
		};
	}

	private tabView(tab: BrowserTabState): BrowserTabView {
		if (tab.homePage) {
			return {
				id: tab.id,
				title: "新标签页",
				url: "",
				loading: false,
				canGoBack: false,
				canGoForward: false,
				active: tab.id === this.activeTabId,
				homePage: true,
			};
		}
		return {
			id: tab.id,
			title: tab.title,
			url: tab.url,
			loading: tab.loading,
			canGoBack: tab.canGoBack,
			canGoForward: tab.canGoForward,
			active: tab.id === this.activeTabId,
			faviconUrl: tab.faviconUrl,
			error: tab.error,
		};
	}

	private recordHistory(tab: BrowserTabState): void {
		if (tab.homePage) return;
		const url = tab.url;
		if (!url || !/^https?:\/\//i.test(url)) return;
		const entry: BrowserHistoryEntry = {
			url,
			title: tab.title && tab.title !== "New tab" ? tab.title : url,
			faviconUrl: tab.faviconUrl,
			ts: Date.now(),
		};
		this.history = [entry, ...this.history.filter((item) => item.url !== url)].slice(0, MAX_HISTORY_ENTRIES);
		this.scheduleHistoryWrite();
	}

	private recentSites(): BrowserHistoryEntry[] {
		const seenHosts = new Set<string>();
		const recent: BrowserHistoryEntry[] = [];
		for (const entry of this.history) {
			const host = hostOf(entry.url);
			if (!host || seenHosts.has(host)) continue;
			seenHosts.add(host);
			recent.push(entry);
			if (recent.length >= MAX_RECENT_SITES) break;
		}
		return recent;
	}

	private loadHistory(): BrowserHistoryEntry[] {
		try {
			const raw = JSON.parse(readFileSync(this.historyPath, "utf-8")) as unknown;
			if (!Array.isArray(raw)) return [];
			return raw
				.flatMap((item): BrowserHistoryEntry[] => {
					const record = asRecord(item);
					const url = readRecordString(record, "url");
					if (!url || !/^https?:\/\//i.test(url)) return [];
					return [
						{
							url,
							title: readRecordString(record, "title") ?? url,
							faviconUrl: readRecordString(record, "faviconUrl"),
							ts: readRecordNumber(record, "ts") ?? 0,
						},
					];
				})
				.slice(0, MAX_HISTORY_ENTRIES);
		} catch {
			return [];
		}
	}

	private scheduleHistoryWrite(): void {
		if (this.historyWriteTimer) return;
		this.historyWriteTimer = setTimeout(() => {
			this.historyWriteTimer = undefined;
			const snapshot = JSON.stringify(this.history);
			void mkdir(this.profilePath, { recursive: true })
				.then(() => writeFile(this.historyPath, snapshot, "utf-8"))
				.catch(() => {
					/* history is best-effort; ignore write failures */
				});
		}, HISTORY_WRITE_DEBOUNCE_MS);
	}

	private emitStatus(): void {
		const win = this.window;
		if (!win || win.isDestroyed()) return;
		const event: BuiltInBrowserEvent = { type: "status", status: this.buildStatusSync() };
		win.webContents.send(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserEvent, event);
	}

	private pushConsole(entry: BrowserConsoleEntry): void {
		this.consoleEntries.push(entry);
		if (this.consoleEntries.length > MAX_LOG_ENTRIES) {
			this.consoleEntries.splice(0, this.consoleEntries.length - MAX_LOG_ENTRIES);
		}
	}

	private pushNetwork(entry: BrowserNetworkEntry): void {
		this.networkEntries.push(entry);
		if (this.networkEntries.length > MAX_LOG_ENTRIES) {
			this.networkEntries.splice(0, this.networkEntries.length - MAX_LOG_ENTRIES);
		}
	}

	private recentConsole(tabId: string): BrowserConsoleEntry[] {
		return this.consoleEntries.filter((entry) => !entry.tabId || entry.tabId === tabId).slice(-80);
	}

	private recentNetwork(tabId: string): BrowserNetworkEntry[] {
		return this.networkEntries.filter((entry) => !entry.tabId || entry.tabId === tabId).slice(-120);
	}

	private resolveNativeStatus(): BrowserNativeStatus {
		return {
			chrome: this.resolveNativeAppStatus("chrome"),
			edge: this.resolveNativeAppStatus("edge"),
		};
	}

	private resolveNativeAppStatus(target: NativeTarget): BrowserNativeAppStatus {
		const executablePath = findNativeBrowserExecutable(target);
		const launch = this.nativeLaunches.get(target);
		return {
			target,
			label: target === "chrome" ? "Chrome" : "Edge",
			executablePath,
			profilePath: join(this.options.userDataDir, "browser-profile", target),
			available: executablePath !== undefined,
			aiProfileRunning: launch !== undefined,
			lastError: launch?.lastError,
		};
	}

	private async withNativeCdp<T>(
		target: NativeTarget,
		run: (client: NativeBrowserCdpClient) => Promise<T>,
	): Promise<T> {
		await this.ensureNativeRunning(target);
		const launch = this.nativeLaunches.get(target);
		if (!launch) throw new Error(`${target} AI profile is not running.`);
		return run(new NativeBrowserCdpClient(launch.port));
	}

	private async withNativePage<T>(
		target: NativeTarget,
		tabId: string | undefined,
		run: (client: NativePageCdpClient) => Promise<T>,
	): Promise<T> {
		return this.withNativeCdp(target, async (browserClient) => {
			const page = await browserClient.resolvePage(tabId);
			await browserClient.activateTarget(page.id);
			const pageClient = await browserClient.attachToPage(page);
			try {
				await pageClient.enable();
				return await run(pageClient);
			} finally {
				pageClient.close();
			}
		});
	}

	private async ensureNativeRunning(target: NativeTarget): Promise<void> {
		const launch = this.nativeLaunches.get(target);
		if (launch && (await isNativeDebugPortReady(launch.port))) return;
		await this.openNative(target);
		const next = this.nativeLaunches.get(target);
		if (!next) throw new Error(`${target} AI profile failed to launch.`);
		if (await waitForNativeDebugPort(next.port)) return;
		this.nativeLaunches.set(target, { ...next, lastError: "Timed out waiting for CDP debug port." });
		throw new Error(`${target} AI profile started, but its CDP debug port is not ready.`);
	}

	private async nativeStatusWithActiveTab(
		target: NativeTarget,
		activeTabId?: string,
	): Promise<{ native: BrowserNativeAppStatus; tabs: BrowserTabView[]; activeTabId?: string }> {
		await this.ensureNativeRunning(target);
		const launch = this.nativeLaunches.get(target);
		if (!launch) throw new Error(`${target} AI profile is not running.`);
		const client = new NativeBrowserCdpClient(launch.port);
		const pages = await client.listPages();
		return {
			native: this.resolveNativeAppStatus(target),
			tabs: pages.map((page) => cdpPageToTabView(page, page.id === activeTabId)),
			activeTabId,
		};
	}
}

class NativeBrowserCdpClient {
	private port: number;

	constructor(port: number) {
		this.port = port;
	}

	async listPages(): Promise<CdpTargetInfo[]> {
		const value = await fetchJson(this.endpoint("/json/list"));
		if (!Array.isArray(value)) return [];
		return value
			.flatMap((item): CdpTargetInfo[] => {
				if (!item || typeof item !== "object") return [];
				const raw = item as Record<string, unknown>;
				const id = typeof raw.id === "string" ? raw.id : undefined;
				if (!id) return [];
				return [
					{
						id,
						type: typeof raw.type === "string" ? raw.type : undefined,
						title: typeof raw.title === "string" ? raw.title : undefined,
						url: typeof raw.url === "string" ? raw.url : undefined,
						webSocketDebuggerUrl:
							typeof raw.webSocketDebuggerUrl === "string" ? raw.webSocketDebuggerUrl : undefined,
					},
				];
			})
			.filter((page) => page.type === undefined || page.type === "page");
	}

	async resolvePage(tabId?: string): Promise<CdpTargetInfo> {
		const pages = await this.listPages();
		const byId = tabId ? pages.find((page) => page.id === tabId) : undefined;
		const page = byId ?? pages.find((item) => item.url !== "chrome://newtab/") ?? pages[0];
		if (page) return page;
		return this.createPage("about:blank");
	}

	async createPage(url: string): Promise<CdpTargetInfo> {
		const value = await fetchJson(this.endpoint(`/json/new?${encodeURIComponent(url)}`), { method: "PUT" });
		const record = asRecord(value);
		const id = readRecordString(record, "id");
		if (!id) throw new Error("Native browser did not create a CDP page.");
		return {
			id,
			type: readRecordString(record, "type"),
			title: readRecordString(record, "title"),
			url: readRecordString(record, "url"),
			webSocketDebuggerUrl: readRecordString(record, "webSocketDebuggerUrl"),
		};
	}

	async activateTarget(targetId: string): Promise<void> {
		await fetchJson(this.endpoint(`/json/activate/${encodeURIComponent(targetId)}`));
	}

	async closeTarget(targetId: string): Promise<void> {
		await fetchJson(this.endpoint(`/json/close/${encodeURIComponent(targetId)}`));
	}

	async attachToPage(page: CdpTargetInfo): Promise<NativePageCdpClient> {
		if (page.webSocketDebuggerUrl) {
			return new NativePageCdpClient(page.id, page.webSocketDebuggerUrl, page.url ?? "about:blank");
		}
		const fresh = (await this.listPages()).find((item) => item.id === page.id);
		if (!fresh?.webSocketDebuggerUrl) throw new Error("Native browser tab has no CDP WebSocket endpoint.");
		return new NativePageCdpClient(fresh.id, fresh.webSocketDebuggerUrl, fresh.url ?? "about:blank");
	}

	private endpoint(path: string): string {
		return `http://127.0.0.1:${this.port}${path}`;
	}
}

class NativePageCdpClient {
	readonly targetId: string;
	private wsUrl: string;
	pageUrl: string;
	private socket: WebSocketLike | undefined;
	private nextId = 1;
	private pending = new Map<
		number,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	private onMessage = (event: unknown) => this.handleMessage(event);
	private onClose = () => this.rejectAll(new Error("CDP WebSocket closed."));
	private onError = () => this.rejectAll(new Error("CDP WebSocket error."));

	constructor(targetId: string, wsUrl: string, pageUrl: string) {
		this.targetId = targetId;
		this.wsUrl = wsUrl;
		this.pageUrl = pageUrl;
	}

	async enable(): Promise<void> {
		await this.send("Runtime.enable");
		await this.send("Page.enable");
		await this.send("DOM.enable");
		await this.send("Network.enable");
	}

	async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
		const socket = await this.ensureSocket();
		const id = this.nextId;
		this.nextId += 1;
		const payload = params === undefined ? { id, method } : { id, method, params };
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP method timed out: ${method}`));
			}, 15000);
			this.pending.set(id, { resolve, reject, timer });
			socket.send(JSON.stringify(payload));
		});
	}

	async evaluate(expression: string): Promise<unknown> {
		const response = await this.send("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
			userGesture: true,
		});
		return normalizeCdpEvaluation(response);
	}

	async currentTabView(): Promise<BrowserTabView> {
		const value = await this.evaluate("({ title: document.title, url: location.href })");
		const record = asRecord(value);
		this.pageUrl = readRecordString(record, "url") ?? this.pageUrl;
		return {
			id: this.targetId,
			title: readRecordString(record, "title") ?? "Native browser tab",
			url: this.pageUrl,
			loading: false,
			canGoBack: false,
			canGoForward: false,
			active: true,
		};
	}

	async pressKey(key: string): Promise<void> {
		const normalized = normalizeCdpKey(key);
		await this.send("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: normalized,
			text: key.length === 1 ? key : undefined,
		});
		await this.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: normalized,
		});
	}

	async mouse(request: BrowserVirtualMouseRequest): Promise<void> {
		const action = request.action ?? "click";
		const button = request.button ?? "left";
		if (action === "move") {
			await this.dispatchMouse("mouseMoved", request.x, request.y, "none", 0);
			return;
		}
		if (action === "down") {
			await this.dispatchMouse("mousePressed", request.x, request.y, button, 1);
			return;
		}
		if (action === "up") {
			await this.dispatchMouse("mouseReleased", request.x, request.y, button, 1);
			return;
		}
		const clickCount = action === "double_click" ? 2 : 1;
		await this.dispatchMouse("mouseMoved", request.x, request.y, "none", 0);
		await this.dispatchMouse("mousePressed", request.x, request.y, button, clickCount);
		await this.dispatchMouse("mouseReleased", request.x, request.y, button, clickCount);
	}

	async getCookies(url?: string): Promise<BrowserCookieView[]> {
		const response = await this.send("Network.getCookies", { urls: [url ?? this.pageUrl] });
		const cookies = readRecordArray(response, "cookies");
		return cookies.flatMap((item): BrowserCookieView[] => {
			const record = asRecord(item);
			if (!record) return [];
			const name = readRecordString(record, "name");
			const value = readRecordString(record, "value");
			if (name === undefined || value === undefined) return [];
			return [
				{
					name,
					value,
					domain: readRecordString(record, "domain"),
					path: readRecordString(record, "path"),
					secure: readRecordBoolean(record, "secure"),
					httpOnly: readRecordBoolean(record, "httpOnly"),
					session: readRecordBoolean(record, "session"),
					expirationDate: readRecordNumber(record, "expires"),
				},
			];
		});
	}

	close(): void {
		if (!this.socket) return;
		this.socket.removeEventListener("message", this.onMessage);
		this.socket.removeEventListener("close", this.onClose);
		this.socket.removeEventListener("error", this.onError);
		this.socket.close(1000, "done");
		this.socket = undefined;
		this.rejectAll(new Error("CDP WebSocket closed."));
	}

	private async dispatchMouse(
		type: "mouseMoved" | "mousePressed" | "mouseReleased",
		x: number,
		y: number,
		button: CdpMouseButton,
		clickCount: number,
	): Promise<void> {
		await this.send("Input.dispatchMouseEvent", {
			type,
			x,
			y,
			button,
			clickCount,
		});
	}

	private async ensureSocket(): Promise<WebSocketLike> {
		if (this.socket) return this.socket;
		const ctor = resolveWebSocketConstructor();
		const socket = new ctor(this.wsUrl);
		this.socket = socket;
		socket.addEventListener("message", this.onMessage);
		socket.addEventListener("close", this.onClose);
		socket.addEventListener("error", this.onError);
		await waitForWebSocketOpen(socket);
		return socket;
	}

	private handleMessage(event: unknown): void {
		const text = eventDataToString(event);
		if (!text) return;
		const parsed = parseJsonObject(text);
		const id = readRecordNumber(parsed, "id");
		if (id === undefined) return;
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		const error = readRecord(parsed, "error");
		if (error) {
			pending.reject(new Error(readRecordString(error, "message") ?? "CDP command failed."));
			return;
		}
		pending.resolve(readRecord(parsed, "result") ?? {});
	}

	private rejectAll(error: Error): void {
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			clearTimeout(pending.timer);
			pending.reject(error);
		}
	}
}

async function loadRendererWindow(
	win: BrowserWindow,
	devServerUrl: string | undefined,
	rendererDistDir: string,
	windowMode: string,
): Promise<void> {
	if (devServerUrl) {
		const url = new URL(devServerUrl);
		url.searchParams.set("window", windowMode);
		await win.loadURL(url.toString());
		return;
	}
	await win.loadFile(join(rendererDistDir, "index.html"), { query: { window: windowMode } });
}

export function normalizeNavigationUrl(value: string): string {
	const trimmed = value.trim();
	if (!trimmed || trimmed === "about:blank") return "about:blank";
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
	if (existsSync(trimmed)) return pathToFileURL(trimmed).toString();
	return `https://${trimmed}`;
}

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).host || undefined;
	} catch {
		return undefined;
	}
}

function directorySize(path: string): number {
	try {
		const stat = statSync(path);
		if (stat.isFile()) return stat.size;
		if (!stat.isDirectory()) return 0;
		return readdirSync(path).reduce((total, entry) => total + directorySize(join(path, entry)), 0);
	} catch {
		return 0;
	}
}

function findNativeBrowserExecutable(target: NativeTarget): string | undefined {
	const env = process.env;
	const candidates =
		target === "chrome"
			? [
					env.ProgramFiles ? join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe") : "",
					env["ProgramFiles(x86)"]
						? join(env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe")
						: "",
					env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : "",
				]
			: [
					env.ProgramFiles ? join(env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe") : "",
					env["ProgramFiles(x86)"]
						? join(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe")
						: "",
					env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe") : "",
				];
	return candidates.find((candidate) => candidate && existsSync(candidate));
}

function legacyConsoleLevel(level: number): BrowserConsoleEntry["level"] {
	switch (level) {
		case 3:
			return "error";
		case 2:
			return "warning";
		case 0:
			return "debug";
		default:
			return "info";
	}
}

function normalizeConsoleLevel(level: string | BrowserConsoleEntry["level"]): BrowserConsoleEntry["level"] {
	if (level === "debug" || level === "info" || level === "warning" || level === "error") return level;
	if (level === "warn") return "warning";
	return "info";
}

function networkEntryFromCompleted(details: OnCompletedListenerDetails, tabId?: string): BrowserNetworkEntry {
	return {
		id: randomUUID(),
		ts: Date.now(),
		tabId,
		method: details.method,
		url: details.url,
		resourceType: details.resourceType,
		statusCode: details.statusCode,
		statusLine: details.statusLine,
		fromCache: details.fromCache,
	};
}

function networkEntryFromError(details: OnErrorOccurredListenerDetails, tabId?: string): BrowserNetworkEntry {
	return {
		id: randomUUID(),
		ts: Date.now(),
		tabId,
		method: details.method,
		url: details.url,
		resourceType: details.resourceType,
		error: details.error,
	};
}

function trimChars(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

function safeString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeElements(value: unknown): BrowserElementSnapshot[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): BrowserElementSnapshot[] => {
		const raw = asRecord(item);
		if (!raw) return [];
		const boundsRaw = readRecord(raw, "bounds");
		return [
			{
				index: readRecordNumber(raw, "index") ?? 0,
				tagName: readRecordString(raw, "tagName") ?? "",
				text: readRecordString(raw, "text") ?? "",
				selector: readRecordString(raw, "selector") ?? "",
				visible: Boolean(raw.visible),
				disabled: Boolean(raw.disabled),
				checked: readRecordBoolean(raw, "checked"),
				role: readRecordString(raw, "role"),
				ariaLabel: readRecordString(raw, "ariaLabel"),
				placeholder: readRecordString(raw, "placeholder"),
				href: readRecordString(raw, "href"),
				value: readRecordString(raw, "value"),
				bounds: boundsRaw
					? {
							x: readRecordNumber(boundsRaw, "x") ?? 0,
							y: readRecordNumber(boundsRaw, "y") ?? 0,
							width: readRecordNumber(boundsRaw, "width") ?? 0,
							height: readRecordNumber(boundsRaw, "height") ?? 0,
						}
					: undefined,
			},
		];
	});
}

function cookieToView(cookie: Cookie): BrowserCookieView {
	return {
		name: cookie.name,
		value: cookie.value,
		domain: cookie.domain,
		path: cookie.path,
		secure: cookie.secure,
		httpOnly: cookie.httpOnly,
		session: cookie.session,
		expirationDate: cookie.expirationDate,
	};
}

function cdpPageToTabView(page: CdpTargetInfo, active: boolean): BrowserTabView {
	return {
		id: page.id,
		title: page.title ?? "Native browser tab",
		url: page.url ?? "about:blank",
		loading: false,
		canGoBack: false,
		canGoForward: false,
		active,
	};
}

function normalizeRawPageSnapshot(value: unknown): RawPageSnapshot {
	const record = asRecord(value);
	return record ?? {};
}

function normalizeCdpEvaluation(response: unknown): unknown {
	const result = readRecord(response, "result");
	if (!result) return undefined;
	if (Object.hasOwn(result, "value")) return result.value;
	return readRecordString(result, "unserializableValue") ?? readRecordString(result, "description");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	return value as Record<string, unknown>;
}

function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
	const record = asRecord(value);
	const child = record?.[key];
	return asRecord(child);
}

function readRecordArray(value: unknown, key: string): unknown[] {
	const record = asRecord(value);
	const child = record?.[key];
	return Array.isArray(child) ? child : [];
}

function readRecordString(value: unknown, key: string): string | undefined {
	const record = asRecord(value);
	const child = record?.[key];
	return typeof child === "string" ? child : undefined;
}

function readRecordNumber(value: unknown, key: string): number | undefined {
	const record = asRecord(value);
	const child = record?.[key];
	return typeof child === "number" && Number.isFinite(child) ? child : undefined;
}

function readRecordBoolean(value: unknown, key: string): boolean | undefined {
	const record = asRecord(value);
	const child = record?.[key];
	return typeof child === "boolean" ? child : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
	try {
		return asRecord(JSON.parse(text) as unknown);
	} catch {
		return undefined;
	}
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) throw new Error(`CDP HTTP request failed: ${response.status} ${response.statusText}`);
	return response.json() as Promise<unknown>;
}

async function isNativeDebugPortReady(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/json/version`);
		return response.ok;
	} catch {
		return false;
	}
}

async function waitForNativeDebugPort(port: number): Promise<boolean> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < NATIVE_DEBUG_TIMEOUT_MS) {
		if (await isNativeDebugPortReady(port)) return true;
		await delay(200);
	}
	return false;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveWebSocketConstructor(): WebSocketConstructor {
	const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
	if (typeof ctor !== "function") throw new Error("WebSocket is not available for CDP control.");
	return ctor as WebSocketConstructor;
}

function waitForWebSocketOpen(socket: WebSocketLike): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("CDP WebSocket open timed out."));
		}, 10000);
		const cleanup = () => {
			clearTimeout(timer);
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
		};
		const onOpen = () => {
			cleanup();
			resolve();
		};
		const onError = () => {
			cleanup();
			reject(new Error("CDP WebSocket failed to open."));
		};
		const onClose = () => {
			cleanup();
			reject(new Error("CDP WebSocket closed before opening."));
		};
		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
	});
}

function eventDataToString(event: unknown): string | undefined {
	const data = (event as { data?: unknown }).data;
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf-8");
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf-8");
	return undefined;
}

function normalizeCdpKey(key: string): string {
	if (key.length === 1) return key;
	const normalized = key.toLowerCase();
	const map: Record<string, string> = {
		enter: "Enter",
		return: "Enter",
		escape: "Escape",
		esc: "Escape",
		tab: "Tab",
		backspace: "Backspace",
		delete: "Delete",
		space: " ",
		arrowup: "ArrowUp",
		arrowdown: "ArrowDown",
		arrowleft: "ArrowLeft",
		arrowright: "ArrowRight",
	};
	return map[normalized] ?? key;
}

function pageSnapshotScript(includeElements: boolean): string {
	return `
(() => {
	const cssEscape = (value) => {
		if (window.CSS && window.CSS.escape) return window.CSS.escape(value);
		return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
	};
	const selectorFor = (el) => {
		if (!(el instanceof Element)) return "";
		if (el.id) return "#" + cssEscape(el.id);
		const parts = [];
		let current = el;
		while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
			let part = current.tagName.toLowerCase();
			if (current.classList.length > 0) {
				part += "." + Array.from(current.classList).slice(0, 2).map(cssEscape).join(".");
			}
			const parent = current.parentElement;
			if (parent) {
				const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
				if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
			}
			parts.unshift(part);
			current = parent;
		}
		return parts.join(" > ");
	};
	const visible = (el) => {
		const rect = el.getBoundingClientRect();
		const style = window.getComputedStyle(el);
		return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
	};
	const elementSnapshot = (el, index) => {
		const rect = el.getBoundingClientRect();
		return {
			index,
			tagName: el.tagName.toLowerCase(),
			text: (el.innerText || el.textContent || "").trim().slice(0, 500),
			selector: selectorFor(el),
			visible: visible(el),
			disabled: Boolean(el.disabled),
			checked: typeof el.checked === "boolean" ? el.checked : undefined,
			role: el.getAttribute("role") || undefined,
			ariaLabel: el.getAttribute("aria-label") || undefined,
			placeholder: el.getAttribute("placeholder") || undefined,
			href: el.href || undefined,
			value: typeof el.value === "string" ? el.value.slice(0, 500) : undefined,
			bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
		};
	};
	const interactive = ${includeElements ? `Array.from(document.querySelectorAll("a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true],[tabindex]")).slice(0, 120).map(elementSnapshot)` : "undefined"};
	return {
		title: document.title,
		url: location.href,
		text: (document.body ? document.body.innerText : document.documentElement.innerText || "").trim(),
		html: document.documentElement.outerHTML,
		source: document.documentElement.outerHTML,
		elements: interactive,
	};
})()
`;
}

function queryElementsScript(options: { selector?: string; text?: string; limit: number }): string {
	return `
(() => {
	const selector = ${JSON.stringify(options.selector ?? "")};
	const text = ${JSON.stringify(options.text?.toLowerCase() ?? "")};
	const limit = ${options.limit};
	const cssEscape = (value) => window.CSS && window.CSS.escape ? window.CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
	const selectorFor = (el) => {
		if (el.id) return "#" + cssEscape(el.id);
		const parts = [];
		let current = el;
		while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
			let part = current.tagName.toLowerCase();
			if (current.classList.length > 0) part += "." + Array.from(current.classList).slice(0, 2).map(cssEscape).join(".");
			const parent = current.parentElement;
			if (parent) {
				const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
				if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
			}
			parts.unshift(part);
			current = parent;
		}
		return parts.join(" > ");
	};
	const visible = (el) => {
		const rect = el.getBoundingClientRect();
		const style = window.getComputedStyle(el);
		return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
	};
	const nodes = Array.from(document.querySelectorAll(selector || "a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true],[tabindex]"));
	return nodes.filter((el) => !text || ((el.innerText || el.textContent || el.value || "").toLowerCase().includes(text))).slice(0, limit).map((el, index) => {
		const rect = el.getBoundingClientRect();
		return {
			index,
			tagName: el.tagName.toLowerCase(),
			text: (el.innerText || el.textContent || "").trim().slice(0, 500),
			selector: selectorFor(el),
			visible: visible(el),
			disabled: Boolean(el.disabled),
			checked: typeof el.checked === "boolean" ? el.checked : undefined,
			role: el.getAttribute("role") || undefined,
			ariaLabel: el.getAttribute("aria-label") || undefined,
			placeholder: el.getAttribute("placeholder") || undefined,
			href: el.href || undefined,
			value: typeof el.value === "string" ? el.value.slice(0, 500) : undefined,
			bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
		};
	});
})()
`;
}

function elementActionScript(kind: "click" | "type", request: BrowserElementActionRequest): string {
	return `
(() => {
	const selector = ${JSON.stringify(request.selector ?? "")};
	const index = ${request.elementIndex ?? -1};
	const text = ${JSON.stringify(request.text ?? "")};
	const clearFirst = ${request.clearFirst === false ? "false" : "true"};
	const elements = Array.from(document.querySelectorAll(selector || "a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true],[tabindex]"));
	const el = selector ? document.querySelector(selector) : elements[index];
	if (!el) throw new Error("Element not found");
	el.scrollIntoView({ block: "center", inline: "center" });
	el.focus();
	if (${JSON.stringify(kind)} === "click") {
		el.click();
		return true;
	}
	if ("value" in el) {
		if (clearFirst) el.value = "";
		el.value += text;
		el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
		return true;
	}
	if (el.isContentEditable) {
		if (clearFirst) el.textContent = "";
		el.textContent = (el.textContent || "") + text;
		el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
		return true;
	}
	throw new Error("Element is not editable");
})()
`;
}

function sendKey(webContents: WebContents, key: string): void {
	const normalized = key.length === 1 ? key : key.toLowerCase();
	const keyCode = key.length === 1 ? key : normalizeKeyCode(normalized);
	webContents.sendInputEvent({ type: "keyDown", keyCode });
	webContents.sendInputEvent({ type: "keyUp", keyCode });
}

function normalizeKeyCode(key: string): string {
	const map: Record<string, string> = {
		enter: "Enter",
		return: "Enter",
		escape: "Escape",
		esc: "Escape",
		tab: "Tab",
		backspace: "Backspace",
		delete: "Delete",
		space: "Space",
		arrowup: "Up",
		arrowdown: "Down",
		arrowleft: "Left",
		arrowright: "Right",
	};
	return map[key] ?? key;
}
