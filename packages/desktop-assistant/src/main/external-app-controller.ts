import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { BrowserWindow } from "electron";
import type { ExternalAppToolHost } from "../agent/app-bridge-tools.ts";
import type {
	ExternalAppConfig,
	ExternalAppManifest,
	ExternalAppStatus,
	MoreAppEvent,
	MoreAppTerminalLine,
	MoreAppTerminalResponse,
	MoreAppView,
} from "../shared/types.ts";
import type { ExternalAppRegistry } from "./external-app-registry.ts";

const MAX_TERMINAL_LINES = 500;
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_INTERVAL_MS = 400;

interface AppRuntime {
	manifest: ExternalAppManifest;
	status: ExternalAppStatus;
	child?: ChildProcess;
	window?: BrowserWindow;
	port?: number;
	url?: string;
	error?: string;
	terminal: MoreAppTerminalLine[];
	seq: number;
	/** In-flight start, so concurrent callers share one launch. */
	starting?: Promise<void>;
	/** Timestamp of last AI call or window interaction — drives idle auto-close. */
	lastUsedAt: number;
	/** Pending auto-close timer (setTimeout handle). */
	idleTimer?: ReturnType<typeof setTimeout>;
}

interface ExternalAppControllerOptions {
	registry: ExternalAppRegistry;
	addWindow: (window: BrowserWindow, label: string) => void;
	/** Pushes status / terminal events to the renderer (main window). */
	emit?: (event: MoreAppEvent) => void;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reserve a free ephemeral port on the loopback interface. */
function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => (port ? resolve(port) : reject(new Error("无法分配端口"))));
		});
	});
}

/** Replace the literal "{port}" token. */
function substitute(value: string, port: number): string {
	return value.replace(/\{port\}/g, String(port));
}

/**
 * Manages "更多应用": each integrated app is launched as a child process (a local
 * web server) and shown in its own window; the AI drives it over HTTP. Mirrors the
 * lifecycle / event conventions of built-in-browser-controller.ts.
 */
export class ExternalAppController {
	private readonly registry: ExternalAppRegistry;
	private readonly options: ExternalAppControllerOptions;
	private readonly runtimes = new Map<string, AppRuntime>();

	constructor(options: ExternalAppControllerOptions) {
		this.registry = options.registry;
		this.options = options;
	}

	// ── Renderer-facing API ──────────────────────────────────────────────────

	listApps(): MoreAppView[] {
		return this.buildViews();
	}

	async startApp(appId: string): Promise<MoreAppView[]> {
		await this.ensureStarted(appId);
		return this.buildViews();
	}

	stopApp(appId: string): MoreAppView[] {
		const runtime = this.runtimes.get(appId);
		if (runtime) {
			this.clearIdleTimer(runtime);
			this.closeWindow(runtime);
			this.terminate(runtime);
			runtime.status = "stopped";
			runtime.url = undefined;
			runtime.error = undefined;
			this.pushTerminal(runtime, "system", "已停止应用进程。");
		}
		this.emitStatus();
		return this.buildViews();
	}

	async openApp(appId: string): Promise<MoreAppView[]> {
		const runtime = await this.ensureStarted(appId);
		this.touchApp(runtime);
		this.ensureWindow(runtime);
		this.emitStatus();
		return this.buildViews();
	}

	async openAppAtPath(appId: string, path: string): Promise<MoreAppView[]> {
		const runtime = await this.ensureStarted(appId);
		this.touchApp(runtime);
		const base = (
			runtime.url ?? substitute(runtime.manifest.urlPattern, runtime.port ?? runtime.manifest.port ?? 0)
		).replace(/\/$/, "");
		const subPath = path.startsWith("/") ? path : `/${path}`;
		this.ensureWindow(runtime, `${base}${subPath}`);
		this.emitStatus();
		return this.buildViews();
	}

	getTerminal(appId: string): MoreAppTerminalResponse {
		const runtime = this.runtimes.get(appId);
		return { appId, lines: runtime ? [...runtime.terminal] : [] };
	}

