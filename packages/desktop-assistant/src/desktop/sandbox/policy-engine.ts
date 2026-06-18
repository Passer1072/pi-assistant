import type {
	AutomationPermissionMode,
	SandboxLane,
	SandboxNetworkSettings,
	SandboxPhase,
	SandboxSettings,
} from "../../shared/types.ts";
import { classifyAutomationRisk } from "../risk.ts";
import { isWithin, isWithinAny } from "./sandbox-workspace.ts";

/** What a tool action wants to do, in policy terms. */
export interface ActionContext {
	toolName: string;
	kind:
		| "shell"
		| "office_run"
		| "file_write"
		| "file_read"
		| "process_launch"
		| "desktop_input"
		| "system_config"
		| "network"
		| "sandbox_op"
		| "other";
	/** Lane the model asked for. Inherently-real actions are forced to "real". */
	lane: SandboxLane;
	permissionMode: AutomationPermissionMode;
	/** Command text for shell/office_run. */
	command?: string;
	/** Canonicalized write targets. */
	writePaths?: string[];
	/** Canonicalized read sources. */
	readPaths?: string[];
	/** URL for network actions. */
	url?: string;
	/** Free text used for risk classification when no command is present. */
	riskText?: string;
}

/** Canonicalized, resolved roots + live phase the engine needs at decision time. */
export interface SandboxRuntimeState {
	phase: SandboxPhase;
	sandboxRoot: string;
	writeRoots: string[];
	readRoots: string[];
	protectedPaths: string[];
}

export interface Decision {
	effect: "allow" | "confirm" | "deny";
	lane: SandboxLane;
	reason: string;
	/** Identifier of the rule that produced the decision (for audit/UI). */
	rule?: string;
	/** Machine-readable code for special handling (e.g. "sandbox_initializing"). */
	code?: string;
}

const DOWNLOAD_CMDLET =
	/\b(Invoke-WebRequest|iwr|curl|wget|Invoke-RestMethod|irm|Start-BitsTransfer|bitsadmin|certutil)\b/i;

const compiledCache = new Map<string, RegExp | null>();

function compile(source: string): RegExp | null {
	if (compiledCache.has(source)) return compiledCache.get(source) ?? null;
	let re: RegExp | null = null;
	try {
		re = new RegExp(source, "i");
	} catch {
		re = null;
	}
	compiledCache.set(source, re);
	return re;
}

function matchesAny(patterns: string[], text: string): string | undefined {
	for (const source of patterns) {
		const re = compile(source);
		if (re?.test(text)) return source;
	}
	return undefined;
}

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
	} catch {
		return undefined;
	}
}

/** SSRF guard: localhost / RFC1918 / link-local (incl. 169.254.169.254) / ULA / *.local. */
export function isPrivateHost(hostname: string): boolean {
	const h = hostname.toLowerCase();
	if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
	const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		if (a === 127 || a === 0 || a === 10) return true;
		if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
		return false;
	}
	if (h === "::1" || h === "::") return true;
	if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true; // link-local / ULA
	return false;
}

/** Standalone URL check, shared by the engine and the web tools. */
export function evaluateNetworkUrl(
	url: string,
	net: SandboxNetworkSettings,
): { allowed: boolean; reason?: string; rule?: string } {
	const host = hostOf(url);
	if (!host) return { allowed: true };
	if (net.blockPrivateIps && isPrivateHost(host)) {
		return { allowed: false, reason: `阻止访问内网/本机地址 ${host}（SSRF 防护）`, rule: "network.private_ip" };
	}
	const denied = net.domainDenyList.find((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));
	if (denied) return { allowed: false, reason: `域名 ${host} 在黑名单中`, rule: "network.deny_list" };
	if (net.domainAllowList.length > 0) {
		const ok = net.domainAllowList.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));
		if (!ok) return { allowed: false, reason: `域名 ${host} 不在白名单中`, rule: "network.allow_list" };
	}
	return { allowed: true };
}

