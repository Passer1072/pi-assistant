import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	InstalledSoftwarePlugin,
	InstallSoftwarePluginRequest,
	InstallSoftwarePluginResponse,
	McpServerConfig,
	SoftwarePluginDefinition,
	SoftwarePluginListResponse,
	SoftwarePluginOperation,
	SoftwarePluginOperationProgress,
	SoftwarePluginOperationStep,
	SoftwarePluginOperationStepStatus,
	SoftwarePluginStatus,
	SoftwarePluginTargetValidation,
	TestSoftwarePluginBridgeResponse,
	UninstallSoftwarePluginResponse,
	ValidateSoftwarePluginTargetRequest,
} from "../shared/types.ts";

export const NETEASE_PLUGIN_ID = "netease-cloud-music-api-bridge";
export const NETEASE_MCP_SERVER_ID = "netease-cloud-music-api";
export const STEAM_PLUGIN_ID = "steam-url-protocol-control";
export const STEAM_MCP_SERVER_ID = "steam-control";

const STORE_VERSION = 1;
const REDACTED = "[redacted]";
const DEFAULT_DEBUG_PORT = 9222;
const NETEASE_REQUIRED_FILES = ["cloudmusic.exe", "cloudmusic.dll", "package/orpheus.ntpk", "libcef.dll"];
const STEAM_REQUIRED_FILES = ["steam.exe", "steamapps/libraryfolders.vdf"];
const MCP_SERVER_FILE = "netease-music-mcp-server.mjs";
const BUNDLED_SERVER_RELATIVE = join("mcp-servers", "netease-music", MCP_SERVER_FILE);
const STEAM_MCP_SERVER_FILE = "steam-mcp-server.mjs";
const STEAM_BUNDLED_SERVER_RELATIVE = join("mcp-servers", "steam", STEAM_MCP_SERVER_FILE);

type ProgressReporter = (progress: SoftwarePluginOperationProgress) => void;
type ExecutableVersionReader = (filePath: string) => string | undefined;

interface SoftwarePluginStore {
	version: 1;
	plugins: InstalledSoftwarePlugin[];
}

interface SoftwarePluginManagerOptions {
	agentDir: string;
	nodeCommand?: string;
	fetchImpl?: typeof fetch;
	now?: () => Date;
	tokenFactory?: () => string;
	progressReporter?: ProgressReporter;
	executableVersionReader?: ExecutableVersionReader;
	/** Override the path to the bundled CDP MCP server script (mainly for tests). */
	serverScriptPath?: string;
	/** Override the path to the bundled Steam MCP server script (mainly for tests). */
	steamServerScriptPath?: string;
	/** Default Chromium remote-debugging port the client is launched with. */
	debugPort?: number;
}

/**
 * Installs the NetEase Cloud Music control plugin.
 *
 * Control method: CDP (Chromium DevTools Protocol). The client must be launched
 * with `--remote-debugging-port`; the MCP server attaches over that port and runs
 * JavaScript inside the client. Nothing is written into the NetEase install
 * directory, so this works on NCM >= 3.1 where BetterNCM/Chromatic injection is
 * blocked by the startup-integrity protection. See
 * mcp-servers/netease-music/RESEARCH.md for the full method.
 */
export class SoftwarePluginManager {
	private storePath: string;
	private assetDir: string;
	private nodeCommand: string;
	private fetchImpl: typeof fetch;
	private now: () => Date;
	private tokenFactory: () => string;
	private progressReporter?: ProgressReporter;
	private executableVersionReader: ExecutableVersionReader;
	private serverScriptPath: string;
	private steamServerScriptPath: string;
	private debugPort: number;

