import { randomUUID } from "node:crypto";
import type {
	AutomationPermissionMode,
	AutomationRiskLevel,
	DesktopToolResult,
	SandboxLane,
	SandboxSettings,
} from "../../shared/types.ts";
import { classifyAutomationRisk } from "../risk.ts";
import { type ActionContext, type Decision, evaluateAction, type SandboxRuntimeState } from "./policy-engine.ts";
import { canonicalize, isWithin } from "./sandbox-workspace.ts";

/** Sandbox view a tool needs to make one gating decision. */
export interface SandboxToolEnv {
	settings: SandboxSettings;
	permissionMode: AutomationPermissionMode;
	autoApproveMaxRisk?: AutomationRiskLevel;
	runtime: SandboxRuntimeState;
}

export interface GateRequest {
	toolName: string;
	kind: ActionContext["kind"];
	/** Requested lane. Inherently-real actions should pass "real". Defaults to "sandbox". */
	lane?: SandboxLane;
	intent: string;
	action: string;
	target: string;
	command?: string;
	url?: string;
	/** Raw (un-canonicalized) write targets; canonicalized against the sandbox root here. */
	writePathsRaw?: string[];
	readPathsRaw?: string[];
	riskText?: string;
}

export interface GateOutcome {
	decision: Decision;
	ctx: ActionContext;
	/** Lane the action should actually run in (may be auto-classified from paths). */
	lane: SandboxLane;
	/** Present when the action must not run as-is (confirm or deny). */
	blocked?: DesktopToolResult;
}

/**
 * Auto-classify the lane for a path-bearing action: if every write target sits
 * inside the sandbox root it is sandbox-internal; otherwise it crosses to the
 * real system. Explicit `requestedLane` (from a tool's `target` param) wins.
 */
function resolveLane(requestedLane: SandboxLane | undefined, writePaths: string[], sandboxRoot: string): SandboxLane {
	if (requestedLane) return requestedLane;
	if (writePaths.length > 0 && sandboxRoot) {
		return writePaths.every((p) => isWithin(sandboxRoot, p)) ? "sandbox" : "real";
	}
	return "sandbox";
}

export function gateAction(env: SandboxToolEnv, req: GateRequest): GateOutcome {
	const sandboxRoot = env.runtime.sandboxRoot;
	const writePaths = (req.writePathsRaw ?? []).map((p) => canonicalize(p, sandboxRoot || process.cwd()));
	const readPaths = (req.readPathsRaw ?? []).map((p) => canonicalize(p, sandboxRoot || process.cwd()));
	const lane = resolveLane(req.lane, writePaths, sandboxRoot);
	const ctx: ActionContext = {
		toolName: req.toolName,
		kind: req.kind,
		lane,
		permissionMode: env.permissionMode,
		autoApproveMaxRisk: env.autoApproveMaxRisk,
		command: req.command,
		url: req.url,
		writePaths,
		readPaths,
		riskText: req.riskText,
	};
	const decision = evaluateAction(ctx, env.settings, env.runtime);
	if (decision.effect === "allow") {
		return { decision, ctx, lane };
	}
	const riskLevel = classifyAutomationRisk(req.riskText ?? req.command ?? `${req.action} ${req.target}`);
	const nextActions: string[] = [];
	if (decision.code === "sandbox_initializing") {
		nextActions.push("调用 sandbox_status 轮询，待 phase=ready 后重试", "向用户说明沙箱仍在初始化，请稍候");
	} else if (decision.code === "sandbox_unavailable") {
		nextActions.push("调用 sandbox_reset 重置沙箱", "或按当前权限模式请求在真实环境运行");
	} else if (decision.code === "sandbox_escape") {
		nextActions.push("改用 real 车道写真实路径，或先在沙箱内完成再用 sandbox_export 导出");
	}
	const blocked: DesktopToolResult = {
		stepId: randomUUID(),
		intent: req.intent,
		action: req.action,
		target: req.target,
		status: "blocked",
		riskLevel,
		requiresConfirmation: decision.effect === "confirm",
		stderr: decision.reason,
		nextActions: nextActions.length > 0 ? nextActions : undefined,
	};
	return { decision, ctx, lane, blocked };
}

/** Disabled sandbox used when a tool host provides no sandbox settings (tests). Reproduces legacy behaviour. */
export const LEGACY_DISABLED_SANDBOX: SandboxSettings = {
	enabled: false,
	preset: "custom",
	workspace: {
		scope: "global",
		quotaMb: 0,
		warnAtPercent: 100,
		overQuotaPolicy: "confirm",
		cleanOnSessionEnd: false,
		autoInitOnStartup: false,
		keepWarmProcess: false,
	},
	filesystem: {
		writeRoots: [],
		readRoots: [],
		protectedPaths: [],
		confineWritesToRoots: false,
		denySymlinkEscape: false,
	},
	commands: { denyPatterns: [], allowPatterns: [], blockNetworkDownload: false },
	network: { domainAllowList: [], domainDenyList: [], blockPrivateIps: false },
	toolGates: {},
	resourceLimits: {
		commandTimeoutMs: 30000,
		maxOutputChars: 1_000_000,
		maxConcurrentProcesses: 8,
		killProcessTree: false,
	},
	hardening: { runAsRestrictedUser: false },
	audit: { logDecisions: false },
	aiMayEdit: "tighten_only",
};

/** Runtime state used when no sandbox manager is wired (tests): treated as ready with no roots. */
export const LEGACY_RUNTIME_STATE: SandboxRuntimeState = {
	phase: "ready",
	sandboxRoot: "",
	writeRoots: [],
	readRoots: [],
	protectedPaths: [],
};

export type { Decision };
