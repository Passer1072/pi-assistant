import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { dirname, join, relative, resolve, sep } from "node:path";
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
export const OFFICE_WORD_PLUGIN_ID = "office-word-live-addin";
export const OFFICE_WORD_MCP_SERVER_ID = "office-word-live";
export const OFFICE_CHAT_BRIDGE_PORT = 49240;

const STORE_VERSION = 1;
const REDACTED = "[redacted]";
const DEFAULT_DEBUG_PORT = 9222;
const NETEASE_REQUIRED_FILES = ["cloudmusic.exe", "cloudmusic.dll", "package/orpheus.ntpk", "libcef.dll"];
const STEAM_REQUIRED_FILES = ["steam.exe", "steamapps/libraryfolders.vdf"];
const MCP_SERVER_FILE = "netease-music-mcp-server.mjs";
const BUNDLED_SERVER_RELATIVE = join("mcp-servers", "netease-music", MCP_SERVER_FILE);
const STEAM_MCP_SERVER_FILE = "steam-mcp-server.mjs";
const STEAM_BUNDLED_SERVER_RELATIVE = join("mcp-servers", "steam", STEAM_MCP_SERVER_FILE);
const OFFICE_ADDIN_BUNDLED_SERVER_RELATIVE = join("mcp-servers", "office-addins", "office-addin-mcp-server.mjs");
const OFFICE_ADDIN_WEB_RELATIVE = join("mcp-servers", "office-addins", "web");
const OFFICE_ADDIN_MANIFEST_RELATIVE = join("mcp-servers", "office-addins", "manifests");
const OFFICE_HOST_BY_PLUGIN = { [OFFICE_WORD_PLUGIN_ID]: "word" } as const;
const OFFICE_PORT_BY_HOST = { word: 49230 } as const;
const OFFICE_EXE_BY_HOST = { word: "WINWORD.EXE" } as const;
const OFFICE_APP_PATH_EXE_BY_HOST = { word: "winword.exe" } as const;
const OFFICE_MCP_SERVER_ID_BY_HOST = { word: OFFICE_WORD_MCP_SERVER_ID } as const;
const OFFICE_TOOL_PREFIX_BY_HOST = { word: "word" } as const;
const OFFICE_NAME_BY_HOST = { word: "Word" } as const;
const OFFICE_WEF_DEVELOPER_KEY = "HKCU:\\Software\\Microsoft\\Office\\16.0\\WEF\\Developer";

type ProgressReporter = (progress: SoftwarePluginOperationProgress) => void;
type ExecutableVersionReader = (filePath: string) => string | undefined;
export type OfficeHost = "word";
type PowerShellRunner = (script: string) => string;

