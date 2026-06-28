import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExternalAppConfig, ExternalAppManifest } from "../shared/types.ts";

/**
 * The "更多应用" registry. Each integrated app is a local web service the
 * assistant spawns and shows in its own window (see external-app-controller.ts).
 *
 * Built-in manifests below point at the user's local project checkouts. They are
 * intentionally machine-specific defaults; users can override the port / launch
 * command per app, and the overrides persist to agentDir/more-apps.json.
 */

const EMAIL_MANAGER_ROOT = "C:\\pythonProject\\Email-manager";
const EBOOK_ROOT = "C:\\pythonProject\\E-Book";

/** Path to a project's venv python on Windows. */
function venvPython(root: string): string {
	return join(root, ".venv", "Scripts", "python.exe");
}

function builtInManifests(): ExternalAppManifest[] {
	return [
		{
			id: "email-manager",
			name: "邮箱管家",
			description: "多邮箱管理：快速收件、提取验证码、总结邮件。",
			icon: "📧",
			cwd: join(EMAIL_MANAGER_ROOT, "backend"),
			command: venvPython(EMAIL_MANAGER_ROOT),
			// Single-process: FastAPI serves both the built Vue UI ("/") and /api/v1.
			// Fixed port 8001 because the Graph OAuth redirect URI is registered for it.
			args: ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "{port}"],
			port: 8001,
			urlPattern: "http://127.0.0.1:{port}/",
			healthPath: "/health",
			autoStart: false,
			builtIn: true,
			ai: { basePath: "/api/v1", allowPrefixes: ["/mailboxes", "/groups", "/dashboard"] },
		},
		{
			id: "ebook-library",
			name: "电子书库",
			description: "从在线书库检索并抽取书籍到本地书架，支持 AI 管理书架与发起抓取任务。",
			icon: "📚",
			cwd: EBOOK_ROOT,
			command: venvPython(EBOOK_ROOT),
			args: ["main.py"],
			// E-Book already honours these env vars: port, no auto-open, no reloader fork.
			env: { EBOOK_PORT: "{port}", EBOOK_OPEN_BROWSER: "0", EBOOK_DEBUG: "0" },
			urlPattern: "http://127.0.0.1:{port}/",
			healthPath: "/health",
			autoStart: false,
			builtIn: true,
			// basePath is "" because E-Book routes live at root (no /api prefix).
			// /extract covers start/preview/jobs/status/<id>/retry-failed; /api/books covers all book CRUD.
			ai: { basePath: "", allowPrefixes: ["/api/books", "/extract"] },
		},
	];
}

interface PersistedRegistry {
	version: number;
	/** Per-app user overrides keyed by app id. */
	apps: Record<string, ExternalAppConfig>;
}

const REGISTRY_VERSION = 1;

export class ExternalAppRegistry {
	private readonly filePath: string;
	private configs: Record<string, ExternalAppConfig> = {};

	constructor(agentDir: string) {
		this.filePath = join(agentDir, "more-apps.json");
		this.load();
	}

	/** Effective manifests (built-ins merged with persisted overrides). */
	list(): ExternalAppManifest[] {
		return builtInManifests().map((manifest) => this.applyConfig(manifest));
	}

	get(id: string): ExternalAppManifest | undefined {
		const base = builtInManifests().find((manifest) => manifest.id === id);
		return base ? this.applyConfig(base) : undefined;
	}

	getConfig(id: string): ExternalAppConfig {
		return this.configs[id] ?? {};
	}

	/** Merge a partial config override for an app and persist it. */
	updateConfig(id: string, partial: ExternalAppConfig): ExternalAppManifest | undefined {
		const base = builtInManifests().find((manifest) => manifest.id === id);
		if (!base) return undefined;
		this.configs[id] = { ...this.configs[id], ...partial };
		this.save();
		return this.applyConfig(base);
	}

	private applyConfig(manifest: ExternalAppManifest): ExternalAppManifest {
		const config = this.configs[manifest.id] ?? {};
		return {
			...manifest,
			autoStart: config.autoStart ?? manifest.autoStart,
			port: config.port ?? manifest.port,
			idleTimeoutMinutes: config.idleTimeoutMinutes ?? manifest.idleTimeoutMinutes,
			command: config.command ?? manifest.command,
			args: config.args ?? manifest.args,
			env: { ...(manifest.env ?? {}), ...(config.env ?? {}) },
		};
	}

	private load(): void {
		try {
			if (!existsSync(this.filePath)) return;
			const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<PersistedRegistry>;
			if (parsed && typeof parsed === "object" && parsed.apps && typeof parsed.apps === "object") {
				this.configs = parsed.apps as Record<string, ExternalAppConfig>;
			}
		} catch (error) {
			console.error("Failed to load more-apps.json:", error);
		}
	}

	private save(): void {
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
			const payload: PersistedRegistry = { version: REGISTRY_VERSION, apps: this.configs };
			writeFileSync(this.filePath, JSON.stringify(payload, null, 2), "utf-8");
		} catch (error) {
			console.error("Failed to save more-apps.json:", error);
		}
	}
}
