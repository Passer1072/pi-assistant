export const AUTOMATION_PERMISSION_MODES = ["tiered", "automatic", "sandbox", "full_access"] as const;

export type AutomationRiskLevel = "low" | "medium" | "high";
export type AutomationStatus = "pending" | "running" | "succeeded" | "blocked" | "failed" | "timeout";
export type AutomationPermissionMode = (typeof AUTOMATION_PERMISSION_MODES)[number];
export type AutomationConfidence = "low" | "medium" | "high";
export type ApiConnectionMode = "official" | "relay";
export type MediaCommand = "play" | "pause" | "toggle" | "next" | "previous";
export interface DesktopRectangle {
	x: number;
	y: number;
	width: number;
	height: number;
}
export interface WindowInfo {
	title: string;
	processName?: string;
	bounds?: DesktopRectangle;
	isActive?: boolean;
}
export type VoiceState =
	| "idle"
	| "requesting-microphone"
	| "wake-listening"
	| "awaiting-speech"
	| "recording"
	| "transcribing"
	| "speaking"
	| "error"
	| "unavailable";
export type DesktopCapabilityId = "system" | "document" | "ppt" | "excel";

export type DesktopAssistantProvider = "deepseek" | "openai" | "anthropic" | "custom" | string;

export type WebSearchMode = "off" | "auto" | "on";
export type WebSearchProvider = "duckduckgo" | "bing" | "google" | "serper" | "searxng" | "tavily" | "brave";
export type WindowMode = "compact" | "expanded";

export type McpTransport = "stdio" | "http";
export type McpServerState = "disabled" | "disconnected" | "connecting" | "connected" | "error";

export interface WebSearchSettings {
	/** off = disabled; auto = AI decides; on = always search for factual queries */
	mode: WebSearchMode;
	/** Which search backend to use. Default: "duckduckgo" (free, no key). */
	provider: WebSearchProvider;
	/**
	 * API key for the selected provider:
	 * - Bing: Ocp-Apim-Subscription-Key (Azure Cognitive Services)
	 * - Google: Cloud Console API key
	 * - Serper: serper.dev API key
	 * - Tavily: tvly-xxx key from app.tavily.com (1000 queries/month free)
	 * - Brave: BSA-xxx key from brave.com/search/api (2000 queries/month free)
	 * Not used by duckduckgo or searxng.
	 */
	apiKey?: string;
	/** Google only: Programmable Search Engine ID (cx). */
	googleCx?: string;
	/** SearXNG only: base URL of your self-hosted instance, e.g. https://searx.example.com */
	searxngUrl?: string;
}

export interface McpServerConfig {
	id: string;
	name: string;
	enabled: boolean;
	transport: McpTransport;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	timeoutMs?: number;
	toolNamePrefix?: string;
	description?: string;
	builtIn?: boolean;
}

export interface McpSettings {
	enabled: boolean;
	servers: McpServerConfig[];
}

export interface TokenSavingSettings {
	enabled: boolean;
}

export interface AutoTitleSettings {
	enabled: boolean;
}

export interface HomeWelcomeSettings {
	/** Generate the home greeting with the model (off → static fallback greeting). */
	enabled: boolean;
	/** Best-effort weather glance; requires a WeatherAPI.com API key. */
	includeWeather: boolean;
	/** WeatherAPI.com key (https://www.weatherapi.com/). When absent, weather is skipped. */
	weatherApiKey?: string;
	/** Best-effort unread glance, only when the email app is already running. */
	includeEmail: boolean;
}

/** User-tunable persona/locale, injected into the main chat system prompt and home greeting. */
export interface PersonalizationSettings {
	/** Master switch — off keeps the default 「小派」 persona untouched. */
	enabled: boolean;
	/** Speaking tone: a preset label (e.g. 「友好亲切」) or free-form custom text. */
	tone?: string;
	/** Role/character the assistant plays, e.g. 「资深程序员」「贴心助理」. */
	rolePlay?: string;
	/** How the assistant addresses the user, e.g. 「主人」「老板」 or a name. */
	userAddressing?: string;
	/** Whether the user's location is typed in or auto-detected from WeatherAPI auto:ip. */
	locationMode: "manual" | "auto";
	/** Manually entered location (used when locationMode === "manual"). */
	manualLocation?: string;
}

/**
 * Opt-in experimental features. Each flag is off by default. Kept as a nested
 * object so new experiments can be added without touching the top-level settings
 * shape (mirrors how {@link DEFAULT_DESKTOP_ASSISTANT_SETTINGS} groups others).
 */
export interface ExperimentalSettings {
	/**
	 * "模型自动总结改进方案"：开启后，模型在某一轮里调用工具遇到真实困难
	 * （工具调用失败，或工具成功但返回内容含报错）时，会在答完该轮后自动做一次
	 * 流程回顾自我总结，并通过 memo_create 记成一条备忘录，便于交给 Claude/ChatGPT 分析修复。
	 */
	errorSelfSummary: { enabled: boolean };
	/**
	 * "实时流程化"：开启后，模型在普通会话收到多步骤、有明确执行步骤的任务时，
	 * 先用 flow_plan 设计一张流程图（不确定时先调研清楚再画），用右下角可拖动/可折叠
	 * 的浮窗展示，再照流程图逐步执行（每步 flow_step done 的结果会回传下一步），
	 * 中途遇到问题就 flow_plan 重画反映方案后继续。
	 */
	liveFlow: { enabled: boolean };
}

export type BrowserTarget = "built_in" | "chrome" | "edge";
export type BrowserStorageClearScope = "cookies" | "cache" | "site_data" | "all";

/**
 * Which browser control surface the AI uses:
 * - built_in: only the built-in browser_* tools (external browser-control MCP suppressed)
 * - external: the external browser-control MCP (controls the user's native Chrome/Edge); built-in browser_* off
 * - auto: both surfaces available; the model decides
 */
export type AiBrowserPreference = "built_in" | "external" | "auto";

/**
 * Which Office control surface the AI uses:
 * - live: Office add-in MCP tools edit the currently open visible document
 * - file: file/COM tools operate on closed files or hidden Office instances
 * - auto: both surfaces are available; the model chooses one
 */
export type AiOfficePreference = "live" | "file" | "auto";

/** A user-defined quick-launch button on the built-in browser home page. */
export interface BrowserShortcut {
	id: string;
	label: string;
	url: string;
	iconUrl?: string;
}

/** One recently visited page, surfaced as a quick link on the home page. */
export interface BrowserHistoryEntry {
	url: string;
	title: string;
	faviconUrl?: string;
	ts: number;
}

export interface BrowserSettings {
	defaultBrowser: BrowserTarget;
	allowAiControl: boolean;
	/** Which browser control surface the AI prefers: built-in tools, external MCP, or auto. */
	aiBrowserPreference: AiBrowserPreference;
	homeUrl: string;
	maxTabs: number;
	persistStorage: true;
	/** Quick-launch buttons shown on the built-in browser home page. */
	shortcuts: BrowserShortcut[];
	/** Search URL template with a "%s" placeholder for omnibox/home-page searches. */
	searchTemplate: string;
}

export interface OfficeSettings {
	aiOfficePreference: AiOfficePreference;
}

export interface BrowserTabView {
	id: string;
	title: string;
	url: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	active: boolean;
	faviconUrl?: string;
	error?: string;
	/** True when this tab shows the custom home page instead of a loaded web page. */
	homePage?: boolean;
}

export interface BrowserConsoleEntry {
	id: string;
	ts: number;
	level: "debug" | "info" | "warning" | "error";
	message: string;
	source?: string;
	lineNumber?: number;
	tabId?: string;
}

export interface BrowserNetworkEntry {
	id: string;
	ts: number;
	tabId?: string;
	method?: string;
	url: string;
	resourceType?: string;
	statusCode?: number;
	statusLine?: string;
	fromCache?: boolean;
	error?: string;
}

export interface BrowserNativeAppStatus {
	target: Extract<BrowserTarget, "chrome" | "edge">;
	label: string;
	executablePath?: string;
	profilePath: string;
	available: boolean;
	aiProfileRunning: boolean;
	lastError?: string;
}

export interface BrowserNativeStatus {
	chrome: BrowserNativeAppStatus;
	edge: BrowserNativeAppStatus;
}

export interface BuiltInBrowserStatus {
	tabs: BrowserTabView[];
	activeTabId?: string;
	profilePath: string;
	profileSizeBytes: number;
	maxTabs: number;
	aiControlEnabled: boolean;
	native: BrowserNativeStatus;
	/** Most-recent distinct sites for the home page "recent" section. */
	recent: BrowserHistoryEntry[];
}

export interface OpenBuiltInBrowserRequest {
	url?: string;
}

export interface OpenUrlInDefaultBrowserRequest {
	url: string;
	browser?: BrowserTarget;
}

/** Request to act on a produced output file (open / reveal / copy). */
export interface FilePathRequest {
	path: string;
}

export interface FileActionResponse {
	ok: boolean;
	/** Present when ok is false. */
	error?: string;
}

export interface BrowserNavigateRequest {
	tabId?: string;
	url: string;
}

export interface BrowserTabRequest {
	tabId?: string;
}

