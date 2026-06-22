import { describe, expect, it } from "vitest";
import {
	type ActionContext,
	evaluateAction,
	evaluateNetworkUrl,
	isPrivateHost,
	SANDBOX_PRESETS,
	type SandboxRuntimeState,
} from "../src/desktop/sandbox/policy-engine.ts";
import { DEFAULT_SANDBOX_SETTINGS, type SandboxSettings } from "../src/shared/types.ts";

const ROOT = "c:\\sandbox";

function runtime(overrides: Partial<SandboxRuntimeState> = {}): SandboxRuntimeState {
	return {
		phase: "ready",
		sandboxRoot: ROOT,
		writeRoots: [ROOT, "c:\\users\\me\\documents"],
		readRoots: [ROOT, "c:\\users\\me"],
		protectedPaths: ["c:\\windows", "c:\\program files"],
		...overrides,
	};
}

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
	return {
		toolName: "shell_command_safe",
		kind: "shell",
		lane: "sandbox",
		permissionMode: "tiered",
		...overrides,
	};
}

describe("evaluateAction — sandbox lane", () => {
	it("allows safe sandbox-internal work without approval in any mode", () => {
		for (const mode of ["tiered", "automatic", "full_access", "sandbox"] as const) {
			const d = evaluateAction(
				ctx({ permissionMode: mode, command: "Get-Date" }),
				DEFAULT_SANDBOX_SETTINGS,
				runtime(),
			);
			expect(d.effect).toBe("allow");
			expect(d.lane).toBe("sandbox");
		}
	});

	it("blocks sandbox-lane work while initializing with a pollable code", () => {
		const d = evaluateAction(
			ctx({ command: "Get-Date" }),
			DEFAULT_SANDBOX_SETTINGS,
			runtime({ phase: "initializing" }),
		);
		expect(d.effect).toBe("deny");
		expect(d.code).toBe("sandbox_initializing");
	});

	it("reports sandbox unavailable when stuck/failed", () => {
		const d = evaluateAction(ctx({ command: "Get-Date" }), DEFAULT_SANDBOX_SETTINGS, runtime({ phase: "stuck" }));
		expect(d.effect).toBe("deny");
		expect(d.code).toBe("sandbox_unavailable");
	});

	it("denies a sandbox-lane write that escapes the sandbox root", () => {
		const d = evaluateAction(
			ctx({ kind: "file_write", writePaths: ["c:\\users\\me\\documents\\out.docx"] }),
			DEFAULT_SANDBOX_SETTINGS,
			runtime(),
		);
		expect(d.effect).toBe("deny");
		expect(d.code).toBe("sandbox_escape");
	});

	it("denies inherently-real actions on the sandbox lane", () => {
		const d = evaluateAction(ctx({ kind: "desktop_input" }), DEFAULT_SANDBOX_SETTINGS, runtime());
		expect(d.effect).toBe("deny");
		expect(d.code).toBe("needs_real");
	});
});

describe("evaluateAction — real lane × permission mode", () => {
	const real = (mode: ActionContext["permissionMode"], over: Partial<ActionContext> = {}) =>
		evaluateAction(
			ctx({ lane: "real", permissionMode: mode, command: "Get-Process", ...over }),
			DEFAULT_SANDBOX_SETTINGS,
			runtime(),
		);

	it("full_access auto-approves real actions", () => {
		expect(real("full_access").effect).toBe("allow");
	});
	it("tiered requires confirmation for all real actions", () => {
		expect(real("tiered").effect).toBe("confirm");
	});
	it("sandbox-only mode denies real actions", () => {
		expect(real("sandbox").effect).toBe("deny");
	});
	it("automatic confirms high-risk but allows low-risk real actions", () => {
		expect(real("automatic", { command: "shutdown /r", riskText: "shutdown /r" }).effect).toBe("confirm");
		expect(real("automatic", { command: "Get-Process", riskText: "Get-Process" }).effect).toBe("allow");
	});

	it("honours per-run autoApproveMaxRisk thresholds", () => {
		expect(real("tiered", { command: "Get-Date", riskText: "Get-Date", autoApproveMaxRisk: "low" }).effect).toBe(
			"allow",
		);
		expect(
			real("tiered", { command: "New-Item file.txt", riskText: "New-Item file.txt", autoApproveMaxRisk: "low" })
				.effect,
		).toBe("confirm");
		expect(
			real("tiered", { command: "New-Item file.txt", riskText: "New-Item file.txt", autoApproveMaxRisk: "medium" })
				.effect,
		).toBe("allow");
		expect(
			real("tiered", { command: "shutdown /r", riskText: "shutdown /r", autoApproveMaxRisk: "medium" }).effect,
		).toBe("confirm");
		expect(
			real("tiered", { command: "shutdown /r", riskText: "shutdown /r", autoApproveMaxRisk: "high" }).effect,
		).toBe("allow");
	});
});