function networkDecision(ctx: ActionContext, settings: SandboxSettings): Decision {
	if (!ctx.url) return { effect: "allow", lane: "real", reason: "网络读取允许", rule: "network.allow" };
	const verdict = evaluateNetworkUrl(ctx.url, settings.network);
	if (!verdict.allowed) {
		return {
			effect: "deny",
			lane: "real",
			reason: verdict.reason ?? "网络访问被拒绝",
			rule: verdict.rule,
			code: "ssrf_blocked",
		};
	}
	return { effect: "allow", lane: "real", reason: "网络读取允许", rule: "network.allow" };
}

/**
 * The single decision authority. Given an action, the sandbox settings, and the
 * live runtime state, returns allow/confirm/deny. Precedence: hard deny > lane
 * confinement > mode/gate. When `settings.enabled` is false, falls back to the
 * legacy risk×mode confirmation behaviour (no real isolation).
 */
export function evaluateAction(ctx: ActionContext, settings: SandboxSettings, state: SandboxRuntimeState): Decision {
	// ── Legacy fallback: behave exactly like the old requiresConfirmation() ──
	if (!settings.enabled) {
		return legacyDecision(ctx);
	}

	// Network reads are external but not real-system mutations; gate by network rules only.
	if (ctx.kind === "network") {
		return networkDecision(ctx, settings);
	}

	const cmd = ctx.command ?? "";
	const writePaths = ctx.writePaths ?? [];

	// ── 1. Hard deny (always wins) ───────────────────────────────────────────
	if (cmd) {
		const denyHit = matchesAny(settings.commands.denyPatterns, cmd);
		if (denyHit) {
			return {
				effect: "deny",
				lane: ctx.lane,
				reason: "命中危险命令黑名单，已禁止",
				rule: `command.deny:${denyHit}`,
			};
		}
		if (settings.commands.blockNetworkDownload && DOWNLOAD_CMDLET.test(cmd)) {
			return { effect: "deny", lane: ctx.lane, reason: "已禁止从网络下载到磁盘", rule: "command.block_download" };
		}
	}
	const protectedHit = writePaths.find((p) => isWithinAny(state.protectedPaths, p));
	if (protectedHit) {
		return { effect: "deny", lane: ctx.lane, reason: `禁止写入受保护路径：${protectedHit}`, rule: "fs.protected" };
	}

	// ── 2. Sandbox lane ──────────────────────────────────────────────────────
	if (ctx.lane === "sandbox") {
		if (ctx.kind === "desktop_input" || ctx.kind === "process_launch" || ctx.kind === "system_config") {
			return {
				effect: "deny",
				lane: "sandbox",
				reason: "该动作只能作用于真实系统，无法在沙箱内运行；请改用 real 车道",
				rule: "lane.real_only",
				code: "needs_real",
			};
		}
		const escaped = writePaths.find((p) => !isWithin(state.sandboxRoot, p));
		if (escaped) {
			return {
				effect: "deny",
				lane: "sandbox",
				reason: `沙箱车道不能写到沙箱外：${escaped}。请用 real 车道或 sandbox_export 导出成果`,
				rule: "lane.escape",
				code: "sandbox_escape",
			};
		}
		if (state.phase !== "ready") {
			const stuck = state.phase === "failed" || state.phase === "stuck";
			return {
				effect: "deny",
				lane: "sandbox",
				reason: stuck
					? "沙箱不可用（初始化失败/卡住）。可重置沙箱，或按权限在真实环境运行"
					: "沙箱仍在初始化，请稍等片刻后用 sandbox_status 轮询重试",
				rule: "lane.not_ready",
				code: stuck ? "sandbox_unavailable" : "sandbox_initializing",
			};
		}
		return { effect: "allow", lane: "sandbox", reason: "沙箱内安全运行，免审批", rule: "lane.sandbox_ok" };
	}

	// ── 3. Real lane ─────────────────────────────────────────────────────────
	if (ctx.permissionMode === "sandbox") {
		return { effect: "deny", lane: "real", reason: "仅沙盒模式禁止任何真实系统动作", rule: "mode.sandbox_only" };
	}

	const gate = settings.toolGates[ctx.toolName];
	if (gate === "deny") {
		return { effect: "deny", lane: "real", reason: `工具 ${ctx.toolName} 被设置为禁止`, rule: "gate.deny" };
	}

	// Hard write confinement (deny) only when explicitly enabled.
	const outsideWrite = writePaths.find((p) => !isWithinAny(state.writeRoots, p));
	if (outsideWrite && settings.filesystem.confineWritesToRoots) {
		return { effect: "deny", lane: "real", reason: `禁止写入允许根目录之外：${outsideWrite}`, rule: "fs.confine" };
	}

	// An explicit user-set "confirm" gate is a deliberate tightening and wins over
	// the mode (even full_access). "allow" is an explicit whitelist.
	if (gate === "confirm") {
		return { effect: "confirm", lane: "real", reason: `工具 ${ctx.toolName} 被设置为需确认`, rule: "gate.confirm" };
	}
	if (gate === "allow") {
		return { effect: "allow", lane: "real", reason: `工具 ${ctx.toolName} 已加入放行白名单`, rule: "gate.allow" };
	}

	const baseline = realBaselineEffect(ctx);
	if (baseline === "deny") {
		return { effect: "deny", lane: "real", reason: "真实系统动作被拒绝", rule: `mode.${ctx.permissionMode}` };
	}

	// Writing outside the allowed roots is unusual, so soft-confirm it — EXCEPT in
	// full_access (完全控制), where the user has opted into auto-approving all real
	// actions. Without this exception full-control would still prompt for every
	// out-of-root write (e.g. a sandbox_export to G:\…).
	if (baseline === "allow" && outsideWrite && ctx.permissionMode !== "full_access") {
		return {
			effect: "confirm",
			lane: "real",
			reason: `写入允许根目录之外需用户确认：${outsideWrite}`,
			rule: "fs.outside_root",
		};
	}

	return {
		effect: baseline,
		lane: "real",
		reason: baseline === "allow" ? "真实系统动作已自动放行" : "真实系统动作需用户批准",
		rule: `mode.${ctx.permissionMode}`,
	};
}