	constructor(options: SoftwarePluginManagerOptions) {
		this.storePath = join(options.agentDir, "software-plugins.json");
		this.assetDir = join(options.agentDir, "software-plugin-assets");
		this.nodeCommand = options.nodeCommand ?? process.execPath;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.now = options.now ?? (() => new Date());
		this.tokenFactory = options.tokenFactory ?? (() => randomBytes(24).toString("hex"));
		this.progressReporter = options.progressReporter;
		this.executableVersionReader = options.executableVersionReader ?? readExecutableFileVersion;
		this.serverScriptPath = resolveBundledServerScript(BUNDLED_SERVER_RELATIVE, "NetEase", options.serverScriptPath);
		this.steamServerScriptPath = resolveBundledServerScript(
			STEAM_BUNDLED_SERVER_RELATIVE,
			"Steam",
			options.steamServerScriptPath,
		);
		this.debugPort = normalizeDebugPort(options.debugPort, DEFAULT_DEBUG_PORT);
	}

	list(): SoftwarePluginListResponse {
		const store = this.readStore();
		return {
			plugins: SOFTWARE_PLUGIN_CATALOG.map((definition) => ({
				definition,
				installed: redactInstalledPlugin(store.plugins.find((plugin) => plugin.pluginId === definition.id)),
			})),
		};
	}

	validateTarget(request: ValidateSoftwarePluginTargetRequest): SoftwarePluginTargetValidation {
		const definition = getPluginDefinition(request.pluginId);
		if (definition.id === NETEASE_PLUGIN_ID) {
			return validateNeteaseTarget(request.targetPath, this.executableVersionReader);
		}
		if (definition.id === STEAM_PLUGIN_ID) {
			return validateSteamTarget(request.targetPath, this.executableVersionReader);
		}
		throw new Error(`Unsupported software plugin: ${request.pluginId}`);
	}