describe("evaluateAction — hard rules win over mode", () => {
	it("denies destructive commands even under full_access", () => {
		const d = evaluateAction(
			ctx({ lane: "real", permissionMode: "full_access", command: "format C:" }),
			DEFAULT_SANDBOX_SETTINGS,
			runtime(),
		);
		expect(d.effect).toBe("deny");
		expect(d.rule).toMatch(/command\.deny/);
	});

	it("denies writes to protected paths", () => {
		const d = evaluateAction(
			ctx({
				lane: "real",
				permissionMode: "full_access",
				kind: "file_write",
				writePaths: ["c:\\windows\\system32\\x.dll"],
			}),
			DEFAULT_SANDBOX_SETTINGS,
			runtime(),
		);
		expect(d.effect).toBe("deny");
		expect(d.rule).toBe("fs.protected");
	});

	it("honours an explicit tool gate of confirm/deny", () => {
		const settings: SandboxSettings = { ...DEFAULT_SANDBOX_SETTINGS, toolGates: { office_word_run: "confirm" } };
		const d = evaluateAction(
			ctx({
				toolName: "office_word_run",
				kind: "office_run",
				lane: "real",
				permissionMode: "full_access",
				command: "x",
			}),
			settings,
			runtime(),
		);
		expect(d.effect).toBe("confirm");
	});

	it("confines real writes outside writeRoots when confineWritesToRoots is on", () => {
		const confined: SandboxSettings = {
			...DEFAULT_SANDBOX_SETTINGS,
			filesystem: { ...DEFAULT_SANDBOX_SETTINGS.filesystem, confineWritesToRoots: true },
		};
		const d = evaluateAction(
			ctx({ lane: "real", permissionMode: "full_access", kind: "file_write", writePaths: ["d:\\elsewhere\\x.txt"] }),
			confined,
			runtime(),
		);
		expect(d.effect).toBe("deny");
		expect(d.rule).toBe("fs.confine");
	});

	it("soft-confirms out-of-root real writes under non-full-access modes", () => {
		const d = evaluateAction(
			ctx({
				lane: "real",
				permissionMode: "automatic",
				kind: "file_write",
				command: "copy",
				riskText: "copy",
				writePaths: ["d:\\elsewhere\\x.txt"],
			}),
			DEFAULT_SANDBOX_SETTINGS,
			runtime(),
		);
		expect(d.effect).toBe("confirm");
		expect(d.rule).toBe("fs.outside_root");
	});

	it("full_access (完全控制) auto-approves out-of-root real writes — no prompt", () => {
		const d = evaluateAction(
			ctx({
				lane: "real",
				permissionMode: "full_access",
				kind: "file_write",
				writePaths: ["g:\\个人文件\\王涛.docx"],
			}),
			DEFAULT_SANDBOX_SETTINGS,
			runtime(),
		);
		expect(d.effect).toBe("allow");
	});
});

describe("evaluateAction — disabled sandbox falls back to legacy behaviour", () => {
	const disabled: SandboxSettings = { ...DEFAULT_SANDBOX_SETTINGS, enabled: false };
	it("matches the old requiresConfirmation semantics", () => {
		expect(evaluateAction(ctx({ permissionMode: "full_access", command: "x" }), disabled, runtime()).effect).toBe(
			"allow",
		);
		expect(evaluateAction(ctx({ permissionMode: "sandbox", command: "x" }), disabled, runtime()).effect).toBe(
			"confirm",
		);
		expect(
			evaluateAction(
				ctx({ permissionMode: "automatic", command: "shutdown", riskText: "shutdown" }),
				disabled,
				runtime(),
			).effect,
		).toBe("confirm");
		expect(
			evaluateAction(
				ctx({ permissionMode: "automatic", command: "Get-Date", riskText: "Get-Date" }),
				disabled,
				runtime(),
			).effect,
		).toBe("allow");
	});
});

describe("network policy", () => {
	it("flags private / metadata hosts", () => {
		expect(isPrivateHost("127.0.0.1")).toBe(true);
		expect(isPrivateHost("169.254.169.254")).toBe(true);
		expect(isPrivateHost("10.1.2.3")).toBe(true);
		expect(isPrivateHost("192.168.0.1")).toBe(true);
		expect(isPrivateHost("172.16.5.5")).toBe(true);
		expect(isPrivateHost("localhost")).toBe(true);
		expect(isPrivateHost("example.com")).toBe(false);
		expect(isPrivateHost("8.8.8.8")).toBe(false);
	});

	it("blocks SSRF and honours allow/deny lists", () => {
		const net = { domainAllowList: [], domainDenyList: ["evil.com"], blockPrivateIps: true };
		expect(evaluateNetworkUrl("http://169.254.169.254/latest", net).allowed).toBe(false);
		expect(evaluateNetworkUrl("https://evil.com/x", net).allowed).toBe(false);
		expect(evaluateNetworkUrl("https://good.com/x", net).allowed).toBe(true);
		const allowOnly = { domainAllowList: ["good.com"], domainDenyList: [], blockPrivateIps: true };
		expect(evaluateNetworkUrl("https://other.com", allowOnly).allowed).toBe(false);
		expect(evaluateNetworkUrl("https://good.com", allowOnly).allowed).toBe(true);
	});
});

describe("presets", () => {
	it("strict tightens, permissive loosens write confinement, balanced is the default", () => {
		expect(SANDBOX_PRESETS.balanced().preset).toBe("balanced");
		expect(SANDBOX_PRESETS.strict().filesystem.confineWritesToRoots).toBe(true);
		expect(SANDBOX_PRESETS.strict().commands.blockNetworkDownload).toBe(true);
		expect(SANDBOX_PRESETS.permissive().filesystem.confineWritesToRoots).toBe(false);
		expect(SANDBOX_PRESETS.permissive().network.blockPrivateIps).toBe(true);
	});
});
