import * as fs from "node:fs";
import * as path from "node:path";
import type { SandboxCleanStrategy, SandboxSettings, SandboxStatus } from "../../shared/types.ts";
import type { SandboxRuntimeState } from "./policy-engine.ts";
import {
	buildSandboxPathContext,
	canonicalize,
	expandRoots,
	isWithin,
	resolvePathToken,
	type SandboxPathContext,
} from "./sandbox-workspace.ts";

export interface SandboxProbeResult {
	stdout: string;
	stderr: string;
}

export interface SandboxManagerDeps {
	/** Fallback root when settings.workspace.rootDir is unset (e.g. userData/sandbox). */
	defaultRoot: string;
	getSettings: () => SandboxSettings;
	/** Known OS dirs (documents/desktop/downloads/appResources/...) supplied by main. */
	pathOverrides?: Partial<SandboxPathContext>;
	/** Runs a PowerShell probe with the given cwd; omitted in tests that skip warm-up. */
	runProbe?: (
		script: string,
		opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
	) => Promise<SandboxProbeResult>;
	onStatus?: (status: SandboxStatus) => void;
	now?: () => number;
}

const STUCK_AFTER_ATTEMPTS = 3;
const USAGE_TTL_MS = 5000;
const INFRA_DIRS = ["tmp", "attachments"];

export interface SandboxCleanOutcome {
	status: SandboxStatus;
	removedEntries: number;
	freedMb: number;
}

export interface SandboxCopyOutcome {
	path: string;
	sizeMb: number;
}

/**
 * Owns the sandbox workspace lifecycle: async (non-blocking) initialization with
 * progress, quota accounting, import/export across the sandbox boundary, and
 * cleanup. Pure path/policy logic lives in sandbox-workspace / policy-engine.
 */
export class SandboxManager {
	private readonly deps: SandboxManagerDeps;
	private status: SandboxStatus;
	private initInFlight?: Promise<void>;
	private usageCache?: { mb: number; at: number };

	constructor(deps: SandboxManagerDeps) {
		this.deps = deps;
		const settings = deps.getSettings();
		this.status = {
			phase: "uninitialized",
			progress: 0,
			currentStep: "未初始化",
			rootDir: this.resolveRoot(settings),
			usageMb: 0,
			quotaMb: settings.workspace.quotaMb,
			attempts: 0,
			updatedAt: this.now(),
		};
	}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	private resolveRoot(settings: SandboxSettings): string {
		const configured = settings.workspace.rootDir?.trim();
		const ctx = buildSandboxPathContext({ ...this.deps.pathOverrides, sandboxRoot: this.deps.defaultRoot });
		const raw = configured ? resolvePathToken(configured, ctx) : this.deps.defaultRoot;
		return canonicalize(raw || this.deps.defaultRoot, this.deps.defaultRoot, { realpath: false });
	}

	pathContext(): SandboxPathContext {
		const settings = this.deps.getSettings();
		return buildSandboxPathContext({ ...this.deps.pathOverrides, sandboxRoot: this.resolveRoot(settings) });
	}

	/**
	 * Real OS folder paths (resolved at runtime via the host's app.getPath, never
	 * hardcoded) the AI can use when delivering artifacts. Exposed through
	 * sandbox_status so the model targets the actual Desktop/Documents/Downloads
	 * (which may be on any drive) instead of guessing C:\Users\….
	 */
	knownPaths(): {
		sandboxRoot: string;
		temp: string;
		home: string;
		desktop: string;
		documents: string;
		downloads: string;
	} {
		const ctx = this.pathContext();
		return {
			sandboxRoot: ctx.sandboxRoot,
			temp: ctx.tempDir,
			home: ctx.home,
			desktop: ctx.desktop,
			documents: ctx.documents,
			downloads: ctx.downloads,
		};
	}

	/** Snapshot of the canonicalized roots + phase used by the policy engine. */
	getRuntimeState(): SandboxRuntimeState {
		const settings = this.deps.getSettings();
		const ctx = this.pathContext();
		return {
			phase: this.status.phase,
			sandboxRoot: canonicalize(ctx.sandboxRoot, ctx.sandboxRoot, { realpath: false }),
			writeRoots: expandRoots(settings.filesystem.writeRoots, ctx),
			readRoots: expandRoots(settings.filesystem.readRoots, ctx),
			protectedPaths: expandRoots(settings.filesystem.protectedPaths, ctx),
		};
	}

	getStatus(): SandboxStatus {
		return { ...this.status, quotaMb: this.deps.getSettings().workspace.quotaMb };
	}