interface OfficeCert {
	pfxPath: string;
	cerPath: string;
	passphrase: string;
	thumbprint: string;
}

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
	/** Override the path to the bundled Office add-in MCP server script (mainly for tests). */
	officeServerScriptPath?: string;
	/** Default Chromium remote-debugging port the client is launched with. */
	debugPort?: number;
	/** Test seam for Office certificate/sideload PowerShell commands. */
	powerShellRunner?: PowerShellRunner;
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
	private customFetchImpl: boolean;
	private now: () => Date;
	private tokenFactory: () => string;
	private progressReporter?: ProgressReporter;
	private executableVersionReader: ExecutableVersionReader;
	private serverScriptPath: string;
	private steamServerScriptPath: string;
	private officeServerScriptPath: string;
	private debugPort: number;
	private powerShellRunner: PowerShellRunner;

	constructor(options: SoftwarePluginManagerOptions) {
		this.storePath = join(options.agentDir, "software-plugins.json");
		this.assetDir = join(options.agentDir, "software-plugin-assets");
		this.nodeCommand = options.nodeCommand ?? process.execPath;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.customFetchImpl = options.fetchImpl !== undefined;
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
		this.officeServerScriptPath = resolveBundledServerScript(
			OFFICE_ADDIN_BUNDLED_SERVER_RELATIVE,
			"Office add-in",
			options.officeServerScriptPath,
		);
		this.debugPort = normalizeDebugPort(options.debugPort, DEFAULT_DEBUG_PORT);
		this.powerShellRunner = options.powerShellRunner ?? runPowerShell;
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
		const officeHost = officeHostForPlugin(definition.id);
		if (officeHost) {
			return validateOfficeTarget(officeHost, request.targetPath, this.executableVersionReader);
		}
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
		if (officeHostForPlugin(definition.id)) return this.installOfficeAddin(request, definition);
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
		if (officeHostForPlugin(definition.id)) return this.uninstallOfficeAddin(definition);
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
		if (officeHostForPlugin(definition.id)) {
			return this.testOfficeBridge(definition, installed);
		}
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
		const officeHost = officeHostForPlugin(definition.id);
		if (officeHost) {
			const cert = this.certFromInstalledPlugin(installed);
			return this.buildOfficeAddinMcpServerConfig(
				officeHost,
				portFromBridgeUrl(installed.bridgeUrl) ?? OFFICE_PORT_BY_HOST[officeHost],
				installed.token ?? this.tokenFactory(),
				cert,
				{ url: installed.officeChatBridgeUrl ?? "", token: installed.officeChatBridgeToken ?? "" },
			);
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

	private async installOfficeAddin(
		request: InstallSoftwarePluginRequest,
		definition: SoftwarePluginDefinition,
	): Promise<InstallSoftwarePluginResponse> {
		const host = officeHostForPlugin(definition.id);
		if (!host) throw new Error(`Unsupported Office plugin: ${definition.id}`);
		const progress = createOperationProgress(
			definition.id,
			"install",
			definition.installSteps.map((step) => ({ ...step, status: "pending" })),
		);
		const report = (stepId: string, status: SoftwarePluginOperationStepStatus, detail?: string): void => {
			updateOperationProgress(progress, stepId, status, detail);
			this.progressReporter?.(progress);
		};
		this.progressReporter?.(progress);

		try {
			report("validate-office", "running");
			const validation = validateOfficeTarget(host, request.targetPath, this.executableVersionReader);
			if (!validation.valid) {
				report("validate-office", "failed", validation.summary.join("; "));
				throw new Error(`Invalid ${OFFICE_NAME_BY_HOST[host]} path. ${validation.summary.join(" ")}`);
			}
			report("validate-office", "succeeded", validation.targetPath);

			report("generate-cert", "running");
			const cert = this.ensureLocalhostCert();
			report("generate-cert", "succeeded", cert.thumbprint);

			const store = this.readStore();
			const existing = store.plugins.find((plugin) => plugin.pluginId === definition.id);
			const token = existing?.token && existing.token !== REDACTED ? existing.token : this.tokenFactory();
			const officeChatBridgeToken =
				existing?.officeChatBridgeToken && existing.officeChatBridgeToken !== REDACTED
					? existing.officeChatBridgeToken
					: this.tokenFactory();
			const port = normalizeDebugPort(request.bridgePort, OFFICE_PORT_BY_HOST[host]);
			const manifestId = existing?.manifestId ?? stableOfficeManifestId(definition.id);
			const bridgeUrl = `https://localhost:${port}`;
			const officeChatBridgeUrl = `http://127.0.0.1:${OFFICE_CHAT_BRIDGE_PORT}`;

			report("serve-content", "running");
			const manifestPath = this.writeOfficeManifest(host, manifestId, port);
			report("serve-content", "succeeded", manifestPath);

			report("sideload-manifest", "running");
			const registryValueName = this.sideloadManifest(manifestPath);
			report("sideload-manifest", "succeeded", registryValueName);

			report("configure-mcp", "running");
			const mcpServer = this.buildOfficeAddinMcpServerConfig(host, port, token, cert, {
				url: officeChatBridgeUrl,
				token: officeChatBridgeToken,
			});
			report("configure-mcp", "succeeded", mcpServer.id);

			const timestamp = this.now().toISOString();
			const installedFiles = Array.from(new Set([cert.pfxPath, cert.cerPath, manifestPath]));
			const record: InstalledSoftwarePlugin = {
				pluginId: definition.id,
				status: "installed",
				targetPath: validation.targetPath,
				softwareVersion: validation.softwareVersion,
				bridgeUrl,
				token,
				officeChatBridgeUrl,
				officeChatBridgeToken,
				certThumbprint: cert.thumbprint,
				registryValueName,
				manifestId,
				installedFiles,
				mcpServerId: mcpServer.id,
				installedAt: existing?.installedAt ?? timestamp,
				updatedAt: timestamp,
			};
			this.writeStore({
				version: STORE_VERSION,
				plugins: [record, ...store.plugins.filter((plugin) => plugin.pluginId !== definition.id)],
			});
			progress.status = "succeeded";
			progress.message = `${OFFICE_NAME_BY_HOST[host]} live add-in configured. Open the taskpane in Office to connect it.`;
			this.progressReporter?.(progress);
			return {
				plugin: redactInstalledPlugin(record),
				validation,
				mcpServer: redactMcpServer(mcpServer),
				steps: progress.steps,
				message: progress.message,
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

	private uninstallOfficeAddin(definition: SoftwarePluginDefinition): UninstallSoftwarePluginResponse {
		const progress = createOperationProgress(definition.id, "uninstall", [
			{
				id: "remove-sideload",
				title: "Remove Office sideload registration",
				description: "Delete the HKCU Office WEF Developer registry value.",
				status: "pending",
			},
			{
				id: "remove-cert",
				title: "Remove local certificate",
				description: "Remove the trusted localhost certificate when no installed Office add-in still uses it.",
				status: "pending",
			},
			{
				id: "remove-files",
				title: "Remove generated add-in files",
				description: "Delete generated manifest and certificate files from the plugin asset directory.",
				status: "pending",
			},
			{
				id: "remove-record",
				title: "Remove install record",
				description: "Delete the local plugin record.",
				status: "pending",
			},
			{
				id: "remove-mcp",
				title: "Remove MCP server",
				description: "Delete the corresponding MCP server config.",
				status: "pending",
			},
		]);
		const report = (stepId: string, status: SoftwarePluginOperationStepStatus, detail?: string): void => {
			updateOperationProgress(progress, stepId, status, detail);
			this.progressReporter?.(progress);
		};
		this.progressReporter?.(progress);

		const store = this.readStore();
		const installed = store.plugins.find((plugin) => plugin.pluginId === definition.id);
		if (!installed) {
			for (const step of progress.steps) report(step.id, "skipped");
			progress.status = "succeeded";
			progress.message = "Plugin was not installed.";
			this.progressReporter?.(progress);
			return {
				pluginId: definition.id,
				removedFiles: [],
				mcpServerId: definition.mcpTemplate.serverId,
				steps: progress.steps,
				message: progress.message,
			};
		}

		report("remove-sideload", "running");
		if (installed.registryValueName) {
			this.removeSideload(installed.registryValueName);
			report("remove-sideload", "succeeded", installed.registryValueName);
		} else {
			report("remove-sideload", "skipped");
		}

		const remainingPlugins = store.plugins.filter((plugin) => plugin.pluginId !== definition.id);
		report("remove-cert", "running");
		const certShared = Boolean(
			installed.certThumbprint &&
				remainingPlugins.some((plugin) => plugin.certThumbprint === installed.certThumbprint),
		);
		if (installed.certThumbprint && !certShared) {
			this.removeCertFromRoot(installed.certThumbprint);
			report("remove-cert", "succeeded", installed.certThumbprint);
		} else {
			report(
				"remove-cert",
				"skipped",
				certShared ? "Certificate is still used by another Office add-in." : undefined,
			);
		}

		report("remove-files", "running");
		const removedFiles: string[] = [];
		for (const filePath of installed.installedFiles) {
			if (!isManagedPluginFile(filePath, this.assetDir)) continue;
			if (certShared && (filePath.endsWith(".pfx") || filePath.endsWith(".cer"))) continue;
			try {
				rmSync(filePath, { force: true, recursive: true });
				removedFiles.push(filePath);
			} catch {
				// Best effort uninstall.
			}
		}
		report("remove-files", "succeeded", `${removedFiles.length} file(s) removed.`);

		report("remove-record", "running");
		this.writeStore({ version: STORE_VERSION, plugins: remainingPlugins });
		report("remove-record", "succeeded");
		report("remove-mcp", "succeeded", installed.mcpServerId ?? definition.mcpTemplate.serverId);
		progress.status = "succeeded";
		progress.message = "Office live add-in files and registration were removed.";
		this.progressReporter?.(progress);
		return {
			pluginId: definition.id,
			removedFiles,
			mcpServerId: installed.mcpServerId ?? definition.mcpTemplate.serverId,
			steps: progress.steps,
			message: progress.message,
		};
	}

	private async testOfficeBridge(
		definition: SoftwarePluginDefinition,
		installed: InstalledSoftwarePlugin | undefined,
	): Promise<TestSoftwarePluginBridgeResponse> {
		const host = officeHostForPlugin(definition.id);
		if (!host || !installed?.bridgeUrl) {
			return { pluginId: definition.id, ok: false, message: "Plugin is not configured. Install the plugin first." };
		}
		const base = installed.bridgeUrl.replace(/\/+$/, "");
		try {
			const response = await this.fetchOfficeBridge(`${base}/bridge/status`);
			const text = response.text;
			const sample = parseMaybeJson(text);
			const connected =
				typeof sample === "object" && sample !== null && "connected" in sample
					? Boolean((sample as { connected?: unknown }).connected)
					: false;
			return {
				pluginId: definition.id,
				ok: response.ok && connected,
				bridgeUrl: installed.bridgeUrl,
				statusCode: response.status,
				message:
					response.ok && connected
						? `${OFFICE_NAME_BY_HOST[host]} add-in is connected. The assistant can edit the active document.`
						: `Open a ${OFFICE_NAME_BY_HOST[host]} document and show the Desktop Assistant taskpane, then test again.`,
				sample,
			};
		} catch (error) {
			return {
				pluginId: definition.id,
				ok: false,
				bridgeUrl: installed.bridgeUrl,
				message: `Office live bridge is not running. Confirm MCP is enabled and this plugin is enabled. ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
	}

	private async fetchOfficeBridge(url: string): Promise<{ ok: boolean; status: number; text: string }> {
		if (this.customFetchImpl) {
			const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(3000) });
			return { ok: response.ok, status: response.status, text: await response.text() };
		}
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")) {
			throw new Error(`Office bridge test only supports local HTTPS URLs: ${url}`);
		}
		return await new Promise((resolvePromise, rejectPromise) => {
			const req = httpsRequest(
				{
					hostname: parsed.hostname,
					port: parsed.port,
					path: `${parsed.pathname}${parsed.search}`,
					method: "GET",
					rejectUnauthorized: false,
					timeout: 3000,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () => {
						const status = res.statusCode ?? 0;
						resolvePromise({
							ok: status >= 200 && status < 300,
							status,
							text: Buffer.concat(chunks).toString("utf-8"),
						});
					});
				},
			);
			req.on("timeout", () => req.destroy(new Error("Office bridge request timed out")));
			req.on("error", rejectPromise);
			req.end();
		});
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

	private buildOfficeAddinMcpServerConfig(
		host: OfficeHost,
		port: number,
		token: string,
		cert: OfficeCert,
		chatBridge: { url: string; token: string },
	): McpServerConfig {
		const runningInElectron = Boolean(process.versions.electron);
		const webDir = resolveBundledDir(OFFICE_ADDIN_WEB_RELATIVE, "Office add-in web assets");
		const hostName = OFFICE_NAME_BY_HOST[host];
		return {
			id: OFFICE_MCP_SERVER_ID_BY_HOST[host],
			name: `${hostName} Live Add-in`,
			enabled: true,
			transport: "stdio",
			command: this.nodeCommand,
			args: [this.officeServerScriptPath],
			env: {
				...(runningInElectron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
				OFFICE_HOST: host,
				OFFICE_BRIDGE_PORT: String(port),
				OFFICE_BRIDGE_TOKEN: token,
				OFFICE_PFX_PATH: cert.pfxPath,
				OFFICE_PFX_PASSPHRASE: cert.passphrase,
				OFFICE_WEB_DIR: webDir,
				OFFICE_CHAT_BRIDGE_URL: chatBridge.url,
				OFFICE_CHAT_BRIDGE_TOKEN: chatBridge.token,
			},
			timeoutMs: 20000,
			toolNamePrefix: OFFICE_TOOL_PREFIX_BY_HOST[host],
			description: "Edit the currently open visible Office document through an Office add-in bridge.",
		};
	}

	private writeOfficeManifest(host: OfficeHost, manifestId: string, port: number): string {
		const templatePath = join(
			resolveBundledDir(OFFICE_ADDIN_MANIFEST_RELATIVE, "Office add-in manifests"),
			`${host}-manifest.xml`,
		);
		const template = readFileSync(templatePath, "utf-8");
		const manifestDir = join(this.assetDir, "office-addins", host);
		mkdirSync(manifestDir, { recursive: true });
		const manifestPath = join(manifestDir, "manifest.xml");
		writeFileSync(
			manifestPath,
			template.replaceAll("{{ID}}", manifestId).replaceAll("{{PORT}}", String(port)),
			"utf-8",
		);
		return manifestPath;
	}

	private ensureLocalhostCert(): OfficeCert {
		const certDir = join(this.assetDir, "office-addins", "certs");
		mkdirSync(certDir, { recursive: true });
		const pfxPath = join(certDir, "desktop-assistant-office-bridge.pfx");
		const cerPath = join(certDir, "desktop-assistant-office-bridge.cer");
		const metaPath = join(certDir, "desktop-assistant-office-bridge.json");
		const existing = readOfficeCertMeta(metaPath);
		if (existing && existsSync(existing.pfxPath) && existsSync(existing.cerPath)) {
			if (!this.isCertTrusted(existing.thumbprint)) {
				this.trustLocalhostCert(existing.cerPath, existing.thumbprint);
			}
			return existing;
		}

		const passphrase = this.tokenFactory();
		const script = [
			`$ErrorActionPreference = 'Stop'`,
			`$pfx = ${psString(pfxPath)}`,
			`$cer = ${psString(cerPath)}`,
			`$meta = ${psString(metaPath)}`,
			`$pass = ${psString(passphrase)}`,
			`Remove-Item -LiteralPath $pfx,$cer,$meta -Force -ErrorAction SilentlyContinue`,
			`$cert = New-SelfSignedCertificate -DnsName 'localhost','127.0.0.1' -CertStoreLocation Cert:\\CurrentUser\\My -FriendlyName 'DesktopAssistantOfficeBridge' -NotAfter (Get-Date).AddYears(5) -KeyExportPolicy Exportable`,
			`$pw = ConvertTo-SecureString -String $pass -Force -AsPlainText`,
			`Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pw | Out-Null`,
			`Export-Certificate -Cert $cert -FilePath $cer | Out-Null`,
			`$cert.Thumbprint`,
		].join("\n");
		const thumbprint = this.powerShellRunner(script).trim();
		if (!thumbprint) {
			throw new Error("PowerShell did not return a thumbprint for the generated Office add-in certificate.");
		}
		this.trustLocalhostCert(cerPath, thumbprint);
		const cert = { pfxPath, cerPath, passphrase, thumbprint };
		writeFileSync(metaPath, JSON.stringify(cert, null, 2), "utf-8");
		return cert;
	}

	private trustLocalhostCert(cerPath: string, thumbprint: string): void {
		const script = [
			`$ErrorActionPreference = 'Stop'`,
			`$cer = ${psString(cerPath)}`,
			`$thumb = ${psString(thumbprint)}`,
			`if (Test-Path "Cert:\\CurrentUser\\Root\\$thumb") { 'already-trusted'; exit 0 }`,
			`$certutil = Join-Path $env:SystemRoot 'System32\\certutil.exe'`,
			`$process = Start-Process -FilePath $certutil -ArgumentList @('-user','-addstore','Root',$cer) -Wait -PassThru -WindowStyle Normal`,
			`if ($process.ExitCode -ne 0) { throw "certutil failed with exit code $($process.ExitCode)" }`,
			`if (!(Test-Path "Cert:\\CurrentUser\\Root\\$thumb")) { throw "Certificate was not trusted. Click Yes in the Windows security confirmation, then retry." }`,
			`'trusted'`,
		].join("\n");
		try {
			this.powerShellRunner(script);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				[
					"无法信任 Office 加载项的本地 HTTPS 证书。",
					"安装时会弹出 Windows 安全确认，请点击“是”以信任 localhost 证书。",
					"如果没有看到弹窗，请检查是否被系统安全策略或安全软件拦截。",
					message,
				].join(" "),
			);
		}
	}

	private isCertTrusted(thumbprint: string): boolean {
		try {
			const script = [
				`$thumb = ${psString(thumbprint)}`,
				`if (Test-Path "Cert:\\CurrentUser\\Root\\$thumb") { 'yes' }`,
			].join("\n");
			return this.powerShellRunner(script).trim() === "yes";
		} catch {
			return false;
		}
	}

	private sideloadManifest(manifestPath: string): string {
		const registryValueName = resolve(manifestPath);
		const script = [
			`$ErrorActionPreference = 'Stop'`,
			`$key = ${psString(OFFICE_WEF_DEVELOPER_KEY)}`,
			`$manifest = ${psString(registryValueName)}`,
			`New-Item -Path $key -Force | Out-Null`,
			`New-ItemProperty -Path $key -Name $manifest -Value $manifest -PropertyType String -Force | Out-Null`,
			`$manifest`,
		].join("\n");
		return this.powerShellRunner(script).trim() || registryValueName;
	}

	private removeSideload(registryValueName: string): void {
		const script = [
			`$key = ${psString(OFFICE_WEF_DEVELOPER_KEY)}`,
			`$name = ${psString(registryValueName)}`,
			`Remove-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue`,
		].join("\n");
		this.powerShellRunner(script);
	}

	private removeCertFromRoot(thumbprint: string): void {
		const script = [
			`$thumb = ${psString(thumbprint)}`,
			`Remove-Item -Path "Cert:\\CurrentUser\\Root\\$thumb" -ErrorAction SilentlyContinue`,
		].join("\n");
		this.powerShellRunner(script);
	}

	private certFromInstalledPlugin(plugin: InstalledSoftwarePlugin): OfficeCert {
		const pfxPath =
			plugin.installedFiles.find((file) => file.endsWith(".pfx")) ??
			join(this.assetDir, "office-addins", "certs", "desktop-assistant-office-bridge.pfx");
		const cerPath =
			plugin.installedFiles.find((file) => file.endsWith(".cer")) ??
			join(this.assetDir, "office-addins", "certs", "desktop-assistant-office-bridge.cer");
		const meta = readOfficeCertMeta(
			join(this.assetDir, "office-addins", "certs", "desktop-assistant-office-bridge.json"),
		);
		return {
			pfxPath,
			cerPath,
			passphrase: meta?.passphrase ?? "",
			thumbprint: plugin.certThumbprint ?? meta?.thumbprint ?? "",
		};
	}

	private readStore(): SoftwarePluginStore {
		try {
			if (!existsSync(this.storePath)) return { version: STORE_VERSION, plugins: [] };
			const parsed = JSON.parse(stripUtf8Bom(readFileSync(this.storePath, "utf-8"))) as Partial<SoftwarePluginStore>;
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
		id: OFFICE_WORD_PLUGIN_ID,
		name: "Word Live Collaboration",
		description:
			"Use an Office add-in to let the assistant edit the Word document you currently have open: read selection/state, insert/replace text, format text, and apply styles. Requires Office 2016 or Microsoft 365. First install trusts a local HTTPS certificate and registers the Word add-in for the current user.",
		targetSoftware: {
			id: "microsoft-word",
			name: "Microsoft Word",
			platform: "windows",
			suggestedPaths: ["C:\\Program Files\\Microsoft Office\\root\\Office16"],
		},
		validationRules: [],
		installSteps: [
			{
				id: "validate-office",
				title: "Detect Office",
				description: "Confirm Word/Office version is at least 16.0 for Office.js support.",
			},
			{
				id: "generate-cert",
				title: "Generate and trust local certificate",
				description: "Create a localhost certificate and add it to the current user's trusted root store.",
			},
			{
				id: "serve-content",
				title: "Prepare add-in manifest",
				description: "Generate the Word add-in manifest for the local HTTPS bridge.",
			},
			{
				id: "sideload-manifest",
				title: "Register Word add-in",
				description: "Write the HKCU Office WEF Developer registry value for sideloading.",
			},
			{
				id: "configure-mcp",
				title: "Configure MCP server",
				description: "Register the live Office add-in bridge MCP server.",
			},
		],
		mcpTemplate: {
			serverId: OFFICE_WORD_MCP_SERVER_ID,
			name: "Word Live Collaboration",
			toolNamePrefix: "word",
			description: "Edit the active Word document through an Office add-in.",
		},
	},
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

export function validateOfficeTarget(
	host: OfficeHost,
	targetPath = "",
	executableVersionReader: ExecutableVersionReader = readExecutableFileVersion,
): SoftwarePluginTargetValidation {
	const explicitTarget = targetPath.trim();
	const normalizedTarget = explicitTarget ? resolve(explicitTarget) : "";
	const exeName = OFFICE_EXE_BY_HOST[host];
	const exePath = normalizedTarget ? join(normalizedTarget, exeName) : findOfficeExecutable(host);
	const softwareVersion = exePath ? executableVersionReader(exePath) : undefined;
	const major = Number.parseInt((softwareVersion ?? "").split(".")[0] ?? "", 10);
	const valid = Boolean(exePath && softwareVersion && major >= 16);
	const displayName = OFFICE_NAME_BY_HOST[host];
	const warnings = ["Install will trust a localhost certificate in the current user's trusted root store."];
	const summary = valid
		? [
				`Target: ${exePath ? dirname(exePath) : normalizedTarget}`,
				`Executable: ${softwareVersion}`,
				`Control method: ${displayName} Office.js add-in + local HTTPS/WSS bridge.`,
			]
		: [
				normalizedTarget ? `Target: ${normalizedTarget}` : "Target: auto-detect",
				exePath ? `Executable version: ${softwareVersion ?? "unavailable"}` : `${exeName} was not found.`,
				"Office 2016 or Microsoft 365 (major version 16+) is required for Office.js add-ins.",
			];
	return {
		pluginId: pluginIdForOfficeHost(host),
		targetPath: exePath ? dirname(exePath) : normalizedTarget,
		valid,
		missingFiles: exePath && existsSync(exePath) ? [] : [exeName],
		softwareVersion,
		summary,
		requiresHost: false,
		hostDetected: false,
		autoHostInstallSupported: true,
		hostInstallHints: [],
		warnings,
	};
}

export function readInstalledOfficeChatBridgeTokens(agentDir: string): string[] {
	try {
		const storePath = join(agentDir, "software-plugins.json");
		if (!existsSync(storePath)) return [];
		const parsed = JSON.parse(stripUtf8Bom(readFileSync(storePath, "utf-8"))) as Partial<SoftwarePluginStore>;
		return normalizeStore(parsed)
			.plugins.filter((plugin) => plugin.status === "installed" && officeHostForPlugin(plugin.pluginId))
			.map((plugin) => plugin.officeChatBridgeToken)
			.filter((token): token is string => Boolean(token && token !== REDACTED));
	} catch {
		return [];
	}
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
		officeChatBridgeToken: plugin.officeChatBridgeToken ? REDACTED : undefined,
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
		officeChatBridgeUrl: cleanString(item.officeChatBridgeUrl),
		officeChatBridgeToken: cleanString(item.officeChatBridgeToken),
		hostPath: cleanString(item.hostPath),
		certThumbprint: cleanString(item.certThumbprint),
		registryValueName: cleanString(item.registryValueName),
		manifestId: cleanString(item.manifestId),
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

function stripUtf8Bom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function normalizeDebugPort(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(65535, Math.max(1024, Math.floor(value)));
}

function isManagedPluginFile(filePath: string, assetDir: string): boolean {
	const root = resolve(assetDir);
	const target = resolve(filePath);
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
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
		const output = runPowerShell(script).trim();
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

function runPowerShell(script: string): string {
	return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	});
}

function officeHostForPlugin(pluginId: string): OfficeHost | undefined {
	return OFFICE_HOST_BY_PLUGIN[pluginId as keyof typeof OFFICE_HOST_BY_PLUGIN];
}

function pluginIdForOfficeHost(host: OfficeHost): string {
	if (host === "word") return OFFICE_WORD_PLUGIN_ID;
	throw new Error(`Unsupported Office host: ${host}`);
}

function portFromBridgeUrl(bridgeUrl: string | undefined): number | undefined {
	if (!bridgeUrl) return undefined;
	try {
		return Number(new URL(bridgeUrl).port) || undefined;
	} catch {
		return undefined;
	}
}

function stableOfficeManifestId(pluginId: string): string {
	const hex = createHash("sha256").update(pluginId).digest("hex").slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function psString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function readOfficeCertMeta(path: string): OfficeCert | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<OfficeCert>;
		if (
			typeof parsed.pfxPath === "string" &&
			typeof parsed.cerPath === "string" &&
			typeof parsed.passphrase === "string" &&
			typeof parsed.thumbprint === "string"
		) {
			return {
				pfxPath: parsed.pfxPath,
				cerPath: parsed.cerPath,
				passphrase: parsed.passphrase,
				thumbprint: parsed.thumbprint,
			};
		}
	} catch {
		// No reusable certificate metadata.
	}
	return undefined;
}

function resolveBundledDir(relativePath: string, label: string, explicit?: string): string {
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
	throw new Error(`Bundled ${label} directory not found (${relativePath}).`);
}

function findOfficeExecutable(host: OfficeHost): string | undefined {
	const appPathExe = OFFICE_APP_PATH_EXE_BY_HOST[host];
	const script = [
		`$exe = ${psString(appPathExe)}`,
		`$paths = @("HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$exe", "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$exe")`,
		`foreach ($path in $paths) {`,
		`  try {`,
		`    $value = (Get-Item -Path $path -ErrorAction Stop).GetValue("")`,
		`    if ($value -and (Test-Path -LiteralPath $value)) { $value; exit 0 }`,
		`  } catch {}`,
		`}`,
	].join("\n");
	try {
		const output = runPowerShell(script).trim();
		return output || undefined;
	} catch {
		return undefined;
	}
}
