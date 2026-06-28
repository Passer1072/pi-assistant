import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
	AutomationPermissionMode,
	AutomationRiskLevel,
	DesktopCapabilityId,
	DesktopCapabilitySettings,
	DesktopToolResult,
	DocumentApplyResult,
	DocumentEditOperation,
	DocumentInspectionResult,
	DocumentRiskFlag,
	DocumentVerifyCheck,
	DocumentVerifyResult,
	MediaCommand,
	SandboxLane,
	SandboxSettings,
	WindowInfo,
} from "../shared/types.ts";
import {
	isLikelyDirectLaunch,
	parseFindAppResults,
	rememberFindAppResults,
	rememberLaunchFailure,
	rememberSuccessfulLaunch,
	resolveKnownWebsiteLaunch,
	resolveRememberedLaunch,
} from "./app-launch-memory.ts";
import type { CommandResult, DesktopAutomationHost, PowerShellRunOptions } from "./automation-host.ts";
import { isTimeout } from "./automation-host.ts";
import { classifyAutomationRisk, requiresConfirmation } from "./risk.ts";
import type { SandboxManager } from "./sandbox/sandbox-manager.ts";
import { canonicalize, isWithin } from "./sandbox/sandbox-workspace.ts";
import {
	type GateRequest,
	gateAction,
	LEGACY_DISABLED_SANDBOX,
	LEGACY_RUNTIME_STATE,
	type SandboxToolEnv,
} from "./sandbox/tool-gate.ts";

export interface DesktopToolOptions {
	host: DesktopAutomationHost;
	permissionMode: () => AutomationPermissionMode;
	autoApproveMaxRisk?: () => AutomationRiskLevel | undefined;
	systemCapability: () => DesktopCapabilitySettings;
	appLaunchCachePath?: string;
	/** Names of currently active MCP tools (e.g. mcp_ncm_*), used to redirect app workflows to a control plugin. */
	activeMcpToolNames?: () => string[];
	/** Current sandbox settings. Absent → legacy (no sandbox) behaviour, used by older tests. */
	sandbox?: () => SandboxSettings;
	/** Live sandbox manager (lifecycle, workspace, import/export). Absent → legacy behaviour. */
	sandboxManager?: SandboxManager;
	/**
	 * Route a browser/URL launch to the user's configured default (assistant) browser instead of
	 * the OS-default browser. Provided when AI browser control is enabled. open_app uses it so that
	 * "open a website" / "open chrome" go through the default browser (built-in/Chrome/Edge with the
	 * assistant's dedicated profile) rather than launching the user's native OS browser.
	 */
	openInDefaultBrowser?: (url?: string) => Promise<{ stdout: string; stderr: string }>;
}

/** Build the sandbox view a tool needs to gate one action. Falls back to a disabled sandbox. */
function sandboxEnvFor(options: DesktopToolOptions): SandboxToolEnv {
	return {
		settings: options.sandbox?.() ?? LEGACY_DISABLED_SANDBOX,
		permissionMode: options.permissionMode(),
		autoApproveMaxRisk: options.autoApproveMaxRisk?.(),
		runtime: options.sandboxManager?.getRuntimeState() ?? LEGACY_RUNTIME_STATE,
	};
}

function requiresToolConfirmation(riskLevel: AutomationRiskLevel, options: DesktopToolOptions): boolean {
	const threshold = options.autoApproveMaxRisk?.();
	if (!threshold) return requiresConfirmation(riskLevel, options.permissionMode());
	return riskRank(riskLevel) > riskRank(threshold);
}

function riskRank(risk: AutomationRiskLevel): number {
	switch (risk) {
		case "low":
			return 0;
		case "medium":
			return 1;
		case "high":
			return 2;
	}
}

/** Sandbox cwd/env/limits for a PowerShell run, given the chosen lane. */
function sandboxRunOptions(options: DesktopToolOptions, lane: SandboxLane): PowerShellRunOptions {
	const settings = options.sandbox?.() ?? LEGACY_DISABLED_SANDBOX;
	const limits = settings.resourceLimits;
	const base: PowerShellRunOptions = {
		timeoutMs: limits.commandTimeoutMs,
		maxOutputChars: limits.maxOutputChars,
		killProcessTree: limits.killProcessTree,
	};
	const manager = options.sandboxManager;
	if (manager) {
		const paths = manager.knownPaths();
		// Always expose the sandbox + real folder absolute paths as env vars so the
		// model can reliably build absolute paths in EITHER lane (e.g.
		// "$env:SANDBOX_ROOT\out.docx", "$env:SANDBOX_DESKTOP\report.docx") instead
		// of guessing or relying on cwd. These are real, resolved at runtime.
		const env: Record<string, string> = {
			SANDBOX_ROOT: paths.sandboxRoot,
			SANDBOX_TMP: paths.temp,
			SANDBOX_DESKTOP: paths.desktop,
			SANDBOX_DOCUMENTS: paths.documents,
			SANDBOX_DOWNLOADS: paths.downloads,
		};
		if (lane === "sandbox") {
			base.cwd = paths.sandboxRoot;
			env.TEMP = paths.temp;
			env.TMP = paths.temp;
		}
		base.env = env;
	}
	return base;
}

/** Map a built-in app workflow target to the MCP control-plugin tools that supersede it, if any are active. */
export function detectControlPluginTools(app: string, activeToolNames: string[]): string[] {
	if (app === "netease_cloud_music") {
		const signature = /play_song|play_personal_fm|play_daily_recommend|play_playlist|like_song|^mcp_ncm_/i;
		return activeToolNames.filter((name) => name.startsWith("mcp_") && signature.test(name));
	}
	return [];
}

const SYSTEM_OPERATION_GUIDELINES = [
	"System operation capability is enabled: you may operate Windows through background commands, system APIs, process launch, window control, keyboard and mouse automation, and safe PowerShell when appropriate.",
	"Do not create, edit, move, archive, or delete built-in Desktop Assistant skill files under packages/desktop-assistant/skills. AI maintenance of skills is limited to personal_skill_* tools and data/personal-skills.",
	"For system operations, prefer direct background command or API tools over opening Windows Settings or another visible UI. Opening Settings is a fallback only when the user explicitly asks for a Settings page or no direct operation tool exists.",
	"Use set_audio_device_or_volume for mute, unmute, and volume changes. Do not open sound settings for those tasks.",
	"Use set_display_brightness_or_scale for brightness changes. Do not open display settings for brightness tasks.",
	"For music players (网易云音乐/NetEase Cloud Music, QQ音乐, Spotify, etc.): if a music-control MCP plugin tool (name starts with mcp_, e.g. mcp_ncm_*) is available, you MUST use it for search/play/点歌/歌单/红心 instead of opening the app or pressing keys. Only when no such plugin exists, use app_interaction for the app workflow, then media_control, then keyboard_mouse as the last resort.",
	"Use media_control for generic system media keys (play, pause, next, previous) when no app-specific control plugin is available. Do not rely on keyboard_mouse alone for media playback tasks.",
	"After GUI or media actions, verify state with desktop_observe, get_screen_context, or the structured tool result before claiming completion.",
	"打开网页 / 网址 / 浏览器：用浏览器工具（内置 browser_* 或外部浏览器 MCP，取决于设置），不要用 open_app、命令或键鼠自动化去启动 Chrome/Edge/Firefox 或打开网址。open_app 只用于非浏览器应用。",
	"打开应用：open_app 若返回「已在运行」或「进程已在运行/窗口加载中」，即视为已成功——绝不要再次 open_app 或 find_app 重开（会开出多个实例）。需要确认窗口出现，就用 desktop_observe 稍等观察，而不是重复启动。",
	"控制类 MCP（如 mcp_ncm_*）若返回「目标软件正在启动中，请稍后重试」之类的提示：说明它已自动启动目标软件，应当等待约 5~10 秒后【重试同一个 MCP 工具一次】即可，不要反复重试、也不要因此改用桌面自动化/键盘去操作。",
	"Use shell_command_safe for low-risk Windows system operations that are not covered by a dedicated tool, while respecting confirmation gates for risky actions.",
	"Use open_windows_settings only to show a settings page or as a last resort for an operation that cannot be completed through a background command/API.",
	"Explain completed system operations briefly using the structured tool result instead of exposing private chain of thought.",
];

function result(params: {
	intent: string;
	action: string;
	target: string;
	status: DesktopToolResult["status"];
	stdout?: string;
	stderr?: string;
	riskText: string;
	options: DesktopToolOptions;
	observedState?: unknown;
	confidence?: DesktopToolResult["confidence"];
	nextActions?: string[];
}): DesktopToolResult {
	const riskLevel = classifyAutomationRisk(resultRiskText(params));
	return {
		stepId: randomUUID(),
		intent: params.intent,
		action: params.action,
		target: params.target,
		status: params.status,
		stdout: params.stdout,
		stderr: params.stderr,
		riskLevel,
		requiresConfirmation: requiresToolConfirmation(riskLevel, params.options),
		observedState: params.observedState,
		confidence: params.confidence,
		nextActions: params.nextActions,
	};
}

function resultRiskText(params: { riskText: string; action: string; target: string }): string {
	return `${params.riskText} ${params.action} ${params.target}`;
}

async function runOrBlock(
	options: DesktopToolOptions,
	params: {
		intent: string;
		action: string;
		target: string;
		riskText: string;
		/** Policy kind; desktop/system actions default to "system_config". */
		kind?: GateRequest["kind"];
		/** Tool name for per-tool gate overrides; defaults to the action. */
		toolName?: string;
	},
	run: () => Promise<{
		stdout: string;
		stderr: string;
		observedState?: unknown;
		confidence?: DesktopToolResult["confidence"];
		nextActions?: string[];
	}>,
): Promise<{ content: [{ type: "text"; text: string }]; details: DesktopToolResult }> {
	if (!options.systemCapability().enabled) {
		const details: DesktopToolResult = {
			stepId: randomUUID(),
			intent: params.intent,
			action: params.action,
			target: params.target,
			status: "blocked",
			riskLevel: "low",
			requiresConfirmation: false,
			stderr: "System operation capability is disabled in desktop assistant settings.",
		};
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	}

	// These are inherently real-system actions (desktop input, app launch, system
	// config) — they cannot run in the sandbox, so the lane is always "real".
	const gate = gateAction(sandboxEnvFor(options), {
		toolName: params.toolName ?? params.action,
		kind: params.kind ?? "system_config",
		lane: "real",
		intent: params.intent,
		action: params.action,
		target: params.target,
		riskText: resultRiskText(params),
	});
	if (gate.blocked) {
		return { content: [{ type: "text", text: JSON.stringify(gate.blocked) }], details: gate.blocked };
	}

	try {
		const commandResult = await run();
		const details = result({
			...params,
			status: "succeeded",
			stdout: commandResult.stdout,
			stderr: commandResult.stderr,
			options,
			observedState: commandResult.observedState,
			confidence: commandResult.confidence,
			nextActions: commandResult.nextActions,
		});
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	} catch (error) {
		const details = result({
			...params,
			status: "failed",
			stderr: error instanceof Error ? error.message : String(error),
			options,
		});
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	}
}

export function getActiveDesktopToolNames(
	capabilities: Record<DesktopCapabilityId, DesktopCapabilitySettings> | DesktopCapabilitySettings,
): string[] {
	const names: string[] = [];
	const systemCapability = "system" in capabilities ? capabilities.system : capabilities;
	const documentCapability = "document" in capabilities ? capabilities.document : undefined;
	const excelCapability = "excel" in capabilities ? capabilities.excel : undefined;
	const pptCapability = "ppt" in capabilities ? capabilities.ppt : undefined;
	if (systemCapability.enabled) {
		names.push(
			"find_app",
			"open_app",
			"open_windows_settings",
			"set_audio_device_or_volume",
			"set_display_brightness_or_scale",
			"window_control",
			"keyboard_mouse",
			"media_control",
			"app_interaction",
			"desktop_observe",
			"shell_command_safe",
			"shell_command_continue",
			"shell_command_abort",
			"wait",
			"get_screen_context",
			"sandbox_status",
			"sandbox_init",
			"sandbox_reset",
			"sandbox_list",
			"sandbox_clean",
			"sandbox_import",
			"sandbox_export",
		);
	}
	if (documentCapability?.enabled) {
		names.push(
			"doc_create_from_html",
			"doc_read",
			"doc_inspect",
			"doc_plan_edits",
			"doc_apply_edits",
			"doc_verify",
			"office_word_run",
		);
	}
	if (excelCapability?.enabled) {
		names.push("excel_read", "excel_write", "office_excel_run");
	}
	if (pptCapability?.enabled) {
		names.push("ppt_create", "ppt_read", "office_ppt_run");
	}
	return names;
}

export function createDesktopToolDefinitions(options: DesktopToolOptions): ToolDefinition[] {
	return [
		// System tools
		createFindAppTool(options),
		createOpenAppTool(options),
		createOpenWindowsSettingsTool(options),
		createAudioTool(options),
		createDisplayTool(options),
		createWindowControlTool(options),
		createKeyboardMouseTool(options),
		createMediaControlTool(options),
		createAppInteractionTool(options),
		createDesktopObserveTool(options),
		createSafeShellTool(options),
		createShellContinueTool(options),
		createShellAbortTool(options),
		createWaitTool(options),
		createScreenContextTool(options),
		// Sandbox workspace tools
		createSandboxStatusTool(options),
		createSandboxInitTool(options),
		createSandboxResetTool(options),
		createSandboxListTool(options),
		createSandboxCleanTool(options),
		createSandboxImportTool(options),
		createSandboxExportTool(options),
		// Document (Word) tools
		createDocCreateFromHtmlTool(options),
		createDocReadTool(options),
		createDocInspectTool(options),
		createDocPlanEditsTool(options),
		createDocApplyEditsTool(options),
		createDocVerifyTool(options),
		createOfficeWordRunTool(options),
		// Excel tools
		createExcelReadTool(options),
		createExcelWriteTool(options),
		createOfficeExcelRunTool(options),
		// PowerPoint tools
		createPptCreateTool(options),
		createPptReadTool(options),
		createOfficePptRunTool(options),
	];
}

const findAppSchema = Type.Object({
	query: Type.String({
		description: "App name or keyword to search, e.g. 'chrome', 'visual studio', 'WeChat'. Supports partial names.",
	}),
});

const openAppSchema = Type.Object({
	app: Type.String({
		description:
			"Application name, full exe path, Start Menu shortcut path (.lnk), or shell:AppsFolder\\AppId from find_app results.",
	}),
});

const windowsSettingsSchema = Type.Object({
	page: Type.String({ description: "Settings page key, for example sound, display, bluetooth, network." }),
});

const audioSchema = Type.Object({
	volumePercent: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
	muted: Type.Optional(Type.Boolean({ description: "Mute or unmute the default playback device." })),
	deviceName: Type.Optional(Type.String()),
});

const displaySchema = Type.Object({
	brightnessPercent: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
	scalePercent: Type.Optional(Type.Number({ minimum: 100, maximum: 500 })),
});

const windowControlSchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("focus")]),
	title: Type.Optional(Type.String()),
});

const keyboardMouseSchema = Type.Object({
	action: Type.Union([Type.Literal("type"), Type.Literal("key"), Type.Literal("click")]),
	text: Type.Optional(Type.String()),
	key: Type.Optional(Type.String()),
	modifiers: Type.Optional(Type.Array(Type.String())),
	button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
});

const mediaControlSchema = Type.Object({
	command: Type.Union([
		Type.Literal("play"),
		Type.Literal("pause"),
		Type.Literal("toggle"),
		Type.Literal("next"),
		Type.Literal("previous"),
	]),
});

const appInteractionSchema = Type.Object({
	app: Type.Union([Type.Literal("netease_cloud_music")], {
		description: "Supported app workflow target. netease_cloud_music controls NetEase Cloud Music.",
	}),
	action: Type.Union([Type.Literal("play_song"), Type.Literal("focus"), Type.Literal("verify_playback")]),
	query: Type.Optional(Type.String({ description: "Song, artist, or search query for play_song." })),
});

const safeShellSchema = Type.Object({
	command: Type.String({ description: "PowerShell command to run." }),
	target: Type.Optional(
		Type.Union([Type.Literal("sandbox"), Type.Literal("real")], {
			description:
				"Where to run: 'sandbox' (default) runs isolated in the sandbox workspace (no approval needed); 'real' runs on the real system (approval depends on permission mode). Prefer 'sandbox'; use 'real' only when the task must affect the real system.",
		}),
	),
});

const SYSTEM_SKILL_MUTATION_VERBS =
	/\b(set-content|add-content|out-file|new-item|copy-item|move-item|remove-item|rename-item|clear-content|del|delete|erase|rm|rmdir|mkdir|ni|sc|ac|mv|cp|ren|writealltext|appendalltext|create|openwrite)\b/i;
const SYSTEM_SKILL_PATH_PATTERN =
	/(packages[\\/]+desktop-assistant[\\/]+skills|packages\/desktop-assistant\/skills|packages\\desktop-assistant\\skills|skills[\\/]+(?:system-operation|document-operation|ppt-operation|excel-operation)[\\/]+skill\.md)/i;

export function isSystemSkillMutationCommand(command: string): boolean {
	return SYSTEM_SKILL_PATH_PATTERN.test(command) && SYSTEM_SKILL_MUTATION_VERBS.test(command);
}

const shellContinueSchema = Type.Object({
	executionId: Type.String({
		description: "The executionId returned in the previous timeout result. Identifies the still-running process.",
	}),
	newTimeoutSeconds: Type.Number({
		description: "How many additional seconds to wait before timing out again. Minimum 5.",
	}),
});

const shellAbortSchema = Type.Object({
	executionId: Type.String({
		description: "The executionId of the still-running process to terminate immediately.",
	}),
});

const waitSchema = Type.Object({
	seconds: Type.Number({
		minimum: 1,
		maximum: 120,
		description: "How many seconds to pause before the next status check. Range: 1-120.",
	}),
	reason: Type.Optional(Type.String({ description: "Optional short reason for the wait." })),
});

const desktopObserveSchema = Type.Object({});
const screenContextSchema = Type.Object({});