	async install(request: InstallSoftwarePluginRequest): Promise<InstallSoftwarePluginResponse> {
		const definition = getPluginDefinition(request.pluginId);
		if (definition.id === STEAM_PLUGIN_ID) return this.installSteam(request, definition);
		if (definition.id !== NETEASE_PLUGIN_ID) {
			throw new Error(`Unsupported software plugin: ${request.pluginId}`);
		}
		const progress = createOperationProgress(definition.id, "install", [
			{
				id: "validate-target",
				title: "验证网易云音乐路径",
				description: "检查目标路径和必要文件。",
				status: "pending",
			},
			{
				id: "configure-debug",
				title: "配置调试端口启动",
				description: "记录 cloudmusic.exe 路径，准备以 --remote-debugging-port 启动（不修改安装目录）。",
				status: "pending",
			},
			{
				id: "configure-mcp",
				title: "配置 MCP server",
				description: "写入基于 CDP 的网易云音乐 MCP server。",
				status: "pending",
			},
		]);
		const report = (stepId: string, status: SoftwarePluginOperationStepStatus, detail?: string): void => {
			updateOperationProgress(progress, stepId, status, detail);
			this.progressReporter?.(progress);
		};
		this.progressReporter?.(progress);

		try {
			report("validate-target", "running");
			const validation = validateNeteaseTarget(request.targetPath, this.executableVersionReader);
			if (!validation.valid) {
				report("validate-target", "failed", `缺失文件：${validation.missingFiles.join(", ")}`);
				throw new Error(`Invalid NetEase Cloud Music path. Missing: ${validation.missingFiles.join(", ")}`);
			}
			report("validate-target", "succeeded", validation.targetPath);

			const store = this.readStore();
			const existing = store.plugins.find((plugin) => plugin.pluginId === definition.id);
			const token = existing?.token && existing.token !== REDACTED ? existing.token : this.tokenFactory();
			const debugPort = normalizeDebugPort(request.bridgePort, this.debugPort);
			const bridgeUrl = `http://127.0.0.1:${debugPort}`;
			const exePath = join(validation.targetPath, "cloudmusic.exe");

			report("configure-debug", "running");
			report(
				"configure-debug",
				"succeeded",
				`将以 ${exePath} --remote-debugging-port=${debugPort} 启动（不修改安装目录）。`,
			);

			report("configure-mcp", "running");
			const mcpServer = this.buildMcpServerConfig(exePath, debugPort, token);
			report("configure-mcp", "succeeded", mcpServer.id);

			const timestamp = this.now().toISOString();
			const record: InstalledSoftwarePlugin = {
				pluginId: definition.id,
				status: "installed",
				targetPath: validation.targetPath,
				softwareVersion: validation.softwareVersion,
				bridgeUrl,
				token,
				installedFiles: [],
				mcpServerId: mcpServer.id,
				installedAt: existing?.installedAt ?? timestamp,
				updatedAt: timestamp,
			};
			this.writeStore({
				version: STORE_VERSION,
				plugins: [record, ...store.plugins.filter((plugin) => plugin.pluginId !== definition.id)],
			});
			progress.status = "succeeded";
			progress.message = "网易云音乐 MCP server 已配置（CDP 控制，零注入）。启动客户端时会带调试端口。";
			this.progressReporter?.(progress);

			return {
				plugin: redactInstalledPlugin(record),
				validation,
				mcpServer: redactMcpServer(mcpServer),
				steps: progress.steps,
				message: "网易云音乐 MCP server 已配置（CDP 控制，零注入）。",
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (progress.currentStepId) updateOperationProgress(progress, progress.currentStepId, "failed", message);
			progress.status = "failed";
			progress.message = message;
			this.progressReporter?.(progress);
			throw error;
		}
	}

	uninstall(pluginId: string): UninstallSoftwarePluginResponse {
		const definition = getPluginDefinition(pluginId);
		const progress = createOperationProgress(definition.id, "uninstall", [
			{
				id: "remove-files",
				title: "移除生成的 MCP server 文件",
				description: "删除资产目录里的 CDP server 副本。",
				status: "pending",
			},
			{ id: "remove-record", title: "移除安装记录", description: "删除本地插件安装记录。", status: "pending" },
			{ id: "remove-mcp", title: "移除 MCP server", description: "删除对应 MCP server 配置。", status: "pending" },
		]);
		const report = (stepId: string, status: SoftwarePluginOperationStepStatus, detail?: string): void => {
			updateOperationProgress(progress, stepId, status, detail);
			this.progressReporter?.(progress);
		};
		this.progressReporter?.(progress);
		const store = this.readStore();
		const installed = store.plugins.find((plugin) => plugin.pluginId === definition.id);
		if (!installed) {
			report("remove-files", "skipped", "未找到安装记录。");
			report("remove-record", "skipped");
			report("remove-mcp", "skipped");
			progress.status = "succeeded";
			progress.message = "插件未安装。";
			this.progressReporter?.(progress);
			return {
				pluginId,
				removedFiles: [],
				mcpServerId: definition.mcpTemplate.serverId,
				steps: progress.steps,
				message: "Plugin was not installed.",
			};
		}

		report("remove-files", "running");
		const removedFiles: string[] = [];
		for (const filePath of installed.installedFiles) {
			if (!isManagedPluginFile(filePath, this.assetDir)) continue;
			try {
				rmSync(filePath, { force: true, recursive: true });
				removedFiles.push(filePath);
			} catch {
				// Best effort uninstall.
			}
		}
		report("remove-files", "succeeded", `${removedFiles.length} 个文件已移除。`);
		report("remove-record", "running");
		this.writeStore({
			version: STORE_VERSION,
			plugins: store.plugins.filter((plugin) => plugin.pluginId !== definition.id),
		});
		report("remove-record", "succeeded");
		report("remove-mcp", "succeeded", installed.mcpServerId ?? definition.mcpTemplate.serverId);
		progress.status = "succeeded";
		progress.message = "插件文件和安装记录已移除。网易云安装目录未受影响。";
		this.progressReporter?.(progress);
		return {
			pluginId,
			removedFiles,
			mcpServerId: installed.mcpServerId ?? definition.mcpTemplate.serverId,
			steps: progress.steps,
			message: "插件文件和安装记录已移除。",
		};
	}

	/** Checks that the NetEase client is reachable over the CDP debug port. */
	async testBridge(pluginId: string): Promise<TestSoftwarePluginBridgeResponse> {
		const definition = getPluginDefinition(pluginId);
		const installed = this.readStore().plugins.find((plugin) => plugin.pluginId === definition.id);
		if (definition.id === STEAM_PLUGIN_ID) {
			if (!installed) {
				return { pluginId, ok: false, message: "Plugin is not configured. Install the plugin first." };
			}
			const validation = validateSteamTarget(installed.targetPath, this.executableVersionReader);
			return {
				pluginId,
				ok: validation.valid,
				bridgeUrl: installed.bridgeUrl,
				message: validation.valid
					? "Steam 本地清单可读，MCP server 可以连接并使用 steam:// 协议。"
					: `Steam 路径无效。Missing: ${validation.missingFiles.join(", ")}`,
				sample: {
					targetPath: validation.targetPath,
					softwareVersion: validation.softwareVersion,
					summary: validation.summary,
				},
			};
		}
		if (!installed?.bridgeUrl) {
			return { pluginId, ok: false, message: "Plugin is not configured. Install the plugin first." };
		}
		const url = `${installed.bridgeUrl.replace(/\/+$/, "")}/json/version`;
		try {
			const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(3000) });
			const text = await response.text();
			return {
				pluginId,
				ok: response.ok,
				bridgeUrl: installed.bridgeUrl,
				statusCode: response.status,
				message: response.ok
					? "网易云音乐调试端口已就绪，MCP server 可以连接。"
					: `调试端口返回 HTTP ${response.status}。`,
				sample: parseMaybeJson(text),
			};
		} catch (error) {
			return {
				pluginId,
				ok: false,
				bridgeUrl: installed.bridgeUrl,
				message:
					"无法连接网易云音乐调试端口。请用 --remote-debugging-port 启动网易云音乐" +
					`（见 launch-netease-debug.ps1）。${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	getMcpServerConfig(pluginId: string): McpServerConfig {
		const definition = getPluginDefinition(pluginId);
		const installed = this.readStore().plugins.find((plugin) => plugin.pluginId === definition.id);
		if (!installed) {
			throw new Error(`Plugin is not installed: ${pluginId}`);
		}
		if (definition.id === STEAM_PLUGIN_ID) {
			return this.buildSteamMcpServerConfig(installed.targetPath);
		}
		if (!installed.bridgeUrl) throw new Error(`Plugin is not installed: ${pluginId}`);
		const debugPort = Number(new URL(installed.bridgeUrl).port || this.debugPort);
		const exePath = join(installed.targetPath, "cloudmusic.exe");
		return this.buildMcpServerConfig(exePath, debugPort, installed.token ?? this.tokenFactory());
	}

	private async installSteam(
		request: InstallSoftwarePluginRequest,
		definition: SoftwarePluginDefinition,
	): Promise<InstallSoftwarePluginResponse> {
		const progress = createOperationProgress(definition.id, "install", [
			{
				id: "validate-target",
				title: "Validate Steam path",
				description: "Check steam.exe and steamapps/libraryfolders.vdf.",
				status: "pending",
			},
			{
				id: "configure-mcp",
				title: "Configure Steam MCP server",
				description: "Register the steam:// protocol and local VDF manifest MCP server.",
				status: "pending",
			},
		]);
		const report = (stepId: string, status: SoftwarePluginOperationStepStatus, detail?: string): void => {
			updateOperationProgress(progress, stepId, status, detail);
			this.progressReporter?.(progress);
		};
		this.progressReporter?.(progress);

		try {
			report("validate-target", "running");
			const validation = validateSteamTarget(request.targetPath, this.executableVersionReader);
			if (!validation.valid) {
				report("validate-target", "failed", `Missing files: ${validation.missingFiles.join(", ")}`);
				throw new Error(`Invalid Steam path. Missing: ${validation.missingFiles.join(", ")}`);
			}
			report("validate-target", "succeeded", validation.targetPath);

			report("configure-mcp", "running");
			const mcpServer = this.buildSteamMcpServerConfig(validation.targetPath);
			report("configure-mcp", "succeeded", mcpServer.id);

			const store = this.readStore();
			const existing = store.plugins.find((plugin) => plugin.pluginId === definition.id);
			const timestamp = this.now().toISOString();
			const record: InstalledSoftwarePlugin = {
				pluginId: definition.id,
				status: "installed",
				targetPath: validation.targetPath,
				softwareVersion: validation.softwareVersion,
				bridgeUrl: "steam://open/library",
				installedFiles: [],
				mcpServerId: mcpServer.id,
				installedAt: existing?.installedAt ?? timestamp,
				updatedAt: timestamp,
			};
			this.writeStore({
				version: STORE_VERSION,
				plugins: [record, ...store.plugins.filter((plugin) => plugin.pluginId !== definition.id)],
			});
			progress.status = "succeeded";
			progress.message = "Steam MCP server configured (steam:// protocol + local VDF manifests; no injection).";
			this.progressReporter?.(progress);

			return {
				plugin: redactInstalledPlugin(record),
				validation,
				mcpServer: redactMcpServer(mcpServer),
				steps: progress.steps,
				message: "Steam MCP server configured (steam:// protocol + local VDF manifests; no injection).",
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (progress.currentStepId) updateOperationProgress(progress, progress.currentStepId, "failed", message);
			progress.status = "failed";
			progress.message = message;
			this.progressReporter?.(progress);
			throw error;
		}
	}

	private buildMcpServerConfig(exePath: string, debugPort: number, _token: string): McpServerConfig {
		// Point at the bundled server in the repo tree (so Node can resolve @modelcontextprotocol/sdk etc.
		// from the package's node_modules). Do NOT copy it into agentDir/AppData — that location has no
		// node_modules and ESM bare imports would fail with ERR_MODULE_NOT_FOUND.
		const runningInElectron = Boolean(process.versions.electron);
		return {
			id: NETEASE_MCP_SERVER_ID,
			name: "网易云音乐",
			enabled: true,
			transport: "stdio",
			command: this.nodeCommand,
			args: [this.serverScriptPath],
			env: {
				// When the host process is Electron (process.execPath = electron.exe), run the script as plain
				// Node instead of launching an Electron app, otherwise the stdio MCP server never starts.
				...(runningInElectron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
				NCM_DEBUG_PORT: String(debugPort),
				NCM_EXE_PATH: exePath,
				NCM_AUTO_LAUNCH: "1",
			},
			timeoutMs: 15000,
			toolNamePrefix: "ncm",
			description: "通过 CDP 控制网易云音乐（播放/搜索/歌单/点歌），零注入、不改安装目录。",
		};
	}

	private buildSteamMcpServerConfig(targetPath: string): McpServerConfig {
		const runningInElectron = Boolean(process.versions.electron);
		const steamRoot = resolve(targetPath);
		return {
			id: STEAM_MCP_SERVER_ID,
			name: "Steam Control",
			enabled: true,
			transport: "stdio",
			command: this.nodeCommand,
			args: [this.steamServerScriptPath],
			env: {
				...(runningInElectron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
				STEAM_ROOT: steamRoot,
				STEAM_EXE_PATH: join(steamRoot, "steam.exe"),
				STEAM_AUTO_LAUNCH: "1",
			},
			timeoutMs: 15000,
			toolNamePrefix: "steam",
			description:
				"Control Steam through the official URL protocol and local VDF manifests; no injection and no install-dir modifications.",
		};
	}

	private readStore(): SoftwarePluginStore {
		try {
			if (!existsSync(this.storePath)) return { version: STORE_VERSION, plugins: [] };
			const parsed = JSON.parse(readFileSync(this.storePath, "utf-8")) as Partial<SoftwarePluginStore>;
			return normalizeStore(parsed);
		} catch {
			return { version: STORE_VERSION, plugins: [] };
		}
	}

	private writeStore(store: SoftwarePluginStore): void {
		mkdirSync(dirname(this.storePath), { recursive: true });
		writeFileSync(this.storePath, JSON.stringify(normalizeStore(store), null, 2), "utf-8");
	}
}

export const SOFTWARE_PLUGIN_CATALOG: SoftwarePluginDefinition[] = [
	{
		id: NETEASE_PLUGIN_ID,
		name: "网易云音乐控制",
		description:
			"通过 Chromium 调试协议(CDP)控制网易云音乐：播放、搜索、歌单、点歌等。零注入、不修改安装目录，适配 3.1+ 启动保护。",
		targetSoftware: {
			id: "netease-cloud-music",
			name: "网易云音乐",
			platform: "windows",
			suggestedPaths: ["D:\\CloudMusic\\CloudMusic"],
		},
		validationRules: [{ type: "files_exist", paths: NETEASE_REQUIRED_FILES }],
		installSteps: [
			{
				id: "validate-target",
				title: "验证网易云音乐",
				description: "检查 cloudmusic.exe、核心 DLL、package/orpheus.ntpk 和 CEF 运行时文件。",
			},
			{
				id: "configure-debug",
				title: "配置调试端口启动",
				description: "记录 cloudmusic.exe 路径，准备以 --remote-debugging-port 启动（不修改安装目录）。",
			},
			{
				id: "configure-mcp",
				title: "配置 MCP server",
				description: "写入基于 CDP 的网易云音乐 MCP server。",
			},
		],
		mcpTemplate: {
			serverId: NETEASE_MCP_SERVER_ID,
			name: "网易云音乐",
			toolNamePrefix: "ncm",
			description: "通过 CDP 控制网易云音乐，无需注入或修改文件。",
		},
	},
	{
		id: STEAM_PLUGIN_ID,
		name: "Steam Control",
		description:
			"Control Steam through the official steam:// URL protocol and local VDF manifests: launch, discover libraries/games, open views, run/install/verify games. No injection and no Steam install-dir modifications.",
		targetSoftware: {
			id: "steam",
			name: "Steam",
			platform: "windows",
			suggestedPaths: ["D:\\steam"],
		},
		validationRules: [{ type: "files_exist", paths: STEAM_REQUIRED_FILES }],
		installSteps: [
			{
				id: "validate-target",
				title: "Validate Steam path",
				description: "Check steam.exe and steamapps/libraryfolders.vdf.",
			},
			{
				id: "configure-mcp",
				title: "Configure Steam MCP server",
				description: "Register the steam:// protocol and local VDF manifest MCP server.",
			},
		],
		mcpTemplate: {
			serverId: STEAM_MCP_SERVER_ID,
			name: "Steam Control",
			toolNamePrefix: "steam",
			description: "Control Steam through the official URL protocol and local VDF manifests.",
		},
	},
];

export function validateNeteaseTarget(
	targetPath: string,
	executableVersionReader: ExecutableVersionReader = readExecutableFileVersion,
): SoftwarePluginTargetValidation {
	const normalizedTarget = resolve(targetPath.trim());
	const missingFiles = NETEASE_REQUIRED_FILES.filter(
		(relativePath) => !existsSync(join(normalizedTarget, relativePath)),
	);
	const valid = missingFiles.length === 0;
	const exePath = join(normalizedTarget, "cloudmusic.exe");
	const softwareVersion = valid ? executableVersionReader(exePath) : undefined;
	const summary = valid
		? [
				`Target: ${normalizedTarget}`,
				`Required files: ${NETEASE_REQUIRED_FILES.length}/${NETEASE_REQUIRED_FILES.length}`,
				softwareVersion ? `Executable: ${softwareVersion}` : "Executable version: unavailable",
				"控制方式：CDP 调试端口（零注入，不修改安装目录，适配 3.1+ 启动保护）。",
			]
		: [`Target: ${normalizedTarget}`, `Missing files: ${missingFiles.join(", ")}`];
	const warnings = valid
		? ["首次使用前请用 --remote-debugging-port 启动网易云音乐（见 launch-netease-debug.ps1 或开启自动启动）。"]
		: [];
	return {
		pluginId: NETEASE_PLUGIN_ID,
		targetPath: normalizedTarget,
		valid,
		missingFiles,
		softwareVersion,
		summary,
		requiresHost: false,
		hostDetected: false,
		autoHostInstallSupported: true,
		hostInstallHints: [],
		warnings,
	};
}

export function validateSteamTarget(
	targetPath: string,
	executableVersionReader: ExecutableVersionReader = readExecutableFileVersion,
): SoftwarePluginTargetValidation {
	const normalizedTarget = resolve(targetPath.trim());
	const missingFiles = STEAM_REQUIRED_FILES.filter(
		(relativePath) => !existsSync(join(normalizedTarget, relativePath)),
	);
	const valid = missingFiles.length === 0;
	const exePath = join(normalizedTarget, "steam.exe");
	const softwareVersion = valid ? executableVersionReader(exePath) : undefined;
	const libraryFile = join(normalizedTarget, "steamapps", "libraryfolders.vdf");
	const librarySummary = valid ? summarizeSteamLibraries(libraryFile) : undefined;
	const summary = valid
		? [
				`Target: ${normalizedTarget}`,
				`Required files: ${STEAM_REQUIRED_FILES.length}/${STEAM_REQUIRED_FILES.length}`,
				softwareVersion ? `Executable: ${softwareVersion}` : "Executable version: unavailable",
				librarySummary ?? "Steam library manifest: readable",
				"Control method: steam:// URL protocol + local VDF manifests; no injection and no install-dir modifications.",
			]
		: [`Target: ${normalizedTarget}`, `Missing files: ${missingFiles.join(", ")}`];
	return {
		pluginId: STEAM_PLUGIN_ID,
		targetPath: normalizedTarget,
		valid,
		missingFiles,
		softwareVersion,
		summary,
		requiresHost: false,
		hostDetected: false,
		autoHostInstallSupported: true,
		hostInstallHints: [],
		warnings: valid ? ["Some Steam actions open Steam's own confirmation UI, such as uninstalling a game."] : [],
	};
}

export function redactInstalledPlugin(plugin: InstalledSoftwarePlugin): InstalledSoftwarePlugin;
export function redactInstalledPlugin(plugin: undefined): undefined;
export function redactInstalledPlugin(plugin: InstalledSoftwarePlugin | undefined): InstalledSoftwarePlugin | undefined;
export function redactInstalledPlugin(
	plugin: InstalledSoftwarePlugin | undefined,
): InstalledSoftwarePlugin | undefined {
	if (!plugin) return undefined;
	return {
		...plugin,
		token: plugin.token ? REDACTED : undefined,
	};
}

export function redactSoftwarePluginListResponse(response: SoftwarePluginListResponse): SoftwarePluginListResponse {
	return {
		plugins: response.plugins.map((item) => ({
			definition: item.definition,
			installed: redactInstalledPlugin(item.installed),
		})),
	};
}

function getPluginDefinition(pluginId: string): SoftwarePluginDefinition {
	const definition = SOFTWARE_PLUGIN_CATALOG.find((plugin) => plugin.id === pluginId);
	if (!definition) throw new Error(`Unknown software plugin: ${pluginId}`);
	return definition;
}

function resolveBundledServerScript(relativePath: string, label: string, explicit?: string): string {
	if (explicit && existsSync(explicit)) return resolve(explicit);
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 10; i++) {
		const direct = join(dir, relativePath);
		if (existsSync(direct)) return direct;
		const packaged = join(dir, "packages", "desktop-assistant", relativePath);
		if (existsSync(packaged)) return packaged;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`Bundled ${label} MCP server script not found (${relativePath}).`);
}

function summarizeSteamLibraries(libraryFoldersPath: string): string | undefined {
	try {
		const text = readFileSync(libraryFoldersPath, "utf-8");
		const libraryCount = (text.match(/^\s*"\d+"\s*$/gm) ?? []).length;
		const appCount = (text.match(/^\s*"\d+"\s+"\d+"\s*$/gm) ?? []).length;
		return `Steam libraries: ${libraryCount}; indexed apps: ${appCount}`;
	} catch {
		return undefined;
	}
}

function normalizeStore(store: Partial<SoftwarePluginStore>): SoftwarePluginStore {
	const plugins = Array.isArray(store.plugins)
		? store.plugins
				.map(normalizeInstalledPlugin)
				.filter((plugin): plugin is InstalledSoftwarePlugin => plugin !== undefined)
		: [];
	return { version: STORE_VERSION, plugins };
}

function normalizeInstalledPlugin(value: unknown): InstalledSoftwarePlugin | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const item = value as Partial<InstalledSoftwarePlugin>;
	if (typeof item.pluginId !== "string" || typeof item.targetPath !== "string") return undefined;
	const timestamp = new Date(0).toISOString();
	return {
		pluginId: item.pluginId,
		status: normalizeStatus(item.status),
		targetPath: item.targetPath,
		softwareVersion: cleanString(item.softwareVersion),
		bridgeUrl: cleanString(item.bridgeUrl),
		token: cleanString(item.token),
		hostPath: cleanString(item.hostPath),
		installedFiles: Array.isArray(item.installedFiles)
			? item.installedFiles.filter((entry): entry is string => typeof entry === "string")
			: [],
		mcpServerId: cleanString(item.mcpServerId),
		installedAt: cleanString(item.installedAt) ?? timestamp,
		updatedAt: cleanString(item.updatedAt) ?? cleanString(item.installedAt) ?? timestamp,
		lastError: cleanString(item.lastError),
	};
}

function normalizeStatus(status: unknown): SoftwarePluginStatus {
	if (status === "not_installed" || status === "needs_host" || status === "installed" || status === "error") {
		return status;
	}
	return "error";
}

function cleanString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeDebugPort(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(65535, Math.max(1024, Math.floor(value)));
}

function isManagedPluginFile(filePath: string, assetDir: string): boolean {
	return resolve(filePath) === resolve(join(assetDir, MCP_SERVER_FILE));
}

function createOperationProgress(
	pluginId: string,
	operation: SoftwarePluginOperation,
	steps: SoftwarePluginOperationStep[],
): SoftwarePluginOperationProgress {
	return { pluginId, operation, status: "running", steps, currentStepId: steps[0]?.id };
}

function updateOperationProgress(
	progress: SoftwarePluginOperationProgress,
	stepId: string,
	status: SoftwarePluginOperationStepStatus,
	detail?: string,
): void {
	progress.currentStepId = status === "running" || status === "failed" ? stepId : progress.currentStepId;
	progress.steps = progress.steps.map((step) => (step.id === stepId ? { ...step, status, detail } : step));
	if (status === "failed") {
		progress.status = "failed";
		progress.message = detail;
	}
}

function readExecutableFileVersion(filePath: string): string | undefined {
	const script = `(Get-Item -LiteralPath '${filePath.replace(/'/g, "''")}').VersionInfo.FileVersion`;
	try {
		const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return output || undefined;
	} catch {
		return undefined;
	}
}

function redactMcpServer(server: McpServerConfig): McpServerConfig {
	return {
		...server,
		env: server.env
			? Object.fromEntries(
					Object.entries(server.env).map(([key, value]) => [key, key.includes("TOKEN") ? REDACTED : value]),
				)
			: undefined,
	};
}

function parseMaybeJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text.slice(0, 500);
	}
}