	updateConfig(appId: string, config: ExternalAppConfig): MoreAppView[] {
		const updated = this.registry.updateConfig(appId, config);
		const runtime = this.runtimes.get(appId);
		if (runtime && updated) {
			runtime.manifest = updated;
			// Re-arm the idle timer with the new timeout value.
			if (runtime.status === "running") this.rescheduleIdleTimer(runtime);
		}
		this.emitStatus();
		return this.buildViews();
	}

	/** Apps flagged autoStart: launched once the main window is ready. */
	async startAutoStartApps(): Promise<void> {
		for (const manifest of this.registry.list()) {
			if (!manifest.autoStart) continue;
			await this.ensureStarted(manifest.id).catch((error: unknown) => {
				console.error(`Auto-start of ${manifest.id} failed:`, error);
			});
		}
	}

	/** Kill every child process / window. Call on app quit. */
	dispose(): void {
		for (const runtime of this.runtimes.values()) {
			this.clearIdleTimer(runtime);
			this.closeWindow(runtime);
			this.terminate(runtime);
		}
		this.runtimes.clear();
	}

	// ── AI tool host ─────────────────────────────────────────────────────────

	toolHost(): ExternalAppToolHost {
		return {
			listManifests: () => this.registry.list(),
			getRunningBaseUrl: (appId: string) => {
				const runtime = this.runtimes.get(appId);
				if (!runtime || runtime.status !== "running" || !runtime.port) return undefined;
				return `http://127.0.0.1:${runtime.port}`;
			},
			ensureRunning: async (appId: string) => {
				const runtime = await this.ensureStarted(appId);
				if (runtime.status === "error" || !runtime.port) {
					throw new Error(runtime.error ?? `应用 ${appId} 未能启动`);
				}
				this.touchApp(runtime);
				return { manifest: runtime.manifest, baseUrl: `http://127.0.0.1:${runtime.port}` };
			},
			openAtPath: async (appId: string, path: string) => {
				await this.openAppAtPath(appId, path);
			},
		};
	}

	// ── Lifecycle internals ──────────────────────────────────────────────────

	private getRuntime(appId: string): AppRuntime {
		let runtime = this.runtimes.get(appId);
		if (!runtime) {
			const manifest = this.registry.get(appId);
			if (!manifest) throw new Error(`未知应用: ${appId}`);
			runtime = { manifest, status: "stopped", terminal: [], seq: 0, lastUsedAt: Date.now() };
			this.runtimes.set(appId, runtime);
		} else {
			// Pick up the latest config (port / command overrides) on each launch.
			const manifest = this.registry.get(appId);
			if (manifest) runtime.manifest = manifest;
		}
		return runtime;
	}

	private async ensureStarted(appId: string): Promise<AppRuntime> {
		const runtime = this.getRuntime(appId);
		if (runtime.status === "running") return runtime;
		if (runtime.starting) {
			await runtime.starting;
			return runtime;
		}
		runtime.starting = this.launch(runtime).finally(() => {
			runtime.starting = undefined;
		});
		await runtime.starting;
		return runtime;
	}