function buildFindAppScript(rawQuery: string): string {
	// Encode the query as Base64 so non-ASCII characters (e.g. Chinese) are never
	// literally embedded in the script string — PowerShell 5.1 decodes them correctly.
	const queryB64 = Buffer.from(rawQuery, "utf-8").toString("base64");
	return [
		`# Decode the search query from Base64 to handle Chinese and other non-ASCII names.`,
		`$qRaw = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${queryB64}'))`,
		`$q = "*$qRaw*"`,
		`$r = @()`,
		``,
		`# 1. Desktop + Start Menu .lnk shortcuts (explicit env-var paths for reliability)`,
		`$lnkDirs = @(`,
		`  "$env:USERPROFILE\\Desktop",`,
		`  "$env:PUBLIC\\Desktop",`,
		`  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",`,
		`  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs"`,
		`) | Where-Object { $_ -and (Test-Path $_) }`,
		`foreach ($d in $lnkDirs) {`,
		`  Get-ChildItem $d -Recurse -Filter *.lnk -ErrorAction SilentlyContinue |`,
		`  Where-Object { $_.BaseName -like $q } |`,
		`  ForEach-Object { $r += [pscustomobject]@{name=$_.BaseName;launch=$_.FullName;kind='lnk'} }`,
		`}`,
		``,
		`# 2. Get-StartApps — Store/UWP and modern app list`,
		`try {`,
		`  Get-StartApps | Where-Object { $_.Name -like $q } | ForEach-Object {`,
		`    $launch = if ($_.AppId -match '!') { "shell:AppsFolder\\$($_.AppId)" } else { $_.AppId }`,
		`    $r += [pscustomobject]@{name=$_.Name;launch=$launch;kind='app'}`,
		`  }`,
		`} catch {}`,
		``,
		`# 3. Registry installed Win32 programs`,
		`@('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',`,
		`  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',`,
		`  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*') | ForEach-Object {`,
		`  Get-ItemProperty $_ -ErrorAction SilentlyContinue |`,
		`  Where-Object { $_.DisplayName -like $q -and $_.DisplayIcon } |`,
		`  ForEach-Object {`,
		`    $exe = ($_.DisplayIcon -split ',')[0].Trim('"').Trim("'")`,
		`    if ($exe -like '*.exe' -and (Test-Path $exe)) {`,
		`      $r += [pscustomobject]@{name=$_.DisplayName;launch=$exe;kind='installed'}`,
		`    }`,
		`  }`,
		`}`,
		``,
		`# 4. Scan exe files in common install directories (depth 3)`,
		`$scanDirs = @(`,
		`  $env:ProgramFiles,`,
		`  "$env:SystemDrive\\Program Files (x86)",`,
		`  "$env:LOCALAPPDATA\\Programs",`,
		`  "$env:USERPROFILE\\Tencent",`,
		`  "$env:USERPROFILE\\AppData\\Roaming\\Tencent",`,
		`  "$env:USERPROFILE\\AppData\\Local\\Tencent",`,
		`  "$env:USERPROFILE\\AppData\\Roaming\\NetEase",`,
		`  "$env:USERPROFILE\\AppData\\Local\\Programs"`,
		`) | Where-Object { $_ -and (Test-Path $_) }`,
		`foreach ($dir in $scanDirs) {`,
		`  Get-ChildItem -Path $dir -Recurse -Depth 3 -Filter *.exe -ErrorAction SilentlyContinue |`,
		`  Where-Object { $_.BaseName -like $q } |`,
		`  Select-Object -First 4 |`,
		`  ForEach-Object { $r += [pscustomobject]@{name=$_.BaseName;launch=$_.FullName;kind='exe'} }`,
		`}`,
		``,
		`# 5. Direct command lookup (handles apps in PATH)`,
		`try {`,
		`  $cmd = Get-Command $qRaw -ErrorAction SilentlyContinue -CommandType Application | Select-Object -First 1`,
		`  if ($cmd) { $r += [pscustomobject]@{name=$qRaw;launch=$cmd.Source;kind='cmd'} }`,
		`} catch {}`,
		``,
		`$top = @($r | Sort-Object name -Unique | Select-Object -First 10)`,
		`if ($top.Count -eq 0) {`,
		`  Write-Output '{"found":false,"count":0,"results":[]}'`,
		`} else {`,
		`  $jsonRaw = $top | ConvertTo-Json -Compress -Depth 2`,
		`  if (-not $jsonRaw.TrimStart().StartsWith('[')) { $jsonRaw = "[$jsonRaw]" }`,
		`  Write-Output "{""found"":true,""count"":$($top.Count),""results"":$jsonRaw}"`,
		`}`,
	].join("\n");
}

function createFindAppTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "find_app",
		label: "Find app",
		description:
			"Search for installed Windows applications by name. Returns a list of matching apps with their launch paths. Use this before open_app when the app path is uncertain.",
		promptSnippet:
			"Search for installed apps by partial name. Returns launch paths for Start Menu shortcuts, Store/UWP apps, and registry-installed programs. Pass the returned launch value directly to open_app.",
		promptGuidelines: SYSTEM_OPERATION_GUIDELINES,
		parameters: findAppSchema,
		execute: async (_toolCallId, params) => {
			// Limit length only; special characters are safe because buildFindAppScript
			// Base64-encodes the query before injecting it into the PowerShell script.
			const rawQuery = params.query.trim().slice(0, 100);
			const stepId = randomUUID();
			if (!rawQuery) {
				const details: DesktopToolResult = {
					stepId,
					intent: "Find application",
					action: "find-app",
					target: params.query,
					status: "failed",
					stderr: "Query is empty.",
					riskLevel: "low",
					requiresConfirmation: false,
				};
				return { content: [{ type: "text", text: JSON.stringify(details) }], details };
			}
			try {
				const result = await options.host.runPowerShell(buildFindAppScript(rawQuery));
				const stdout = result.stdout.trim() || '{"found":false,"count":0,"results":[]}';
				if (options.appLaunchCachePath) {
					rememberFindAppResults(options.appLaunchCachePath, rawQuery, stdout);
				}
				const details: DesktopToolResult = {
					stepId,
					intent: "Find application",
					action: "find-app",
					target: params.query,
					status: "succeeded",
					stdout,
					stderr: result.stderr,
					riskLevel: "low",
					requiresConfirmation: false,
				};
				return { content: [{ type: "text", text: JSON.stringify(details) }], details };
			} catch (error) {
				const details: DesktopToolResult = {
					stepId,
					intent: "Find application",
					action: "find-app",
					target: params.query,
					status: "failed",
					stderr: error instanceof Error ? error.message : String(error),
					riskLevel: "low",
					requiresConfirmation: false,
				};
				return { content: [{ type: "text", text: JSON.stringify(details) }], details };
			}
		},
	});
}

/** Base token used to match a process/window for an app (strip path/extension/AppId). */
function appMatchBase(target: string): string {
	return target
		.replace(/^.*[/\\]/, "")
		.replace(/\.lnk$/i, "")
		.replace(/\.exe$/i, "")
		.replace(/^shell:AppsFolder\\.+!/, "")
		.replace(/[_.-]/g, " ")
		.toLowerCase()
		.trim();
}

/** Is a process (or a window) matching `nameBase` already running? Avoids launching an app twice. */
async function findRunningApp(options: DesktopToolOptions, nameBase: string): Promise<boolean> {
	const safe = nameBase.replace(/['`$;]/g, "").trim();
	if (!safe || safe.length < 2) return false;
	const script = [
		`$n = ${JSON.stringify(safe)}`,
		"$p = Get-Process -ErrorAction SilentlyContinue | Where-Object {",
		'  $_.ProcessName -like "*$n*" -or ($_.MainWindowTitle -and $_.MainWindowTitle -like "*$n*")',
		"} | Select-Object -First 1",
		"if ($p) { 'RUNNING' } else { '' }",
	].join("\n");
	try {
		const result = await options.host.runPowerShell(script);
		// Match the executed OUTPUT only (a whole line === "RUNNING"), never the echoed script body.
		return result.stdout.split(/\r?\n/).some((line) => line.trim() === "RUNNING");
	} catch {
		return false;
	}
}

/** App names that mean "a web browser" — launching these should go through the default browser. */
const BROWSER_LAUNCH_NAMES = new Set([
	"chrome",
	"google chrome",
	"googlechrome",
	"chrome.exe",
	"谷歌",
	"谷歌浏览器",
	"edge",
	"msedge",
	"msedge.exe",
	"microsoft edge",
	"微软edge",
	"微软浏览器",
	"firefox",
	"火狐",
	"火狐浏览器",
	"browser",
	"web browser",
	"浏览器",
	"网页浏览器",
	"default browser",
	"默认浏览器",
]);

/**
 * When open_app is asked to launch a browser or open a URL, return the URL to hand to the default
 * browser (undefined url = open the default browser itself). Returns null for non-browser apps.
 */
function browserLaunchRedirect(app: string): { url?: string } | null {
	const trimmed = app.trim();
	if (/^https?:\/\//i.test(trimmed)) return { url: trimmed };
	if (BROWSER_LAUNCH_NAMES.has(trimmed.toLowerCase())) return {};
	return null;
}

function createOpenAppTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "open_app",
		label: "Open app",
		description:
			"Open a Windows application. Accepts an app name (notepad), full exe path, Start Menu .lnk path, or shell:AppsFolder\\AppId from find_app results. If the app name is uncertain, call find_app first.",
		promptSnippet:
			"Launch applications by name, path, or shell:AppsFolder URI. Use find_app first when the exact name or path is unknown.",
		promptGuidelines: SYSTEM_OPERATION_GUIDELINES,
		parameters: openAppSchema,
		execute: async (_toolCallId, params) =>
			runOrBlock(
				options,
				{
					intent: "Open application",
					action: "start-process",
					target: params.app,
					riskText: `open app ${params.app}`,
				},
				async () => {
					const cachePath = options.appLaunchCachePath;
					const requestedApp = params.app.trim();
					// Route browser / URL launches through the user's default browser instead of the
					// OS-default browser, so "open chrome" / "open a website" use the assistant browser.
					if (options.openInDefaultBrowser) {
						const redirect = browserLaunchRedirect(requestedApp);
						if (redirect) return options.openInDefaultBrowser(redirect.url);
					}
					const cacheHit =
						cachePath && !isLikelyDirectLaunch(requestedApp)
							? resolveRememberedLaunch(cachePath, requestedApp)
							: undefined;
					let launchTarget = cacheHit?.entry.launch ?? requestedApp;
					let launchKind = cacheHit?.entry.kind ?? (isLikelyDirectLaunch(requestedApp) ? "direct" : "name");
					let launchDisplayName = cacheHit?.entry.displayName ?? requestedApp;
					let resolvedBy = cacheHit ? `app-launch-cache:${cacheHit.alias}` : "direct";

					// Avoid double-launch: if a process/window for this app is already running, focus it
					// instead of launching again (the app may be opened-but-still-loading from a prior call).
					const preBase = appMatchBase(launchTarget) || appMatchBase(requestedApp);
					if (await findRunningApp(options, preBase)) {
						let focusedNote = "";
						try {
							const focus = await options.host.focusWindow(requestedApp);
							focusedNote = focus.stdout ? "，已聚焦其窗口" : "";
						} catch {}
						return {
							stdout: `已在运行：${requestedApp} 已经打开${focusedNote}。未重复启动，避免开出多个实例。`,
							stderr: "",
						};
					}

					let launchResult: CommandResult;
					try {
						launchResult = await options.host.startProcess(launchTarget);
					} catch (error) {
						if (cachePath) {
							rememberLaunchFailure(cachePath, requestedApp, launchTarget);
						}
						if (isLikelyDirectLaunch(requestedApp)) {
							throw error;
						}
						const searchResult = await options.host.runPowerShell(buildFindAppScript(requestedApp));
						const [foundApp] = parseFindAppResults(searchResult.stdout);
						if (!foundApp) {
							const knownWebsite = resolveKnownWebsiteLaunch(requestedApp);
							if (knownWebsite) {
								// A known-website fallback resolves to a URL — open it in the default browser
								// rather than the OS browser when AI browser control is available.
								if (options.openInDefaultBrowser && /^https?:\/\//i.test(knownWebsite.launch)) {
									return options.openInDefaultBrowser(knownWebsite.launch);
								}
								launchTarget = knownWebsite.launch;
								launchKind = knownWebsite.kind;
								launchDisplayName = knownWebsite.displayName;
								resolvedBy = "known website fallback";
								launchResult = await options.host.startProcess(launchTarget);
							} else {
								const original = error instanceof Error ? error.message : String(error);
								throw new Error(
									`Direct launch failed and find_app found no result for "${requestedApp}". ${original}`,
								);
							}
						} else {
							launchTarget = foundApp.launch;
							launchKind = foundApp.kind;
							launchDisplayName = foundApp.name;
							resolvedBy = "find_app fallback";
							launchResult = await options.host.startProcess(launchTarget);
						}
					}
					// Wait briefly, then verify the window appeared via process list.
					await new Promise<void>((r) => setTimeout(r, 1500));
					const windows = await options.host.listWindows();
					// Match by process name or window title (strip extension and path for flexibility).
					const appBase = launchTarget
						.replace(/^.*[/\\]/, "") // strip directory
						.replace(/\.lnk$/i, "") // strip .lnk extension
						.replace(/\.exe$/i, "") // strip .exe extension
						.replace(/^shell:AppsFolder\\.+!/, "") // strip AppId prefix, keep app name part
						.replace(/[_.-]/g, " ")
						.toLowerCase()
						.trim();
					const found = windows.some((w) => {
						const title = (w.title ?? "").toLowerCase();
						const proc = (w.processName ?? "").toLowerCase();
						return appBase && (title.includes(appBase) || proc.includes(appBase));
					});
					if (cachePath) {
						rememberSuccessfulLaunch(cachePath, {
							query: requestedApp,
							displayName: launchDisplayName || appBase || requestedApp,
							launch: launchTarget,
							kind: launchKind,
							targetType: /^https?:/i.test(launchTarget) || launchKind === "url" ? "url" : "app",
						});
					}
					const resolutionText =
						launchTarget === requestedApp ? requestedApp : `${requestedApp} -> ${launchTarget} (${resolvedBy})`;
					// If no window yet, confirm via the process list so we can tell the model "started, loading"
					// (a success) instead of an ambiguous "not detected" that tempts it to launch again.
					const processRunning = found ? true : await findRunningApp(options, appBase);
					return {
						stdout: found
							? `已启动并确认窗口可见 (${resolutionText})`
							: processRunning
								? `已成功启动 ${requestedApp}（进程已在运行，窗口可能仍在加载中）。请勿重复打开；如需确认窗口出现，可稍后用 desktop_observe，不要再次 open_app。`
								: `启动命令已执行，暂未检测到窗口，应用可能仍在加载 (${params.app})。请勿立即重复打开；可稍后用 desktop_observe 确认。`,
						stderr: launchResult.stderr,
					};
				},
			),
	});
}

function createOpenWindowsSettingsTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "open_windows_settings",
		label: "Open settings",
		description: "Open a Windows Settings page with a safe ms-settings URI.",
		promptSnippet:
			"Fallback-only tool for opening Windows Settings pages. Use it when the user explicitly wants Settings or no direct system operation exists.",
		promptGuidelines: SYSTEM_OPERATION_GUIDELINES,
		parameters: windowsSettingsSchema,
		execute: async (_toolCallId, params) => {
			const uri = settingsPageToUri(params.page);
			return runOrBlock(
				options,
				{ intent: "Open Windows Settings", action: "open-uri", target: uri, riskText: params.page },
				() => options.host.startProcess("cmd.exe", ["/c", "start", "", uri]),
			);
		},
	});
}

function settingsPageToUri(page: string): string {
	const normalized = page.trim().toLowerCase();
	const pages: Record<string, string> = {
		audio: "ms-settings:sound",
		bluetooth: "ms-settings:bluetooth",
		display: "ms-settings:display",
		microphone: "ms-settings:privacy-microphone",
		network: "ms-settings:network",
		privacy: "ms-settings:privacy",
		screen: "ms-settings:display",
		sound: "ms-settings:sound",
		voice: "ms-settings:speech",
	};
	return pages[normalized] ?? `ms-settings:${normalized.replace(/[^a-z0-9-]/g, "")}`;
}

function createAudioTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "set_audio_device_or_volume",
		label: "Audio",
		description: "Mute, unmute, or set the default Windows playback volume in the background.",
		promptSnippet:
			"Set system audio directly in the background without opening Settings. Use muted=true for mute, muted=false for unmute, or volumePercent for volume.",
		promptGuidelines: SYSTEM_OPERATION_GUIDELINES,
		parameters: audioSchema,
		execute: async (_toolCallId, params) => {
			const target = describeAudioTarget(params);
			const script = createAudioPowerShell(params);
			return runOrBlock(
				options,
				{ intent: "Adjust audio", action: "powershell", target: script, riskText: `audio ${target}` },
				() => options.host.runPowerShell(script),
			);
		},
	});
}

export function describeAudioTarget(params: { volumePercent?: number; muted?: boolean; deviceName?: string }): string {
	if (params.muted === true) return "mute default playback device";
	if (params.muted === false) return "unmute default playback device";
	if (params.volumePercent !== undefined)
		return `set default playback volume to ${clampPercent(params.volumePercent)}%`;
	return params.deviceName ? `open audio device settings for ${params.deviceName}` : "open sound settings";
}

export function createAudioPowerShell(params: {
	volumePercent?: number;
	muted?: boolean;
	deviceName?: string;
}): string {
	if (params.volumePercent === undefined && params.muted === undefined) {
		return "Start-Process ms-settings:sound";
	}
	const volumePercent = params.volumePercent === undefined ? undefined : clampPercent(params.volumePercent);
	const scalar = volumePercent === undefined ? undefined : (volumePercent / 100).toFixed(4);
	const muteValue = params.muted === undefined ? volumePercent === 0 : params.muted;
	const lines = [CORE_AUDIO_POWERSHELL];
	if (scalar !== undefined) {
		lines.push(`[AudioEndpoint]::Volume = ${scalar}`);
	}
	lines.push(`[AudioEndpoint]::Mute = ${muteValue ? "$true" : "$false"}`);
	const summary =
		scalar === undefined
			? `Muted default playback device: ${muteValue}`
			: `Set default playback volume to ${volumePercent}%; muted: ${muteValue}`;
	lines.push(`Write-Output ${JSON.stringify(summary)}`);
	return lines.join("\n");
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

const CORE_AUDIO_POWERSHELL = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[ComImport]
[Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumerator {}

public enum EDataFlow { eRender, eCapture, eAll }
public enum ERole { eConsole, eMultimedia, eCommunications }

[ComImport]
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
    int NotImpl1();
    [PreserveSig]
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppDevice);
}

[ComImport]
[Guid("D666063F-1587-4E43-81F1-B948E807363F")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
    [PreserveSig]
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out IAudioEndpointVolume ppInterface);
}

[ComImport]
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr pNotify);
    int UnregisterControlChangeNotify(IntPtr pNotify);
    int GetChannelCount(out uint pnChannelCount);
    int SetMasterVolumeLevel(float fLevelDB, Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    int SetMute(bool bMute, Guid pguidEventContext);
    int GetMute(out bool pbMute);
    int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
    int VolumeStepUp(Guid pguidEventContext);
    int VolumeStepDown(Guid pguidEventContext);
    int QueryHardwareSupport(out uint pdwHardwareSupportMask);
    int GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);
}

