#!/usr/bin/env node
/**
 * OOPZ control MCP server.
 *
 * This server does not inject code into OOPZ and does not modify the install
 * directory. OOPZ is a Flutter Windows app, and its UI automation tree exposes
 * only the top-level FLUTTERVIEW, so control is done through Win32 focus,
 * screenshots, keyboard, and mouse input.
 *
 * Env vars:
 *   OOPZ_EXE_PATH       default D:\OOPZ\oopz\oopz-runner.exe
 *   OOPZ_PROCESS_NAME   default oopz
 *   OOPZ_AUTO_LAUNCH    "1" to launch when a command needs the app
 *   OOPZ_SCREENSHOT_DIR optional screenshot output directory
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const EXE_PATH = process.env.OOPZ_EXE_PATH || "D:\\OOPZ\\oopz\\oopz-runner.exe";
const PROCESS_NAME = process.env.OOPZ_PROCESS_NAME || "oopz";
const AUTO_LAUNCH = process.env.OOPZ_AUTO_LAUNCH === "1";
const SCREENSHOT_DIR = resolve(process.env.OOPZ_SCREENSHOT_DIR || join(process.cwd(), ".tmp", "oopz-screens"));

const SEMANTIC_POINTS = {
	discovery: { x: 130, y: 86, description: "Discovery page" },
	team_hall: { x: 155, y: 133, description: "Team hall" },
	entertainment_party: { x: 155, y: 181, description: "Entertainment party" },
	companion_zone: { x: 155, y: 228, description: "Companion zone" },
	task_center: { x: 155, y: 273, description: "Task center" },
	voice_music: { x: 22, y: 281, description: "Voice music sidebar entry" },
	search: { x: 460, y: 31, description: "Search box" },
	toggle_microphone: { x: 201, y: 31, description: "Top microphone button" },
	toggle_headset: { x: 234, y: 31, description: "Top headset button" },
	first_visible_join_team: { x: 455, y: 250, description: "First visible join-team button" },
};

function ok(payload) {
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(error) {
	const message = error instanceof Error ? error.message : String(error);
	return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, message }, null, 2) }] };
}

function tool(server, name, title, description, inputSchema, handler) {
	server.registerTool(name, { title, description, inputSchema }, async (args) => {
		try {
			return ok(await handler(args || {}));
		} catch (error) {
			return fail(error);
		}
	});
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function psString(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(script, { timeoutMs = 15000 } = {}) {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
			{ windowsHide: true },
		);
		const stdout = [];
		const stderr = [];
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {}
			rejectRun(new Error(`PowerShell timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.on("error", (error) => {
			clearTimeout(timer);
			rejectRun(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const out = Buffer.concat(stdout).toString("utf8").trim();
			const err = Buffer.concat(stderr).toString("utf8").trim();
			if (code !== 0) {
				rejectRun(new Error(err || out || `PowerShell exited with code ${code}`));
				return;
			}
			resolveRun(out);
		});
	});
}

async function runJsonPowerShell(script, options) {
	const text = await runPowerShell(script, options);
	if (!text) return undefined;
	return JSON.parse(text);
}

function win32Prelude(typeName = "OopzWin32") {
	return `
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ${typeName} {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@
Add-Type $code -ErrorAction SilentlyContinue
`;
}

function windowInfoScript() {
	return `
${win32Prelude("OopzWinInfo")}
$processName = ${psString(PROCESS_NAME)}
$processes = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
$plainProcesses = [System.Collections.ArrayList]::new()
foreach ($proc in $processes) {
  $path = $null
  try { $path = $proc.Path } catch {}
  [void]$plainProcesses.Add([ordered]@{
    id = [int]$proc.Id
    processName = [string]$proc.ProcessName
    path = $path
    mainWindowTitle = [string]$proc.MainWindowTitle
  })
}
$windows = [System.Collections.ArrayList]::new()
[OopzWinInfo]::EnumWindows({
  param($h, $l)
  if (-not [OopzWinInfo]::IsWindowVisible($h)) { return $true }
  [uint32]$windowProcId = 0
  [void][OopzWinInfo]::GetWindowThreadProcessId($h, [ref]$windowProcId)
  $p = Get-Process -Id $windowProcId -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq $processName) {
    $title = [Text.StringBuilder]::new(256)
    [void][OopzWinInfo]::GetWindowText($h, $title, 256)
    $className = [Text.StringBuilder]::new(256)
    [void][OopzWinInfo]::GetClassName($h, $className, 256)
    $rect = New-Object OopzWinInfo+RECT
    [void][OopzWinInfo]::GetWindowRect($h, [ref]$rect)
    [void]$windows.Add([ordered]@{
      hwnd = ('0x{0:X}' -f $h.ToInt64())
      pid = [int]$windowProcId
      title = $title.ToString()
      className = $className.ToString()
      left = [int]$rect.Left
      top = [int]$rect.Top
      width = [int]($rect.Right - $rect.Left)
      height = [int]($rect.Bottom - $rect.Top)
      minimized = ($rect.Left -le -30000 -or $rect.Top -le -30000)
    })
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
$ports = [System.Collections.ArrayList]::new()
$connections = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
foreach ($p in $processes) {
  foreach ($connection in $connections) {
    if ($connection.OwningProcess -ne $p.Id) { continue }
    [void]$ports.Add([ordered]@{
      localAddress = [string]$connection.LocalAddress
      localPort = [int]$connection.LocalPort
      owningProcess = [int]$connection.OwningProcess
    })
  }
}
$result = [ordered]@{
  running = $processes.Count -gt 0
  exePath = ${psString(EXE_PATH)}
  exeExists = (Test-Path -LiteralPath ${psString(EXE_PATH)})
  processes = @($plainProcesses.ToArray())
  windows = @($windows.ToArray())
  listeningPorts = @($ports.ToArray())
}
$result | ConvertTo-Json -Depth 8
`;
}

async function getWindowInfo() {
	return runJsonPowerShell(windowInfoScript(), { timeoutMs: 20000 });
}

function bestWindow(info) {
	const windows = info?.windows || [];
	return windows.find((window) => !window.minimized && window.width > 200 && window.height > 100) || windows[0];
}

async function ensureRunning() {
	const info = await getWindowInfo();
	if (info?.running) return info;
	if (!AUTO_LAUNCH) {
		throw new Error("OOPZ is not running. Call launch_oopz first or set OOPZ_AUTO_LAUNCH=1.");
	}
	await launchOopz();
	return getWindowInfo();
}

async function ensureWindow() {
	let info = await ensureRunning();
	let window = bestWindow(info);
	if (!window || window.minimized) {
		await focusOopz();
		await sleep(500);
		info = await getWindowInfo();
		window = bestWindow(info);
	}
	if (!window) throw new Error("OOPZ process is running but no window was found.");
	return { info, window };
}

function spawnDetached(command, args = []) {
	const child = spawn(command, args, {
		cwd: existsSync(command) ? dirname(command) : undefined,
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	child.on("error", () => {});
	child.unref();
}

async function launchOopz() {
	if (!existsSync(EXE_PATH)) throw new Error(`OOPZ executable not found: ${EXE_PATH}`);
	spawnDetached(EXE_PATH);
	for (let i = 0; i < 20; i += 1) {
		await sleep(500);
		const info = await getWindowInfo();
		if (info?.running && info.windows?.length) return { ok: true, action: "launch_oopz", info };
	}
	return { ok: true, action: "launch_oopz", message: "Launch requested; window not detected yet." };
}

async function focusOopz() {
	const script = `
${win32Prelude("OopzFocus")}
$processName = ${psString(PROCESS_NAME)}
$target = [IntPtr]::Zero
[OopzFocus]::EnumWindows({
  param($h, $l)
  if (-not [OopzFocus]::IsWindowVisible($h)) { return $true }
  [uint32]$windowProcId = 0
  [void][OopzFocus]::GetWindowThreadProcessId($h, [ref]$windowProcId)
  $p = Get-Process -Id $windowProcId -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq $processName) { $script:target = $h; return $false }
  return $true
}, [IntPtr]::Zero) | Out-Null
if ($target -eq [IntPtr]::Zero) { throw "OOPZ window not found" }
[void][OopzFocus]::ShowWindow($target, 9)
Start-Sleep -Milliseconds 200
[void][OopzFocus]::SetForegroundWindow($target)
Start-Sleep -Milliseconds 300
${windowInfoScript()}
`;
	return { ok: true, action: "focus_oopz", info: await runJsonPowerShell(script, { timeoutMs: 20000 }) };
}

async function clickRelative({ x, y, normalized = false, button = "left", double = false }) {
	const { window } = await ensureWindow();
	const relativeX = normalized ? Math.round(window.width * Number(x)) : Math.round(Number(x));
	const relativeY = normalized ? Math.round(window.height * Number(y)) : Math.round(Number(y));
	const screenX = Math.round(window.left + relativeX);
	const screenY = Math.round(window.top + relativeY);
	const eventDown = button === "right" ? 0x0008 : 0x0002;
	const eventUp = button === "right" ? 0x0010 : 0x0004;
	const repeats = double ? 2 : 1;
	const script = `
${win32Prelude("OopzClick")}
[void][OopzClick]::SetCursorPos(${screenX}, ${screenY})
for ($i = 0; $i -lt ${repeats}; $i++) {
  [OopzClick]::mouse_event(${eventDown}, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [OopzClick]::mouse_event(${eventUp}, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
}
[pscustomobject]@{ ok = $true; x = ${screenX}; y = ${screenY}; relativeX = ${relativeX}; relativeY = ${relativeY}; button = ${psString(button)}; double = $${double ? "true" : "false"} } | ConvertTo-Json -Depth 4
`;
	return {
		ok: true,
		action: "click",
		...(await runJsonPowerShell(script, { timeoutMs: 10000 })),
		window,
	};
}

async function scrollWindow({ delta = -600, x, y, normalized = false }) {
	const { window } = await ensureWindow();
	const relativeX = x === undefined ? Math.round(window.width / 2) : normalized ? Math.round(window.width * Number(x)) : Math.round(Number(x));
	const relativeY = y === undefined ? Math.round(window.height / 2) : normalized ? Math.round(window.height * Number(y)) : Math.round(Number(y));
	const screenX = Math.round(window.left + relativeX);
	const screenY = Math.round(window.top + relativeY);
	const script = `
${win32Prelude("OopzScroll")}
[void][OopzScroll]::SetCursorPos(${screenX}, ${screenY})
[OopzScroll]::mouse_event(0x0800, 0, 0, ${Math.round(Number(delta))}, [UIntPtr]::Zero)
[pscustomobject]@{ ok = $true; x = ${screenX}; y = ${screenY}; delta = ${Math.round(Number(delta))} } | ConvertTo-Json -Depth 4
`;
	return { ok: true, action: "scroll", ...(await runJsonPowerShell(script, { timeoutMs: 10000 })) };
}

function sendKeysToken(key) {
	const map = {
		enter: "{ENTER}",
		escape: "{ESC}",
		esc: "{ESC}",
		tab: "{TAB}",
		backspace: "{BACKSPACE}",
		delete: "{DELETE}",
		space: " ",
		up: "{UP}",
		down: "{DOWN}",
		left: "{LEFT}",
		right: "{RIGHT}",
		home: "{HOME}",
		end: "{END}",
		pgup: "{PGUP}",
		pgdn: "{PGDN}",
	};
	return map[String(key).toLowerCase()] || String(key);
}

async function sendKeys({ keys }) {
	await ensureWindow();
	const token = sendKeysToken(keys);
	const script = `
$ws = New-Object -ComObject WScript.Shell
$null = $ws.AppActivate('Oopz')
Start-Sleep -Milliseconds 200
$ws.SendKeys(${psString(token)})
[pscustomobject]@{ ok = $true; keys = ${psString(keys)}; sent = ${psString(token)} } | ConvertTo-Json -Depth 4
`;
	return { ok: true, action: "send_keys", ...(await runJsonPowerShell(script, { timeoutMs: 10000 })) };
}

async function typeText({ text, restoreClipboard = true }) {
	await ensureWindow();
	const script = `
Add-Type -AssemblyName System.Windows.Forms
$oldClipboard = $null
$hadClipboard = $false
try {
  $oldClipboard = Get-Clipboard -Raw -ErrorAction Stop
  $hadClipboard = $true
} catch {}
Set-Clipboard -Value ${psString(text)}
$ws = New-Object -ComObject WScript.Shell
$null = $ws.AppActivate('Oopz')
Start-Sleep -Milliseconds 200
$ws.SendKeys('^v')
Start-Sleep -Milliseconds 200
if ($${restoreClipboard ? "true" : "false"} -and $hadClipboard) {
  Set-Clipboard -Value $oldClipboard
}
[pscustomobject]@{ ok = $true; length = ${String(text).length}; restoredClipboard = $${restoreClipboard ? "true" : "false"} -and $hadClipboard } | ConvertTo-Json -Depth 4
`;
	return { ok: true, action: "type_text", ...(await runJsonPowerShell(script, { timeoutMs: 10000 })) };
}

async function screenshotWindow({ fileName } = {}) {
	const { window } = await ensureWindow();
	mkdirSync(SCREENSHOT_DIR, { recursive: true });
	const safeName = (fileName || `oopz-${Date.now()}.png`).replace(/[^a-zA-Z0-9_.-]+/g, "_");
	const path = join(SCREENSHOT_DIR, safeName.endsWith(".png") ? safeName : `${safeName}.png`);
	const script = `
Add-Type -AssemblyName System.Drawing
$left = ${Math.round(window.left)}
$top = ${Math.round(window.top)}
$width = ${Math.round(window.width)}
$height = ${Math.round(window.height)}
$path = ${psString(path)}
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($left, $top, 0, 0, [System.Drawing.Size]::new($width, $height))
$colors = @{}
for ($y = 0; $y -lt $height; $y += [Math]::Max(1, [int]($height / 20))) {
  for ($x = 0; $x -lt $width; $x += [Math]::Max(1, [int]($width / 20))) {
    $colors[$bitmap.GetPixel($x, $y).ToArgb()] = 1
  }
}
$bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
[pscustomobject]@{ ok = $true; path = $path; width = $width; height = $height; sampledUniqueColors = $colors.Count } | ConvertTo-Json -Depth 4
`;
	return { ok: true, action: "screenshot", ...(await runJsonPowerShell(script, { timeoutMs: 20000 })), window };
}

function readJsonFile(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function getOopzProfileDirs() {
	const appdata = process.env.APPDATA || "";
	const root = join(appdata, "Oopz");
	if (!existsSync(root)) return [];
	const script = `
Get-ChildItem -Directory -LiteralPath ${psString(root)} -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -ne 'global' } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -ExpandProperty FullName |
  ConvertTo-Json -Depth 3
`;
	return runJsonPowerShell(script, { timeoutMs: 10000 }).catch(() => []);
}

async function readOopzSettings() {
	const appdata = process.env.APPDATA || "";
	const profileDirs = await getOopzProfileDirs();
	const profileDir = Array.isArray(profileDirs) ? profileDirs[0] : profileDirs;
	const settings = {};
	if (profileDir) {
		settings.audioSetting = readJsonFile(join(profileDir, "audioSetting", "audioSetting"));
		settings.talkRoomAudioSetting = readJsonFile(join(profileDir, "talkRoomAudioSetting", "talkRoomAudioSetting"));
		settings.voiceDeviceSetting = readJsonFile(join(profileDir, "voiceDeviceSetting", "voiceDeviceSetting"));
		settings.voice = readJsonFile(join(profileDir, "voice", "v2.json"));
		settings.voiceRoomEnterState = readJsonFile(join(profileDir, "voiceRoomEnterStateScope", "voiceRoomEnterStateKey"));
	}
	return {
		ok: true,
		appdata,
		profileDir,
		profileDirs: Array.isArray(profileDirs) ? profileDirs : [profileDirs].filter(Boolean),
		settings,
	};
}

async function probeLocalPorts() {
	const info = await getWindowInfo();
	const ports = [];
	for (const entry of info?.listeningPorts || []) {
		const port = entry.LocalPort || entry.localPort;
		if (!port) continue;
		let root;
		try {
			const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
			root = { status: response.status, text: (await response.text()).slice(0, 500) };
		} catch (error) {
			root = { error: error instanceof Error ? error.message : String(error) };
		}
		ports.push({ ...entry, root });
	}
	return { ok: true, ports };
}

async function semanticClick({ action }) {
	const point = SEMANTIC_POINTS[action];
	if (!point) throw new Error(`Unknown OOPZ semantic action: ${action}`);
	const result = await clickRelative({ x: point.x, y: point.y });
	return { ...result, semanticAction: action, description: point.description };
}

const server = new McpServer({ name: "oopz-control", version: "1.0.0" });

tool(server, "get_status", "Get OOPZ status", "Read OOPZ process, window, listening ports, and configured executable path.", {}, async () => ({
	ok: true,
	...(await getWindowInfo()),
}));

tool(server, "launch_oopz", "Launch OOPZ", "Start OOPZ using OOPZ_EXE_PATH.", {}, async () => launchOopz());

tool(server, "focus_oopz", "Focus OOPZ", "Restore and focus the OOPZ window.", {}, async () => focusOopz());

tool(server, "screenshot", "Screenshot OOPZ", "Capture the OOPZ window to a PNG file and return its path.", { fileName: z.string().optional() }, async (args) =>
	screenshotWindow(args),
);

tool(
	server,
	"click",
	"Click OOPZ",
	"Click inside the OOPZ window. Coordinates are window-relative pixels by default, or 0..1 when normalized=true.",
	{
		x: z.number(),
		y: z.number(),
		normalized: z.boolean().optional(),
		button: z.enum(["left", "right"]).optional(),
		double: z.boolean().optional(),
	},
	async (args) => clickRelative(args),
);

tool(
	server,
	"scroll",
	"Scroll OOPZ",
	"Scroll inside the OOPZ window. Negative delta scrolls down, positive scrolls up.",
	{
		delta: z.number().optional(),
		x: z.number().optional(),
		y: z.number().optional(),
		normalized: z.boolean().optional(),
	},
	async (args) => scrollWindow(args),
);

tool(
	server,
	"send_keys",
	"Send keys to OOPZ",
	"Send a key or WScript.SendKeys sequence to OOPZ. Common names: enter, escape, tab, up, down, left, right.",
	{ keys: z.string() },
	async (args) => sendKeys(args),
);

tool(
	server,
	"type_text",
	"Type text into OOPZ",
	"Paste text into the focused OOPZ field, restoring the previous text clipboard when possible.",
	{ text: z.string(), restoreClipboard: z.boolean().optional() },
	async (args) => typeText(args),
);

tool(
	server,
	"click_action",
	"Click a known OOPZ action",
	"Click a known OOPZ window area such as discovery, voice_music, search, toggle_microphone, or toggle_headset.",
	{ action: z.enum(Object.keys(SEMANTIC_POINTS)) },
	async (args) => semanticClick(args),
);

tool(server, "read_audio_settings", "Read OOPZ audio settings", "Read local OOPZ audio/voice settings from AppData.", {}, async () =>
	readOopzSettings(),
);

tool(server, "probe_local_ports", "Probe OOPZ local ports", "Probe HTTP roots for local ports owned by the OOPZ process.", {}, async () =>
	probeLocalPorts(),
);

await server.connect(new StdioServerTransport());