	private async launch(runtime: AppRuntime): Promise<void> {
		const manifest = runtime.manifest;
		runtime.status = "starting";
		runtime.error = undefined;
		this.emitStatus();

		let port: number;
		try {
			port = manifest.port ?? (await findFreePort());
		} catch (error) {
			this.fail(runtime, `端口分配失败：${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		runtime.port = port;

		const args = manifest.args.map((arg) => substitute(arg, port));
		const env: Record<string, string> = { ...(process.env as Record<string, string>) };
		for (const [key, value] of Object.entries(manifest.env ?? {})) env[key] = substitute(value, port);

		this.pushTerminal(runtime, "system", `启动：${manifest.command} ${args.join(" ")}  (cwd=${manifest.cwd})`);

		let child: ChildProcess;
		try {
			child = spawn(manifest.command, args, {
				cwd: manifest.cwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			this.fail(runtime, `进程启动失败：${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		runtime.child = child;

		child.stdout?.on("data", (buf: Buffer) => this.pushTerminal(runtime, "stdout", buf.toString()));
		child.stderr?.on("data", (buf: Buffer) => this.pushTerminal(runtime, "stderr", buf.toString()));
		child.on("error", (error: Error) => {
			this.pushTerminal(runtime, "system", `进程错误：${error.message}`);
			this.fail(runtime, error.message);
		});
		child.on("exit", (code, signal) => {
			runtime.child = undefined;
			this.pushTerminal(
				runtime,
				"system",
				`进程已退出（code=${code ?? "?"}${signal ? `, signal=${signal}` : ""}）。`,
			);
			if (runtime.status !== "stopped") {
				if (runtime.status === "running") {
					runtime.status = "stopped";
				} else {
					this.fail(runtime, `进程提前退出（code=${code ?? "?"}）`);
					return;
				}
			}
			runtime.url = undefined;
			this.emitStatus();
		});

		const healthUrl = `${substitute(manifest.urlPattern, port).replace(/\/$/, "")}${manifest.healthPath}`;
		const ready = await this.probeHealth(healthUrl, () => Boolean(runtime.child) && !runtime.child?.killed);

		if (!runtime.child) return; // exited during probe; exit handler already set state
		if (ready) {
			runtime.status = "running";
			runtime.url = substitute(manifest.urlPattern, port);
			this.pushTerminal(runtime, "system", `就绪：${runtime.url}`);
		} else {
			// Server didn't answer in time but the process is alive — still usable; the
			// window / AI call will surface any real error. Don't hard-fail the launch.
			runtime.status = "running";
			runtime.url = substitute(manifest.urlPattern, port);
			this.pushTerminal(runtime, "system", `健康探测超时，但进程仍在运行：${runtime.url}`);
		}
		this.touchApp(runtime);
		this.emitStatus();
	}

	private async probeHealth(url: string, isAlive: () => boolean): Promise<boolean> {
		const deadline = Date.now() + HEALTH_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (!isAlive()) return false;
			try {
				await fetch(url, { signal: AbortSignal.timeout(2500) });
				return true; // any HTTP response means the server is accepting connections
			} catch {
				// not ready yet
			}
			await delay(HEALTH_INTERVAL_MS);
		}
		return false;
	}

	private fail(runtime: AppRuntime, message: string): void {
		runtime.status = "error";
		runtime.error = message;
		runtime.url = undefined;
		this.emitStatus();
	}

	private terminate(runtime: AppRuntime): void {
		const child = runtime.child;
		runtime.child = undefined;
		if (!child) return;
		if (process.platform === "win32" && child.pid) {
			// Kill the whole tree — uvicorn / flask may have spawned workers.
			try {
				spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			} catch {
				child.kill();
			}
		} else {
			child.kill();
		}
	}

	// ── Window ─────────────────────────────────────────────────────────────────

	/**
	 * Open or focus the app's window. If `url` is given and the window already
	 * exists, navigate to it; otherwise open a new window at `url` (or the app
	 * root when `url` is omitted).
	 */
	private ensureWindow(runtime: AppRuntime, url?: string): void {
		const targetUrl =
			url ?? runtime.url ?? substitute(runtime.manifest.urlPattern, runtime.port ?? runtime.manifest.port ?? 0);
		if (runtime.window && !runtime.window.isDestroyed()) {
			this.clearIdleTimer(runtime);
			if (runtime.window.isMinimized()) runtime.window.restore();
			runtime.window.show();
			runtime.window.focus();
			if (url) {
				void runtime.window.loadURL(url).catch((error: unknown) => {
					this.pushTerminal(
						runtime,
						"system",
						`跳转失败：${error instanceof Error ? error.message : String(error)}`,
					);
				});
			}
			return;
		}
		const manifest = runtime.manifest;
		const win = new BrowserWindow({
			width: 1180,
			height: 800,
			minWidth: 820,
			minHeight: 560,
			title: manifest.name,
			backgroundColor: "#1c1c20",
			autoHideMenuBar: true,
			show: true,
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				// No preload: the window hosts a self-contained external web app.
			},
		});
		runtime.window = win;
		this.clearIdleTimer(runtime);
		this.options.addWindow(win, `app:${manifest.id}`);
		win.on("closed", () => {
			const closedCurrentWindow = runtime.window === win;
			if (closedCurrentWindow) runtime.window = undefined;
			if (closedCurrentWindow && runtime.status === "running") this.touchApp(runtime);
			this.emitStatus();
		});
		void win.loadURL(targetUrl).catch((error: unknown) => {
			this.pushTerminal(
				runtime,
				"system",
				`窗口加载失败：${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}

	private closeWindow(runtime: AppRuntime): void {
		const win = runtime.window;
		runtime.window = undefined;
		if (win && !win.isDestroyed()) win.destroy();
	}

	// ── Events / views ───────────────────────────────────────────────────────

	private pushTerminal(runtime: AppRuntime, stream: MoreAppTerminalLine["stream"], text: string): void {
		const trimmed = text.replace(/\r/g, "");
		const line: MoreAppTerminalLine = { seq: ++runtime.seq, stream, text: trimmed, at: Date.now() };
		runtime.terminal.push(line);
		if (runtime.terminal.length > MAX_TERMINAL_LINES) {
			runtime.terminal.splice(0, runtime.terminal.length - MAX_TERMINAL_LINES);
		}
		this.options.emit?.({ type: "terminal", appId: runtime.manifest.id, line });
	}

	private emitStatus(): void {
		this.options.emit?.({ type: "status", apps: this.buildViews() });
	}

	private buildViews(): MoreAppView[] {
		return this.registry.list().map((manifest) => {
			const runtime = this.runtimes.get(manifest.id);
			const windowOpen = Boolean(runtime?.window && !runtime.window.isDestroyed());
			return {
				id: manifest.id,
				name: manifest.name,
				description: manifest.description,
				icon: manifest.icon,
				status: runtime?.status ?? "stopped",
				autoStart: manifest.autoStart,
				idleTimeoutMinutes: manifest.idleTimeoutMinutes,
				builtIn: Boolean(manifest.builtIn),
				port: runtime?.port,
				url: runtime?.url,
				windowOpen,
				error: runtime?.error,
				aiEnabled: Boolean(manifest.ai),
				commandLine: `${manifest.command} ${manifest.args.join(" ")}`,
			};
		});
	}

	// ── Idle auto-close ──────────────────────────────────────────────────────

	/** Record a usage event and re-arm the idle timer. */
	private touchApp(runtime: AppRuntime): void {
		runtime.lastUsedAt = Date.now();
		this.rescheduleIdleTimer(runtime);
	}

	/**
	 * Cancel any pending idle timer and set a new one based on the manifest's
	 * current idleTimeoutMinutes. Fires once after the idle window expires with
	 * no intervening touch.  Uses unref() so the Node process can exit normally.
	 */
	private rescheduleIdleTimer(runtime: AppRuntime): void {
		this.clearIdleTimer(runtime);
		const minutes = runtime.manifest.idleTimeoutMinutes;
		if (
			!minutes ||
			minutes <= 0 ||
			runtime.status !== "running" ||
			Boolean(runtime.window && !runtime.window.isDestroyed())
		) {
			return;
		}
		const appId = runtime.manifest.id;
		const timer = setTimeout(() => {
			runtime.idleTimer = undefined;
			if (runtime.status !== "running") return;
			this.pushTerminal(runtime, "system", `空闲超过 ${minutes} 分钟，自动关闭。`);
			this.stopApp(appId);
		}, minutes * 60_000);
		(timer as unknown as { unref?: () => void }).unref?.();
		runtime.idleTimer = timer;
	}

	private clearIdleTimer(runtime: AppRuntime): void {
		if (runtime.idleTimer !== undefined) {
			clearTimeout(runtime.idleTimer);
			runtime.idleTimer = undefined;
		}
	}
}