public static class AudioEndpoint {
    private static IAudioEndpointVolume GetEndpointVolume() {
        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice device;
        int endpointResult = enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device);
        if (endpointResult != 0) {
            throw new InvalidOperationException("Unable to get default audio endpoint: " + endpointResult);
        }
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        IAudioEndpointVolume endpoint;
        int activateResult = device.Activate(ref iid, 23, IntPtr.Zero, out endpoint);
        if (activateResult != 0) {
            throw new InvalidOperationException("Unable to activate audio endpoint: " + activateResult);
        }
        return endpoint;
    }

    public static float Volume {
        get {
            float level;
            GetEndpointVolume().GetMasterVolumeLevelScalar(out level);
            return level;
        }
        set {
            float clamped = Math.Max(0.0f, Math.Min(1.0f, value));
            GetEndpointVolume().SetMasterVolumeLevelScalar(clamped, Guid.Empty);
        }
    }

    public static bool Mute {
        get {
            bool muted;
            GetEndpointVolume().GetMute(out muted);
            return muted;
        }
        set {
            GetEndpointVolume().SetMute(value, Guid.Empty);
        }
    }
}
"@
`;

function createDisplayTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "set_display_brightness_or_scale",
		label: "Display",
		description: "Set Windows display brightness in the background, or fall back for display scale/settings.",
		promptSnippet:
			"Set display brightness directly in the background. Open display settings only as a fallback for scale changes or when no direct command is available.",
		promptGuidelines: SYSTEM_OPERATION_GUIDELINES,
		parameters: displaySchema,
		execute: async (_toolCallId, params) => {
			const target = describeDisplayTarget(params);
			return runOrBlock(
				options,
				{ intent: "Adjust display", action: "powershell", target, riskText: `display ${target}` },
				() => options.host.runPowerShell(createDisplayPowerShell(params)),
			);
		},
	});
}

export function describeDisplayTarget(params: { brightnessPercent?: number; scalePercent?: number }): string {
	if (params.brightnessPercent !== undefined) {
		return `set display brightness to ${clampPercent(params.brightnessPercent)}%`;
	}
	if (params.scalePercent !== undefined) {
		return `open display settings for scale ${Math.max(100, Math.min(500, Math.round(params.scalePercent)))}%`;
	}
	return "open display settings";
}

export function createDisplayPowerShell(params: { brightnessPercent?: number; scalePercent?: number }): string {
	if (params.brightnessPercent !== undefined) {
		const brightnessPercent = clampPercent(params.brightnessPercent);
		return [
			"$monitors = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop",
			"if (-not $monitors) { throw 'No controllable display brightness endpoint was found.' }",
			`$monitors | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = ${brightnessPercent} } | Out-Null }`,
			`Write-Output ${JSON.stringify(`Set display brightness to ${brightnessPercent}%`)}`,
		].join("\n");
	}
	if (params.scalePercent !== undefined) {
		const scalePercent = Math.max(100, Math.min(500, Math.round(params.scalePercent)));
		return [
			"Start-Process ms-settings:display",
			`Write-Output ${JSON.stringify(`Display scale ${scalePercent}% requires Windows Settings confirmation`)}`,
		].join("\n");
	}
	return "Start-Process ms-settings:display; Write-Output 'Opened display settings'";
}

function createWindowControlTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "window_control",
		label: "Window",
		description: "Inspect visible desktop windows or focus a matching window by title/process.",
		promptSnippet: "List visible windows or focus a window by title/process before GUI automation.",
		promptGuidelines: SYSTEM_OPERATION_GUIDELINES,
		parameters: windowControlSchema,
		execute: async (_toolCallId, params) =>
			runOrBlock(
				options,
				{
					intent: "Window control",
					action: params.action,
					target: params.title ?? "all windows",
					riskText: `window ${params.action} ${params.title ?? ""}`,
				},
				async () => {
					if (params.action === "focus") {
						const focusTarget = params.title?.trim();
						if (!focusTarget) {
							throw new Error("window_control focus requires a title or process name.");
						}
						const focusResult = await options.host.focusWindow(focusTarget);
						const activeWindow = await options.host.getActiveWindow();
						const succeeded = !focusResult.stderr && activeWindowMatches(activeWindow, focusTarget);
						return {
							stdout: focusResult.stdout || JSON.stringify(activeWindow),
							stderr: focusResult.stderr,
							observedState: { activeWindow },
							confidence: succeeded ? "high" : "low",
							nextActions: succeeded
								? undefined
								: [
										"Call desktop_observe to inspect the active window.",
										"Try a more specific window title or process name.",
									],
						};
					}
					const windows = await options.host.listWindows();
					return { stdout: JSON.stringify(windows), stderr: "", observedState: { windows }, confidence: "high" };
				},
			),
	});
}

function createKeyboardMouseTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "keyboard_mouse",
		label: "Keyboard/mouse",
		description: "Type text, press a key, or click the mouse for GUI automation.",
		promptSnippet: "Use keyboard and mouse for GUI automation after command/API options are insufficient.",
		promptGuidelines: SYSTEM_OPERATION_GUIDELINES,
		parameters: keyboardMouseSchema,
		execute: async (_toolCallId, params) =>
			runOrBlock(
				options,
				{
					intent: "Keyboard or mouse",
					action: params.action,
					target: params.text ?? params.key ?? params.button ?? "input",
					riskText: `${params.action} ${params.text ?? params.key ?? params.button ?? ""}`,
				},
				() => {
					if (params.action === "type") return options.host.typeText(params.text ?? "");
					if (params.action === "key") return options.host.keyTap(params.key ?? "Enter", params.modifiers);
					return options.host.mouseClick(params.button ?? "left");
				},
			),
	});
}

function createMediaControlTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "media_control",
		label: "Media",
		description:
			"Control Windows media playback with system media commands. Use this for play, pause, next, and previous instead of raw spacebar automation.",
		promptSnippet:
			"Send Windows media commands and inspect active/window state afterward. Verify playback state before claiming media tasks are complete.",
		promptGuidelines: SYSTEM_OPERATION_GUIDELINES,
		parameters: mediaControlSchema,
		execute: async (_toolCallId, params) =>
			runOrBlock(
				options,
				{
					intent: "Control media playback",
					action: params.command,
					target: "system media session",
					riskText: `media ${params.command}`,
				},
				async () => {
					const mediaResult = await options.host.sendMediaCommand(params.command as MediaCommand);
					await wait(300);
					const activeWindow = await options.host.getActiveWindow();
					const windows = await options.host.listWindows();
					const observedState = { activeWindow, mediaWindows: windows.filter(isLikelyMediaWindow) };
					const hasMediaWindow = observedState.mediaWindows.length > 0 || isLikelyMediaWindow(activeWindow);
					return {
						stdout: JSON.stringify({
							command: params.command,
							result: mediaResult.stdout,
							verification: hasMediaWindow
								? "Media command sent and a likely media window is visible."
								: "Media command sent, but no likely media window was detected.",
						}),
						stderr: mediaResult.stderr,
						observedState,
						confidence: hasMediaWindow ? "medium" : "low",
						nextActions: hasMediaWindow
							? ["If the user requested a specific track, verify the player shows the requested song."]
							: [
									"Open or focus the media player with app_interaction or open_app.",
									"Call desktop_observe to inspect the current active window.",
								],
					};
				},
			),
	});
}

function createAppInteractionTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "app_interaction",
		label: "App interaction",
		description:
			"Perform known high-level workflows in desktop applications. Currently supports NetEase Cloud Music focus, song search/play, and playback verification. " +
			"If a dedicated control plugin (mcp_ tool) for the target app is active, this tool refuses and tells you to use the plugin instead.",
		promptSnippet:
			"Use for common app workflows such as playing a song in NetEase Cloud Music ONLY when no mcp_ control plugin for that app is available. It performs focus, input, playback trigger, and state reporting.",
		promptGuidelines: SYSTEM_OPERATION_GUIDELINES,
		parameters: appInteractionSchema,
		execute: async (_toolCallId, params) => {
			const pluginTools = options.activeMcpToolNames
				? detectControlPluginTools(params.app, options.activeMcpToolNames())
				: [];
			if (pluginTools.length > 0) {
				return redirectToControlPlugin(params, pluginTools);
			}
			return runOrBlock(
				options,
				{
					intent: "Application interaction",
					action: `${params.app}:${params.action}`,
					target: params.query ?? params.app,
					riskText: `app interaction ${params.app} ${params.action} ${params.query ?? ""}`,
				},
				async () => runAppInteraction(options.host, params),
			);
		},
	});
}

/** When a control plugin supersedes the built-in workflow, refuse and steer the model to the mcp_ tools. */
function redirectToControlPlugin(
	params: { app: "netease_cloud_music"; action: "play_song" | "focus" | "verify_playback"; query?: string },
	pluginTools: string[],
): { content: [{ type: "text"; text: string }]; details: DesktopToolResult } {
	const pick = (suffix: string) => pluginTools.find((name) => name.endsWith(suffix));
	let suggestion: string;
	if (params.action === "play_song") {
		const target = pick("play_song_by_name") ?? pick("search") ?? pluginTools[0];
		suggestion = params.query ? `${target} {"query": ${JSON.stringify(params.query)}}` : target;
	} else {
		suggestion = `${pick("get_playback_state") ?? pluginTools[0]} {}`;
	}
	const details: DesktopToolResult = {
		stepId: randomUUID(),
		intent: "Application interaction",
		action: `${params.app}:${params.action}`,
		target: params.query ?? params.app,
		status: "blocked",
		riskLevel: "low",
		requiresConfirmation: false,
		stderr:
			"网易云音乐控制插件(MCP)已激活。音乐任务必须改用 mcp_ncm_* 工具，已阻止低层 UI 自动化（开应用/键盘搜索）以保证可靠。",
		nextActions: [`改用：${suggestion}`, `可用的网易云控制工具：${pluginTools.slice(0, 10).join(", ")}`],
	};
	return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

function createSafeShellTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "shell_command_safe",
		label: "Safe shell",
		description:
			"Run a PowerShell command after risk classification. " +
			"Commands that exceed the 30-second timeout return status='timeout' with an executionId — " +
			"the process keeps running; use shell_command_continue to keep waiting or shell_command_abort to kill it.",
		promptSnippet:
			"Run Windows system operations through low-risk PowerShell commands in the background, with confirmation gates for risky commands.",
		promptGuidelines: SYSTEM_OPERATION_GUIDELINES,
		parameters: safeShellSchema,
		execute: async (_toolCallId, params) => {
			// ── 1. Capability check ────────────────────────────────────────────
			if (!options.systemCapability().enabled) {
				const details: DesktopToolResult = {
					stepId: randomUUID(),
					intent: "Run shell command",
					action: "powershell",
					target: params.command,
					status: "blocked",
					riskLevel: "low",
					requiresConfirmation: false,
					stderr: "System operation capability is disabled in desktop assistant settings.",
				};
				return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
			}

			if (isSystemSkillMutationCommand(params.command)) {
				const details: DesktopToolResult = {
					stepId: randomUUID(),
					intent: "Run shell command",
					action: "powershell",
					target: params.command,
					status: "blocked",
					riskLevel: "high",
					requiresConfirmation: false,
					stderr:
						"AI cannot maintain built-in Desktop Assistant system skills. Use personal_skill_* tools for personal custom skills under data/personal-skills.",
				};
				return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
			}

			// ── 2. Sandbox/boundary gate ───────────────────────────────────────
			const requestedLane: SandboxLane = params.target ?? "sandbox";
			const gate = gateAction(sandboxEnvFor(options), {
				toolName: "shell_command_safe",
				kind: "shell",
				lane: requestedLane,
				intent: "Run shell command",
				action: "powershell",
				target: params.command,
				command: params.command,
				riskText: `Run shell command powershell ${params.command}`,
			});
			if (gate.blocked) {
				return { content: [{ type: "text" as const, text: JSON.stringify(gate.blocked) }], details: gate.blocked };
			}
			const riskLevel = gate.ctx.command ? classifyAutomationRisk(gate.ctx.command) : "low";

			// ── 3. Execute with managed timeout (sandbox lane → confined cwd/env) ─
			try {
				const psResult = await options.host.runPowerShellManaged(
					params.command,
					sandboxRunOptions(options, gate.lane),
				);

				if (isTimeout(psResult)) {
					// Process still running — give AI the decision
					const details: DesktopToolResult = {
						stepId: randomUUID(),
						intent: "Run shell command",
						action: "powershell",
						target: params.command,
						status: "timeout",
						riskLevel,
						requiresConfirmation: false,
						stdout: psResult.currentStdout,
						stderr: psResult.message,
						executionId: psResult.executionId,
					};
					return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
				}

				// Normal completion
				const details: DesktopToolResult = {
					stepId: randomUUID(),
					intent: "Run shell command",
					action: "powershell",
					target: params.command,
					status: "succeeded",
					riskLevel,
					requiresConfirmation: false,
					stdout: psResult.stdout,
					stderr: psResult.stderr,
				};
				return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
			} catch (error) {
				const details: DesktopToolResult = {
					stepId: randomUUID(),
					intent: "Run shell command",
					action: "powershell",
					target: params.command,
					status: "failed",
					riskLevel,
					requiresConfirmation: false,
					stderr: error instanceof Error ? error.message : String(error),
				};
				return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
			}
		},
	});
}

function createShellContinueTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "shell_command_continue",
		label: "Continue shell",
		description:
			"Continue waiting for a PowerShell command that previously timed out. " +
			"Use the executionId from the timeout result. " +
			"Returns the final output when the process finishes, or another timeout result if it times out again.",
		promptSnippet: "Resume waiting for a still-running PowerShell command after a timeout.",
		promptGuidelines: SYSTEM_OPERATION_GUIDELINES,
		parameters: shellContinueSchema,
		execute: async (_toolCallId, params) => {
			const psResult = await options.host.continuePowerShell(
				params.executionId,
				Math.max(5, params.newTimeoutSeconds) * 1000,
			);

			let details: DesktopToolResult;
			if (isTimeout(psResult)) {
				details = {
					stepId: randomUUID(),
					intent: "Continue shell command",
					action: "powershell-continue",
					target: params.executionId,
					status: "timeout",
					riskLevel: "low",
					requiresConfirmation: false,
					stdout: psResult.currentStdout,
					stderr: psResult.message,
					executionId: psResult.executionId,
				};
			} else {
				details = {
					stepId: randomUUID(),
					intent: "Continue shell command",
					action: "powershell-continue",
					target: params.executionId,
					status: "succeeded",
					riskLevel: "low",
					requiresConfirmation: false,
					stdout: psResult.stdout,
					stderr: psResult.stderr,
				};
			}
			return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
		},
	});
}

function createShellAbortTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "shell_command_abort",
		label: "Abort shell",
		description:
			"Immediately terminate a running PowerShell command by its executionId. " +
			"Use when a shell_command_safe or shell_command_continue returned status='timeout' " +
			"and you decide the command should be stopped.",
		promptSnippet: "Kill a still-running PowerShell command identified by executionId.",
		promptGuidelines: SYSTEM_OPERATION_GUIDELINES,
		parameters: shellAbortSchema,
		execute: async (_toolCallId, params) => {
			options.host.abortPowerShell(params.executionId);
			const details: DesktopToolResult = {
				stepId: randomUUID(),
				intent: "Abort shell command",
				action: "powershell-abort",
				target: params.executionId,
				status: "succeeded",
				riskLevel: "low",
				requiresConfirmation: false,
				stdout: `进程 ${params.executionId} 已中止。`,
			};
			return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
		},
	});
}

function createWaitTool(_options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "wait",
		label: "Wait",
		description:
			"Pause server-side for a bounded number of seconds before checking a long-running task again. This costs no model turns while waiting and can be cancelled.",
		promptSnippet: "Wait before rechecking long-running tasks when no blocking status tool is available.",
		promptGuidelines: [
			"Use wait before rechecking background jobs, loading apps, browser pages, sandbox initialization, or MCP tools that ask you to retry later.",
			"Prefer a tool's own waitForChange or blocking status parameter when available; use wait as the generic fallback.",
			"Do not send a user-facing progress update for every wait/check cycle; report only meaningful progress, completion, or errors.",
		],
		parameters: waitSchema,
		execute: async (_toolCallId, params, signal) => {
			const seconds = Math.min(120, Math.max(1, Math.ceil(params.seconds)));
			await wait(seconds * 1000, signal);
			const payload = { waited: seconds, reason: params.reason };
			const details: DesktopToolResult = {
				stepId: randomUUID(),
				intent: "Wait",
				action: "wait",
				target: params.reason ?? `${seconds}s`,
				status: "succeeded",
				stdout: JSON.stringify(payload),
				riskLevel: "low",
				requiresConfirmation: false,
			};
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	});
}

function createDesktopObserveTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "desktop_observe",
		label: "Desktop observe",
		description:
			"Observe current desktop state: active window plus visible windows with process names and bounds. Use before and after GUI automation.",
		promptSnippet:
			"Inspect the active window and visible windows. Use this to verify GUI/media actions instead of assuming a key press worked.",
		promptGuidelines: SYSTEM_OPERATION_GUIDELINES,
		parameters: desktopObserveSchema,
		execute: async () => {
			const activeWindow = await options.host.getActiveWindow();
			const windows = await options.host.listWindows();
			const observedState = { activeWindow, windows };
			const details: DesktopToolResult = {
				stepId: randomUUID(),
				intent: "Observe desktop",
				action: "desktop-observe",
				target: "desktop",
				status: "succeeded",
				stdout: JSON.stringify(observedState),
				riskLevel: "low",
				requiresConfirmation: false,
				observedState,
				confidence: "high",
			};
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	});
}

function createScreenContextTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "get_screen_context",
		label: "Screen context",
		description: "Get lightweight desktop context: active window and visible windows.",
		promptSnippet: "Read active and visible desktop windows for planning and verifying system operations.",
		promptGuidelines: SYSTEM_OPERATION_GUIDELINES,
		parameters: screenContextSchema,
		execute: async () => {
			const activeWindow = await options.host.getActiveWindow();
			const windows = await options.host.listWindows();
			const observedState = { activeWindow, windows };
			const details: DesktopToolResult = {
				stepId: randomUUID(),
				intent: "Get screen context",
				action: "list-windows",
				target: "desktop",
				status: "succeeded",
				stdout: JSON.stringify(observedState),
				riskLevel: "low",
				requiresConfirmation: false,
				observedState,
				confidence: "high",
			};
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	});
}

async function runAppInteraction(
	host: DesktopAutomationHost,
	params: { app: "netease_cloud_music"; action: "play_song" | "focus" | "verify_playback"; query?: string },
): Promise<{
	stdout: string;
	stderr: string;
	observedState?: unknown;
	confidence?: DesktopToolResult["confidence"];
	nextActions?: string[];
}> {
	if (params.app !== "netease_cloud_music") {
		throw new Error(`Unsupported app interaction target: ${params.app}`);
	}
	if (params.action === "focus") return focusNetEaseCloudMusic(host);
	if (params.action === "verify_playback") return verifyNetEaseCloudMusic(host, params.query);

	const query = params.query?.trim();
	if (!query) throw new Error("app_interaction play_song requires query.");
	const focusResult = await focusNetEaseCloudMusic(host);
	if (focusResult.confidence === "low") return focusResult;

	await host.sendKeyChord("f", ["LeftControl"]);
	await wait(200);
	await host.typeText(query);
	await wait(200);
	await host.sendKeyChord("Enter");
	await wait(1200);
	await host.sendKeyChord("Enter");
	await wait(500);
	await host.sendMediaCommand("play");
	await wait(600);
	return verifyNetEaseCloudMusic(host, query);
}

async function focusNetEaseCloudMusic(host: DesktopAutomationHost): Promise<{
	stdout: string;
	stderr: string;
	observedState?: unknown;
	confidence?: DesktopToolResult["confidence"];
	nextActions?: string[];
}> {
	let windows = await host.listWindows();
	let existingWindow = windows.find(isNetEaseCloudMusicWindow);
	if (!existingWindow) {
		const launchResult = await host.startProcess("cloudmusic");
		await wait(1500);
		windows = await host.listWindows();
		existingWindow = windows.find(isNetEaseCloudMusicWindow);
		if (!existingWindow) {
			return {
				stdout: JSON.stringify({
					result: launchResult.stdout,
					verification: "NetEase Cloud Music was launched but no matching window was detected.",
				}),
				stderr: launchResult.stderr,
				observedState: { windows },
				confidence: "low",
				nextActions: [
					"Call find_app with 网易云音乐 or cloudmusic and open_app with the returned launch value.",
					"Call desktop_observe to inspect the visible player window title.",
				],
			};
		}
	}

	const focusResult = await host.focusWindow(existingWindow.title || existingWindow.processName || "cloudmusic");
	await wait(300);
	const activeWindow = await host.getActiveWindow();
	const confidence = isNetEaseCloudMusicWindow(activeWindow) ? "high" : "low";
	return {
		stdout: JSON.stringify({
			result: focusResult.stdout,
			verification:
				confidence === "high" ? "NetEase Cloud Music is active." : "Focus attempt did not make NetEase active.",
		}),
		stderr: focusResult.stderr,
		observedState: { activeWindow },
		confidence,
		nextActions:
			confidence === "high" ? undefined : ["Call window_control list and retry focus with the exact title."],
	};
}

async function verifyNetEaseCloudMusic(
	host: DesktopAutomationHost,
	query?: string,
): Promise<{
	stdout: string;
	stderr: string;
	observedState?: unknown;
	confidence?: DesktopToolResult["confidence"];
	nextActions?: string[];
}> {
	const activeWindow = await host.getActiveWindow();
	const windows = await host.listWindows();
	const mediaWindows = windows.filter(isNetEaseCloudMusicWindow);
	const queryMatched =
		!query ||
		mediaWindows.some((window) => containsLoose(window.title, query)) ||
		(activeWindow ? containsLoose(activeWindow.title, query) : false);
	const focusedPlayer = isNetEaseCloudMusicWindow(activeWindow);
	const confidence = focusedPlayer && queryMatched ? "medium" : "low";
	const observedState = { activeWindow, mediaWindows, expectedQuery: query };
	return {
		stdout: JSON.stringify({
			verification:
				confidence === "medium"
					? "NetEase Cloud Music is focused and the requested query appears in window state."
					: "Playback could not be strongly verified from available window state.",
			expectedQuery: query,
		}),
		stderr: "",
		observedState,
		confidence,
		nextActions:
			confidence === "medium"
				? ["If exact playback confirmation is required, inspect the player UI visually."]
				: [
						"Call desktop_observe to inspect the active window.",
						"Use media_control play after focusing the player.",
						"Retry app_interaction play_song with the exact song and artist.",
					],
	};
}

function activeWindowMatches(window: WindowInfo | undefined, target: string): boolean {
	if (!window) return false;
	return containsLoose(window.title, target) || containsLoose(window.processName ?? "", target);
}

function isLikelyMediaWindow(window: WindowInfo | undefined): window is WindowInfo {
	if (!window) return false;
	const text = `${window.title} ${window.processName ?? ""}`.toLowerCase();
	return /cloudmusic|netease|网易|music|spotify|vlc|qqmusic|foobar|player/.test(text);
}

function isNetEaseCloudMusicWindow(window: WindowInfo | undefined): window is WindowInfo {
	if (!window) return false;
	const text = `${window.title} ${window.processName ?? ""}`.toLowerCase();
	return /cloudmusic|netease|网易云|网易|cloud music/.test(text);
}

function containsLoose(haystack: string, needle: string): boolean {
	const compactHaystack = haystack.toLowerCase().replace(/\s+/g, "");
	const compactNeedle = needle.toLowerCase().replace(/\s+/g, "");
	return !!compactNeedle && compactHaystack.includes(compactNeedle);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new Error("Aborted"));
	return new Promise((resolve, reject) => {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => {
			finish();
			reject(new Error("Aborted"));
		};
		const finish = () => {
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		};
		timeout = setTimeout(() => {
			finish();
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Office tool schemas
// ─────────────────────────────────────────────────────────────────────────────

const docCreateFromHtmlSchema = Type.Object({
	path: Type.String({
		description: "Output .docx file path, e.g. C:\\Users\\user\\Documents\\report.docx. The directory must exist.",
	}),
	html: Type.String({
		description:
			"A COMPLETE document-style HTML page (include <meta charset='utf-8'>). Word imports it into an editable .docx, so: use <h1>-<h4> for real headings (never a font-sized <p>), <table>/<thead>/<tbody>/<th>/<td> for tabular data, <ul>/<ol> for lists, <strong>/<em> for emphasis, <img> with explicit width (data: base64 or file:/// absolute). Single column only — do NOT use flexbox, grid, absolute/fixed positioning, float layouts, CSS columns, transforms, or vw/vh; for side-by-side use a borderless <table>. Inline CSS that survives: color, background-color, font-family, font-size (pt/px), font-weight, font-style, text-align, line-height, margin, padding, table border/width. Dropped on import: box-shadow, border-radius, ::before/::after, background images, @font-face/web fonts, animation. Page breaks via <div style='page-break-before:always'></div>. Use installed fonts (中文: 微软雅黑/宋体/黑体). Design the visual style (colors, type scale, spacing, table shading) yourself to suit the document type.",
	}),
	pageSetup: Type.Optional(
		Type.Object({
			orientation: Type.Optional(
				Type.Union([Type.Literal("portrait"), Type.Literal("landscape")], {
					description: "Page orientation. Default portrait.",
				}),
			),
			margin: Type.Optional(
				Type.Union([Type.Literal("normal"), Type.Literal("narrow"), Type.Literal("wide")], {
					description: "Page margins preset. Default normal.",
				}),
			),
			pageSize: Type.Optional(
				Type.Union([Type.Literal("A4"), Type.Literal("Letter")], {
					description: "Paper size. Default A4.",
				}),
			),
		}),
	),
});

const docReadSchema = Type.Object({
	path: Type.String({ description: "Full path to the .docx file to read." }),
});

const documentSelectorSchema = Type.Object({
	blockId: Type.Optional(Type.String({ description: "Stable block id from doc_inspect. Preferred selector." })),
	kind: Type.Optional(
		Type.Union([
			Type.Literal("paragraph"),
			Type.Literal("heading"),
			Type.Literal("table"),
			Type.Literal("list"),
			Type.Literal("cell"),
			Type.Literal("header"),
			Type.Literal("footer"),
		]),
	),
	textIncludes: Type.Optional(Type.String({ description: "Substring match against block text." })),
	textEquals: Type.Optional(Type.String({ description: "Exact match against block text." })),
	occurrence: Type.Optional(
		Type.Number({ description: "1-based occurrence when a text selector matches multiple blocks." }),
	),
	tableId: Type.Optional(Type.String({ description: "Table id from doc_inspect." })),
	row: Type.Optional(Type.Number({ description: "1-based row for table cell selectors." })),
	col: Type.Optional(Type.Number({ description: "1-based column for table cell selectors." })),
});

const documentOperationSchema = Type.Union([
	Type.Object({
		type: Type.Literal("replace_text"),
		selector: documentSelectorSchema,
		findText: Type.String(),
		replaceText: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("insert_after_block"),
		selector: documentSelectorSchema,
		text: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("insert_before_block"),
		selector: documentSelectorSchema,
		text: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("set_block_text"),
		selector: documentSelectorSchema,
		text: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("append_to_block"),
		selector: documentSelectorSchema,
		text: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("update_table_cell"),
		selector: documentSelectorSchema,
		text: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("delete_block"),
		selector: documentSelectorSchema,
	}),
]);

const documentVerifyCheckSchema = Type.Union([
	Type.Object({
		type: Type.Literal("text_exists"),
		text: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("text_not_exists"),
		text: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("block_text_equals"),
		selector: documentSelectorSchema,
		expectedText: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("table_cell_equals"),
		selector: documentSelectorSchema,
		expectedText: Type.String(),
	}),
]);

const docInspectSchema = Type.Object({
	path: Type.String({ description: "Full path to the existing .docx file to inspect structurally." }),
	formatForBlockIds: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Optional: blockIds (e.g. 'block-3', 'table-0-cell-1-2') for which to also return FULL formatting (font name/size/color/bold/italic/underline, paragraph alignment/indent/spacing, cell shading) under `formats`. Leave empty for a fast structural pass; pass only the few blocks you actually need detailed formatting for — it reads per requested block, so it stays fast.",
		}),
	),
});

const docPlanEditsSchema = Type.Object({
	path: Type.String({ description: "Full path to the existing .docx file to inspect and plan edits for." }),
	intent: Type.String({ description: "Natural language edit intent." }),
	constraints: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional constraints such as preserve formatting or keep tables unchanged.",
		}),
	),
});

const docApplyEditsSchema = Type.Object({
	path: Type.String({ description: "Full path to the existing .docx file to edit." }),
	operations: Type.Array(documentOperationSchema, {
		description: "Structured document edit operations built from doc_inspect/doc_plan_edits output.",
	}),
});

const docVerifySchema = Type.Object({
	path: Type.String({ description: "Full path to the .docx file to verify." }),
	checks: Type.Array(documentVerifyCheckSchema, {
		description: "Structured verification checks for the final document state.",
	}),
});

const officeWordRunSchema = Type.Object({
	script: Type.String({
		description:
			"PowerShell script body. $Word (Word.Application, Visible=false) is already created. Do NOT call $Word.Quit() — the tool handles cleanup. Access $Word.Selection or open documents with $Word.Documents.Open(). For paragraph styles use built-in WdBuiltinStyle ids ($doc.Styles.Item(-2)=Heading 1, -1=Normal), not English names like 'Heading 1' — those fail on non-English Word installs.",
	}),
});

const excelReadSchema = Type.Object({
	path: Type.String({ description: "Full path to the .xlsx / .xls file to read." }),
	sheet: Type.Optional(
		Type.Union([Type.String(), Type.Number()], {
			description: "Sheet name or 1-based index. Defaults to 1.",
		}),
	),
	maxRows: Type.Optional(Type.Number({ description: "Maximum rows to return. Defaults to 500." })),
});

const excelWriteSchema = Type.Object({
	path: Type.String({
		description: "Full path to the .xlsx file. Created if it does not exist.",
	}),
	data: Type.Array(Type.Array(Type.Any()), {
		description: "Rows of data: [[row1col1, row1col2, ...], [row2col1, ...]]. Use null for empty cells.",
	}),
	sheet: Type.Optional(
		Type.Union([Type.String(), Type.Number()], {
			description: "Sheet name or 1-based index. Defaults to 1.",
		}),
	),
	startRow: Type.Optional(Type.Number({ description: "1-based starting row. Defaults to 1." })),
	startCol: Type.Optional(Type.Number({ description: "1-based starting column. Defaults to 1." })),
	clearSheet: Type.Optional(
		Type.Boolean({ description: "Clear the target sheet before writing. Defaults to false." }),
	),
});

const officeExcelRunSchema = Type.Object({
	script: Type.String({
		description:
			"PowerShell script body. $Excel (Excel.Application, Visible=false) is already created. Do NOT call $Excel.Quit(). When writing numbers, prefer $ws.Cells.Item(row,col) = 123 or explicit casts such as $cell.Value = [double]$n; avoid raw .Value2 = [int].",
	}),
});

const pptCreateSchema = Type.Object({
	path: Type.String({ description: "Output .pptx file path." }),
	slides: Type.Array(
		Type.Object({
			title: Type.Optional(Type.String({ description: "Slide title text." })),
			content: Type.Optional(
				Type.String({ description: "Slide body text. Use \\n for line breaks between bullets." }),
			),
			layout: Type.Optional(
				Type.Number({
					description:
						"PowerPoint layout enum 1-24. 1=Title+Content (default), 2=Title+Body, 7=TitleOnly, 12=Blank.",
				}),
			),
		}),
		{ description: "Ordered array of slide definitions." },
	),
});

const pptReadSchema = Type.Object({
	path: Type.String({ description: "Full path to the .pptx file to read." }),
});

const officePptRunSchema = Type.Object({
	script: Type.String({
		description: "PowerShell script body. $Ppt (PowerPoint.Application) is already created. Do NOT call $Ppt.Quit().",
	}),
});

// ─────────────────────────────────────────────────────────────────────────────
// Office helper — run a script inside a COM application wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gate an Office COM script through the sandbox policy, then run it. The wrapped
 * PowerShell script is used as the action target so an approved confirmation
 * re-runs it via the existing `runDesktopAction("powershell", …)` path. Write
 * tools pass `writePathsRaw` so the lane is auto-classified from the save path.
 */
async function gateAndRunOffice(
	options: DesktopToolOptions,
	gateReq: {
		toolName: string;
		kind: GateRequest["kind"];
		lane?: SandboxLane;
		intent: string;
		writePathsRaw?: string[];
		riskText?: string;
	},
	meta: { intent: string; target: string; riskLevel: DesktopToolResult["riskLevel"]; action?: string },
	wrappedScript: string,
): Promise<{ content: [{ type: "text"; text: string }]; details: DesktopToolResult }> {
	const gate = gateAction(sandboxEnvFor(options), {
		toolName: gateReq.toolName,
		kind: gateReq.kind,
		lane: gateReq.lane,
		intent: gateReq.intent,
		action: "powershell",
		target: wrappedScript,
		command: wrappedScript,
		writePathsRaw: gateReq.writePathsRaw,
		riskText: gateReq.riskText,
	});
	if (gate.blocked) {
		return { content: [{ type: "text", text: JSON.stringify(gate.blocked) }], details: gate.blocked };
	}
	return runOfficeScript(options.host, meta, wrappedScript, sandboxRunOptions(options, gate.lane));
}

function mergeNextActions(...groups: Array<string[] | undefined>): string[] | undefined {
	const merged: string[] = [];
	for (const group of groups) {
		for (const action of group ?? []) {
			if (!merged.includes(action)) {
				merged.push(action);
			}
		}
	}
	return merged.length > 0 ? merged : undefined;
}

function wordTimeoutRecoveryActions(executionId: string | undefined): string[] {
	const continueAction = executionId
		? `Continue waiting with shell_command_continue using executionId ${executionId}.`
		: "Continue waiting with shell_command_continue if an executionId is available.";
	return [
		continueAction,
		"Abort with shell_command_abort if stdout/stderr is not progressing.",
		"After abort, clear Word COM state before retrying: close only the assistant-created or hidden automation instance, and do not kill user-open Word windows unless ownership is confirmed.",
	];
}

function withWordTimeoutRecovery(details: DesktopToolResult, script: string): DesktopToolResult {
	if (details.status !== "timeout" || !/(Word\.Application|\$Word\b)/i.test(script)) {
		return details;
	}
	return {
		...details,
		stderr: [
			details.stderr,
			"Word COM automation timed out and may still be busy. Continue, abort, or clean up only the automation-owned Word instance before retrying.",
		]
			.filter(Boolean)
			.join("\n"),
		nextActions: mergeNextActions(details.nextActions, wordTimeoutRecoveryActions(details.executionId)),
	};
}

async function runOfficeScript(
	host: DesktopAutomationHost,
	meta: {
		intent: string;
		target: string;
		riskLevel: DesktopToolResult["riskLevel"];
		action?: string;
	},
	script: string,
	runOptions?: PowerShellRunOptions,
): Promise<{ content: [{ type: "text"; text: string }]; details: DesktopToolResult }> {
	const stepId = randomUUID();
	try {
		const result = await host.runPowerShellManaged(script, runOptions);
		if (isTimeout(result)) {
			const details: DesktopToolResult = {
				stepId,
				intent: meta.intent,
				action: meta.action ?? "powershell",
				target: meta.target,
				status: "timeout",
				stdout: result.currentStdout,
				stderr: [result.message, result.currentStderr].filter(Boolean).join("\n"),
				riskLevel: meta.riskLevel,
				requiresConfirmation: false,
				executionId: result.executionId,
			};
			const guidedDetails = withWordTimeoutRecovery(details, script);
			return { content: [{ type: "text", text: JSON.stringify(guidedDetails) }], details: guidedDetails };
		}
		const details: DesktopToolResult = {
			stepId,
			intent: meta.intent,
			action: meta.action ?? "powershell",
			target: meta.target,
			status: result.stderr ? "failed" : "succeeded",
			stdout: result.stdout,
			stderr: result.stderr,
			riskLevel: meta.riskLevel,
			requiresConfirmation: false,
		};
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	} catch (error) {
		const details: DesktopToolResult = {
			stepId,
			intent: meta.intent,
			action: meta.action ?? "powershell",
			target: meta.target,
			status: "failed",
			stderr: error instanceof Error ? error.message : String(error),
			riskLevel: meta.riskLevel,
			requiresConfirmation: false,
		};
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	}
}

function toStructuredToolResponse(details: DesktopToolResult) {
	return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

function encodeToolPayload(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf-8").toString("base64");
}

function escapePsString(value: string): string {
	return value.replace(/'/g, "''");
}

function classifyDocumentError(text: string | undefined): DocumentRiskFlag | undefined {
	if (!text) return undefined;
	const normalized = text.toLowerCase();
	if (normalized.includes("readonly") || normalized.includes("read-only")) return "readonly";
	if (normalized.includes("being used by another process") || normalized.includes("cannot access the file"))
		return "file_locked";
	if (normalized.includes("save") && normalized.includes("conflict")) return "save_conflict";
	if (
		normalized.includes("rpc_e_call_rejected") ||
		normalized.includes("0x80010001") ||
		normalized.includes("call was rejected by callee") ||
		(normalized.includes("callee") && normalized.includes("rejected")) ||
		(text.includes("拒绝") && (text.includes("调用") || text.includes("呼叫")))
	) {
		return "word_busy";
	}
	if (
		normalized.includes("word is not installed") ||
		normalized.includes("word is not available") ||
		normalized.includes("word.application")
	) {
		return "word_unavailable";
	}
	if (normalized.includes("selector") && normalized.includes("not found")) return "selector_not_found";
	return undefined;
}

function documentRiskNextActions(flag: DocumentRiskFlag | undefined): string[] | undefined {
	if (flag === "readonly") {
		return [
			"Open the Word document editable with Documents.Open(..., $false, $false), or use doc_apply_edits on a sandbox copy.",
			"Do not save a document that was opened read-only.",
		];
	}
	if (flag === "selector_not_found") {
		return [
			"Run doc_inspect again and prefer the returned blockId selector.",
			"For table forms, use update_table_cell with blockId first, then tableId + row + col if blockId is unavailable.",
		];
	}
	if (flag === "word_busy") {
		return [
			"Wait briefly and retry after Word finishes its current COM operation.",
			"Check for a modal Word dialog or abort the stuck command, then clean up only the assistant-created Word instance before retrying.",
		];
	}
	return undefined;
}

function normalizePowerShellForStaticCheck(script: string): string {
	return script.replace(/`[\r\n]+/g, " ").replace(/\s+/g, " ");
}

