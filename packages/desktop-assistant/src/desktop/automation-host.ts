import { createRequire } from "node:module";
import { Button, keyboard, mouse } from "@nut-tree-fork/nut-js";
import type { MediaCommand, WindowInfo } from "../shared/types.ts";
import { isTimeout, type PowerShellService } from "./powershell-service.ts";

// Re-export types so existing importers (tools.ts, etc.) don't need to change their import paths.
export type { CommandResult, PowerShellResult, PowerShellRunOptions, TimeoutResult } from "./powershell-service.ts";
export { isTimeout } from "./powershell-service.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Import aliases for local use
// ─────────────────────────────────────────────────────────────────────────────

import type { CommandResult, PowerShellResult, PowerShellRunOptions } from "./powershell-service.ts";

// ─────────────────────────────────────────────────────────────────────────────
// DesktopAutomationHost interface
// ─────────────────────────────────────────────────────────────────────────────

export interface DesktopAutomationHost {
	startProcess(file: string, args?: string[]): Promise<CommandResult>;
	/** Run a PowerShell script. Throws on timeout (auto-aborts the process). */
	runPowerShell(script: string, options?: number | PowerShellRunOptions): Promise<CommandResult>;
	/**
	 * Run a PowerShell script with managed timeout.
	 * Returns TimeoutResult (instead of throwing) so the AI can decide to
	 * continue waiting or abort. Process keeps running on timeout.
	 * `options` may be a bare timeout (back-compat) or sandbox cwd/env/limits.
	 */
	runPowerShellManaged(script: string, options?: number | PowerShellRunOptions): Promise<PowerShellResult>;
	/** Continue waiting for a previously timed-out managed execution. */
	continuePowerShell(executionId: string, timeoutMs: number): Promise<PowerShellResult>;
	/** Abort a running managed execution immediately. */
	abortPowerShell(executionId: string): void;
	runDesktopAction(action: string, target: string): Promise<CommandResult>;
	typeText(text: string): Promise<CommandResult>;
	keyTap(key: string, modifiers?: string[]): Promise<CommandResult>;
	sendKeyChord(key: string, modifiers?: string[]): Promise<CommandResult>;
	sendMediaCommand(command: MediaCommand): Promise<CommandResult>;
	mouseClick(button: "left" | "right" | "middle"): Promise<CommandResult>;
	listWindows(): Promise<WindowInfo[]>;
	focusWindow(titleOrProcess: string): Promise<CommandResult>;
	getActiveWindow(): Promise<WindowInfo | undefined>;
}

interface WindowManagerWindow {
	id: number;
	path: string;
	processId: number;
	getBounds(): { x?: number; y?: number; width?: number; height?: number };
	getTitle(): string;
	isWindow(): boolean;
	isVisible(): boolean;
	restore(): void;
	bringToTop(): void;
}

interface WindowManagerLike {
	getActiveWindow(): WindowManagerWindow;
	getWindows(): WindowManagerWindow[];
}

let cachedWindowManager: WindowManagerLike | undefined;
let windowManagerAvailable = true;
const require = createRequire(import.meta.url);

function getWindowManager(): WindowManagerLike | undefined {
	if (!windowManagerAvailable) return undefined;
	if (cachedWindowManager) return cachedWindowManager;
	try {
		cachedWindowManager = require("node-window-manager").windowManager as WindowManagerLike;
		return cachedWindowManager;
	} catch {
		windowManagerAvailable = false;
		return undefined;
	}
}

function windowToInfo(window: WindowManagerWindow, activeWindowId?: number): WindowInfo {
	const bounds = window.getBounds();
	return {
		title: window.getTitle(),
		processName: window.path ? window.path.replace(/^.*[/\\]/, "").replace(/\.exe$/i, "") : undefined,
		bounds: {
			x: bounds.x ?? 0,
			y: bounds.y ?? 0,
			width: bounds.width ?? 0,
			height: bounds.height ?? 0,
		},
		isActive: activeWindowId === undefined ? undefined : window.id === activeWindowId,
	};
}

function matchesWindow(window: WindowManagerWindow, query: string): boolean {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return false;
	const title = window.getTitle().toLowerCase();
	const processName = window.path
		.replace(/^.*[/\\]/, "")
		.replace(/\.exe$/i, "")
		.toLowerCase();
	return title.includes(normalized) || processName.includes(normalized);
}