function realBaselineEffect(ctx: ActionContext): "allow" | "confirm" | "deny" {
	switch (ctx.permissionMode) {
		case "full_access":
			return "allow";
		case "tiered":
			return "confirm";
		case "automatic": {
			const risk = classifyAutomationRisk(ctx.riskText ?? ctx.command ?? `${ctx.kind} ${ctx.toolName}`);
			return risk === "high" ? "confirm" : "allow";
		}
		default:
			return "confirm";
	}
}

/** Old behaviour, used when the sandbox master switch is off. */
function legacyDecision(ctx: ActionContext): Decision {
	const risk = classifyAutomationRisk(ctx.riskText ?? ctx.command ?? `${ctx.kind} ${ctx.toolName}`);
	switch (ctx.permissionMode) {
		case "full_access":
			return { effect: "allow", lane: "real", reason: "完全访问", rule: "legacy.full_access" };
		case "sandbox":
			return { effect: "confirm", lane: "real", reason: "沙盒模式（旧）需确认", rule: "legacy.sandbox" };
		case "automatic":
			return {
				effect: risk === "high" ? "confirm" : "allow",
				lane: "real",
				reason: "自动模式（旧）",
				rule: "legacy.automatic",
			};
		default:
			return {
				effect: risk === "high" ? "confirm" : "allow",
				lane: "real",
				reason: "分级模式（旧）",
				rule: "legacy.tiered",
			};
	}
}

// Presets live in shared/types.ts (pure, renderer-safe); re-export for engine consumers.
export { SANDBOX_PRESETS } from "../../shared/types.ts";