	private setStatus(patch: Partial<SandboxStatus>): void {
		this.status = { ...this.status, ...patch, updatedAt: this.now() };
		this.deps.onStatus?.(this.getStatus());
	}

	get root(): string {
		return this.status.rootDir ?? this.resolveRoot(this.deps.getSettings());
	}

	/** Kick (or join) initialization. Safe to call repeatedly; never throws. */
	init(): Promise<void> {
		if (this.status.phase === "ready") return Promise.resolve();
		if (this.initInFlight) return this.initInFlight;
		this.initInFlight = this.runInit().finally(() => {
			this.initInFlight = undefined;
		});
		return this.initInFlight;
	}

	private async runInit(): Promise<void> {
		const attempts = this.status.attempts + 1;
		const root = this.resolveRoot(this.deps.getSettings());
		this.setStatus({
			phase: "initializing",
			progress: 5,
			currentStep: "创建沙箱目录",
			rootDir: root,
			attempts,
			lastError: undefined,
		});
		try {
			fs.mkdirSync(root, { recursive: true });
			for (const dir of INFRA_DIRS) fs.mkdirSync(path.join(root, dir), { recursive: true });

			this.setStatus({ progress: 35, currentStep: "校验可写" });
			const probeFile = path.join(root, ".sandbox-write-probe");
			fs.writeFileSync(probeFile, "ok", "utf8");
			if (fs.readFileSync(probeFile, "utf8") !== "ok") throw new Error("沙箱目录写入校验失败");
			fs.rmSync(probeFile, { force: true });

			this.setStatus({ progress: 60, currentStep: "统计用量与配额" });
			const usageMb = this.refreshUsage();

			this.setStatus({ progress: 80, currentStep: "预热运行环境" });
			if (this.deps.runProbe && this.deps.getSettings().workspace.keepWarmProcess) {
				const probe = await this.deps.runProbe("Write-Output 'sandbox-ready'", { cwd: root, timeoutMs: 15000 });
				if (!/sandbox-ready/.test(probe.stdout)) {
					throw new Error(`沙箱运行环境探针失败：${probe.stderr || probe.stdout || "无输出"}`);
				}
			}

			this.setStatus({ phase: "ready", progress: 100, currentStep: "就绪", usageMb });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const phase = attempts >= STUCK_AFTER_ATTEMPTS ? "stuck" : "failed";
			this.setStatus({ phase, currentStep: "初始化失败", lastError: message });
		}
	}

	/** Reset attempts and re-run initialization (used by the "retry" button / tool). */
	async retry(): Promise<SandboxStatus> {
		this.setStatus({ attempts: 0 });
		await this.init();
		return this.getStatus();
	}

	/** Clear the workspace contents and re-initialize. */
	async reset(): Promise<SandboxStatus> {
		const root = this.root;
		try {
			if (fs.existsSync(root)) {
				for (const entry of fs.readdirSync(root)) {
					fs.rmSync(path.join(root, entry), { recursive: true, force: true });
				}
			}
		} catch {
			// best effort
		}
		this.usageCache = undefined;
		this.status = { ...this.status, phase: "uninitialized", progress: 0, attempts: 0, currentStep: "已重置" };
		await this.retry();
		return this.getStatus();
	}

	// ── Quota / usage ────────────────────────────────────────────────────────