function buildMediaCommandPowerShell(command: MediaCommand): string {
	const appCommandByCommand: Record<MediaCommand, number> = {
		play: 46,
		pause: 47,
		toggle: 14,
		next: 11,
		previous: 12,
	};
	const appCommand = appCommandByCommand[command];
	return [
		`Add-Type @'`,
		`using System;`,
		`using System.Runtime.InteropServices;`,
		`public static class MediaCommandSender {`,
		`  [DllImport("user32.dll", SetLastError=true)]`,
		`  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);`,
		`}`,
		`'@`,
		`$HWND_BROADCAST = [IntPtr]0xffff`,
		`$WM_APPCOMMAND = 0x0319`,
		`$APPCOMMAND = ${appCommand}`,
		`$lParam = [IntPtr]($APPCOMMAND -shl 16)`,
		`$result = [IntPtr]::Zero`,
		`[MediaCommandSender]::SendMessageTimeout($HWND_BROADCAST, $WM_APPCOMMAND, [IntPtr]::Zero, $lParam, 2, 1000, [ref]$result) | Out-Null`,
		`Write-Output "Sent media command: ${command}"`,
	].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// WindowsDesktopAutomationHost – production implementation
// ─────────────────────────────────────────────────────────────────────────────

export class WindowsDesktopAutomationHost implements DesktopAutomationHost {
	private readonly service: PowerShellService;

	constructor(service: PowerShellService) {
		this.service = service;
	}

	async startProcess(file: string, args: string[] = []): Promise<CommandResult> {
		// PowerShell Start-Process detaches GUI apps immediately, handles Store app
		// shell: URIs (shell:AppsFolder\...), ms-settings:, http://, plain exe names, and full paths.
		const safeFile = file.replace(/'/g, "''");
		const argsStr =
			args.length > 0 ? ` -ArgumentList @(${args.map((a) => `'${a.replace(/'/g, "''")}'`).join(",")})` : "";
		const script = `Start-Process '${safeFile}'${argsStr} -ErrorAction Stop; Write-Output 'Started'`;
		return this.runPowerShell(script);
	}

	async runPowerShell(script: string, options?: number | PowerShellRunOptions): Promise<CommandResult> {
		const result = await this.service.execute(script, options);
		if (isTimeout(result)) {
			// Built-in (non-managed) callers always abort on timeout
			this.service.abortExecution(result.executionId);
			throw new Error(`PowerShell 命令执行超时（${result.elapsedSeconds} 秒），已自动中止。`);
		}
		return result;
	}

	runPowerShellManaged(script: string, options?: number | PowerShellRunOptions): Promise<PowerShellResult> {
		return this.service.execute(script, options);
	}

	continuePowerShell(executionId: string, timeoutMs: number): Promise<PowerShellResult> {
		return this.service.continueExecution(executionId, timeoutMs);
	}

	abortPowerShell(executionId: string): void {
		this.service.abortExecution(executionId);
	}

	async runDesktopAction(action: string, target: string): Promise<CommandResult> {
		if (action === "powershell") return this.runPowerShell(target);
		if (action === "open-uri") return this.startProcess(target);
		if (action === "start-process") return this.startProcess(target);
		if (action === "type") return this.typeText(target);
		if (action === "key") return this.keyTap(target);
		if (action === "click") {
			const button = target === "right" || target === "middle" ? target : "left";
			return this.mouseClick(button);
		}
		return { stdout: "", stderr: `Unsupported approved desktop action: ${action}` };
	}

	async typeText(text: string): Promise<CommandResult> {
		await keyboard.type(text);
		return { stdout: `Typed ${text.length} characters`, stderr: "" };
	}

	async keyTap(key: string, modifiers: string[] = []): Promise<CommandResult> {
		return this.sendKeyChord(key, modifiers);
	}

	async sendKeyChord(key: string, modifiers: string[] = []): Promise<CommandResult> {
		const pressedModifiers: string[] = [];
		try {
			for (const modifier of modifiers) {
				await keyboard.pressKey(modifier as never);
				pressedModifiers.push(modifier);
			}
			await keyboard.pressKey(key as never);
			await keyboard.releaseKey(key as never);
		} finally {
			for (const modifier of pressedModifiers.reverse()) {
				await keyboard.releaseKey(modifier as never);
			}
		}
		return { stdout: `Pressed ${[...modifiers, key].join("+")}`, stderr: "" };
	}

	async sendMediaCommand(command: MediaCommand): Promise<CommandResult> {
		return this.runPowerShell(buildMediaCommandPowerShell(command));
	}

	async mouseClick(button: "left" | "right" | "middle"): Promise<CommandResult> {
		const buttonMap = {
			left: Button.LEFT,
			right: Button.RIGHT,
			middle: Button.MIDDLE,
		};
		await mouse.click(buttonMap[button]);
		return { stdout: `Clicked ${button}`, stderr: "" };
	}

	async listWindows(): Promise<WindowInfo[]> {
		const manager = getWindowManager();
		if (manager) {
			const activeWindow = manager.getActiveWindow();
			const activeWindowId = activeWindow?.id;
			return manager
				.getWindows()
				.filter((window) => window.isVisible() && window.getTitle().trim())
				.map((window) => windowToInfo(window, activeWindowId));
		}
		const script = [
			"Get-Process",
			"| Where-Object { $_.MainWindowTitle }",
			"| Select-Object @{Name='title';Expression={$_.MainWindowTitle}},@{Name='processName';Expression={$_.ProcessName}}",
			"| ConvertTo-Json -Compress",
		].join(" ");
		const result = await this.runPowerShell(script);
		if (!result.stdout.trim()) return [];
		const parsed = JSON.parse(result.stdout) as WindowInfo | WindowInfo[];
		return Array.isArray(parsed) ? parsed : [parsed];
	}

	async focusWindow(titleOrProcess: string): Promise<CommandResult> {
		const manager = getWindowManager();
		if (manager) {
			const target = manager
				.getWindows()
				.find((window) => window.isVisible() && matchesWindow(window, titleOrProcess));
			if (!target) {
				return { stdout: "", stderr: `No visible window matched: ${titleOrProcess}` };
			}
			target.restore();
			target.bringToTop();
			return { stdout: `Focused window: ${target.getTitle()}`, stderr: "" };
		}
		const safeTarget = titleOrProcess.replace(/'/g, "''");
		const script = [
			`$target = '${safeTarget}'.ToLowerInvariant()`,
			`$p = Get-Process | Where-Object { $_.MainWindowTitle -and ($_.MainWindowTitle.ToLowerInvariant().Contains($target) -or $_.ProcessName.ToLowerInvariant().Contains($target)) } | Select-Object -First 1`,
			`if (-not $p) { Write-Error "No visible window matched: ${safeTarget}"; exit 1 }`,
			`$sig = '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'`,
			`$type = Add-Type -MemberDefinition $sig -Name WinFocus -Namespace Native -PassThru`,
			`$type::ShowWindow($p.MainWindowHandle, 9) | Out-Null`,
			`$type::SetForegroundWindow($p.MainWindowHandle) | Out-Null`,
			`Write-Output "Focused window: $($p.MainWindowTitle)"`,
		].join("\n");
		return this.runPowerShell(script);
	}

	async getActiveWindow(): Promise<WindowInfo | undefined> {
		const manager = getWindowManager();
		if (manager) {
			const activeWindow = manager.getActiveWindow();
			if (!activeWindow || !activeWindow.isWindow()) return undefined;
			return windowToInfo(activeWindow, activeWindow.id);
		}
		return undefined;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DryRunDesktopAutomationHost – test/preview implementation
// ─────────────────────────────────────────────────────────────────────────────

export class DryRunDesktopAutomationHost implements DesktopAutomationHost {
	async startProcess(file: string, args: string[] = []): Promise<CommandResult> {
		return { stdout: `DRY RUN start ${file} ${args.join(" ")}`.trim(), stderr: "" };
	}

	async runPowerShell(script: string, _options?: number | PowerShellRunOptions): Promise<CommandResult> {
		return { stdout: `DRY RUN powershell ${script}`, stderr: "" };
	}

	async runPowerShellManaged(script: string, _options?: number | PowerShellRunOptions): Promise<PowerShellResult> {
		return { stdout: `DRY RUN powershell managed ${script}`, stderr: "" };
	}

	async continuePowerShell(executionId: string): Promise<PowerShellResult> {
		return { stdout: `DRY RUN continue ${executionId}`, stderr: "" };
	}

	abortPowerShell(_executionId: string): void {
		// no-op in dry-run
	}

	async runDesktopAction(action: string, target: string): Promise<CommandResult> {
		return { stdout: `DRY RUN approved ${action} ${target}`.trim(), stderr: "" };
	}

	async typeText(text: string): Promise<CommandResult> {
		return { stdout: `DRY RUN type ${text}`, stderr: "" };
	}

	async keyTap(key: string, modifiers: string[] = []): Promise<CommandResult> {
		return this.sendKeyChord(key, modifiers);
	}

	async sendKeyChord(key: string, modifiers: string[] = []): Promise<CommandResult> {
		return { stdout: `DRY RUN key ${[...modifiers, key].join("+")}`, stderr: "" };
	}

	async sendMediaCommand(command: MediaCommand): Promise<CommandResult> {
		return { stdout: `DRY RUN media ${command}`, stderr: "" };
	}

	async mouseClick(button: "left" | "right" | "middle"): Promise<CommandResult> {
		return { stdout: `DRY RUN click ${button}`, stderr: "" };
	}

	async listWindows(): Promise<WindowInfo[]> {
		return [
			{
				title: "DRY RUN Desktop Assistant",
				processName: "desktop-assistant",
				bounds: { x: 0, y: 0, width: 800, height: 600 },
				isActive: true,
			},
		];
	}

	async focusWindow(titleOrProcess: string): Promise<CommandResult> {
		return { stdout: `DRY RUN focus ${titleOrProcess}`, stderr: "" };
	}

	async getActiveWindow(): Promise<WindowInfo | undefined> {
		return {
			title: "DRY RUN Desktop Assistant",
			processName: "desktop-assistant",
			bounds: { x: 0, y: 0, width: 800, height: 600 },
			isActive: true,
		};
	}
}