export interface BrowserSetBoundsRequest {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface BrowserClearStorageRequest {
	scope: BrowserStorageClearScope;
}

export interface BrowserClearStorageResponse {
	ok: boolean;
	scope: BrowserStorageClearScope;
	profilePath: string;
	profileSizeBytes: number;
}

export interface BrowserReadPageRequest {
	tabId?: string;
	includeHtml?: boolean;
	includeSource?: boolean;
	includeElements?: boolean;
	includeNetwork?: boolean;
	includeConsole?: boolean;
	maxChars?: number;
}

export interface BrowserElementSnapshot {
	index: number;
	tagName: string;
	text: string;
	selector: string;
	visible: boolean;
	disabled: boolean;
	checked?: boolean;
	role?: string;
	ariaLabel?: string;
	placeholder?: string;
	href?: string;
	value?: string;
	bounds?: DesktopRectangle;
}

export interface BrowserPageSnapshot {
	tab: BrowserTabView;
	title: string;
	url: string;
	text: string;
	html?: string;
	source?: string;
	elements?: BrowserElementSnapshot[];
	console?: BrowserConsoleEntry[];
	network?: BrowserNetworkEntry[];
	truncated: boolean;
}

export interface BrowserQueryElementsRequest {
	tabId?: string;
	selector?: string;
	text?: string;
	limit?: number;
}

export interface BrowserElementActionRequest {
	tabId?: string;
	selector?: string;
	elementIndex?: number;
	text?: string;
	clearFirst?: boolean;
}

export interface BrowserKeyRequest {
	tabId?: string;
	key: string;
}

export interface BrowserScrollRequest {
	tabId?: string;
	x?: number;
	y?: number;
}

export interface BrowserScreenshotRequest {
	tabId?: string;
}

export interface BrowserScreenshotResponse {
	tabId: string;
	dataUrl: string;
	width: number;
	height: number;
}

export interface BrowserCookieRequest {
	tabId?: string;
	url?: string;
}

export interface BrowserCookieView {
	name: string;
	value: string;
	domain?: string;
	path?: string;
	secure?: boolean;
	httpOnly?: boolean;
	session?: boolean;
	expirationDate?: number;
}

export interface BrowserVirtualMouseRequest {
	tabId?: string;
	x: number;
	y: number;
	action?: "move" | "click" | "down" | "up" | "double_click";
	button?: "left" | "middle" | "right";
}

export interface BuiltInBrowserEvent {
	type: "status";
	status: BuiltInBrowserStatus;
}

// ── More Apps (integrated external local web apps) ────────────────────────────
// Each "app" is a local web service (Flask / FastAPI …) that the assistant
// spawns as a child process and shows in its own window, and that the AI drives
// over HTTP. See main/external-app-controller.ts and agent/app-bridge-tools.ts.

/** Lifecycle status of an integrated external app. */
export type ExternalAppStatus = "stopped" | "starting" | "running" | "error";

/** AI-bridge config: how the agent reaches an app's HTTP API. */
export interface ExternalAppAiConfig {
	/** Base path prefixed to bridge calls, e.g. "/api/v1". */
	basePath: string;
	/** Allowed path prefixes (relative to the app root) the generic app_call may hit. */
	allowPrefixes: string[];
}

/**
 * Declarative manifest describing how to launch & reach an external local web app.
 * The literal token "{port}" inside args / env values / urlPattern is replaced
 * with the resolved port at launch time.
 */
export interface ExternalAppManifest {
	id: string;
	name: string;
	description?: string;
	/** Icon: an emoji or a packaged-asset / data / file URL. */
	icon: string;
	/** Working directory for the spawned process. */
	cwd: string;
	/** Executable to spawn (absolute path or a command on PATH). */
	command: string;
	args: string[];
	env?: Record<string, string>;
	/** Fixed port; when omitted a free port is allocated at start. */
	port?: number;
	/** URL loaded in the app window, e.g. "http://127.0.0.1:{port}/". */
	urlPattern: string;
	/** Path probed for readiness (expects a response). Defaults to "/". */
	healthPath: string;
	/** Auto-start this app when the assistant launches. */
	autoStart: boolean;
	/** Stop the app after this many minutes of inactivity (0 / undefined = disabled). */
	idleTimeoutMinutes?: number;
	/** Shipped manifest (true) vs user-added (false/undefined). */
	builtIn?: boolean;
	/** Present when the app exposes an AI-callable HTTP API. */
	ai?: ExternalAppAiConfig;
}

/** User-editable per-app overrides, persisted to agentDir/more-apps.json. */
export interface ExternalAppConfig {
	autoStart?: boolean;
	port?: number;
	/** Stop after this many minutes of inactivity (0 = disabled). */
	idleTimeoutMinutes?: number;
	/** Advanced overrides. */
	command?: string;
	args?: string[];
	env?: Record<string, string>;
}

/** Renderer-facing runtime view of an external app. */
export interface MoreAppView {
	id: string;
	name: string;
	description?: string;
	icon: string;
	status: ExternalAppStatus;
	autoStart: boolean;
	builtIn: boolean;
	/** Resolved port once running. */
	port?: number;
	/** URL currently served once running. */
	url?: string;
	/** Whether the app's window is currently open. */
	windowOpen: boolean;
	/** Last error message when status === "error". */
	error?: string;
	/** Whether AI tools are wired for this app (manifest has `ai`). */
	aiEnabled: boolean;
	/** The launch command line, shown read-only in settings. */
	commandLine: string;
	/** Minutes of inactivity before auto-close (0 / undefined = disabled). */
	idleTimeoutMinutes?: number;
}

/** A single captured line of an app's child-process terminal output. */
export interface MoreAppTerminalLine {
	/** Monotonic sequence id, for incremental terminal updates. */
	seq: number;
	stream: "stdout" | "stderr" | "system";
	text: string;
	at: number;
}

export type MoreAppEvent =
	| { type: "status"; apps: MoreAppView[] }
	| { type: "terminal"; appId: string; line: MoreAppTerminalLine };

export interface MoreAppActionRequest {
	appId: string;
}

export interface UpdateMoreAppConfigRequest {
	appId: string;
	config: ExternalAppConfig;
}

export interface OpenMoreAppAtPathRequest {
	appId: string;
	/** Sub-path within the app, e.g. "/books/abc123/read". */
	path: string;
}

export interface MoreAppTerminalResponse {
	appId: string;
	lines: MoreAppTerminalLine[];
}

// ── Sandbox ──────────────────────────────────────────────────────────────────
// A lightweight-but-real isolation layer. "Miscellaneous" intermediate work
// (document processing, scratch files, exploratory commands) runs confined to a
// sandbox workspace; only finished artifacts cross the sandbox→real boundary,
// where they tie into the permission/approval flow. See policy-engine.ts.

export const SANDBOX_PRESET_IDS = ["strict", "balanced", "permissive", "custom"] as const;
export type SandboxPresetId = (typeof SANDBOX_PRESET_IDS)[number];

/** Where a tool action is asked to run. Real actions cross the sandbox boundary. */
export type SandboxLane = "sandbox" | "real";
/** Per-tool override of the engine decision. */
export type SandboxToolGate = "allow" | "confirm" | "deny";
export type SandboxScope = "global" | "per_session";
export type SandboxOverQuotaPolicy = "deny_writes" | "auto_clean" | "confirm";

export interface SandboxWorkspaceSettings {
	/** Sandbox storage location. Path tokens (e.g. <appdata>) resolved at runtime; default userData/sandbox. */
	rootDir?: string;
	scope: SandboxScope;
	/** Storage quota in MB. */
	quotaMb: number;
	/** Usage percentage that triggers a cleanup hint to the AI/user. */
	warnAtPercent: number;
	overQuotaPolicy: SandboxOverQuotaPolicy;
	cleanOnSessionEnd: boolean;
	autoInitOnStartup: boolean;
	keepWarmProcess: boolean;
}

export interface SandboxFilesystemSettings {
	/** Roots the real lane may write into (path tokens allowed). */
	writeRoots: string[];
	/** Roots that may be read from (path tokens allowed). */
	readRoots: string[];
	/** Always-denied roots (System32, Program Files, app resources, credential dirs). */
	protectedPaths: string[];
	/** true → writes outside writeRoots are denied; false → they require confirmation. */
	confineWritesToRoots: boolean;
	/** Deny paths whose canonical form escapes an allowed root via symlink/junction. */
	denySymlinkEscape: boolean;
}

export interface SandboxCommandSettings {
	/** Regex source strings (matched case-insensitively) that are always denied. */
	denyPatterns: string[];
	/** Regex source strings that mark a command as safe (may run in sandbox lane unattended). */
	allowPatterns: string[];
	/** Block download-to-disk cmdlets (Invoke-WebRequest/curl/wget/bitsadmin). */
	blockNetworkDownload: boolean;
}

export interface SandboxNetworkSettings {
	domainAllowList: string[];
	domainDenyList: string[];
	/** SSRF guard: deny fetch to localhost / RFC1918 / link-local / 169.254.169.254. */
	blockPrivateIps: boolean;
}

export interface SandboxResourceLimits {
	commandTimeoutMs: number;
	maxOutputChars: number;
	maxConcurrentProcesses: number;
	/** On timeout/abort, kill the whole process tree (taskkill /T). */
	killProcessTree: boolean;
}

export interface SandboxHardeningSettings {
	/** Opt-in: run sandbox-lane commands as a restricted local user with NTFS write only to the sandbox root. */
	runAsRestrictedUser: boolean;
}

export interface SandboxAuditSettings {
	logDecisions: boolean;
}

export interface SandboxSettings {
	/** Master switch. false → fully legacy behaviour (no sandbox, mode-only confirmation). */
	enabled: boolean;
	preset: SandboxPresetId;
	workspace: SandboxWorkspaceSettings;
	filesystem: SandboxFilesystemSettings;
	commands: SandboxCommandSettings;
	network: SandboxNetworkSettings;
	/** Per-tool-name override of the computed decision. */
	toolGates: Record<string, SandboxToolGate>;
	resourceLimits: SandboxResourceLimits;
	hardening: SandboxHardeningSettings;
	audit: SandboxAuditSettings;
	/** The AI may only tighten the sandbox via its own tools; loosening is user-only. */
	aiMayEdit: "tighten_only";
}

export type SandboxPhase = "uninitialized" | "initializing" | "ready" | "failed" | "stuck";

/** Live lifecycle state of the sandbox workspace, surfaced on the snapshot + init popup. */
export interface SandboxStatus {
	phase: SandboxPhase;
	/** 0..100 during initialization. */
	progress: number;
	/** Human-readable current step (e.g. "校验可写"). */
	currentStep: string;
	rootDir?: string;
	usageMb: number;
	quotaMb: number;
	lastError?: string;
	/** Number of init attempts so far (drives the "stuck" escalation). */
	attempts: number;
	updatedAt: number;
}

export interface DeepSeekRelayModelOption {
	id: string;
	label?: string;
	ownedBy?: string;
	supportedEndpointTypes?: string[];
}

export type SoftwarePluginStatus = "not_installed" | "needs_host" | "installed" | "error";

export interface SoftwarePluginValidationRule {
	type: "files_exist";
	paths: string[];
}

export interface SoftwarePluginInstallStep {
	id: string;
	title: string;
	description: string;
	manual?: boolean;
}

export type SoftwarePluginOperation = "install" | "uninstall";
export type SoftwarePluginOperationStatus = "running" | "succeeded" | "failed";
export type SoftwarePluginOperationStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface SoftwarePluginOperationStep {
	id: string;
	title: string;
	description: string;
	status: SoftwarePluginOperationStepStatus;
	detail?: string;
}

export interface SoftwarePluginOperationProgress {
	pluginId: string;
	operation: SoftwarePluginOperation;
	status: SoftwarePluginOperationStatus;
	steps: SoftwarePluginOperationStep[];
	currentStepId?: string;
	message?: string;
}

export interface SoftwarePluginMcpTemplate {
	serverId: string;
	name: string;
	toolNamePrefix: string;
	description: string;
}

export interface SoftwarePluginDefinition {
	id: string;
	name: string;
	description: string;
	targetSoftware: {
		id: string;
		name: string;
		platform: "windows";
		suggestedPaths: string[];
	};
	validationRules: SoftwarePluginValidationRule[];
	installSteps: SoftwarePluginInstallStep[];
	mcpTemplate: SoftwarePluginMcpTemplate;
}

export interface SoftwarePluginTargetValidation {
	pluginId: string;
	targetPath: string;
	valid: boolean;
	missingFiles: string[];
	softwareVersion?: string;
	summary: string[];
	requiresHost: boolean;
	hostDetected: boolean;
	hostPath?: string;
	hostLoaderDetected?: boolean;
	autoHostInstallSupported: boolean;
	autoHostInstallBlockReason?: string;
	hostInstallHints?: string[];
	warnings: string[];
}

export interface InstalledSoftwarePlugin {
	pluginId: string;
	status: SoftwarePluginStatus;
	targetPath: string;
	softwareVersion?: string;
	bridgeUrl?: string;
	token?: string;
	hostPath?: string;
	certThumbprint?: string;
	registryValueName?: string;
	manifestId?: string;
	officeChatBridgeUrl?: string;
	officeChatBridgeToken?: string;
	installedFiles: string[];
	mcpServerId?: string;
	installedAt: string;
	updatedAt: string;
	lastError?: string;
}

export interface SoftwarePluginListItem {
	definition: SoftwarePluginDefinition;
	installed?: InstalledSoftwarePlugin;
}

export interface SoftwarePluginListResponse {
	plugins: SoftwarePluginListItem[];
}

export interface ValidateSoftwarePluginTargetRequest {
	pluginId: string;
	targetPath: string;
}

export interface InstallSoftwarePluginRequest {
	pluginId: string;
	targetPath: string;
	bridgePort?: number;
}

export interface InstallSoftwarePluginResponse {
	plugin: InstalledSoftwarePlugin;
	validation: SoftwarePluginTargetValidation;
	mcpServer: McpServerConfig;
	steps: SoftwarePluginOperationStep[];
	message: string;
}

export interface UninstallSoftwarePluginRequest {
	pluginId: string;
}

export interface UninstallSoftwarePluginResponse {
	pluginId: string;
	removedFiles: string[];
	mcpServerId?: string;
	steps: SoftwarePluginOperationStep[];
	message: string;
}

export interface TestSoftwarePluginBridgeRequest {
	pluginId: string;
}

export interface TestSoftwarePluginBridgeResponse {
	pluginId: string;
	ok: boolean;
	bridgeUrl?: string;
	statusCode?: number;
	message: string;
	sample?: unknown;
}

/** A self-evolving "forged" tool that an AI added at runtime via the forge framework. */
export interface ForgeExtensionView {
	appId: string;
	name: string;
	description: string;
	jsBody: string;
	trusted: boolean;
	origin: string;
	createdBy?: string;
	createdAt?: string;
	notes?: string;
	inputSchema?: Record<string, { type: string; required?: boolean; description?: string }>;
}

export interface ListForgeExtensionsResponse {
	extensions: ForgeExtensionView[];
}

export interface SetForgeExtensionTrustRequest {
	appId: string;
	name: string;
	trusted: boolean;
}

export interface DeleteForgeExtensionRequest {
	appId: string;
	name: string;
}

export interface ForgeExtensionMutationResponse {
	ok: boolean;
	extensions: ForgeExtensionView[];
}

export interface McpToolView {
	name: string;
	originalName: string;
	title?: string;
	description?: string;
}

export interface McpResourceView {
	uri: string;
	name?: string;
	title?: string;
	description?: string;
	mimeType?: string;
}

export interface McpPromptView {
	name: string;
	title?: string;
	description?: string;
}

export interface McpServerStatus {
	id: string;
	name: string;
	enabled: boolean;
	builtIn: boolean;
	state: McpServerState;
	toolCount: number;
	resourceCount: number;
	promptCount: number;
	lastError?: string;
	tools: McpToolView[];
	resources: McpResourceView[];
	prompts: McpPromptView[];
}

export type VoiceSttProvider = "openai" | "siliconflow" | "groq" | "custom";

export const DEFAULT_VOICE_STT_BASE_URL_BY_PROVIDER: Record<VoiceSttProvider, string> = {
	openai: "https://api.openai.com/v1",
	siliconflow: "https://api.siliconflow.cn/v1",
	groq: "https://api.groq.com/openai/v1",
	custom: "",
};

export const DEFAULT_VOICE_STT_MODEL_BY_PROVIDER: Record<VoiceSttProvider, string> = {
	openai: "whisper-1",
	siliconflow: "whisper-1",
	groq: "whisper-large-v3-turbo",
	custom: "whisper-1",
};

export interface VoiceSettings {
	enabled: boolean;
	wakeWordEnabled: boolean;
	wakeWord: string;
	fuzzyThreshold: number;
	language: string;
	postWakeWaitMs: number;
	endSilenceMs: number;
	sttProvider: VoiceSttProvider;
	sttBaseUrl?: string;
	sttModel: string;
	sttApiKey?: string;
	wakeModelUrl?: string;
	/**
	 * Wake word backend. "kws" (default) uses the native sherpa-onnx keyword spotter;
	 * "auto" also prefers it. Both fall back to Vosk, then the browser recognizer.
	 */
	wakeEngine?: "kws" | "auto" | "openwakeword" | "vosk";
	/** sherpa-onnx KWS sensitivity (0..1; higher is easier to wake). */
	kwsSensitivity?: number;
	/** Advanced: raw sherpa-onnx keywords-file content (model tokens) overriding the wake word. */
	kwsKeywords?: string;
	/** URL of the openWakeWord classifier model (e.g. the trained "小派" model). Relative URLs resolve against the renderer. */
	owwModelUrl?: string;
	/** ID of a user-imported openWakeWord classifier model stored under Electron userData. */
	activeOwwModelId?: string;
	/** Activation probability (0..1) above which openWakeWord fires. */
	owwThreshold?: number;
}

export interface DesktopAssistantSettings {
	provider: DesktopAssistantProvider;
	apiConnectionMode: ApiConnectionMode;
	modelId: string;
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	permissionMode: AutomationPermissionMode;
	capabilities: Record<DesktopCapabilityId, DesktopCapabilitySettings>;
	webSearch: WebSearchSettings;
	browser: BrowserSettings;
	office: OfficeSettings;
	mcp: McpSettings;
	voice: VoiceSettings;
	memory: MemorySettings;
	tokenSaving: TokenSavingSettings;
	autoTitle: AutoTitleSettings;
	homeWelcome: HomeWelcomeSettings;
	personalization: PersonalizationSettings;
	experimental: ExperimentalSettings;
	sandbox: SandboxSettings;
	/** @deprecated use voice.wakeWord. */
	wakeWord: string;
	/** @deprecated use voice.language. */
	voiceLanguage: string;
	/** @deprecated kept for playback setting compatibility. */
	ttsEnabled: boolean;
	/** Relay/custom OpenAI-compatible base URL. DeepSeek relay mode normalizes this to a /v1 base URL. */
	apiBaseUrl?: string;
	/** Model IDs discovered from the selected relay provider's OpenAI-compatible /models endpoint. */
	deepseekRelayModels?: DeepSeekRelayModelOption[];
	customModelId?: string;
}

export interface DesktopCapabilitySettings {
	enabled: boolean;
	commandFirst: boolean;
	skillName: string;
}

export interface MemorySettings {
	enabled: boolean;
	maxInjected: number;
	autoExtract: boolean;
	allowExternalContextExtraction: boolean;
	allowAssistantDerivedFacts: boolean;
}

export type GlobalMemoryKind = "preference" | "profile" | "project" | "task" | "correction" | "fact";
export type GlobalMemoryScope = "user" | "workspace";
export type GlobalMemorySource = "explicit" | "auto" | "manual";

export interface GlobalMemoryEntry {
	schemaVersion: 2;
	id: string;
	kind: GlobalMemoryKind;
	scope: GlobalMemoryScope;
	source: GlobalMemorySource;
	text: string;
	confidence: number;
	reason?: string;
	sourceSessionId?: string;
	createdAt: string;
	updatedAt: string;
	lastUsedAt?: string;
	useCount: number;
	tags: string[];
	archived: boolean;
}

export interface DesktopAuthStatus {
	configured: boolean;
	source?: string;
	needsRotationWarning: boolean;
}

export interface ApiKeyValidationStatus {
	state: "idle" | "validating" | "valid" | "invalid";
	code?: "cleared" | "validating" | "valid" | "invalid";
	message?: string;
	detail?: string;
}

export interface DesktopToolResult {
	stepId: string;
	intent: string;
	action: string;
	target: string;
	status: AutomationStatus;
	stdout?: string;
	stderr?: string;
	riskLevel: AutomationRiskLevel;
	requiresConfirmation: boolean;
	/** Present when status is "timeout". Used by shell_command_continue / shell_command_abort. */
	executionId?: string;
	observedState?: unknown;
	confidence?: AutomationConfidence;
	nextActions?: string[];
}

export type DocumentBackend = "word";
export type DocumentBlockKind = "paragraph" | "heading" | "table" | "list" | "cell" | "header" | "footer";
export type DocumentRiskFlag =
	| "file_locked"
	| "readonly"
	| "save_conflict"
	| "word_unavailable"
	| "word_busy"
	| "path_slow_or_remote"
	| "selector_not_found"
	| "unsupported_extension"
	| "verification_failed";

export interface DocumentSelector {
	blockId?: string;
	kind?: DocumentBlockKind;
	textIncludes?: string;
	textEquals?: string;
	occurrence?: number;
	tableId?: string;
	row?: number;
	col?: number;
}

export interface DocumentBlock {
	blockId: string;
	kind: DocumentBlockKind;
	text: string;
	styleName: string;
	index: number;
	tableId?: string;
	row?: number;
	col?: number;
}

export interface DocumentTableCell {
	blockId: string;
	tableId?: string;
	row: number;
	col: number;
	text: string;
	address?: string;
	rowSpan?: number;
	colSpan?: number;
	merged?: boolean;
}

export interface DocumentTable {
	tableId: string;
	index: number;
	rows: number;
	cols: number;
	cells: DocumentTableCell[];
}

export interface DocumentHeaderFooter {
	blockId: string;
	kind: "header" | "footer";
	sectionIndex: number;
	variant: string;
	text: string;
}

export interface DocumentTextSpan {
	blockId: string;
	start: number;
	end: number;
	text: string;
}

/** Detailed character/paragraph formatting for one block, returned on demand by doc_inspect. */
export interface DocumentBlockFormat {
	blockId: string;
	font: {
		name: string;
		size: number;
		bold: boolean;
		italic: boolean;
		underline: boolean;
		/** Word color value (BGR long, or -1 for "automatic"). */
		color: string;
	};
	paragraph: {
		alignment: string;
		leftIndent: number;
		firstLineIndent: number;
		spaceBefore: number;
		spaceAfter: number;
		lineSpacing: number;
	};
	/** Cell shading (BackgroundPatternColor), present for table cells. */
	shading?: string;
}

export interface DocumentInspectionResult {
	backend: DocumentBackend;
	documentKind: string;
	blocks: DocumentBlock[];
	tables: DocumentTable[];
	headersFooters: DocumentHeaderFooter[];
	textSpans: DocumentTextSpan[];
	/** Full formatting for the blocks requested via doc_inspect's formatForBlockIds. */
	formats?: DocumentBlockFormat[];
	warnings: DocumentRiskFlag[];
}

export interface DocumentReplaceTextOperation {
	type: "replace_text";
	selector: DocumentSelector;
	findText: string;
	replaceText: string;
}

export interface DocumentInsertAfterBlockOperation {
	type: "insert_after_block";
	selector: DocumentSelector;
	text: string;
}

export interface DocumentInsertBeforeBlockOperation {
	type: "insert_before_block";
	selector: DocumentSelector;
	text: string;
}

export interface DocumentSetBlockTextOperation {
	type: "set_block_text";
	selector: DocumentSelector;
	text: string;
}

export interface DocumentAppendToBlockOperation {
	type: "append_to_block";
	selector: DocumentSelector;
	text: string;
}

export interface DocumentUpdateTableCellOperation {
	type: "update_table_cell";
	selector: DocumentSelector;
	text: string;
}

export interface DocumentDeleteBlockOperation {
	type: "delete_block";
	selector: DocumentSelector;
}

export type DocumentEditOperation =
	| DocumentReplaceTextOperation
	| DocumentInsertAfterBlockOperation
	| DocumentInsertBeforeBlockOperation
	| DocumentSetBlockTextOperation
	| DocumentAppendToBlockOperation
	| DocumentUpdateTableCellOperation
	| DocumentDeleteBlockOperation;

export interface DocumentApplyOperationResult {
	type: DocumentEditOperation["type"];
	selector: DocumentSelector;
	blockId?: string;
	reason?: string;
	text?: string;
}

export interface DocumentApplyResult {
	applied: DocumentApplyOperationResult[];
	skipped: DocumentApplyOperationResult[];
	savePath: string;
	verificationHints: string[];
	warnings: DocumentRiskFlag[];
}

export interface DocumentVerifyTextExistsCheck {
	type: "text_exists";
	text: string;
}

export interface DocumentVerifyTextNotExistsCheck {
	type: "text_not_exists";
	text: string;
}

export interface DocumentVerifyBlockTextEqualsCheck {
	type: "block_text_equals";
	selector: DocumentSelector;
	expectedText: string;
}

export interface DocumentVerifyTableCellEqualsCheck {
	type: "table_cell_equals";
	selector: DocumentSelector;
	expectedText: string;
}

export type DocumentVerifyCheck =
	| DocumentVerifyTextExistsCheck
	| DocumentVerifyTextNotExistsCheck
	| DocumentVerifyBlockTextEqualsCheck
	| DocumentVerifyTableCellEqualsCheck;

export interface DocumentVerifyCheckResult {
	type: DocumentVerifyCheck["type"];
	passed: boolean;
	reason?: string;
}

export interface DocumentVerifyResult {
	passed: boolean;
	checks: DocumentVerifyCheckResult[];
	warnings: DocumentRiskFlag[];
}

export interface PendingConfirmation {
	id: string;
	intent: string;
	action: string;
	target: string;
	riskLevel: AutomationRiskLevel;
	createdAt: number;
}

export interface TimelineItem {
	id: string;
	kind:
		| "agent"
		| "assistant"
		| "thinking_summary"
		| "thinking"
		| "tool"
		| "confirmation"
		| "voice"
		| "retry"
		| "error"
		| "compaction"
		| "artifact"
		| "flowchart";
	title: string;
	detail?: string;
	status: AutomationStatus;
	timestamp: number;
	order: number;
	toolCallId?: string;
	/** Present on `artifact` items: the output files this tool step produced. */
	artifacts?: FileArtifact[];
	/** Present on `flowchart` items: the automation flow graph + live run progress. */
	flowGraph?: FlowGraphTimelineData;
}

/**
 * Payload for a `flowchart` timeline item: a snapshot of an automation flow's
 * graph plus its live execution progress. Rendered as a pinned flowchart panel
 * at the top of the automation conversation (reuses the editor's FlowGraphPreview).
 * The single item is updated in place by id as the run progresses, so its final
 * state is archived with the conversation and replays correctly from history.
 */
export interface FlowGraphTimelineData {
	flowId: string;
	runId: string;
	name: string;
	nodes: FlowNode[];
	edges: FlowEdge[];
	/** Node currently executing (blue highlight), if any. */
	activeNodeId?: string;
	/** Nodes that have finished (green highlight + green traversed edges). */
	doneNodeIds: string[];
	status: AutomationRunStatus;
}

/**
 * Live-flow working state for the "实时流程化" experiment: a flowchart the model
 * designs on the fly in a NORMAL chat and executes step-by-step. Carried on the
 * session snapshot (NOT a timeline item — kept separate from automation's pinned
 * panel) and rendered in a draggable/collapsible floating window. Ephemeral working
 * state for the active session only; not archived.
 */
export interface LiveFlowSnapshot {
	title: string;
	nodes: FlowNode[];
	edges: FlowEdge[];
	/** Node currently executing (blue highlight), if any. */
	activeNodeId?: string;
	/** Nodes that have finished (green highlight + green traversed edges). */
	doneNodeIds: string[];
	/** Nodes added by the most recent re-plan/revision (amber "新增" highlight). */
	freshNodeIds?: string[];
	status: AutomationRunStatus;
	/** Short caption for the step in progress / next step, shown in the window footer. */
	currentStep?: string;
	updatedAt: number;
}

/**
 * A file (or folder) the assistant produced as the result of a tool step.
 * Surfaced in the conversation as an interactive shortcut card: left-click opens
 * it, right-click offers open / reveal-in-folder / copy-file / copy-path. Derived
 * (not separately stored) from tool results both live and on history reload, so
 * the path is always validated against disk before a card is shown.
 */
export interface FileArtifact {
	/** Canonical absolute path on disk. */
	path: string;
	/** Base name including extension, e.g. "图片转excel输出表.xlsx". */
	name: string;
	/** Lower-case extension without the dot ("xlsx"), or "" for folders/extensionless files. */
	ext: string;
	/** File size in bytes (0 for folders). */
	sizeBytes: number;
	/** Last-modified time (epoch ms). */
	modifiedAt: number;
	/** Whether the entry is a directory. */
	isDirectory: boolean;
}

// ── 灵动窗 (Dynamic Window) ────────────────────────────────────────────────
// A per-conversation, multi-facet floating window that visualizes what the model
// is doing (files / web / commands) and lets the user interact with it directly.
// The flow facet is NOT modeled here — it reads `liveFlow` directly.

/** Which content facet of the dynamic window is in view / has data. */
export type DynamicWindowFacet = "flow" | "files" | "web" | "commands";

/**
 * One "operation" = a single tool call that fed a facet. Lets the dynamic window
 * group its accumulated items so the user can scroll back / filter to an earlier
 * operation's outputs.
 */
export interface DynamicWindowOperation {
	id: string;
	label: string;
	timestamp: number;
}

/** A node in the "touched files" tree (folder = recursive, file = leaf). */
export interface DynamicWindowFileNode {
	name: string;
	path: string;
	isDirectory: boolean;
	children?: DynamicWindowFileNode[];
	/** Present on leaves: the underlying file, reusing the artifact-card model. */
	artifact?: FileArtifact;
	/** True when the model produced (wrote) this file, vs merely read/touched it. */
	produced?: boolean;
	/** Which operation introduced this leaf (for grouping / highlight). */
	operationId?: string;
}

/** A page the model browsed/searched, surfaced in the web facet. */
export interface DynamicWindowWebPage {
	url: string;
	title: string;
	visitedAt: number;
	operationId: string;
}

/** A command the model ran, surfaced in the commands facet. */
export interface DynamicWindowCommand {
	id: string;
	command: string;
	status: AutomationStatus;
	stdout?: string;
	stderr?: string;
	timestamp: number;
	operationId: string;
}

/**
 * Accumulated state of one facet: items + operation grouping. The unread red-dot
 * is derived on the client (item count vs last-seen), so it isn't carried here.
 */
export interface DynamicWindowFacetState<T> {
	operations: DynamicWindowOperation[];
	items: T[];
}

/**
 * Per-session ephemeral working state for the dynamic window, accumulated over
 * the whole conversation. Carried on the snapshot like `liveFlow`; not archived
 * (history rebuilds it from the archived tool records, same as artifact cards).
 */
export interface DynamicWindowSnapshot {
	/** Backend's suggested default facet (most recent activity); the UI may override. */
	activeFacet: DynamicWindowFacet;
	files: DynamicWindowFacetState<DynamicWindowFileNode> & { produced: FileArtifact[] };
	web: DynamicWindowFacetState<DynamicWindowWebPage>;
	commands: DynamicWindowFacetState<DynamicWindowCommand>;
	updatedAt: number;
}

/**
 * A file the user "marked" in the dynamic window's file facet. Marked files form
 * a per-conversation persistent set: their name+path are injected into every
 * turn's prompt so the model keeps attending to them until unmarked.
 */
export interface MarkedFileView {
	path: string;
	name: string;
	ext: string;
	markedAt: number;
}

export interface ChatMessageView {
	id: string;
	role: "user" | "assistant" | "system";
	text: string;
	thinking?: string;
	timestamp: number;
	order: number;
	tokenUsage?: MessageTokenUsageView;
	turnTokenUsage?: MessageTokenUsageView;
	/** Attachments sent with a user message; stored for display only (not re-sent). */
	attachments?: Array<{ name: string; kind?: PromptAttachmentKind; sizeBytes: number }>;
}

export interface VoiceOverlayState {
	visible: boolean;
	state: VoiceState;
	transcript: string;
	currentStep?: string;
	error?: string;
	remainingMs?: number;
	elapsedMs?: number;
	level?: number;
	wakeWord?: string;
}

export interface ConversationThinkingState {
	enabled: boolean;
	effectiveLevel: DesktopAssistantSettings["thinkingLevel"];
	supported: boolean;
}

export interface ConversationContextUsageView {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
	/**
	 * Cumulative prompt-cache hit ratio for this session
	 * (sum(cacheRead) / sum(input + cacheRead + cacheWrite)), or null before any
	 * usage has been reported. A healthy value (DeepSeek auto prefix cache) stays
	 * high as a conversation grows; a falling value means the sent prefix is
	 * churning and the server-side cache is being missed.
	 */
	cacheHitRatio: number | null;
}

export interface MessageTokenUsageView {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

/**
 * Coarse run state of one conversation, surfaced in the session list.
 * "queued" means the session wants to run but is waiting for a concurrency
 * slot or the shared desktop action lease.
 */
export type SessionRunStatus = "idle" | "running" | "queued" | "awaiting_confirmation" | "error";

/**
 * Lightweight per-session entry for the live "running sessions" roster.
 * Carries only what the session list needs (status + indicator dots); the
 * focused session's full detail rides on the top-level snapshot fields.
 */
export interface SessionSummary {
	sessionId: string;
	title: string;
	status: SessionRunStatus;
	isRunning: boolean;
	lastActivityAt: number;
	/** > 0 → yellow dot (awaiting approval). */
	pendingConfirmationCount: number;
	/** true → blue dot (a background session finished with unread output). */
	unreadCompletion: boolean;
	contextUsage?: ConversationContextUsageView;
}

export interface DesktopAssistantSnapshot {
	sessionId: string;
	/** Live roster of all in-memory conversations (focused + background). */
	sessions: SessionSummary[];
	/** sessionId of the conversation whose detail is carried by this snapshot. */
	focusedSessionId: string;
	settings: DesktopAssistantSettings;
	authStatus: DesktopAuthStatus;
	voiceAuthStatus: DesktopAuthStatus;
	apiKeyStatus: ApiKeyValidationStatus;
	isRunning: boolean;
	streamingText: string;
	streamingThinking: string;
	messages: ChatMessageView[];
	timeline: TimelineItem[];
	pendingConfirmations: PendingConfirmation[];
	queuedPreInputs: QueuedPreInputView[];
	queuedSteeringMessages: string[];
	steeringLog: SteeringLogEntry[];
	voiceOverlay: VoiceOverlayState;
	conversationThinking: ConversationThinkingState;
	historyWindow?: ConversationHistoryWindow;
	memoryEnabled: boolean;
	lastInjectedMemoryCount: number;
	contextUsage?: ConversationContextUsageView;
	/** Live sandbox lifecycle state; drives the home-page init popup. */
	sandboxStatus?: SandboxStatus;
	/** Roll-up of memos/to-dos; drives the sidebar badge and reminder strips. */
	memoSummary?: MemoSummary;
	/** Roll-up of automation flows; drives sidebar badges and home summaries. */
	automationSummary?: AutomationSummary;
	/** AI-generated home greeting + today overview; absent → renderer shows static. */
	homeWelcome?: HomeWelcomeState;
	/** "实时流程化" working flow for the focused session; drives the floating window. */
	liveFlow?: LiveFlowSnapshot;
	/** 灵动窗 working state for the focused session (files / web / commands facets). */
	dynamicWindow?: DynamicWindowSnapshot;
	/** Files the user pinned ("marked"); their name+path are injected every turn. */
	markedFiles?: MarkedFileView[];
}

/** Cached AI home greeting carried on snapshots; drives the home hero typewriter. */
export interface HomeWelcomeState {
	/** The greeting + overview text to display. */
	text: string;
	/** ISO 8601 time it was generated (drives the 30-min regeneration gate). */
	generatedAt: string;
	/** Signature of the cheap context fields used; lets the gate dedupe. */
	signature: string;
	source: "ai" | "fallback";
}

/** Structured current weather for the home hero widget (from WeatherAPI.com current.json). */
export interface HomeWeatherView {
	/** Resolved city name (auto:ip lookup); absent if the payload omitted it. */
	city?: string;
	/** Current temperature in °C (always present — parse fails without it). */
	tempC: number;
	/** "Feels like" temperature in °C. */
	feelsLikeC?: number;
	/** Localized condition text, e.g. "多云". */
	conditionText?: string;
	/** WeatherAPI condition code; drives the lucide icon mapping. */
	conditionCode?: number;
	/** True for daytime conditions (is_day === 1); flips sun/moon style icons. */
	isDay: boolean;
	/** Relative humidity percentage. */
	humidity?: number;
	/** Wind speed in km/h. */
	windKph?: number;
	/** ISO 8601 fetch time. */
	fetchedAt: string;
}

export type SessionNotificationKind = "awaiting" | "completed";

/**
 * Lightweight cross-session signal that drives the global toast + list dots.
 * "awaiting" → a background session needs approval (yellow dot);
 * "completed" → a background session finished with unread output (blue dot).
 */
export interface SessionNotification {
	sessionId: string;
	title: string;
	kind: SessionNotificationKind;
}

// ── 备忘录 / 待办 ──────────────────────────────────────────────────────────
export type MemoStatus = "active" | "completed" | "archived";
export type MemoPriority = "none" | "low" | "medium" | "high";
export type MemoRecurrence = "none" | "daily" | "weekly" | "monthly";
/** Lifecycle of a memo's reminder. "fired" includes "missed" (fired late on startup). */
export type MemoReminderState = "none" | "pending" | "fired" | "snoozed" | "dismissed";
export type MemoAutoRunStatus = "running" | "succeeded" | "failed";

export interface MemoSubtask {
	id: string;
	title: string;
	done: boolean;
}

export interface MemoAttachment {
	id: string;
	type: "file" | "image" | "url";
	name: string;
	href: string;
	size?: number;
	addedAt: string;
}

export interface MemoList {
	id: string;
	name: string;
	color?: string;
	icon?: string;
	/** Manual display order (ascending). Lower sorts first. */
	order?: number;
	createdAt: string;
	updatedAt: string;
}

export interface MemoItem {
	id: string;
	title: string;
	/** Free-form body / notes. */
	notes: string;
	status: MemoStatus;
	priority: MemoPriority;
	/** Due time (ISO 8601). Optional. */
	dueAt?: string;
	/** Reminder time (ISO 8601); may differ from dueAt (e.g. remind a day early). */
	reminderAt?: string;
	recurrence: MemoRecurrence;
	tags: string[];
	subtasks: MemoSubtask[];
	listId?: string;
	/** Manual display order within the current memo scope. Lower sorts first. */
	order?: number;
	progress?: number;
	attachments?: MemoAttachment[];
	pinned: boolean;
	/** Optional accent color token (hex or css var). */
	color?: string;
	/** When true, the assistant starts a background AI run when reminderAt fires on time. */
	autoRunAtReminder: boolean;
	/** Optional prompt for the scheduled AI run. Falls back to title + notes. */
	autoRunPrompt?: string;
	/** Last background session created by an automatic memo run. */
	lastAutoRunSessionId?: string;
	lastAutoRunAt?: string;
	lastAutoRunError?: string;
	lastAutoRunStatus?: MemoAutoRunStatus;
	reminderState: MemoReminderState;
	/** True when the reminder fired after its scheduled time (app was closed). */
	reminderMissed?: boolean;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
	createdBy: "user" | "ai";
	/** Conversation that created this memo (AI-created); used to jump back. */
	sourceSessionId?: string;
}

/** Lightweight roll-up carried on snapshots; drives sidebar badge + reminder strips. */
export interface MemoSummary {
	total: number;
	activeCount: number;
	dueTodayCount: number;
	overdueCount: number;
	/** Overdue + due-today + nearest upcoming active memos, capped for display. */
	upcoming: MemoItem[];
}

export type MemoSortKey = "due" | "priority" | "created" | "manual" | "reminderAt";

export interface MemoListRequest {
	status?: MemoStatus;
	tag?: string;
	query?: string;
	sort?: MemoSortKey;
	listId?: string;
}

export interface MemoListResponse {
	memos: MemoItem[];
	summary: MemoSummary;
}

export interface MemoCreateRequest {
	title: string;
	notes?: string;
	priority?: MemoPriority;
	dueAt?: string;
	reminderAt?: string;
	recurrence?: MemoRecurrence;
	tags?: string[];
	subtasks?: Array<{ title: string; done?: boolean }>;
	listId?: string;
	order?: number;
	progress?: number;
	pinned?: boolean;
	color?: string;
	autoRunAtReminder?: boolean;
	autoRunPrompt?: string;
	createdBy?: "user" | "ai";
	sourceSessionId?: string;
}

export interface MemoUpdateRequest {
	id: string;
	title?: string;
	notes?: string;
	status?: MemoStatus;
	priority?: MemoPriority;
	/** Pass null to clear; omit to leave unchanged. */
	dueAt?: string | null;
	reminderAt?: string | null;
	recurrence?: MemoRecurrence;
	tags?: string[];
	subtasks?: MemoSubtask[];
	listId?: string | null;
	order?: number | null;
	progress?: number | null;
	pinned?: boolean;
	color?: string | null;
	autoRunAtReminder?: boolean;
	autoRunPrompt?: string | null;
}

export interface MemoStatsResult {
	total: number;
	active: number;
	overdue: number;
	dueToday: number;
	completedThisWeek: number;
	completedThisMonth: number;
	byPriority: Record<MemoPriority, number>;
	snoozedCount: number;
	avgCompletionDays?: number;
}

export interface MemoBatchRequest {
	ids: string[];
	action: "complete" | "delete" | "archive" | "setTags" | "setPriority" | "setListId";
	tags?: string[];
	priority?: MemoPriority;
	listId?: string;
}

export interface MemoBatchResult {
	succeeded: string[];
	failed: string[];
}

export interface MemoListCreateRequest {
	name: string;
	color?: string;
	icon?: string;
}

export interface MemoListUpdateRequest {
	id: string;
	name?: string;
	color?: string | null;
	icon?: string | null;
}

export interface MemoListDeleteRequest {
	id: string;
}

export interface MemoListReorderRequest {
	id: string;
	direction: "up" | "down";
}

export interface MemoReorderRequest {
	id: string;
	beforeId?: string | null;
	afterId?: string | null;
	listId?: string | null;
}

export interface MemoAttachmentAddRequest {
	memoId: string;
	name?: string;
	type?: MemoAttachment["type"];
	filePath?: string;
	url?: string;
}

export interface MemoAttachmentRemoveRequest {
	memoId: string;
	attachmentId: string;
}

export interface MemoDeleteRequest {
	id: string;
}

export interface MemoCompleteRequest {
	id: string;
	/** Defaults to true; pass false to re-open a completed memo. */
	completed?: boolean;
}

export interface MemoSnoozeRequest {
	id: string;
	/** New reminder time (ISO 8601). */
	until: string;
}

export interface MemoSetReminderRequest {
	id: string;
	/** New reminder time (ISO 8601), or null to clear it. */
	reminderAt: string | null;
	autoRunAtReminder?: boolean;
	autoRunPrompt?: string | null;
}

export interface MemoRunAutoRequest {
	id: string;
}

// Automation flows ----------------------------------------------------------

export type FlowNodeKind = "start" | "task" | "condition" | "loop" | "wait" | "end";

export interface FlowPosition {
	x: number;
	y: number;
}

export interface FlowNodeConfig {
	waitMs?: number;
	loopMaxIterations?: number;
}

export interface FlowNode {
	id: string;
	kind: FlowNodeKind;
	label: string;
	instruction?: string;
	config?: FlowNodeConfig;
	position: FlowPosition;
}

/**
 * A flow node whose position may be omitted. Callers (AI design tools) that
 * don't care where a node lands pass it without a position; the draft session
 * then places only the missing ones, leaving already-positioned nodes put.
 */
export type FlowNodeInput = Omit<FlowNode, "position"> & { position?: FlowPosition };

export interface FlowEdge {
	id: string;
	source: string;
	target: string;
	label?: string;
}

export type AutomationTrigger =
	| { kind: "manual" }
	| { kind: "once"; at: string }
	| { kind: "interval"; everyMs: number }
	| { kind: "daily"; time: string }
	| { kind: "weekly"; weekdays: number[]; time: string };

export interface AutomationRunPolicy {
	/** How the run handles actions that cross into the real system — same model as the main chat. */
	permissionMode: AutomationPermissionMode;
	thinkingLevel?: DesktopAssistantSettings["thinkingLevel"];
}

export type AutomationRunStatus = "running" | "succeeded" | "failed" | "cancelled";
export type AutomationRunTrigger = "manual" | "test" | "scheduled";

export interface AutomationRunRecord {
	id: string;
	startedAt: string;
	finishedAt?: string;
	status: AutomationRunStatus;
	trigger: AutomationRunTrigger;
	sessionId?: string;
	summary?: string;
	error?: string;
}

export interface AutomationFlow {
	id: string;
	name: string;
	description: string;
	enabled: boolean;
	nodes: FlowNode[];
	edges: FlowEdge[];
	trigger: AutomationTrigger;
	runPolicy: AutomationRunPolicy;
	lastRun?: AutomationRunRecord;
	runs: AutomationRunRecord[];
	nextRunAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface AutomationSummary {
	total: number;
	enabledCount: number;
	runningCount: number;
	nextRunAt?: string;
	missedCount: number;
}

export interface AutomationListResponse {
	flows: AutomationFlow[];
	summary: AutomationSummary;
}

export interface AutomationGetRequest {
	id: string;
}

export interface AutomationCreateRequest {
	title?: string;
	name?: string;
	description?: string;
	trigger?: AutomationTrigger;
	runPolicy?: Partial<AutomationRunPolicy>;
	nodes?: FlowNode[];
	edges?: FlowEdge[];
	draft?: unknown;
	tags?: string[];
	permissionMode?: AutomationPermissionMode;
	enabled?: boolean;
}

export interface AutomationUpdateRequest {
	id: string;
	title?: string;
	name?: string;
	description?: string;
	trigger?: AutomationTrigger;
	runPolicy?: Partial<AutomationRunPolicy>;
	nodes?: FlowNode[];
	edges?: FlowEdge[];
	draft?: unknown;
	tags?: string[];
	permissionMode?: AutomationPermissionMode;
	enabled?: boolean;
}

export interface AutomationDeleteRequest {
	id: string;
}

export interface AutomationSetEnabledRequest {
	id: string;
	enabled: boolean;
}

export interface AutomationRunRequest {
	id: string;
	trigger?: AutomationRunTrigger;
	reason?: AutomationRunTrigger;
}

export interface AutomationRunResponse {
	flow: AutomationFlow;
	run: AutomationRunRecord;
}

export interface AutomationCancelRunRequest {
	flowId: string;
	runId?: string;
}

export interface AutomationOpenEditorRequest {
	flowId?: string;
	id?: string;
}

export interface AutomationDraft {
	flowId?: string;
	name: string;
	description: string;
	nodes: FlowNode[];
	edges: FlowEdge[];
	trigger: AutomationTrigger;
	runPolicy: AutomationRunPolicy;
	dirty: boolean;
	updatedAt: string;
}

export type AutomationDraftOperation =
	| {
			type: "replace";
			draft: Omit<Partial<AutomationDraft>, "nodes" | "edges"> & { nodes: FlowNodeInput[]; edges: FlowEdge[] };
	  }
	| {
			type: "set_meta";
			name?: string;
			description?: string;
			trigger?: AutomationTrigger;
			runPolicy?: Partial<AutomationRunPolicy>;
	  }
	| { type: "add_node"; node: Omit<FlowNodeInput, "id"> & { id?: string } }
	| { type: "update_node"; id: string; update: Partial<Omit<FlowNode, "id">> }
	| { type: "delete_node"; id: string }
	| { type: "connect"; edge: Omit<FlowEdge, "id"> & { id?: string } }
	| { type: "disconnect"; id: string }
	| { type: "autolayout" };

export interface AutomationDraftGetRequest {
	flowId?: string;
}

export interface AutomationDraftApplyRequest {
	ops: AutomationDraftOperation[];
}

export interface AutomationDraftSaveRequest {
	flowId?: string;
}

export interface AutomationDraftSaveResponse {
	flow: AutomationFlow;
	draft: AutomationDraft;
}

export interface AutomationDesignChatRequest {
	flowId?: string;
	message: string;
}

export interface AutomationDesignChatResponse {
	sessionId: string;
	snapshot: AutomationDraft;
	/** The design assistant's reply text for this turn, if it produced one. */
	reply?: string;
	/** Full design conversation after this turn, so the editor renders the real thread. */
	messages: ChatMessageView[];
	timeline: TimelineItem[];
	streamingText: string;
	streamingThinking: string;
}

export interface AutomationDesignStateResponse {
	/** Present only if a design session already exists. */
	sessionId?: string;
	messages: ChatMessageView[];
	timeline: TimelineItem[];
	streamingText: string;
	streamingThinking: string;
}

export type AutomationProgressPhase = "enter" | "done";
export type AutomationProgressEventKind = "step" | "branch" | "finish" | "log";

export interface AutomationProgressEvent {
	flowId: string;
	runId: string;
	kind: AutomationProgressEventKind;
	nodeId?: string;
	phase?: AutomationProgressPhase;
	choice?: string;
	status?: AutomationRunStatus;
	summary?: string;
	message?: string;
	timestamp: string;
}

export type DesktopAssistantDiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface DesktopAssistantDiagnostic {
	source: "conversation_title" | string;
	level: DesktopAssistantDiagnosticLevel;
	title: string;
	details?: Record<string, unknown>;
}

export interface DesktopAssistantEvent {
	type:
		| "snapshot"
		| "session_status"
		| "session_notification"
		| "diagnostic"
		| "agent_event"
		| "timeline"
		| "voice"
		| "error"
		| "skill_file"
		| "streaming_text"
		| "streaming_thinking"
		| "mcp_status"
		| "software_plugin_progress"
		| "sandbox_status"
		| "memo_changed"
		| "memo_reminder"
		| "automation_changed"
		| "automation_draft_changed"
		| "automation_progress"
		| "automation_missed"
		| "home_welcome"
		| "route";
	snapshot?: DesktopAssistantSnapshot;
	/** Live roster for "session_status" events (and mirrored on snapshots). */
	sessions?: SessionSummary[];
	focusedSessionId?: string;
	/** Payload for "session_notification" events. */
	sessionNotification?: SessionNotification;
	/** Payload for "diagnostic" events. */
	diagnostic?: DesktopAssistantDiagnostic;
	/** sessionId of the conversation this event originated from, when applicable. */
	sessionId?: string;
	agentEvent?: unknown;
	timelineItem?: TimelineItem;
	voiceOverlay?: VoiceOverlayState;
	skillFile?: SkillFileView;
	error?: string;
	streamingText?: string;
	streamingThinking?: string;
	mcp?: McpServerListResponse;
	softwarePluginProgress?: SoftwarePluginOperationProgress;
	/** Payload for "sandbox_status" events. */
	sandboxStatus?: SandboxStatus;
	/** Payload for "memo_reminder" events (the memo whose reminder just fired). */
	memo?: MemoItem;
	/** Roll-up carried on "memo_changed" / "memo_reminder" events. */
	memoSummary?: MemoSummary;
	automation?: AutomationFlow;
	automations?: AutomationFlow[];
	automationSummary?: AutomationSummary;
	automationDraft?: AutomationDraft;
	automationRun?: AutomationRunRecord;
	automationProgress?: AutomationProgressEvent;
	/** Payload for "home_welcome" events (the freshly generated greeting). */
	homeWelcome?: HomeWelcomeState;
	route?: "settings" | "mcp" | "memo" | "automation";
}

export type PromptAttachmentKind = "text" | "word" | "excel" | "powerpoint" | "pdf" | "image" | "unknown";

export interface PendingPromptAttachment {
	id: string;
	name: string;
	path: string;
	sizeBytes: number;
	mimeType?: string;
	kind?: PromptAttachmentKind;
}

export type PromptDelivery = "prompt" | "preInput" | "steer";

export interface QueuedPreInputView {
	id: string;
	text: string;
	createdAt: number;
	sessionId: string;
}

export interface SteeringLogEntry {
	id: string;
	text: string;
	/** "pending" = queued, awaiting safe insertion; "applied" = successfully inserted */
	status: "pending" | "applied";
	queuedAt: number;
	appliedAt?: number;
	/** Display order assigned at apply time so the bubble can be sorted into the conversation flow. */
	order?: number;
}

export interface QueuedPreInputRequest {
	id: string;
	/** Target conversation; defaults to the focused one when omitted. */
	sessionId?: string;
}

export interface WithdrawQueuedPreInputResponse {
	queuedPreInput?: QueuedPreInputView;
	snapshot: DesktopAssistantSnapshot;
}

export interface AttachmentSnapshotMetadata {
	name: string;
	path: string;
	sizeBytes: number;
	kind: PromptAttachmentKind;
	extractedAt: string;
	truncated: boolean;
	error?: string;
}

export interface AttachmentDocumentSnapshot {
	metadata: AttachmentSnapshotMetadata;
	outline: string[];
	content: unknown;
	formatNotes: string[];
	markdown: string;
}

export interface PromptRequest {
	message: string;
	source: "text" | "voice";
	attachments?: PendingPromptAttachment[];
	delivery?: PromptDelivery;
	/** Target conversation; defaults to the focused one when omitted. */
	sessionId?: string;
}

export interface AbortRequest {
	/** Target conversation; defaults to the focused one when omitted. */
	sessionId?: string;
}

export interface FocusSessionRequest {
	sessionId: string;
}

export interface CloseSessionRequest {
	sessionId: string;
}

export interface ListSessionsResponse {
	sessions: SessionSummary[];
	focusedSessionId: string;
}

export interface ApiKeyUpdateRequest {
	apiKey: string;
}

export interface SettingsUpdateRequest {
	settings: Partial<DesktopAssistantSettings>;
}

export interface RefreshHomeWelcomeRequest {
	/** Bypass the signature/age dedupe (e.g. the user tapped manual refresh). */
	force?: boolean;
}

export interface ConversationThinkingUpdateRequest {
	enabled: boolean;
}

export interface McpServerListResponse {
	enabled: boolean;
	servers: McpServerConfig[];
	statuses: McpServerStatus[];
}

export interface McpServerUpsertRequest {
	server: Partial<McpServerConfig> & Pick<McpServerConfig, "name">;
}

export interface McpServerDeleteRequest {
	id: string;
}

export interface McpServerActionRequest {
	id?: string;
	server?: Partial<McpServerConfig> & Pick<McpServerConfig, "name">;
}

export interface McpEnabledUpdateRequest {
	enabled: boolean;
}

export interface StartVoiceRequest {
	mode?: "wake-listening" | "manual";
}

export interface TranscribeAudioRequest {
	audioWav: ArrayBuffer;
	mimeType?: string;
}

export interface TranscribeAudioResponse {
	text: string;
}

export interface VoiceApiKeyUpdateRequest {
	apiKey: string;
}

export interface WakeWordModelMetadata {
	id: string;
	wakeWord: string;
	label: string;
	fileName: string;
	sizeBytes: number;
	importedAt: number;
}

export interface WakeWordModelListResponse {
	models: WakeWordModelMetadata[];
}

export interface WakeWordModelImportRequest {
	wakeWord?: string;
	label?: string;
}

export interface WakeWordModelImportResponse extends WakeWordModelListResponse {
	model?: WakeWordModelMetadata;
}

export interface WakeWordModelDeleteRequest {
	id: string;
}

export interface WakeWordModelReadRequest {
	id: string;
}

export interface WakeWordModelReadResponse {
	model: WakeWordModelMetadata;
	data: ArrayBuffer;
}

export interface StartWakeKwsRequest {
	wakeWord: string;
	/** 0..1; higher is easier to wake. */
	sensitivity: number;
	/** Advanced: raw keywords-file content (model tokens) that overrides the wake word. */
	keywordsOverride?: string;
}

export interface StartWakeKwsResponse {
	/** False when the native engine or model files are unavailable; renderer falls back. */
	available: boolean;
}

export interface WakeKwsAudioFrame {
	samples: Float32Array;
	sampleRate: number;
}

export interface WakeKwsWakeEvent {
	keyword: string;
}

export interface VoiceOverlayUpdateRequest {
	update: Partial<VoiceOverlayState>;
}

export interface ConfirmationUpdateRequest {
	id: string;
	/** Owning conversation; defaults to the context holding this confirmation. */
	sessionId?: string;
}

export interface SkillFileRequest {
	capabilityId: DesktopCapabilityId;
}

export interface SkillFileUpdateRequest {
	capabilityId: DesktopCapabilityId;
	content: string;
}

export interface SkillFileView {
	capabilityId: DesktopCapabilityId;
	skillName: string;
	path: string;
	content: string;
	editable: boolean;
}

export interface PersonalSkillEntry {
	id: string;
	title: string;
	description: string;
	tags: string[];
	path: string;
	createdAt: string;
	updatedAt: string;
	sourceSessionId?: string;
	archived: boolean;
	preview: string;
}

export interface PersonalSkillFileView extends PersonalSkillEntry {
	content: string;
}

export interface PersonalSkillListResponse {
	rootDir: string;
	skills: PersonalSkillEntry[];
}

export interface PersonalSkillSearchRequest {
	query: string;
	limit?: number;
}

export interface PersonalSkillReadRequest {
	id: string;
}

export interface PersonalSkillSaveRequest {
	id?: string;
	title: string;
	description: string;
	tags?: string[];
	content: string;
	sourceSessionId?: string;
	overwrite?: boolean;
}

export interface PersonalSkillArchiveRequest {
	id: string;
}

export interface ConversationHistoryEntry {
	sessionId: string;
	title: string;
	preview: string;
	updatedAt: number;
	messageCount: number;
}

export interface ConversationHistoryListResponse {
	conversations: ConversationHistoryEntry[];
}

export interface ResumeConversationRequest {
	sessionId: string;
}

export type ConversationHistoryLoadSource = "conversation" | "events";

export interface ConversationHistoryWindow {
	sessionId: string;
	hasMoreBefore: boolean;
	oldestOrder?: number;
	loadedFrom: ConversationHistoryLoadSource;
}

export interface LoadConversationPageRequest {
	sessionId: string;
	beforeOrder?: number;
	limit?: number;
}

export interface LoadConversationPageResponse extends ConversationHistoryWindow {
	messages: ChatMessageView[];
	timeline: TimelineItem[];
}

export interface DeleteConversationRequest {
	sessionId: string;
}

export interface DeleteConversationResponse {
	deletedSessionId: string;
	activeSessionId: string;
}

export interface ClearConversationHistoryResponse {
	deletedCount: number;
	activeSessionId: string;
}

export interface GlobalMemoryListResponse {
	memories: GlobalMemoryEntry[];
}

export interface GlobalMemoryDeleteRequest {
	id: string;
}

export interface GlobalMemoryClearResponse {
	deletedCount: number;
}

export interface GlobalMemoryUpdateRequest {
	id: string;
	kind?: GlobalMemoryKind;
	scope?: GlobalMemoryScope;
	source?: GlobalMemorySource;
	text?: string;
	confidence?: number;
	reason?: string;
	tags?: string[];
	archived?: boolean;
}

export type AppLaunchCacheTargetType = "app" | "url";

export interface AppLaunchCacheEntry {
	displayName: string;
	launch: string;
	kind: string;
	targetType: AppLaunchCacheTargetType;
	sourceQueries: string[];
	successCount: number;
	failCount: number;
	lastSucceededAt?: number;
	lastFailedAt?: number;
}

export interface AppLaunchCacheView {
	path: string;
	version: 1;
	updatedAt: number;
	aliases: Record<string, AppLaunchCacheEntry>;
}

export interface DeleteAppLaunchCacheEntryRequest {
	alias: string;
}

export type SandboxCleanStrategy = "all" | "oldest" | "largest";

export interface SandboxCleanRequest {
	strategy?: SandboxCleanStrategy;
	/** Target free space to reach, in MB (used by oldest/largest strategies). */
	targetMb?: number;
}

export interface SandboxStatusResponse {
	status: SandboxStatus;
}

export interface SandboxCleanResponse {
	status: SandboxStatus;
	removedEntries: number;
	freedMb: number;
}

export const DESKTOP_ASSISTANT_MCP_SERVER_ID = "desktop-assistant";

/**
 * Path tokens usable in sandbox root lists; resolved against real OS paths in the
 * main process (see sandbox-workspace.ts). Using tokens keeps these defaults pure
 * and machine-independent.
 */
export const SANDBOX_PATH_TOKENS = [
	"<sandbox>",
	"<temp>",
	"<home>",
	"<documents>",
	"<desktop>",
	"<downloads>",
	"<attachments>",
	"<windows>",
	"<system32>",
	"<programfiles>",
	"<programfiles86>",
	"<appresources>",
] as const;

/** Catastrophic / irreversible command patterns denied outright in the Balanced preset. */
export const DEFAULT_SANDBOX_DENY_PATTERNS: string[] = [
	"\\bformat(?:\\.com)?\\s+[A-Za-z]:",
	"\\bdiskpart\\b",
	"\\bbcdedit\\b",
	"\\bvssadmin\\s+delete\\b",
	"\\bcipher\\s+/w",
	"\\bfsutil\\b",
	"\\bRemove-Item\\b[^\\n]*\\b[A-Za-z]:\\\\Windows\\b",
	"\\bwevtutil\\s+cl\\b",
	"\\bnet\\s+user\\b\\s+\\S+\\s+/add",
	"\\breg(?:\\.exe)?\\s+(?:add|delete|import)\\b",
	"\\bSet-ExecutionPolicy\\b",
	"\\btakeown\\b",
];

/** Balanced default: sandbox on, sensible roots, destructive commands denied, risky actions confirmed. */
export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
	enabled: true,
	preset: "balanced",
	workspace: {
		rootDir: undefined,
		scope: "global",
		quotaMb: 2048,
		warnAtPercent: 80,
		overQuotaPolicy: "auto_clean",
		cleanOnSessionEnd: false,
		autoInitOnStartup: true,
		keepWarmProcess: true,
	},
	filesystem: {
		writeRoots: ["<sandbox>", "<temp>", "<documents>", "<desktop>", "<downloads>"],
		readRoots: ["<sandbox>", "<temp>", "<documents>", "<desktop>", "<downloads>", "<home>", "<attachments>"],
		protectedPaths: ["<windows>", "<system32>", "<programfiles>", "<programfiles86>", "<appresources>"],
		// Balanced: real writes outside the listed roots are CONFIRMED (gated by the
		// permission mode), not hard-denied — so e.g. "save to Desktop" still works
		// via approval even if a path token resolves oddly. Strict preset sets this true.
		confineWritesToRoots: false,
		denySymlinkEscape: true,
	},
	commands: {
		denyPatterns: [...DEFAULT_SANDBOX_DENY_PATTERNS],
		allowPatterns: [],
		blockNetworkDownload: false,
	},
	network: {
		domainAllowList: [],
		domainDenyList: [],
		blockPrivateIps: true,
	},
	// No per-tool overrides by default: the permission mode governs (完全控制 = no
	// prompts). Users can add a gate (e.g. office_word_run: "confirm") in Settings
	// if they want a specific tool to always confirm regardless of mode.
	toolGates: {},
	resourceLimits: {
		commandTimeoutMs: 30000,
		maxOutputChars: 200000,
		maxConcurrentProcesses: 6,
		killProcessTree: true,
	},
	hardening: {
		runAsRestrictedUser: false,
	},
	audit: {
		logDecisions: true,
	},
	aiMayEdit: "tighten_only",
};

/** Build a full sandbox settings object for a named preset. Pure — safe to import in the renderer. */
export const SANDBOX_PRESETS: Record<"strict" | "balanced" | "permissive", () => SandboxSettings> = {
	balanced: () => structuredClone(DEFAULT_SANDBOX_SETTINGS),
	strict: () => {
		const s = structuredClone(DEFAULT_SANDBOX_SETTINGS);
		s.preset = "strict";
		s.commands.blockNetworkDownload = true;
		s.commands.denyPatterns = [
			...s.commands.denyPatterns,
			"\\bshutdown\\b",
			"\\bRestart-Computer\\b",
			"\\bclear-recyclebin\\b",
			"\\bnetsh\\b",
			"\\bschtasks\\b",
			"\\bwmic\\b",
			"\\bsc(?:\\.exe)?\\s+(?:create|config|delete)\\b",
		];
		s.filesystem.confineWritesToRoots = true;
		s.network.blockPrivateIps = true;
		s.workspace.quotaMb = 1024;
		s.workspace.overQuotaPolicy = "deny_writes";
		s.resourceLimits.commandTimeoutMs = 20000;
		s.resourceLimits.maxConcurrentProcesses = 3;
		return s;
	},
	permissive: () => {
		const s = structuredClone(DEFAULT_SANDBOX_SETTINGS);
		s.preset = "permissive";
		s.filesystem.confineWritesToRoots = false; // outside roots → confirm, not deny
		s.commands.blockNetworkDownload = false;
		s.network.blockPrivateIps = true; // SSRF guard stays on even when permissive
		s.workspace.quotaMb = 8192;
		s.workspace.overQuotaPolicy = "confirm";
		s.resourceLimits.commandTimeoutMs = 60000;
		s.resourceLimits.maxConcurrentProcesses = 8;
		return s;
	},
};

export const DEFAULT_DESKTOP_ASSISTANT_SETTINGS: DesktopAssistantSettings = {
	provider: "deepseek",
	apiConnectionMode: "official",
	modelId: "deepseek-v4-pro",
	thinkingLevel: "high",
	permissionMode: "tiered",
	capabilities: {
		system: { enabled: true, commandFirst: true, skillName: "system-operation" },
		document: { enabled: true, commandFirst: true, skillName: "document-operation" },
		ppt: { enabled: true, commandFirst: true, skillName: "ppt-operation" },
		excel: { enabled: true, commandFirst: true, skillName: "excel-operation" },
	},
	webSearch: { mode: "auto", provider: "duckduckgo" },
	browser: {
		defaultBrowser: "built_in",
		allowAiControl: true,
		aiBrowserPreference: "built_in",
		homeUrl: "https://www.google.com",
		maxTabs: 12,
		persistStorage: true,
		searchTemplate: "https://www.google.com/search?q=%s",
		shortcuts: [
			{ id: "default-bing", label: "必应", url: "https://www.bing.com" },
			{ id: "default-github", label: "GitHub", url: "https://github.com" },
			{ id: "default-bilibili", label: "哔哩哔哩", url: "https://www.bilibili.com" },
		],
	},
	office: { aiOfficePreference: "auto" },
	mcp: {
		enabled: true,
		servers: [
			{
				id: DESKTOP_ASSISTANT_MCP_SERVER_ID,
				name: "Desktop Assistant MCP",
				enabled: true,
				transport: "stdio",
				timeoutMs: 10000,
				toolNamePrefix: "desktop_assistant",
				description: "Built-in MCP server that controls this desktop assistant's own settings.",
				builtIn: true,
			},
			{
				id: "excel-mcp",
				name: "Excel 高级操作 (haris-musa)",
				// Off by default: needs `uv`/`uvx` installed and spawns an external process. Toggle on
				// in Settings → MCP after installing uv. Routed via the excel capability (see SKILL.md).
				enabled: false,
				transport: "stdio",
				command: "uvx",
				args: ["excel-mcp-server", "stdio"],
				toolNamePrefix: "xlsx",
				timeoutMs: 60000,
				description:
					"对磁盘上的 .xlsx 做公式/图表/透视表/格式化（openpyxl，免装 Office）。文件级操作，不能修改正在 Excel 中打开的工作簿。需先安装 uv，再在设置中启用。",
			},
			{
				id: "ppt-mcp",
				name: "PPT 高级设计 (GongRzhe)",
				// Off by default: needs `uv`/`uvx` installed and spawns an external process. Toggle on
				// in Settings → MCP after installing uv. Routed via the ppt capability (see SKILL.md).
				enabled: false,
				transport: "stdio",
				command: "uvx",
				args: ["--from", "office-powerpoint-mcp-server", "ppt_mcp_server"],
				toolNamePrefix: "pptx",
				timeoutMs: 60000,
				description:
					"对磁盘上的 .pptx 做模板/图表/形状/过渡等富设计（python-pptx，免装 Office）。文件级操作，不能修改正在 PowerPoint 中打开的演示文稿。需先安装 uv，再在设置中启用。",
			},
		],
	},
	memory: {
		enabled: false,
		maxInjected: 5,
		autoExtract: false,
		allowExternalContextExtraction: false,
		allowAssistantDerivedFacts: false,
	},
	tokenSaving: {
		enabled: false,
	},
	autoTitle: {
		enabled: true,
	},
	homeWelcome: {
		enabled: true,
		includeWeather: true,
		includeEmail: true,
	},
	personalization: {
		enabled: false,
		locationMode: "auto",
	},
	experimental: {
		errorSelfSummary: { enabled: false },
		liveFlow: { enabled: false },
	},
	sandbox: DEFAULT_SANDBOX_SETTINGS,
	voice: {
		enabled: true,
		wakeWordEnabled: true,
		wakeWord: "小派",
		fuzzyThreshold: 0.6,
		language: "zh-CN",
		postWakeWaitMs: 5000,
		endSilenceMs: 1000,
		sttProvider: "openai",
		sttModel: DEFAULT_VOICE_STT_MODEL_BY_PROVIDER.openai,
		wakeEngine: "kws",
		kwsSensitivity: 0.6,
		owwModelUrl: "models/oww/xiaopai.onnx",
		owwThreshold: 0.5,
	},
	wakeWord: "小派",
	voiceLanguage: "zh-CN",
	ttsEnabled: true,
};

export const DEFAULT_API_KEY_STATUS: ApiKeyValidationStatus = {
	state: "idle",
};

export type LogEntryCat =
	| "user"
	| "ai"
	| "tool_call"
	| "tool_result"
	| "think"
	| "diagnostic"
	| "system"
	| "error"
	| "abort"
	| "retry"
	| "pet";

export interface LogEntry {
	id: string;
	ts: number;
	cat: LogEntryCat;
	title: string;
	detail?: string;
}

export interface PetDebugVector {
	x: number;
	y: number;
}

export interface PetDebugBounds {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

export interface PetDebugSnapshot {
	enabled: boolean;
	updatedAt: number;
	speciesId?: string;
	speciesLabel?: string;
	colorId?: string;
	colorLabel?: string;
	behavior?: string;
	behaviorLabel: string;
	behaviorStartedAt?: number;
	behaviorEndsAt?: number;
	behaviorRemainingMs?: number;
	behaviorStartReason?: string;
	behaviorTarget?: string;
	position?: PetDebugVector;
	velocity?: PetDebugVector;
	targetVx?: number;
	direction?: "left" | "right";
	grounded?: boolean;
	grabbed?: boolean;
	placed?: boolean;
	chasingBall?: boolean;
	wanderTarget?: number;
	mood?: {
		energy: number;
		sleepiness: number;
		curiosity: number;
	};
	terrain?: {
		platformCount: number;
		bubblePlatformCount: number;
		bounds: PetDebugBounds;
	};
	ball?: {
		x: number;
		y: number;
		vx: number;
		vy: number;
		ageMs: number;
	};
	canvas?: {
		width: number;
		height: number;
	};
	sprite?: {
		width: number;
		height: number;
	};
}

export interface PetDebugStateEvent {
	id: string;
	ts: number;
	phase: "start" | "end";
	behavior: string;
	title: string;
	reason: string;
	target?: string;
	detail?: string;
}

export interface PetDebugUpdateRequest {
	snapshot: PetDebugSnapshot;
	events?: PetDebugStateEvent[];
}

export const DESKTOP_ASSISTANT_CHANNELS = {
	getSnapshot: "desktop-assistant:get-snapshot",
	newConversation: "desktop-assistant:new-conversation",
	listSessions: "desktop-assistant:list-sessions",
	focusSession: "desktop-assistant:focus-session",
	closeSession: "desktop-assistant:close-session",
	prompt: "desktop-assistant:prompt",
	deleteQueuedPreInput: "desktop-assistant:delete-queued-pre-input",
	withdrawQueuedPreInput: "desktop-assistant:withdraw-queued-pre-input",
	abort: "desktop-assistant:abort",
	updateConversationThinking: "desktop-assistant:update-conversation-thinking",
	updateApiKey: "desktop-assistant:update-api-key",
	updateSettings: "desktop-assistant:update-settings",
	refreshHomeWelcome: "desktop-assistant:refresh-home-welcome",
	getHomeWeather: "desktop-assistant:get-home-weather",
	listMcpServers: "desktop-assistant:list-mcp-servers",
	upsertMcpServer: "desktop-assistant:upsert-mcp-server",
	deleteMcpServer: "desktop-assistant:delete-mcp-server",
	testMcpServer: "desktop-assistant:test-mcp-server",
	refreshMcpServer: "desktop-assistant:refresh-mcp-server",
	setMcpEnabled: "desktop-assistant:set-mcp-enabled",
	listSoftwarePlugins: "desktop-assistant:list-software-plugins",
	validateSoftwarePluginTarget: "desktop-assistant:validate-software-plugin-target",
	installSoftwarePlugin: "desktop-assistant:install-software-plugin",
	uninstallSoftwarePlugin: "desktop-assistant:uninstall-software-plugin",
	testSoftwarePluginBridge: "desktop-assistant:test-software-plugin-bridge",
	softwarePluginProgress: "desktop-assistant:software-plugin-progress",
	listForgeExtensions: "desktop-assistant:list-forge-extensions",
	setForgeExtensionTrust: "desktop-assistant:set-forge-extension-trust",
	deleteForgeExtension: "desktop-assistant:delete-forge-extension",
	openPluginManagerWindow: "desktop-assistant:open-plugin-manager-window",
	approveConfirmation: "desktop-assistant:approve-confirmation",
	rejectConfirmation: "desktop-assistant:reject-confirmation",
	getSkillFile: "desktop-assistant:get-skill-file",
	updateSkillFile: "desktop-assistant:update-skill-file",
	listPersonalSkills: "desktop-assistant:list-personal-skills",
	searchPersonalSkills: "desktop-assistant:search-personal-skills",
	readPersonalSkill: "desktop-assistant:read-personal-skill",
	savePersonalSkill: "desktop-assistant:save-personal-skill",
	archivePersonalSkill: "desktop-assistant:archive-personal-skill",
	refreshPersonalSkills: "desktop-assistant:refresh-personal-skills",
	openPersonalSkillManagerWindow: "desktop-assistant:open-personal-skill-manager-window",
	listConversationHistory: "desktop-assistant:list-conversation-history",
	resumeConversation: "desktop-assistant:resume-conversation",
	loadConversationPage: "desktop-assistant:load-conversation-page",
	deleteConversation: "desktop-assistant:delete-conversation",
	clearConversationHistory: "desktop-assistant:clear-conversation-history",
	listGlobalMemories: "desktop-assistant:list-global-memories",
	deleteGlobalMemory: "desktop-assistant:delete-global-memory",
	clearGlobalMemories: "desktop-assistant:clear-global-memories",
	updateGlobalMemory: "desktop-assistant:update-global-memory",
	memoList: "desktop-assistant:memo-list",
	memoCreate: "desktop-assistant:memo-create",
	memoUpdate: "desktop-assistant:memo-update",
	memoReorder: "desktop-assistant:memo-reorder",
	memoComplete: "desktop-assistant:memo-complete",
	memoSnooze: "desktop-assistant:memo-snooze",
	memoSetReminder: "desktop-assistant:memo-set-reminder",
	memoRunAutoNow: "desktop-assistant:memo-run-auto-now",
	memoDelete: "desktop-assistant:memo-delete",
	memoStats: "desktop-assistant:memo-stats",
	memoBatch: "desktop-assistant:memo-batch",
	memoListList: "desktop-assistant:memo-list-list",
	memoListCreate: "desktop-assistant:memo-list-create",
	memoListUpdate: "desktop-assistant:memo-list-update",
	memoListReorder: "desktop-assistant:memo-list-reorder",
	memoListDelete: "desktop-assistant:memo-list-delete",
	memoAttachmentAdd: "desktop-assistant:memo-attachment-add",
	memoAttachmentRemove: "desktop-assistant:memo-attachment-remove",
	automationList: "desktop-assistant:automation-list",
	automationGet: "desktop-assistant:automation-get",
	automationCreate: "desktop-assistant:automation-create",
	automationUpdate: "desktop-assistant:automation-update",
	automationDelete: "desktop-assistant:automation-delete",
	automationSetEnabled: "desktop-assistant:automation-set-enabled",
	automationRun: "desktop-assistant:automation-run",
	automationCancelRun: "desktop-assistant:automation-cancel-run",
	automationOpenEditor: "desktop-assistant:automation-open-editor",
	automationDraftGet: "desktop-assistant:automation-draft-get",
	automationDraftApply: "desktop-assistant:automation-draft-apply",
	automationDraftSave: "desktop-assistant:automation-draft-save",
	automationDesignChat: "desktop-assistant:automation-design-chat",
	automationDesignState: "desktop-assistant:automation-design-state",
	getAppLaunchCache: "desktop-assistant:get-app-launch-cache",
	clearAppLaunchCache: "desktop-assistant:clear-app-launch-cache",
	deleteAppLaunchCacheEntry: "desktop-assistant:delete-app-launch-cache-entry",
	openAppLaunchCacheWindow: "desktop-assistant:open-app-launch-cache-window",
	openUrlInDefaultBrowser: "desktop-assistant:open-url-in-default-browser",
	openPath: "desktop-assistant:open-path",
	showItemInFolder: "desktop-assistant:show-item-in-folder",
	copyFileToClipboard: "desktop-assistant:copy-file-to-clipboard",
	openBuiltInBrowser: "desktop-assistant:open-built-in-browser",
	getBuiltInBrowserStatus: "desktop-assistant:get-built-in-browser-status",
	builtInBrowserNavigate: "desktop-assistant:built-in-browser-navigate",
	builtInBrowserNewTab: "desktop-assistant:built-in-browser-new-tab",
	builtInBrowserSwitchTab: "desktop-assistant:built-in-browser-switch-tab",
	builtInBrowserCloseTab: "desktop-assistant:built-in-browser-close-tab",
	builtInBrowserCloseWindow: "desktop-assistant:built-in-browser-close-window",
	builtInBrowserGoBack: "desktop-assistant:built-in-browser-go-back",
	builtInBrowserGoForward: "desktop-assistant:built-in-browser-go-forward",
	builtInBrowserReload: "desktop-assistant:built-in-browser-reload",
	builtInBrowserStop: "desktop-assistant:built-in-browser-stop",
	builtInBrowserSetContentBounds: "desktop-assistant:built-in-browser-set-content-bounds",
	builtInBrowserClearStorage: "desktop-assistant:built-in-browser-clear-storage",
	builtInBrowserGetNativeStatus: "desktop-assistant:built-in-browser-get-native-status",
	builtInBrowserReadPage: "desktop-assistant:built-in-browser-read-page",
	builtInBrowserQueryElements: "desktop-assistant:built-in-browser-query-elements",
	builtInBrowserClick: "desktop-assistant:built-in-browser-click",
	builtInBrowserTypeText: "desktop-assistant:built-in-browser-type-text",
	builtInBrowserPressKey: "desktop-assistant:built-in-browser-press-key",
	builtInBrowserScroll: "desktop-assistant:built-in-browser-scroll",
	builtInBrowserScreenshot: "desktop-assistant:built-in-browser-screenshot",
	builtInBrowserGetCookies: "desktop-assistant:built-in-browser-get-cookies",
	builtInBrowserVirtualMouse: "desktop-assistant:built-in-browser-virtual-mouse",
	builtInBrowserEvent: "desktop-assistant:built-in-browser-event",
	listMoreApps: "desktop-assistant:list-more-apps",
	startMoreApp: "desktop-assistant:start-more-app",
	stopMoreApp: "desktop-assistant:stop-more-app",
	openMoreApp: "desktop-assistant:open-more-app",
	openMoreAppAtPath: "desktop-assistant:open-more-app-at-path",
	getMoreAppTerminal: "desktop-assistant:get-more-app-terminal",
	updateMoreAppConfig: "desktop-assistant:update-more-app-config",
	moreAppEvent: "desktop-assistant:more-app-event",
	getSandboxStatus: "desktop-assistant:get-sandbox-status",
	initSandbox: "desktop-assistant:init-sandbox",
	resetSandbox: "desktop-assistant:reset-sandbox",
	cleanSandbox: "desktop-assistant:clean-sandbox",
	openSandboxFolder: "desktop-assistant:open-sandbox-folder",
	openSandboxSettingsWindow: "desktop-assistant:open-sandbox-settings-window",
	openMcpManagerWindow: "desktop-assistant:open-mcp-manager-window",
	openToolsetManagerWindow: "desktop-assistant:open-toolset-manager-window",
	startVoice: "desktop-assistant:start-voice",
	stopVoice: "desktop-assistant:stop-voice",
	updateVoiceOverlay: "desktop-assistant:update-voice-overlay",
	transcribeAudio: "desktop-assistant:transcribe-audio",
	updateVoiceApiKey: "desktop-assistant:update-voice-api-key",
	listWakeWordModels: "desktop-assistant:list-wake-word-models",
	importWakeWordModel: "desktop-assistant:import-wake-word-model",
	deleteWakeWordModel: "desktop-assistant:delete-wake-word-model",
	readWakeWordModel: "desktop-assistant:read-wake-word-model",
	startWakeKws: "desktop-assistant:start-wake-kws",
	wakeKwsAudio: "desktop-assistant:wake-kws-audio",
	stopWakeKws: "desktop-assistant:stop-wake-kws",
	wakeKwsEvent: "desktop-assistant:wake-kws-event",
	events: "desktop-assistant:events",
	logEvent: "desktop-assistant:log-event",
	openLogWindow: "desktop-assistant:open-log-window",
	getLogEntries: "desktop-assistant:get-log-entries",
	updatePetDebug: "desktop-assistant:update-pet-debug",
	getPetDebug: "desktop-assistant:get-pet-debug",
	petDebugEvent: "desktop-assistant:pet-debug-event",
	windowSetMode: "desktop-assistant:window-set-mode",
	windowSetAlwaysOnTop: "desktop-assistant:window-set-always-on-top",
} as const;