	private dirSizeBytes(target: string): number {
		let total = 0;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(target, { withFileTypes: true });
		} catch {
			return 0;
		}
		for (const entry of entries) {
			const full = path.join(target, entry.name);
			if (entry.isDirectory()) {
				total += this.dirSizeBytes(full);
			} else if (entry.isFile()) {
				try {
					total += fs.statSync(full).size;
				} catch {
					// ignore vanished files
				}
			}
		}
		return total;
	}

	private refreshUsage(): number {
		const bytes = this.dirSizeBytes(this.root);
		const mb = Math.round((bytes / (1024 * 1024)) * 100) / 100;
		this.usageCache = { mb, at: this.now() };
		this.status = { ...this.status, usageMb: mb };
		return mb;
	}

	usageMb(): number {
		if (this.usageCache && this.now() - this.usageCache.at < USAGE_TTL_MS) return this.usageCache.mb;
		return this.refreshUsage();
	}

	/** Fraction of quota currently used (0..1+). */
	usageFraction(): number {
		const quota = this.deps.getSettings().workspace.quotaMb;
		if (quota <= 0) return 0;
		return this.usageMb() / quota;
	}

	private childEntries(): Array<{ name: string; full: string; sizeBytes: number; mtimeMs: number }> {
		const root = this.root;
		const out: Array<{ name: string; full: string; sizeBytes: number; mtimeMs: number }> = [];
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(root, { withFileTypes: true });
		} catch {
			return out;
		}
		for (const entry of entries) {
			if (INFRA_DIRS.includes(entry.name)) continue;
			const full = path.join(root, entry.name);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(full);
			} catch {
				continue;
			}
			const sizeBytes = entry.isDirectory() ? this.dirSizeBytes(full) : stat.size;
			out.push({ name: entry.name, full, sizeBytes, mtimeMs: stat.mtimeMs });
		}
		return out;
	}

	/** Delete workspace entries to reclaim space. Returns how much was freed. */
	clean(strategy: SandboxCleanStrategy = "oldest", targetMb?: number): SandboxCleanOutcome {
		const entries = this.childEntries();
		let order = entries;
		if (strategy === "oldest") order = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs);
		else if (strategy === "largest") order = [...entries].sort((a, b) => b.sizeBytes - a.sizeBytes);

		const goalBytes = strategy === "all" ? Infinity : (targetMb ?? this.usageMb()) * 1024 * 1024;
		let freedBytes = 0;
		let removed = 0;
		for (const entry of order) {
			if (strategy !== "all" && freedBytes >= goalBytes) break;
			try {
				fs.rmSync(entry.full, { recursive: true, force: true });
				freedBytes += entry.sizeBytes;
				removed += 1;
			} catch {
				// skip locked files
			}
		}
		this.refreshUsage();
		return {
			status: this.getStatus(),
			removedEntries: removed,
			freedMb: Math.round((freedBytes / (1024 * 1024)) * 100) / 100,
		};
	}

	/** Auto-clean oldest entries to bring usage back under quota (best effort). */
	enforceQuota(): void {
		const settings = this.deps.getSettings();
		if (settings.workspace.overQuotaPolicy !== "auto_clean") return;
		if (this.usageMb() <= settings.workspace.quotaMb) return;
		const target = settings.workspace.quotaMb * (settings.workspace.warnAtPercent / 100);
		this.clean("oldest", Math.max(0, this.usageMb() - target));
	}

	// ── Import / export across the boundary ──────────────────────────────────

	/** True when a sandbox-relative (or in-root absolute) path exists. */
	existsInside(relative: string): boolean {
		try {
			return fs.existsSync(this.resolveInside(relative));
		} catch {
			return false;
		}
	}

	/** Resolve a relative path inside the sandbox, refusing escapes. */
	resolveInside(relative: string): string {
		const abs = path.isAbsolute(relative)
			? canonicalize(relative, this.root)
			: canonicalize(path.join(this.root, relative), this.root);
		if (!isWithin(canonicalize(this.root, this.root, { realpath: false }), abs)) {
			throw new Error(`路径越出沙箱根目录：${relative}`);
		}
		return abs;
	}

	/** Copy a real-machine file/dir into the sandbox (real → sandbox). */
	importPath(source: string, destRelative?: string): SandboxCopyOutcome {
		const src = canonicalize(source, this.root);
		if (!fs.existsSync(src)) throw new Error(`源路径不存在：${source}`);
		const dest = this.resolveInside(destRelative ?? path.basename(src));
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.cpSync(src, dest, { recursive: true });
		this.refreshUsage();
		return {
			path: dest,
			sizeMb:
				Math.round(
					(this.dirSizeBytes(fs.statSync(dest).isDirectory() ? dest : path.dirname(dest)) / (1024 * 1024)) * 100,
				) / 100,
		};
	}

	/**
	 * Copy a finished artifact out of the sandbox to a real destination
	 * (sandbox → real). Caller is responsible for gating this boundary crossing.
	 */
	exportPath(sourceRelative: string, destination: string): SandboxCopyOutcome {
		const src = this.resolveInside(sourceRelative);
		if (!fs.existsSync(src)) throw new Error(`沙箱内源路径不存在：${sourceRelative}`);
		const dest = canonicalize(destination, this.root);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.cpSync(src, dest, { recursive: true });
		const size = fs.statSync(dest).isDirectory() ? this.dirSizeBytes(dest) : fs.statSync(dest).size;
		return { path: dest, sizeMb: Math.round((size / (1024 * 1024)) * 100) / 100 };
	}

	/** Flat listing of workspace entries with sizes. */
	list(): Array<{ name: string; sizeMb: number; modifiedAt: number; isDirectory: boolean }> {
		return this.childEntries().map((e) => ({
			name: e.name,
			sizeMb: Math.round((e.sizeBytes / (1024 * 1024)) * 100) / 100,
			modifiedAt: e.mtimeMs,
			isDirectory: fs.existsSync(e.full) && fs.statSync(e.full).isDirectory(),
		}));
	}
}