function detectUnsafeReadonlyWordWrite(script: string): string | undefined {
	const normalized = normalizePowerShellForStaticCheck(script);
	const opensReadonly =
		/\bDocuments\.Open\s*\([^)]*,\s*\$false\s*,\s*\$true\b/i.test(normalized) ||
		/\bDocuments\.Open\s*\([^)]*\bReadOnly\s*:=\s*\$true\b/i.test(normalized) ||
		/\bDocuments\.Open\s*\([^)]*\bReadOnly\s*=\s*\$true\b/i.test(normalized);
	const writesDocument =
		/(?:\.Range\.Text\s*=|\.Text\s*=|\.Save(?:As2?|CopyAs)?\s*\(|\.Save\s*\(|\.FormattedText\s*=|\.InsertAfter\s*\(|\.InsertBefore\s*\(|\.Delete\s*\()/i.test(
			normalized,
		);
	if (!opensReadonly || !writesDocument) {
		return undefined;
	}
	return [
		"office_word_run blocked: script opens a Word document as read-only and then writes or saves.",
		"Open editable with Documents.Open(..., $false, $false), or use doc_inspect -> doc_apply_edits -> doc_verify for form/table fills.",
	].join(" ");
}

function blockedOfficeWordRunResult(script: string, message: string) {
	const details: DesktopToolResult = {
		stepId: randomUUID(),
		intent: "Word automation script",
		action: "office_word_run",
		target: script,
		status: "blocked",
		riskLevel: "medium",
		requiresConfirmation: false,
		stderr: message,
		nextActions: [
			"Use doc_inspect, doc_apply_edits, and doc_verify for existing .docx form/table edits.",
			"If custom COM is required, reopen the document with ReadOnly=$false before writing or saving.",
		],
	};
	return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

function parseStructuredStdout<T>(stdout: string | undefined): T | undefined {
	if (!stdout) return undefined;
	try {
		return JSON.parse(stdout) as T;
	} catch {
		return undefined;
	}
}

function buildDocumentToolDetails(params: {
	intent: string;
	action: string;
	target: string;
	status: DesktopToolResult["status"];
	stdout?: string;
	stderr?: string;
	executionId?: string;
}): DesktopToolResult {
	return {
		stepId: randomUUID(),
		intent: params.intent,
		action: params.action,
		target: params.target,
		status: params.status,
		stdout: params.stdout,
		stderr: params.stderr,
		riskLevel: "low",
		requiresConfirmation: false,
		executionId: params.executionId,
	};
}

async function runStructuredWordTool<T>(
	host: DesktopAutomationHost,
	meta: { intent: string; action: string; target: string },
	script: string,
): Promise<{ content: [{ type: "text"; text: string }]; details: DesktopToolResult; payload?: T }> {
	const execution = await runOfficeScript(
		host,
		{ intent: meta.intent, action: meta.action, target: meta.target, riskLevel: "low" },
		script,
	);
	const executionDetails = execution.details;
	if (executionDetails.status !== "succeeded") {
		const classified = classifyDocumentError(executionDetails.stderr);
		const details: DesktopToolResult = {
			...execution.details,
			stderr: classified
				? `${execution.details.stderr ?? ""}\nerrorCategory=${classified}`.trim()
				: execution.details.stderr,
			nextActions: mergeNextActions(execution.details.nextActions, documentRiskNextActions(classified)),
		};
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	}
	const payload = parseStructuredStdout<T>(executionDetails.stdout);
	return { ...execution, payload };
}

function inferDocumentWarnings(path: string): DocumentRiskFlag[] {
	const normalized = path.replace(/\//g, "\\");
	const warnings = new Set<DocumentRiskFlag>();
	if (!/\.docx$/i.test(normalized)) {
		warnings.add("unsupported_extension");
	}
	if (/^(\\\\|[a-z]:\\(?:users\\[^\\]+\\onedrive|mnt|net use))/i.test(normalized) || normalized.includes("onedrive")) {
		warnings.add("path_slow_or_remote");
	}
	return [...warnings];
}

function buildSafeWordTableInspectionScript(): string[] {
	return [
		`  $tableIndex = 0`,
		`  foreach ($table in $doc.Tables) {`,
		`    $tableId = 'table-' + $tableIndex`,
		`    $cells = New-Object System.Collections.ArrayList`,
		`    $rowCount = 0`,
		`    $colCount = 0`,
		`    try { $rowCount = [int]$table.Rows.Count } catch { if (-not ($warnings -contains 'selector_not_found')) { [void]$warnings.Add('selector_not_found') } }`,
		`    try { $colCount = [int]$table.Columns.Count } catch { if (-not ($warnings -contains 'selector_not_found')) { [void]$warnings.Add('selector_not_found') } }`,
		// One COM call reads all cell text (BEL-separated, row-major, merged cells once).
		`    $cellTexts = @(); try { $cellTexts = @($table.Range.Text -split ([char]7)) } catch {}`,
		`    if ($cellTexts.Count -gt 0 -and $cellTexts[$cellTexts.Count-1] -eq '') { $cellTexts = @($cellTexts[0..($cellTexts.Count-2)]) }`,
		`    $uniform = ($rowCount -gt 0 -and $colCount -gt 0 -and $cellTexts.Count -eq ($rowCount * $colCount))`,
		`    if ($uniform) {`,
		// Fast path for non-merged tables: derive row/col from index — zero per-cell COM calls.
		`      for ($r = 1; $r -le $rowCount; $r++) {`,
		`        for ($c = 1; $c -le $colCount; $c++) {`,
		`          $cellText = ($cellTexts[(($r-1)*$colCount)+($c-1)] -replace '[\\r\\a]+$', '').TrimEnd()`,
		`          $blockId = "$tableId-cell-$r-$c"`,
		`          [void]$cells.Add([pscustomobject]@{ blockId=$blockId; tableId=$tableId; row=$r; col=$c; text=$cellText; address=('R'+$r+'C'+$c); rowSpan=1; colSpan=1; merged=$false })`,
		`          [void]$blocks.Add([pscustomobject]@{ blockId=$blockId; kind='cell'; text=$cellText; styleName='TableCell'; index=$index; tableId=$tableId; row=$r; col=$c })`,
		`          [void]$textSpans.Add([pscustomobject]@{ blockId=$blockId; start=0; end=$cellText.Length; text=$cellText })`,
		`          $index++`,
		`        }`,
		`      }`,
		`    } else {`,
		// Merged / irregular: per-cell fallback (correct, slower), reusing the pre-split text by index.
		`      $ci = 0`,
		`      foreach ($cell in $table.Range.Cells) {`,
		`        $row = 0`,
		`        $col = 0`,
		`        $rowLocated = $true`,
		`        $colLocated = $true`,
		`        try { $row = [int]$cell.RowIndex } catch { $rowLocated = $false }`,
		`        try { $col = [int]$cell.ColumnIndex } catch { $colLocated = $false }`,
		`        $rowSpan = 1`,
		`        $colSpan = 1`,
		`        try { $rowSpan = [int]$cell.RowSpan } catch {}`,
		`        try { $colSpan = [int]$cell.ColumnSpan } catch {}`,
		`        $merged = (-not $rowLocated) -or (-not $colLocated) -or ($rowSpan -gt 1) -or ($colSpan -gt 1)`,
		`        if ($merged -and -not ($warnings -contains 'selector_not_found')) { [void]$warnings.Add('selector_not_found') }`,
		`        $cellText = if ($ci -lt $cellTexts.Count) { ($cellTexts[$ci] -replace '[\\r\\a]+$', '').TrimEnd() } else { ($cell.Range.Text -replace '[\\r\\a]+$', '').TrimEnd() }`,
		`        $blockId = if ($row -gt 0 -and $col -gt 0) { "$tableId-cell-$row-$col" } else { "$tableId-cell-unknown-$index" }`,
		`        $address = if ($row -gt 0 -and $col -gt 0) { 'R' + $row + 'C' + $col } else { '' }`,
		`        [void]$cells.Add([pscustomobject]@{ blockId=$blockId; tableId=$tableId; row=$row; col=$col; text=$cellText; address=$address; rowSpan=$rowSpan; colSpan=$colSpan; merged=$merged })`,
		`        [void]$blocks.Add([pscustomobject]@{ blockId=$blockId; kind='cell'; text=$cellText; styleName='TableCell'; index=$index; tableId=$tableId; row=$row; col=$col })`,
		`        [void]$textSpans.Add([pscustomobject]@{ blockId=$blockId; start=0; end=$cellText.Length; text=$cellText })`,
		`        $index++`,
		`        $ci++`,
		`      }`,
		`    }`,
		`    [void]$tables.Add([pscustomobject]@{ tableId=$tableId; index=$tableIndex; rows=$rowCount; cols=$colCount; cells=$cells })`,
		`    $tableIndex++`,
		`  }`,
	];
}

function buildWordResolveCellScript(indent: string): string[] {
	return [
		`${indent}function Add-SelectorWarning {`,
		`${indent}  if (-not ($warnings -contains 'selector_not_found')) { [void]$warnings.Add('selector_not_found') }`,
		`${indent}}`,
		`${indent}function Try-Resolve-TableCell([int]$tableIndex, [int]$row, [int]$col) {`,
		`${indent}  if ($tableIndex -lt 1 -or $row -lt 1 -or $col -lt 1) { Add-SelectorWarning; return $null }`,
		`${indent}  if ($tableIndex -gt $doc.Tables.Count) { Add-SelectorWarning; return $null }`,
		`${indent}  try {`,
		`${indent}    return $doc.Tables.Item($tableIndex).Cell($row, $col)`,
		`${indent}  } catch {`,
		`${indent}    Add-SelectorWarning`,
		`${indent}    return $null`,
		`${indent}  }`,
		`${indent}}`,
		`${indent}function Resolve-Cell([object]$selector) {`,
		`${indent}  if ($null -eq $selector) { return $null }`,
		`${indent}  if ($selector.blockId -match '^table-(\\d+)-cell-(\\d+)-(\\d+)$') {`,
		`${indent}    return Try-Resolve-TableCell ([int]$Matches[1] + 1) ([int]$Matches[2]) ([int]$Matches[3])`,
		`${indent}  }`,
		`${indent}  if ($selector.tableId -match '^table-(\\d+)$' -and $selector.row -and $selector.col) {`,
		`${indent}    return Try-Resolve-TableCell ([int]$Matches[1] + 1) ([int]$selector.row) ([int]$selector.col)`,
		`${indent}  }`,
		`${indent}  Add-SelectorWarning`,
		`${indent}  return $null`,
		`${indent}}`,
	];
}

function buildWordInspectScript(path: string, formatForBlockIds: string[] = []): string {
	const pathEsc = escapePsString(path);
	const formatIdsLiteral =
		formatForBlockIds.length > 0 ? `@(${formatForBlockIds.map((id) => `'${escapePsString(id)}'`).join(",")})` : "@()";
	return wrapWordCom(
		[
			`$path = '${pathEsc}'`,
			`if (-not (Test-Path -LiteralPath $path)) { throw "Document path not found: $path" }`,
			`$warnings = New-Object System.Collections.ArrayList`,
			`if ($path -match '^(\\\\\\\\|[A-Za-z]:\\\\Users\\\\[^\\\\]+\\\\OneDrive\\\\)') { [void]$warnings.Add('path_slow_or_remote') }`,
			`$doc = $Word.Documents.Open($path, $false, $true)`,
			`try {`,
			`  $blocks = New-Object System.Collections.ArrayList`,
			`  $tables = New-Object System.Collections.ArrayList`,
			`  $headersFooters = New-Object System.Collections.ArrayList`,
			`  $textSpans = New-Object System.Collections.ArrayList`,
			`  $index = 0`,
			`  foreach ($para in $doc.Paragraphs) {`,
			`    $text = ($para.Range.Text -replace '[\\r\\a]+$', '').TrimEnd()`,
			`    if (-not $text) { continue }`,
			`    $styleName = ''`,
			`    try { $styleName = [string]$para.Range.Style.NameLocal } catch { try { $styleName = [string]$para.Range.Style } catch {} }`,
			`    $outline = 10`,
			`    try { $outline = [int]$para.OutlineLevel } catch {}`,
			`    # OutlineLevel 1-9 marks headings regardless of UI language; NameLocal is localized (e.g. '标题 1').`,
			`    $kind = if ($outline -ge 1 -and $outline -le 9) { 'heading' } elseif ($styleName -match 'List|列表') { 'list' } else { 'paragraph' }`,
			`    $blockId = 'block-' + $index`,
			`    [void]$blocks.Add([pscustomobject]@{ blockId=$blockId; kind=$kind; text=$text; styleName=$styleName; index=$index })`,
			`    [void]$textSpans.Add([pscustomobject]@{ blockId=$blockId; start=0; end=$text.Length; text=$text })`,
			`    $index++`,
			`  }`,
			...buildSafeWordTableInspectionScript(),
			`  for ($sectionIndex = 1; $sectionIndex -le $doc.Sections.Count; $sectionIndex++) {`,
			`    $section = $doc.Sections.Item($sectionIndex)`,
			`    foreach ($pair in @(@{key='header'; collection=$section.Headers}, @{key='footer'; collection=$section.Footers})) {`,
			`      foreach ($variant in @(1,2,3)) {`,
			`        try {`,
			`          $item = $pair.collection.Item($variant)`,
			`          $text = ($item.Range.Text -replace '[\\r\\a]+$', '').TrimEnd()`,
			`          if ($text) {`,
			`            [void]$headersFooters.Add([pscustomobject]@{ blockId=($pair.key + '-' + $sectionIndex + '-' + $variant); kind=$pair.key; sectionIndex=$sectionIndex; variant="$variant"; text=$text })`,
			`          }`,
			`        } catch {}`,
			`      }`,
			`    }`,
			`  }`,
			// On-demand detailed formatting: read full font/paragraph/shading only for the
			// specifically requested blockIds (kept fast — per requested block, not the whole doc).
			`  $formats = New-Object System.Collections.ArrayList`,
			`  $requestedFormatIds = ${formatIdsLiteral}`,
			`  foreach ($bid in $requestedFormatIds) {`,
			`    $rng = $null`,
			`    $shading = $null`,
			`    if ($bid -match '^block-(\\d+)$') { $pi = [int]$Matches[1] + 1; if ($pi -ge 1 -and $pi -le $doc.Paragraphs.Count) { try { $rng = $doc.Paragraphs.Item($pi).Range } catch {} } }`,
			`    elseif ($bid -match '^table-(\\d+)-cell-(\\d+)-(\\d+)$') { try { $cellObj = $doc.Tables.Item([int]$Matches[1] + 1).Cell([int]$Matches[2], [int]$Matches[3]); $rng = $cellObj.Range; try { $shading = [string]$cellObj.Shading.BackgroundPatternColor } catch {} } catch {} }`,
			`    if ($null -eq $rng) { if (-not ($warnings -contains 'selector_not_found')) { [void]$warnings.Add('selector_not_found') }; continue }`,
			`    $fn=''; $fs=0; $fb=$false; $fi=$false; $fu=$false; $fc=''`,
			`    try { $fn=[string]$rng.Font.Name } catch {}; try { $fs=[double]$rng.Font.Size } catch {}`,
			`    try { $fb=([int]$rng.Font.Bold) -ne 0 } catch {}; try { $fi=([int]$rng.Font.Italic) -ne 0 } catch {}`,
			`    try { $fu=([int]$rng.Font.Underline) -ne 0 } catch {}; try { $fc=[string]$rng.Font.Color } catch {}`,
			`    $pa=''; $pli=0; $pfli=0; $psb=0; $psa=0; $pls=0`,
			`    try { $pa=[string]$rng.ParagraphFormat.Alignment } catch {}; try { $pli=[double]$rng.ParagraphFormat.LeftIndent } catch {}`,
			`    try { $pfli=[double]$rng.ParagraphFormat.FirstLineIndent } catch {}; try { $psb=[double]$rng.ParagraphFormat.SpaceBefore } catch {}`,
			`    try { $psa=[double]$rng.ParagraphFormat.SpaceAfter } catch {}; try { $pls=[double]$rng.ParagraphFormat.LineSpacing } catch {}`,
			`    [void]$formats.Add([pscustomobject]@{ blockId=$bid; font=[pscustomobject]@{ name=$fn; size=$fs; bold=$fb; italic=$fi; underline=$fu; color=$fc }; paragraph=[pscustomobject]@{ alignment=$pa; leftIndent=$pli; firstLineIndent=$pfli; spaceBefore=$psb; spaceAfter=$psa; lineSpacing=$pls }; shading=$shading })`,
			`  }`,
			`  $result = [pscustomobject]@{`,
			`    backend='word';`,
			`    documentKind='word_document';`,
			`    blocks=$blocks;`,
			`    tables=$tables;`,
			`    headersFooters=$headersFooters;`,
			`    textSpans=$textSpans;`,
			`    formats=$formats;`,
			`    warnings=$warnings`,
			`  }`,
			`  $result | ConvertTo-Json -Compress -Depth 8`,
			`} finally {`,
			`  $doc.Close($false)`,
			`}`,
		].join("\n"),
	);
}

function buildWordApplyScript(path: string, operations: DocumentEditOperation[]): string {
	const pathEsc = escapePsString(path);
	const operationsB64 = encodeToolPayload(operations);
	return wrapWordCom(
		[
			`$path = '${pathEsc}'`,
			`if (-not (Test-Path -LiteralPath $path)) { throw "Document path not found: $path" }`,
			`$ops = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${operationsB64}')) | ConvertFrom-Json`,
			`$tempRoot = Join-Path $env:TEMP ('desktop-assistant-doc-' + [Guid]::NewGuid().ToString())`,
			`New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null`,
			`$workingPath = Join-Path $tempRoot ([System.IO.Path]::GetFileName($path))`,
			`Copy-Item -LiteralPath $path -Destination $workingPath -Force`,
			`$warnings = New-Object System.Collections.ArrayList`,
			`if ($path -match '^(\\\\\\\\|[A-Za-z]:\\\\Users\\\\[^\\\\]+\\\\OneDrive\\\\)') { [void]$warnings.Add('path_slow_or_remote') }`,
			`$doc = $Word.Documents.Open($workingPath, $false, $false)`,
			`function Resolve-Paragraph([object]$selector) {`,
			`  if ($null -eq $selector) { return $null }`,
			`  if ($selector.blockId) {`,
			`    if ($selector.blockId -match '^block-(\\d+)$') {`,
			`      $idx = [int]$Matches[1] + 1`,
			`      if ($idx -le $doc.Paragraphs.Count) { return $doc.Paragraphs.Item($idx) }`,
			`    }`,
			`    if ($selector.blockId -match '^table-(\\d+)-cell-(\\d+)-(\\d+)$') { return $null }`,
			`  }`,
			`  $occ = if ($selector.occurrence) { [int]$selector.occurrence } else { 1 }`,
			`  $seen = 0`,
			`  foreach ($para in $doc.Paragraphs) {`,
			`    $text = ($para.Range.Text -replace '[\\r\\a]+$', '').TrimEnd()`,
			`    if ($selector.kind -and $selector.kind -ne 'paragraph' -and $selector.kind -ne 'heading' -and $selector.kind -ne 'list') { continue }`,
			`    if ($selector.textEquals -and $text -ne [string]$selector.textEquals) { continue }`,
			`    if ($selector.textIncludes -and $text -notlike ('*' + [string]$selector.textIncludes + '*')) { continue }`,
			`    $seen++`,
			`    if ($seen -eq $occ) { return $para }`,
			`  }`,
			`  return $null`,
			`}`,
			...buildWordResolveCellScript(""),
			`$applied = New-Object System.Collections.ArrayList`,
			`$skipped = New-Object System.Collections.ArrayList`,
			`foreach ($op in $ops) {`,
			`  $selectorJson = $op.selector | ConvertTo-Json -Compress -Depth 6`,
			`  $record = [ordered]@{ type=$op.type; selector=($selectorJson | ConvertFrom-Json) }`,
			`  $handled = $false`,
			`  switch ($op.type) {`,
			`    'replace_text' {`,
			`      $para = Resolve-Paragraph $op.selector`,
			`      if ($para) {`,
			`        $text = ($para.Range.Text -replace '[\\r\\a]+$', '')`,
			`        if ($text -like ('*' + [string]$op.findText + '*')) {`,
			`          $para.Range.Text = $text.Replace([string]$op.findText, [string]$op.replaceText)`,
			`          $record.blockId = if ($op.selector.blockId) { [string]$op.selector.blockId } else { '' }`,
			`          $record.text = [string]$op.replaceText`,
			`          [void]$applied.Add([pscustomobject]$record)`,
			`          $handled = $true`,
			`        }`,
			`      }`,
			`    }`,
			`    'insert_after_block' {`,
			`      $para = Resolve-Paragraph $op.selector`,
			`      if ($para) {`,
			`        $range = $para.Range.Duplicate`,
			`        $range.Collapse(0)`,
			`        $range.InsertAfter([Environment]::NewLine + [string]$op.text)`,
			`        $record.text = [string]$op.text`,
			`        [void]$applied.Add([pscustomobject]$record)`,
			`        $handled = $true`,
			`      }`,
			`    }`,
			`    'insert_before_block' {`,
			`      $para = Resolve-Paragraph $op.selector`,
			`      if ($para) {`,
			`        $range = $para.Range.Duplicate`,
			`        $range.Collapse(1)`,
			`        $range.InsertBefore([string]$op.text + [Environment]::NewLine)`,
			`        $record.text = [string]$op.text`,
			`        [void]$applied.Add([pscustomobject]$record)`,
			`        $handled = $true`,
			`      }`,
			`    }`,
			`    'set_block_text' {`,
			`      $para = Resolve-Paragraph $op.selector`,
			`      if ($para) {`,
			`        $para.Range.Text = [string]$op.text`,
			`        $record.text = [string]$op.text`,
			`        [void]$applied.Add([pscustomobject]$record)`,
			`        $handled = $true`,
			`      }`,
			`    }`,
			`    'append_to_block' {`,
			`      $para = Resolve-Paragraph $op.selector`,
			`      if ($para) {`,
			`        $text = ($para.Range.Text -replace '[\\r\\a]+$', '')`,
			`        $para.Range.Text = $text + [string]$op.text`,
			`        $record.text = [string]$op.text`,
			`        [void]$applied.Add([pscustomobject]$record)`,
			`        $handled = $true`,
			`      }`,
			`    }`,
			`    'update_table_cell' {`,
			`      $cell = Resolve-Cell $op.selector`,
			`      if ($cell) {`,
			`        $cell.Range.Text = [string]$op.text`,
			`        $record.text = [string]$op.text`,
			`        [void]$applied.Add([pscustomobject]$record)`,
			`        $handled = $true`,
			`      }`,
			`    }`,
			`    'delete_block' {`,
			`      $para = Resolve-Paragraph $op.selector`,
			`      if ($para) {`,
			`        $para.Range.Delete()`,
			`        [void]$applied.Add([pscustomobject]$record)`,
			`        $handled = $true`,
			`      }`,
			`    }`,
			`  }`,
			`  if (-not $handled) {`,
			`    $record.reason = 'selector_not_found'`,
			`    [void]$skipped.Add([pscustomobject]$record)`,
			`    if (-not ($warnings -contains 'selector_not_found')) { [void]$warnings.Add('selector_not_found') }`,
			`  }`,
			`}`,
			`$doc.Save()`,
			`$doc.Close($false)`,
			`try { Copy-Item -LiteralPath $workingPath -Destination $path -Force } catch {`,
			`  if (-not ($warnings -contains 'save_conflict')) { [void]$warnings.Add('save_conflict') }`,
			`}`,
			`$result = [pscustomobject]@{`,
			`  applied=$applied;`,
			`  skipped=$skipped;`,
			`  savePath=$workingPath;`,
			`  verificationHints=@('Run doc_verify against the updated file', 'Original file is only safe if overwrite succeeded');`,
			`  warnings=$warnings`,
			`}`,
			`$result | ConvertTo-Json -Compress -Depth 8`,
		].join("\n"),
	);
}

function buildWordVerifyScript(path: string, checks: DocumentVerifyCheck[]): string {
	const pathEsc = escapePsString(path);
	const checksB64 = encodeToolPayload(checks);
	return wrapWordCom(
		[
			`$path = '${pathEsc}'`,
			`if (-not (Test-Path -LiteralPath $path)) { throw "Document path not found: $path" }`,
			`$checks = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${checksB64}')) | ConvertFrom-Json`,
			`$doc = $Word.Documents.Open($path, $false, $true)`,
			`try {`,
			`  $allText = $doc.Content.Text`,
			`  $results = New-Object System.Collections.ArrayList`,
			`  $warnings = New-Object System.Collections.ArrayList`,
			`  function Resolve-Paragraph([object]$selector) {`,
			`    if ($selector.blockId -match '^block-(\\d+)$') { $idx = [int]$Matches[1] + 1; if ($idx -le $doc.Paragraphs.Count) { return $doc.Paragraphs.Item($idx) } }`,
			`    return $null`,
			`  }`,
			...buildWordResolveCellScript("  "),
			`  foreach ($check in $checks) {`,
			`    switch ($check.type) {`,
			`      'text_exists' {`,
			`        $passed = $allText -like ('*' + [string]$check.text + '*')`,
			`        [void]$results.Add([pscustomobject]@{ type=$check.type; passed=$passed; reason=if ($passed) { '' } else { 'text_missing' } })`,
			`      }`,
			`      'text_not_exists' {`,
			`        $passed = $allText -notlike ('*' + [string]$check.text + '*')`,
			`        [void]$results.Add([pscustomobject]@{ type=$check.type; passed=$passed; reason=if ($passed) { '' } else { 'text_still_present' } })`,
			`      }`,
			`      'block_text_equals' {`,
			`        $para = Resolve-Paragraph $check.selector`,
			`        if ($para) {`,
			`          $text = ($para.Range.Text -replace '[\\r\\a]+$', '').TrimEnd()`,
			`          $passed = $text -eq [string]$check.expectedText`,
			`          [void]$results.Add([pscustomobject]@{ type=$check.type; passed=$passed; reason=if ($passed) { '' } else { 'block_text_mismatch' } })`,
			`        } else {`,
			`          [void]$results.Add([pscustomobject]@{ type=$check.type; passed=$false; reason='selector_not_found' })`,
			`          if (-not ($warnings -contains 'selector_not_found')) { [void]$warnings.Add('selector_not_found') }`,
			`        }`,
			`      }`,
			`      'table_cell_equals' {`,
			`        $cell = Resolve-Cell $check.selector`,
			`        if ($cell) {`,
			`          $text = ($cell.Range.Text -replace '[\\r\\a]+$', '').TrimEnd()`,
			`          $passed = $text -eq [string]$check.expectedText`,
			`          [void]$results.Add([pscustomobject]@{ type=$check.type; passed=$passed; reason=if ($passed) { '' } else { 'table_cell_mismatch' } })`,
			`        } else {`,
			`          [void]$results.Add([pscustomobject]@{ type=$check.type; passed=$false; reason='selector_not_found' })`,
			`          if (-not ($warnings -contains 'selector_not_found')) { [void]$warnings.Add('selector_not_found') }`,
			`        }`,
			`      }`,
			`    }`,
			`  }`,
			`  $passed = -not (@($results | Where-Object { -not $_.passed }).Count)`,
			`  [pscustomobject]@{ passed=$passed; checks=$results; warnings=$warnings } | ConvertTo-Json -Compress -Depth 6`,
			`} finally {`,
			`  $doc.Close($false)`,
			`}`,
		].join("\n"),
	);
}

function buildDocumentPlan(
	path: string,
	intent: string,
	inspection: DocumentInspectionResult | undefined,
	constraints: string[] | undefined,
) {
	const operations: DocumentEditOperation[] = [];
	const riskFlags = [...new Set([...(inspection?.warnings ?? []), ...inferDocumentWarnings(path)])];
	const normalizedIntent = intent.trim();
	const firstBlock = inspection?.blocks.find((block) => block.kind === "paragraph" || block.kind === "heading");
	if (firstBlock && normalizedIntent) {
		operations.push({
			type: "append_to_block",
			selector: { blockId: firstBlock.blockId },
			text: `\n${normalizedIntent}`,
		});
	}
	return {
		operations,
		riskFlags,
		requiresUserClarification: operations.length === 0,
		preview: {
			intent,
			constraints: constraints ?? [],
			suggestedOperations: operations,
			anchorBlockId: firstBlock?.blockId,
		},
	};
}

/** Build the outer Word COM wrapper; innerScript receives $Word already created. */
function wrapWordCom(innerScript: string): string {
	return [
		`$ErrorActionPreference = 'Stop'`,
		`$createdByAgent = $false`,
		`try { $Word = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application') }`,
		`catch {`,
		`  try {`,
		`    $Word = New-Object -ComObject Word.Application -ErrorAction Stop`,
		`    $createdByAgent = $true`,
		`  } catch {`,
		`    Write-Error "Microsoft Word is not installed or inaccessible: $_"; exit 1`,
		`  }`,
		`}`,
		`$Word.Visible = $false; $Word.DisplayAlerts = 0`,
		`try {`,
		innerScript,
		`} catch { Write-Error "Word error: $_"; exit 1 }`,
		`finally {`,
		`  if ($createdByAgent) {`,
		`    try { $Word.Quit($false) } catch {}`,
		`  }`,
		`  [void][System.Runtime.Interopservices.Marshal]::ReleaseComObject($Word)`,
		`}`,
	].join("\n");
}

/** Build the outer Excel COM wrapper; innerScript receives $Excel already created. */
function wrapExcelCom(innerScript: string): string {
	return [
		`$ErrorActionPreference = 'Stop'`,
		`$createdByAgent = $false`,
		`try { $Excel = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application') }`,
		`catch {`,
		`  try {`,
		`    $Excel = New-Object -ComObject Excel.Application -ErrorAction Stop`,
		`    $createdByAgent = $true`,
		`  } catch {`,
		`    Write-Error "Microsoft Excel is not installed or inaccessible: $_"; exit 1`,
		`  }`,
		`}`,
		`$Excel.Visible = $false; $Excel.DisplayAlerts = $false`,
		`try {`,
		innerScript,
		`} catch {`,
		`  $err = $_`,
		`  $ex = $err.Exception`,
		`  $line = $err.InvocationInfo.ScriptLineNumber`,
		`  $pos = $err.InvocationInfo.OffsetInLine`,
		`  $cmd = $err.InvocationInfo.Line`,
		`  if ($null -eq $cmd) { $cmd = '' }`,
		`  Write-Error ("Excel error ({0}): {1}\`nAt line {2}, char {3}\`n{4}" -f $ex.GetType().FullName, $ex.Message, $line, $pos, $cmd)`,
		`  exit 1`,
		`}`,
		`finally {`,
		`  if ($createdByAgent) {`,
		`    try { $Excel.Quit() } catch {}`,
		`  }`,
		`  [void][System.Runtime.Interopservices.Marshal]::ReleaseComObject($Excel)`,
		`}`,
	].join("\n");
}

/** Build the outer PowerPoint COM wrapper; innerScript receives $Ppt already created. */
function wrapPptCom(innerScript: string): string {
	return [
		`$ErrorActionPreference = 'Stop'`,
		`$createdByAgent = $false`,
		`try { $Ppt = [System.Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') }`,
		`catch {`,
		`  try {`,
		`    $Ppt = New-Object -ComObject PowerPoint.Application -ErrorAction Stop`,
		`    $createdByAgent = $true`,
		`  } catch {`,
		`    Write-Error "Microsoft PowerPoint is not installed or inaccessible: $_"; exit 1`,
		`  }`,
		`}`,
		`try {`,
		innerScript,
		`} catch { Write-Error "PowerPoint error: $_"; exit 1 }`,
		`finally {`,
		`  if ($createdByAgent) {`,
		`    try { $Ppt.Quit() } catch {}`,
		`  }`,
		`  [void][System.Runtime.Interopservices.Marshal]::ReleaseComObject($Ppt)`,
		`}`,
	].join("\n");
}

const OFFICE_DOC_GUIDELINES = [
	"Document capability is enabled: choose the lightest safe Word path for the requested edit.",
	"Fast path: for simple global edits across one or more existing documents (Find/Replace, append/prepend plain text, update all font family/size/style, update fields, export PDF), prefer office_word_run because it is faster and does not need an initial doc_inspect.",
	"Structured path: for targeted edits that depend on document structure, user-visible block selection, table/form cell filling, or verification-sensitive changes, use doc_inspect -> doc_apply_edits -> doc_verify.",
	"Use doc_plan_edits before doc_apply_edits when the request is non-trivial or ambiguous.",
	"Use doc_apply_edits with structured operations when selectors matter. Prefer blockId selectors from doc_inspect.",
	"Filling a form/table in an existing .docx (e.g. 回访调查表): use doc_inspect to read the tables (it returns each cell's tableId/row/col/text and tolerates merged cells), then doc_apply_edits with update_table_cell or replace_text. Do NOT iterate cells with office_word_run via $table.Cell($r,$c) — that throws on merged cells (very common in forms) and dumps oversized output; the structured tools are the correct path here.",
	"Use doc_verify after edits when correctness matters so the assistant can confirm the result from tool output instead of assuming success.",
	"To create a brand-new Word document, use doc_create_from_html: write a complete document-style HTML page and the tool converts it into an editable .docx (headings become real Word styles, tables become real tables). Design the visual style yourself based on the document type. There is no markdown doc_create — even a one-line note is created as minimal HTML. Do not use doc_create_from_html to edit an existing document.",
	"document-HTML rules for doc_create_from_html: single-column SEMANTIC html only — <h1>-<h4> for headings (never a font-sized <p>), <table> for tabular data, <ul>/<ol> for lists. Allowed inline CSS: color, background-color, font-family, font-size, font-weight, font-style, text-align, line-height, margin, padding, table border/width. Do NOT use flexbox, grid, absolute/fixed positioning, CSS columns, transforms, vw/vh, box-shadow, border-radius, or web fonts — they are dropped on import; for side-by-side use a borderless <table>. Page breaks via <div style='page-break-before:always'></div>. Use installed fonts (中文: 微软雅黑/宋体/黑体).",
	"READ vs EDIT — pick the right tool: if you only need to READ / compare / summarize / extract text from a document (you are NOT editing it), use doc_read — it does a single fast full-text pass. Do NOT use doc_inspect for read-only tasks: doc_inspect walks every paragraph and table cell to build edit selectors and is far slower (often 30s+ / times out) on large or form documents. Use doc_inspect ONLY as the first step when you are about to EDIT the document.",
	'To read DETAILED / RAW formatting (exact font name/size/color, bold/italic/underline, paragraph alignment/indent/spacing, cell shading) — which doc_read (text only) and doc_inspect\'s styleName (the Word style name) do not give: either (a) call doc_inspect with formatForBlockIds=[the few blockIds you care about] to get their full `formats`, or (b) use office_word_run to read exactly the properties you need via Word COM, e.g. `$r=$doc.Paragraphs.Item(1).Range; "$($r.Font.Name) $($r.Font.Size) bold=$($r.Font.Bold)"`. Read only the specific parts you need — reading full formatting for the WHOLE document is slow and usually unnecessary.',
	"Use office_word_run as the fast path for simple global edits and as an advanced escape hatch for operations the structured tools do not cover yet, such as complex headers/footers, field updates, or PDF export.",
	"Do not use office_word_run for routine form/table filling with $table.Cell($row,$col) loops. Use doc_inspect -> doc_apply_edits -> doc_verify first, especially for merged-cell forms.",
	"When office_word_run writes a document, open it editable (Documents.Open(..., $false, $false) or ReadOnly:=$false). Never open read-only and then save or mutate content.",
	"Office tools manage the Word application lifecycle automatically. If Word was already open, reuse it and do not quit it. If the tool created Word, it will close that instance after the task finishes.",
	"When writing an office_word_run script, close only the documents you opened. Do not call $Word.Quit() inside the user script.",
	"In office_word_run, set paragraph styles with built-in WdBuiltinStyle ids, not English names: $doc.Styles.Item(-2)=Heading 1, -3=Heading 2, -4=Heading 3, -1=Normal. Localized Word (e.g. Chinese) does not resolve names like 'Heading 1' and throws 'the requested member of the collection does not exist'.",
	"Microsoft Word must be installed. If Word is unavailable, tell the user and suggest installing Microsoft Office.",
];

const OFFICE_EXCEL_GUIDELINES = [
	"Excel capability is enabled: use excel_read, excel_write, and office_excel_run to work with Excel workbooks.",
	"Use excel_read to inspect data, headers, or formulas from an existing .xlsx.",
	"Use excel_write to bulk-write rows of data (new file or append/overwrite to existing).",
	"Use office_excel_run for advanced operations: formulas, charts, formatting, pivot tables, CSV import/export.",
	"When office_excel_run writes numbers, prefer $ws.Cells.Item(row,col) = 123 or explicit casts like $cell.Value = [double]$n; avoid raw .Value2 = [int].",
	"Office tools manage the Excel application lifecycle automatically. If Excel was already open, reuse it and do not quit it. If the tool created Excel, it will close that instance after the task finishes.",
	"When writing an office_excel_run script, close only the workbooks you opened. Do not call $Excel.Quit() inside the user script.",
	"Microsoft Excel must be installed. If Excel is unavailable, tell the user and suggest installing Microsoft Office.",
];

const OFFICE_PPT_GUIDELINES = [
	"PPT capability is enabled: use ppt_create, ppt_read, and office_ppt_run to work with PowerPoint presentations.",
	"Use ppt_create to generate a new .pptx from slide definitions.",
	"Use ppt_read to extract slide titles and content from an existing .pptx.",
	"Use office_ppt_run for advanced operations: animation, slide design, master layout, speaker notes export.",
	"Office tools manage the PowerPoint application lifecycle automatically. If PowerPoint was already open, reuse it and do not quit it. If the tool created PowerPoint, it will close that instance after the task finishes.",
	"When writing an office_ppt_run script, close only the presentations you opened. Do not call $Ppt.Quit() inside the user script.",
	"Microsoft PowerPoint must be installed. If unavailable, tell the user and suggest installing Microsoft Office.",
];

// ─────────────────────────────────────────────────────────────────────────────
// Document (Word) tools
// ─────────────────────────────────────────────────────────────────────────────

function createDocCreateFromHtmlTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "doc_create_from_html",
		label: "Create document from HTML",
		description:
			"Create a brand-new editable Word .docx by writing a document-style HTML page. Word imports the HTML, so headings become real Word styles and tables become real tables — the result is fully editable, not a screenshot. This is the way to create a new Word document; design the visual style yourself to suit the content. Not for editing existing documents (use doc_inspect/doc_apply_edits for that).",
		promptSnippet:
			"Create a new Word document by writing document-style HTML; the tool converts it to an editable .docx.",
		promptGuidelines: OFFICE_DOC_GUIDELINES,
		parameters: docCreateFromHtmlSchema,
		execute: async (_toolCallId, params) => {
			const pathEsc = escapePsString(params.path);
			const htmlB64 = Buffer.from(params.html, "utf-8").toString("base64");
			// COM page setup is language-independent; CSS @page is unreliable on import.
			const orientation = params.pageSetup?.orientation === "landscape" ? 1 : 0;
			const paperSize = params.pageSetup?.pageSize === "Letter" ? 2 : 7; // wdPaperLetter=2, wdPaperA4=7
			const marginPt = params.pageSetup?.margin === "narrow" ? 36 : params.pageSetup?.margin === "wide" ? 108 : 72;
			const inner = [
				`$outPath = '${pathEsc}'`,
				`$html = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${htmlB64}'))`,
				// UTF-8 with BOM so Chinese imports correctly; random name avoids multi-session collisions.
				`$tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), [System.IO.Path]::GetRandomFileName() + '.html')`,
				`[System.IO.File]::WriteAllText($tmp, $html, (New-Object System.Text.UTF8Encoding($true)))`,
				`try {`,
				`  $doc = $Word.Documents.Open($tmp, $false)`, // ConfirmConversions=$false suppresses the format dialog
				`  $doc.PageSetup.Orientation = ${orientation}`,
				`  $doc.PageSetup.PaperSize = ${paperSize}`,
				`  $doc.PageSetup.TopMargin = ${marginPt}`,
				`  $doc.PageSetup.BottomMargin = ${marginPt}`,
				`  $doc.PageSetup.LeftMargin = ${marginPt}`,
				`  $doc.PageSetup.RightMargin = ${marginPt}`,
				`  $doc.SaveAs2($outPath, 16)`, // 16 = wdFormatDocumentDefault (.docx)
				`  $doc.Close($false)`,
				`  Write-Output "Document created: $outPath"`,
				`} finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }`,
			].join("\n");
			return gateAndRunOffice(
				options,
				{
					toolName: "doc_create_from_html",
					kind: "file_write",
					intent: "Create Word document from HTML",
					writePathsRaw: [params.path],
					riskText: `Create Word document ${params.path}`,
				},
				{ intent: "Create Word document from HTML", target: params.path, riskLevel: "medium" },
				wrapWordCom(inner),
			);
		},
	});
}

function createDocReadTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "doc_read",
		label: "Read document",
		description: "Read the full text content from a Word .docx file.",
		promptSnippet: "Extract all text from an existing Word document.",
		promptGuidelines: OFFICE_DOC_GUIDELINES,
		parameters: docReadSchema,
		execute: async (_toolCallId, params) => {
			const pathEsc = params.path.replace(/'/g, "''");
			const inner = [
				`$doc = $Word.Documents.Open('${pathEsc}', $false, $true)`,
				`$text = $doc.Content.Text`,
				`$doc.Close($false)`,
				`Write-Output $text`,
			].join("\n");
			return runOfficeScript(
				options.host,
				{ intent: "Read Word document", target: params.path, riskLevel: "low" },
				wrapWordCom(inner),
			);
		},
	});
}

function createDocInspectTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "doc_inspect",
		label: "Inspect document",
		description:
			"Inspect an existing Word .docx file: returns structured blocks, tables, headers, footers, each block's styleName, and warnings. Optionally pass formatForBlockIds to also get FULL formatting (font/size/color/bold/italic/underline, paragraph alignment/indent/spacing, cell shading) for just those blocks under `formats`.",
		promptSnippet:
			"Inspect an existing Word document before editing it. Returns structured JSON with stable block ids; pass formatForBlockIds for detailed formatting of specific blocks.",
		promptGuidelines: OFFICE_DOC_GUIDELINES,
		parameters: docInspectSchema,
		execute: async (_toolCallId, params) => {
			const warnings = inferDocumentWarnings(params.path);
			const response = await runStructuredWordTool<DocumentInspectionResult>(
				options.host,
				{ intent: "Inspect Word document", action: "doc_inspect", target: params.path },
				buildWordInspectScript(params.path, params.formatForBlockIds ?? []),
			);
			if (response.payload) {
				response.details.stdout = JSON.stringify({
					...response.payload,
					warnings: [...new Set([...(response.payload.warnings ?? []), ...warnings])],
				});
				return toStructuredToolResponse(response.details);
			}
			return response;
		},
	});
}

function createDocPlanEditsTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "doc_plan_edits",
		label: "Plan document edits",
		description:
			"Inspect an existing Word .docx file and return a structured candidate edit plan without changing the file.",
		promptSnippet:
			"Analyze the Word document structure, then propose structured operations and risks before editing.",
		promptGuidelines: OFFICE_DOC_GUIDELINES,
		parameters: docPlanEditsSchema,
		execute: async (_toolCallId, params) => {
			const inspection = await runStructuredWordTool<DocumentInspectionResult>(
				options.host,
				{ intent: "Inspect Word document for edit planning", action: "doc_plan_edits", target: params.path },
				buildWordInspectScript(params.path),
			);
			if (inspection.details.status !== "succeeded") {
				return inspection;
			}
			const payload = buildDocumentPlan(params.path, params.intent, inspection.payload, params.constraints);
			const details = buildDocumentToolDetails({
				intent: "Plan Word document edits",
				action: "doc_plan_edits",
				target: params.path,
				status: "succeeded",
				stdout: JSON.stringify(payload),
			});
			return toStructuredToolResponse(details);
		},
	});
}

function createDocApplyEditsTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "doc_apply_edits",
		label: "Apply document edits",
		description:
			"Apply structured edit operations to an existing Word .docx file using a safer copy-verify-overwrite runtime.",
		promptSnippet: "Apply declarative Word edit operations. Do not send arbitrary PowerShell here.",
		promptGuidelines: OFFICE_DOC_GUIDELINES,
		parameters: docApplyEditsSchema,
		execute: async (_toolCallId, params) => {
			const response = await runStructuredWordTool<DocumentApplyResult>(
				options.host,
				{ intent: "Apply Word document edits", action: "doc_apply_edits", target: params.path },
				buildWordApplyScript(params.path, params.operations as DocumentEditOperation[]),
			);
			if (response.payload) {
				const mergedWarnings = [
					...new Set([...(response.payload.warnings ?? []), ...inferDocumentWarnings(params.path)]),
				];
				response.details.stdout = JSON.stringify({
					...response.payload,
					warnings: mergedWarnings,
				});
			}
			return toStructuredToolResponse(response.details);
		},
	});
}

function createDocVerifyTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "doc_verify",
		label: "Verify document",
		description:
			"Verify whether a Word .docx file satisfies structured checks such as text existence, block equality, and table-cell equality.",
		promptSnippet:
			"Verify the final Word document state from explicit checks instead of assuming the edit succeeded.",
		promptGuidelines: OFFICE_DOC_GUIDELINES,
		parameters: docVerifySchema,
		execute: async (_toolCallId, params) => {
			const response = await runStructuredWordTool<DocumentVerifyResult>(
				options.host,
				{ intent: "Verify Word document", action: "doc_verify", target: params.path },
				buildWordVerifyScript(params.path, params.checks as DocumentVerifyCheck[]),
			);
			if (response.payload) {
				response.details.stdout = JSON.stringify({
					...response.payload,
					warnings: [...new Set([...(response.payload.warnings ?? []), ...inferDocumentWarnings(params.path)])],
				});
			}
			return toStructuredToolResponse(response.details);
		},
	});
}

function createOfficeWordRunTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "office_word_run",
		label: "Word script",
		description:
			"Advanced fallback: run a custom PowerShell script inside a Word COM session when structured document tools cannot express the required operation.",
		promptSnippet:
			"Advanced Word escape hatch. Prefer doc_inspect/doc_apply_edits/doc_verify for normal edits. Use this only for unsupported Word COM operations such as PDF export or field updates.",
		promptGuidelines: OFFICE_DOC_GUIDELINES,
		parameters: officeWordRunSchema,
		execute: async (_toolCallId, params) => {
			const unsafeReadonlyWrite = detectUnsafeReadonlyWordWrite(params.script);
			if (unsafeReadonlyWrite) {
				return blockedOfficeWordRunResult(params.script, unsafeReadonlyWrite);
			}
			return gateAndRunOffice(
				options,
				{
					toolName: "office_word_run",
					kind: "office_run",
					lane: "real",
					intent: "Word automation script",
					riskText: params.script,
				},
				{
					intent: "Word automation script",
					action: "office_word_run",
					target: "Word.Application",
					riskLevel: "medium",
				},
				wrapWordCom(params.script),
			);
		},
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Excel tools
// ─────────────────────────────────────────────────────────────────────────────

function createExcelReadTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "excel_read",
		label: "Read spreadsheet",
		description: "Read data from an Excel .xlsx file and return it as a JSON array of rows.",
		promptSnippet: "Read Excel data as [[row1col1, row1col2], [row2...]] JSON. Specify sheet name or index.",
		promptGuidelines: OFFICE_EXCEL_GUIDELINES,
		parameters: excelReadSchema,
		execute: async (_toolCallId, params) => {
			const pathEsc = params.path.replace(/'/g, "''");
			const sheet = params.sheet ?? 1;
			const sheetRef = typeof sheet === "string" ? `'${String(sheet).replace(/'/g, "''")}'` : String(sheet);
			const maxRows = params.maxRows ?? 500;
			const inner = [
				`$wb = $Excel.Workbooks.Open('${pathEsc}', 0, $true)`,
				`$ws = $wb.Sheets.Item(${sheetRef})`,
				`$used = $ws.UsedRange`,
				`$rowLimit = [Math]::Min($used.Rows.Count, ${maxRows})`,
				`$rows = @()`,
				`for ($r = 1; $r -le $rowLimit; $r++) {`,
				`  $row = @()`,
				`  for ($c = 1; $c -le $used.Columns.Count; $c++) {`,
				`    $v = $ws.Cells.Item($r, $c).Value2`,
				`    $row += if ($null -eq $v) { $null } else { "$v" }`,
				`  }`,
				`  $rows += ,$row`,
				`}`,
				`$wb.Close($false)`,
				`$rows | ConvertTo-Json -Compress -Depth 3`,
			].join("\n");
			return runOfficeScript(
				options.host,
				{ intent: "Read Excel data", target: params.path, riskLevel: "low" },
				wrapExcelCom(inner),
			);
		},
	});
}

function createExcelWriteTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "excel_write",
		label: "Write spreadsheet",
		description:
			"Write rows of data to an Excel .xlsx file. Creates the file if it does not exist. Can optionally clear the sheet first.",
		promptSnippet:
			"Write [[row1col1, col2], [row2...]] data to an Excel file. Specify path, data, sheet, and start position.",
		promptGuidelines: OFFICE_EXCEL_GUIDELINES,
		parameters: excelWriteSchema,
		execute: async (_toolCallId, params) => {
			const pathEsc = params.path.replace(/'/g, "''");
			const sheet = params.sheet ?? 1;
			const sheetRef = typeof sheet === "string" ? `'${String(sheet).replace(/'/g, "''")}'` : String(sheet);
			const startRow = params.startRow ?? 1;
			const startCol = params.startCol ?? 1;
			const clearSheet = params.clearSheet ?? false;
			const dataB64 = Buffer.from(JSON.stringify(params.data), "utf-8").toString("base64");
			const inner = [
				`$data = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${dataB64}')) | ConvertFrom-Json`,
				`$path = '${pathEsc}'`,
				`function Set-ExcelCellValue($cell, $value) {`,
				`  if ($null -eq $value) { return }`,
				`  $typeCode = [System.Type]::GetTypeCode($value.GetType())`,
				`  switch ($typeCode) {`,
				`    'Boolean' { $cell.Value = [bool]$value; return }`,
				`    'Byte' { $cell.Value = [double]$value; return }`,
				`    'SByte' { $cell.Value = [double]$value; return }`,
				`    'Int16' { $cell.Value = [double]$value; return }`,
				`    'UInt16' { $cell.Value = [double]$value; return }`,
				`    'Int32' { $cell.Value = [double]$value; return }`,
				`    'UInt32' { $cell.Value = [double]$value; return }`,
				`    'Int64' { $cell.Value = [double]$value; return }`,
				`    'UInt64' { $cell.Value = [double]$value; return }`,
				`    'Single' { $cell.Value = [double]$value; return }`,
				`    'Double' { $cell.Value = [double]$value; return }`,
				`    'Decimal' { $cell.Value = [double]$value; return }`,
				`    'String' { $cell.Value2 = [string]$value; return }`,
				`    default { $cell.Value2 = [string]$value; return }`,
				`  }`,
				`}`,
				`if (Test-Path $path) { $wb = $Excel.Workbooks.Open($path) } else { $wb = $Excel.Workbooks.Add() }`,
				`$ws = $wb.Sheets.Item(${sheetRef})`,
				`if (${clearSheet ? "$true" : "$false"}) { $ws.UsedRange.Clear() }`,
				`$row = ${startRow}`,
				`foreach ($rowData in $data) {`,
				`  $col = ${startCol}`,
				`  foreach ($val in $rowData) {`,
				`    if ($null -ne $val) { Set-ExcelCellValue ($ws.Cells.Item($row, $col)) $val }`,
				`    $col++`,
				`  }`,
				`  $row++`,
				`}`,
				`if (Test-Path $path) { $wb.Save() } else { $wb.SaveAs($path, 51) }`,
				`$wb.Close($false)`,
				`Write-Output "Written $($row - ${startRow}) rows to: $path"`,
			].join("\n");
			return gateAndRunOffice(
				options,
				{
					toolName: "excel_write",
					kind: "file_write",
					intent: "Write Excel data",
					writePathsRaw: [params.path],
					riskText: `Write Excel file ${params.path}`,
				},
				{ intent: "Write Excel data", target: params.path, riskLevel: "medium" },
				wrapExcelCom(inner),
			);
		},
	});
}

function createOfficeExcelRunTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "office_excel_run",
		label: "Excel script",
		description:
			"Run a custom PowerShell script inside an Excel COM session. $Excel (Excel.Application) is pre-created. Use for formulas, charts, pivot tables, formatting, CSV import, or PDF export.",
		promptSnippet:
			"Execute arbitrary Excel COM automation. $Excel is available. Example: $wb = $Excel.Workbooks.Open('file.xlsx'); $ws = $wb.Sheets.Item(1); $ws.Cells.Item(1,1).Formula = '=SUM(A2:A10)'",
		promptGuidelines: OFFICE_EXCEL_GUIDELINES,
		parameters: officeExcelRunSchema,
		execute: async (_toolCallId, params) =>
			gateAndRunOffice(
				options,
				{
					toolName: "office_excel_run",
					kind: "office_run",
					lane: "real",
					intent: "Excel automation script",
					riskText: params.script,
				},
				{ intent: "Excel automation script", target: "Excel.Application", riskLevel: "medium" },
				wrapExcelCom(params.script),
			),
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// PowerPoint tools
// ─────────────────────────────────────────────────────────────────────────────

function createPptCreateTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "ppt_create",
		label: "Create presentation",
		description:
			"Create a PowerPoint .pptx file from slide definitions. Each slide can have a title, body content, and layout.",
		promptSnippet:
			"Generate a .pptx from [{title, content, layout}] slide definitions. Layout 1 = Title+Content (default).",
		promptGuidelines: OFFICE_PPT_GUIDELINES,
		parameters: pptCreateSchema,
		execute: async (_toolCallId, params) => {
			const pathEsc = params.path.replace(/'/g, "''");
			const slidesB64 = Buffer.from(JSON.stringify(params.slides), "utf-8").toString("base64");
			const inner = [
				`$path = '${pathEsc}'`,
				`$slides = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${slidesB64}')) | ConvertFrom-Json`,
				`$pres = $Ppt.Presentations.Add($false)`,
				`for ($i = 0; $i -lt $slides.Count; $i++) {`,
				`  $def = $slides[$i]`,
				`  $layout = if ($def.layout) { [int]$def.layout } else { 1 }`,
				`  $s = $pres.Slides.Add($i + 1, $layout)`,
				`  try { if ($def.title) { $s.Shapes.Title.TextFrame.TextRange.Text = $def.title } } catch {}`,
				`  try {`,
				`    if ($def.content -and $s.Shapes.Count -ge 2) {`,
				`      $s.Shapes.Item(2).TextFrame.TextRange.Text = ($def.content -replace '\\\\n', "\`n")`,
				`    }`,
				`  } catch {}`,
				`}`,
				`$pres.SaveAs($path, 24)`,
				`$pres.Close()`,
				`Write-Output "Presentation created: $path ($($slides.Count) slides)"`,
			].join("\n");
			return gateAndRunOffice(
				options,
				{
					toolName: "ppt_create",
					kind: "file_write",
					intent: "Create PowerPoint presentation",
					writePathsRaw: [params.path],
					riskText: `Create PowerPoint file ${params.path}`,
				},
				{ intent: "Create PowerPoint presentation", target: params.path, riskLevel: "medium" },
				wrapPptCom(inner),
			);
		},
	});
}

function createPptReadTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "ppt_read",
		label: "Read presentation",
		description: "Read slide titles and text content from a PowerPoint .pptx file.",
		promptSnippet: "Extract slide content from a .pptx as [{index, title, text}] JSON.",
		promptGuidelines: OFFICE_PPT_GUIDELINES,
		parameters: pptReadSchema,
		execute: async (_toolCallId, params) => {
			const pathEsc = params.path.replace(/'/g, "''");
			const inner = [
				`$pres = $Ppt.Presentations.Open('${pathEsc}', $true, $true, $false)`,
				`$result = @()`,
				`for ($i = 1; $i -le $pres.Slides.Count; $i++) {`,
				`  $slide = $pres.Slides.Item($i)`,
				`  $info = [pscustomobject]@{ index=$i; title=''; text=@() }`,
				`  foreach ($shape in $slide.Shapes) {`,
				`    if ($shape.HasTextFrame -eq -1) {`,
				`      $t = $shape.TextFrame.TextRange.Text`,
				`      if ($shape.Name -like '*Title*') { $info.title = $t }`,
				`      else { $info.text += $t }`,
				`    }`,
				`  }`,
				`  $result += $info`,
				`}`,
				`$pres.Close()`,
				`$result | ConvertTo-Json -Compress -Depth 4`,
			].join("\n");
			return runOfficeScript(
				options.host,
				{ intent: "Read PowerPoint presentation", target: params.path, riskLevel: "low" },
				wrapPptCom(inner),
			);
		},
	});
}

function createOfficePptRunTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "office_ppt_run",
		label: "PowerPoint script",
		description:
			"Run a custom PowerShell script inside a PowerPoint COM session. $Ppt (PowerPoint.Application) is pre-created. Use for animations, slide design, master layout, notes export, or PDF conversion.",
		promptSnippet:
			"Execute arbitrary PowerPoint COM automation. $Ppt is available. Example: $pres = $Ppt.Presentations.Open('file.pptx'); $pres.ExportAsFixedFormat('out.pdf', 2); $pres.Close()",
		promptGuidelines: OFFICE_PPT_GUIDELINES,
		parameters: officePptRunSchema,
		execute: async (_toolCallId, params) =>
			gateAndRunOffice(
				options,
				{
					toolName: "office_ppt_run",
					kind: "office_run",
					lane: "real",
					intent: "PowerPoint automation script",
					riskText: params.script,
				},
				{ intent: "PowerPoint automation script", target: "PowerPoint.Application", riskLevel: "medium" },
				wrapPptCom(params.script),
			),
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox workspace tools
// ─────────────────────────────────────────────────────────────────────────────

const SANDBOX_GUIDELINES = [
	"A real sandbox workspace exists for scratch work (document processing, temp files, exploratory commands). Prefer doing intermediate work IN the sandbox; only deliver the finished result to the real system.",
	"Even in 完全控制/full-access mode, prefer the sandbox first. Only fall back to running on the real system when the task truly cannot be done inside the sandbox.",
	"Run commands with shell_command_safe(target:'sandbox') by default; use target:'real' only for actions that must affect the real system (those are gated by the permission mode).",
	"DEFAULT WORKFLOW for editing/processing a user's existing file (document/spreadsheet/PPT/etc.): (1) sandbox_import it into the sandbox; (2) do ALL edits on the sandbox copy using absolute paths under $env:SANDBOX_ROOT (sandbox-internal work needs no approval); (3) sandbox_export the finished file to the real destination. Do NOT repeatedly run office_*_run / write tools directly against the user's real original file — work on the imported copy and only deliver the result.",
	"Before running a sandbox command, if the sandbox may not be ready, call sandbox_status. If phase is 'initializing', tell the user it is still initializing, wait briefly, and poll sandbox_status again before retrying.",
	"If sandbox_status reports phase 'failed' or 'stuck' after retrying, tell the user and offer options: sandbox_reset (or restart the app), or — per the permission mode — run on the real system instead.",
	"Watch the quota: if usage approaches the quota, use sandbox_clean to free space (oldest/largest first) before writing more.",
	"When delivering a file to a real location (Desktop, Documents, Downloads, …), FIRST call sandbox_status and use the real absolute paths it returns under `paths` (paths.desktop / paths.documents / paths.downloads / paths.home). Never assume `C:\\Users\\<name>\\Desktop` — the real folder may be on another drive (e.g. F:).",
	'In shell commands, these environment variables are ALWAYS set to real absolute paths (in both sandbox and real lanes): $env:SANDBOX_ROOT (the sandbox root), $env:SANDBOX_TMP, $env:SANDBOX_DESKTOP, $env:SANDBOX_DOCUMENTS, $env:SANDBOX_DOWNLOADS. Build absolute paths from them (e.g. "$env:SANDBOX_ROOT\\proj\\out.docx", copy to "$env:SANDBOX_DESKTOP"). Do NOT rely on the current directory or guess drive letters, and do not invent other env vars.',
	'Always use ABSOLUTE paths when creating/reading files — especially with Office/COM tools, whose SaveAs writes a relative path to the app\'s default folder (Documents), not the working directory. e.g. create at "$env:SANDBOX_ROOT\\out.docx", not "out.docx".',
	"Long commands (e.g. npm install) may return status='timeout' with an executionId after ~30s while the process keeps running — call shell_command_continue with a larger timeout to keep waiting; do NOT restart the command or assume it failed.",
];

const sandboxImportSchema = Type.Object({
	source: Type.String({ description: "Real-machine file or directory path to copy INTO the sandbox." }),
	destination: Type.Optional(
		Type.String({ description: "Relative path inside the sandbox to copy to. Defaults to the source's base name." }),
	),
});

const sandboxExportSchema = Type.Object({
	source: Type.String({ description: "Path inside the sandbox (relative to the sandbox root) to export." }),
	destination: Type.String({ description: "Real-machine destination path for the finished artifact." }),
});

const sandboxCleanSchema = Type.Object({
	strategy: Type.Optional(
		Type.Union([Type.Literal("all"), Type.Literal("oldest"), Type.Literal("largest")], {
			description: "all = wipe workspace; oldest/largest = evict by age/size until enough is freed. Default oldest.",
		}),
	),
	targetMb: Type.Optional(Type.Number({ description: "Approximate MB to free (oldest/largest strategies)." })),
});

const sandboxNoArgsSchema = Type.Object({});

function sandboxToolResult(p: {
	intent: string;
	action: string;
	target: string;
	status: DesktopToolResult["status"];
	stdout?: string;
	stderr?: string;
	nextActions?: string[];
}): { content: [{ type: "text"; text: string }]; details: DesktopToolResult } {
	const details: DesktopToolResult = {
		stepId: randomUUID(),
		intent: p.intent,
		action: p.action,
		target: p.target,
		status: p.status,
		riskLevel: "low",
		requiresConfirmation: false,
		stdout: p.stdout,
		stderr: p.stderr,
		nextActions: p.nextActions,
	};
	return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

function sandboxUnavailable(
	intent: string,
	action: string,
): { content: [{ type: "text"; text: string }]; details: DesktopToolResult } {
	return sandboxToolResult({
		intent,
		action,
		target: "sandbox",
		status: "blocked",
		stderr: "沙箱不可用：未启用或未在主进程初始化。请在设置中启用沙箱，或改用真实环境（受权限模式约束）。",
	});
}

function createSandboxStatusTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "sandbox_status",
		label: "Sandbox status",
		description:
			"Report the sandbox workspace lifecycle (phase, progress, usage, quota) AND the real OS folder paths under `paths` (sandboxRoot, desktop, documents, downloads, home, temp) resolved at runtime. Call before running sandbox commands when readiness is uncertain, while initializing, and before saving a file to a real location so you use the correct absolute path.",
		promptSnippet: "Check sandbox readiness + the real Desktop/Documents/Downloads paths.",
		promptGuidelines: SANDBOX_GUIDELINES,
		parameters: sandboxNoArgsSchema,
		execute: async () => {
			const manager = options.sandboxManager;
			if (!manager) return sandboxUnavailable("Check sandbox status", "sandbox_status");
			const status = manager.getStatus();
			// `paths` carries the real OS folders (resolved via app.getPath) so the AI
			// targets the actual Desktop/Documents/Downloads instead of guessing.
			const summary = {
				...status,
				usageMb: manager.usageMb(),
				entries: manager.list().length,
				paths: manager.knownPaths(),
			};
			return sandboxToolResult({
				intent: "Check sandbox status",
				action: "sandbox_status",
				target: status.rootDir ?? "sandbox",
				status: "succeeded",
				stdout: JSON.stringify(summary),
			});
		},
	});
}

function createSandboxInitTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "sandbox_init",
		label: "Initialize sandbox",
		description:
			"Start or retry sandbox initialization. Returns the resulting status (does not block the conversation).",
		promptSnippet: "Initialize or retry the sandbox.",
		promptGuidelines: SANDBOX_GUIDELINES,
		parameters: sandboxNoArgsSchema,
		execute: async () => {
			const manager = options.sandboxManager;
			if (!manager) return sandboxUnavailable("Initialize sandbox", "sandbox_init");
			const status = await manager.retry();
			return sandboxToolResult({
				intent: "Initialize sandbox",
				action: "sandbox_init",
				target: status.rootDir ?? "sandbox",
				status: status.phase === "ready" ? "succeeded" : "failed",
				stdout: JSON.stringify(status),
			});
		},
	});
}

function createSandboxResetTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "sandbox_reset",
		label: "Reset sandbox",
		description:
			"Wipe the sandbox workspace contents and re-initialize. Use when the sandbox is stuck or to start clean.",
		promptSnippet: "Wipe and re-initialize the sandbox workspace.",
		promptGuidelines: SANDBOX_GUIDELINES,
		parameters: sandboxNoArgsSchema,
		execute: async () => {
			const manager = options.sandboxManager;
			if (!manager) return sandboxUnavailable("Reset sandbox", "sandbox_reset");
			const status = await manager.reset();
			return sandboxToolResult({
				intent: "Reset sandbox",
				action: "sandbox_reset",
				target: status.rootDir ?? "sandbox",
				status: status.phase === "ready" ? "succeeded" : "failed",
				stdout: JSON.stringify(status),
			});
		},
	});
}

function createSandboxListTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "sandbox_list",
		label: "List sandbox contents",
		description: "List the entries in the sandbox workspace with their sizes, plus total usage and quota.",
		promptSnippet: "List sandbox files/dirs with sizes and quota.",
		promptGuidelines: SANDBOX_GUIDELINES,
		parameters: sandboxNoArgsSchema,
		execute: async () => {
			const manager = options.sandboxManager;
			if (!manager) return sandboxUnavailable("List sandbox contents", "sandbox_list");
			const status = manager.getStatus();
			const payload = { entries: manager.list(), usageMb: manager.usageMb(), quotaMb: status.quotaMb };
			return sandboxToolResult({
				intent: "List sandbox contents",
				action: "sandbox_list",
				target: status.rootDir ?? "sandbox",
				status: "succeeded",
				stdout: JSON.stringify(payload),
			});
		},
	});
}

function createSandboxCleanTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "sandbox_clean",
		label: "Clean sandbox",
		description:
			"Free space in the sandbox by deleting entries (strategy: all | oldest | largest). Use when usage nears the quota.",
		promptSnippet: "Reclaim sandbox space by removing files.",
		promptGuidelines: SANDBOX_GUIDELINES,
		parameters: sandboxCleanSchema,
		execute: async (_toolCallId, params) => {
			const manager = options.sandboxManager;
			if (!manager) return sandboxUnavailable("Clean sandbox", "sandbox_clean");
			const outcome = manager.clean(params.strategy ?? "oldest", params.targetMb);
			return sandboxToolResult({
				intent: "Clean sandbox",
				action: "sandbox_clean",
				target: outcome.status.rootDir ?? "sandbox",
				status: "succeeded",
				stdout: JSON.stringify({
					removedEntries: outcome.removedEntries,
					freedMb: outcome.freedMb,
					usageMb: outcome.status.usageMb,
				}),
			});
		},
	});
}

function createSandboxImportTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "sandbox_import",
		label: "Import into sandbox",
		description:
			"Copy a real-machine file or directory INTO the sandbox so it can be processed safely (real → sandbox). Returns the in-sandbox path.",
		promptSnippet: "Bring a local file/dir into the sandbox to work on it.",
		promptGuidelines: SANDBOX_GUIDELINES,
		parameters: sandboxImportSchema,
		execute: async (_toolCallId, params) => {
			const manager = options.sandboxManager;
			if (!manager) return sandboxUnavailable("Import into sandbox", "sandbox_import");
			const runtime = sandboxEnvFor(options).runtime;
			const src = canonicalize(params.source, manager.root);
			if (runtime.protectedPaths.some((root) => isWithin(root, src))) {
				return sandboxToolResult({
					intent: "Import into sandbox",
					action: "sandbox_import",
					target: params.source,
					status: "blocked",
					stderr: `禁止从受保护路径导入：${params.source}`,
				});
			}
			try {
				const outcome = manager.importPath(params.source, params.destination);
				return sandboxToolResult({
					intent: "Import into sandbox",
					action: "sandbox_import",
					target: outcome.path,
					status: "succeeded",
					stdout: `已导入到沙箱：${outcome.path}`,
				});
			} catch (error) {
				return sandboxToolResult({
					intent: "Import into sandbox",
					action: "sandbox_import",
					target: params.source,
					status: "failed",
					stderr: error instanceof Error ? error.message : String(error),
				});
			}
		},
	});
}

function createSandboxExportTool(options: DesktopToolOptions): ToolDefinition {
	return defineTool({
		name: "sandbox_export",
		label: "Export from sandbox",
		description:
			"Copy a finished artifact OUT of the sandbox to a real-machine destination (sandbox → real). This crosses the sandbox boundary and is gated by the permission mode.",
		promptSnippet: "Deliver a finished sandbox artifact to the real system.",
		promptGuidelines: SANDBOX_GUIDELINES,
		parameters: sandboxExportSchema,
		execute: async (_toolCallId, params) => {
			const manager = options.sandboxManager;
			if (!manager) return sandboxUnavailable("Export from sandbox", "sandbox_export");
			let src: string;
			try {
				src = manager.resolveInside(params.source);
			} catch (error) {
				return sandboxToolResult({
					intent: "Export from sandbox",
					action: "sandbox_export",
					target: params.source,
					status: "failed",
					stderr: error instanceof Error ? error.message : String(error),
				});
			}
			// Fail fast with a helpful listing if the source isn't where expected,
			// so the model can correct the path instead of getting a raw Copy-Item error.
			if (!manager.existsInside(params.source)) {
				const entries = manager.list().map((e) => `${e.name}${e.isDirectory ? "/" : ""}`);
				return sandboxToolResult({
					intent: "Export from sandbox",
					action: "sandbox_export",
					target: params.source,
					status: "failed",
					stderr: `沙箱内找不到源文件：解析为 ${src}。沙箱根（$env:SANDBOX_ROOT）顶层包含：${entries.join(", ") || "(空)"}。`,
					nextActions: [
						"用 sandbox_list 查看沙箱实际结构",
						"确认创建文件时用的是绝对路径 $env:SANDBOX_ROOT\\... ",
						"export 的 source 用相对沙箱根的路径（如 finance-doc\\recite.docx）",
					],
				});
			}
			// Implement the boundary write as a PowerShell copy so an approved
			// confirmation re-runs it via the standard runDesktopAction path.
			const copyScript =
				`Copy-Item -LiteralPath '${escapePsString(src)}' -Destination '${escapePsString(params.destination)}' -Recurse -Force; ` +
				`Write-Output 'Exported to ${escapePsString(params.destination)}'`;
			const gate = gateAction(sandboxEnvFor(options), {
				toolName: "sandbox_export",
				kind: "file_write",
				lane: "real",
				intent: "Export from sandbox",
				action: "powershell",
				target: copyScript,
				command: copyScript,
				writePathsRaw: [params.destination],
				riskText: `Export sandbox artifact to ${params.destination}`,
			});
			if (gate.blocked) {
				return { content: [{ type: "text", text: JSON.stringify(gate.blocked) }], details: gate.blocked };
			}
			try {
				const out = await options.host.runPowerShell(copyScript, sandboxRunOptions(options, "real"));
				return sandboxToolResult({
					intent: "Export from sandbox",
					action: "sandbox_export",
					target: params.destination,
					status: out.stderr ? "failed" : "succeeded",
					stdout: out.stdout,
					stderr: out.stderr || undefined,
				});
			} catch (error) {
				return sandboxToolResult({
					intent: "Export from sandbox",
					action: "sandbox_export",
					target: params.destination,
					status: "failed",
					stderr: error instanceof Error ? error.message : String(error),
				});
			}
		},
	});
}
