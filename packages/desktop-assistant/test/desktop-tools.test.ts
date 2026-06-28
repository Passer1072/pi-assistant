import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	buildSkillRoutedPrompt,
	buildSystemOperationAppendPrompt,
	classifySkillHeuristically,
	DesktopAgentService,
	resolveDesktopSkillFiles,
	resolveSystemOperationSkillFile,
} from "../src/agent/desktop-agent-service.ts";
import {
	deleteAppLaunchCacheEntry,
	getAppLaunchCachePath,
	readAppLaunchCache,
	rememberFindAppResults,
	rememberSuccessfulLaunch,
	resolveRememberedLaunch,
} from "../src/desktop/app-launch-memory.ts";
import {
	type CommandResult,
	type DesktopAutomationHost,
	DryRunDesktopAutomationHost,
} from "../src/desktop/automation-host.ts";
import { classifyAutomationRisk, requiresConfirmation } from "../src/desktop/risk.ts";
import {
	createDesktopToolDefinitions,
	createDisplayPowerShell,
	getActiveDesktopToolNames,
	isSystemSkillMutationCommand,
} from "../src/desktop/tools.ts";
import { createWebTools } from "../src/desktop/tools-web.ts";
import { buildAppLaunchCacheHtml } from "../src/main/app-launch-cache-view.ts";
import type { DesktopCapabilityId, DesktopCapabilitySettings, DesktopToolResult } from "../src/shared/types.ts";

const enabledSystemCapability: DesktopCapabilitySettings = {
	enabled: true,
	commandFirst: true,
	skillName: "system-operation",
};

describe("desktop automation tools", () => {
	it("classifies destructive commands as high risk", () => {
		expect(classifyAutomationRisk("shutdown /s")).toBe("high");
		expect(requiresConfirmation("high", "tiered")).toBe(true);
		expect(requiresConfirmation("low", "tiered")).toBe(false);
		expect(requiresConfirmation("high", "full_access")).toBe(false);
		expect(requiresConfirmation("medium", "full_access")).toBe(false);
	});

	it("opens normal apps without confirmation in tiered mode", async () => {
		const tools = createDesktopToolDefinitions({
			host: new DryRunDesktopAutomationHost(),
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "open_app");
		if (!tool) throw new Error("open_app tool missing");

		const response = await tool.execute("tool-1", { app: "notepad.exe" }, undefined, undefined, stubContext());
		const details = response.details as DesktopToolResult;

		expect(details.status).toBe("succeeded");
		expect(details.requiresConfirmation).toBe(false);
		// Launch proceeded (not short-circuited as "already running"); window not detected in dry-run.
		expect(details.stdout).toContain("启动命令已执行");
		expect(details.stdout).not.toContain("已在运行");
	});

	it("routes a URL launch through the default browser instead of the OS browser", async () => {
		const calls: (string | undefined)[] = [];
		const host = Object.assign(new DryRunDesktopAutomationHost(), {
			startProcess: async () => {
				throw new Error("startProcess must NOT be called for a browser/URL launch");
			},
		}) as DesktopAutomationHost;
		const tools = createDesktopToolDefinitions({
			host,
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
			openInDefaultBrowser: async (url) => {
				calls.push(url);
				return { stdout: `默认浏览器已打开 ${url ?? "(home)"}`, stderr: "" };
			},
		});
		const tool = tools.find((entry) => entry.name === "open_app");
		if (!tool) throw new Error("open_app tool missing");

		const response = await tool.execute("t", { app: "https://example.com" }, undefined, undefined, stubContext());
		const details = response.details as DesktopToolResult;
		expect(details.status).toBe("succeeded");
		expect(calls).toEqual(["https://example.com"]);
	});

	it("routes a browser-name launch (chrome) through the default browser with no url", async () => {
		const calls: (string | undefined)[] = [];
		const host = Object.assign(new DryRunDesktopAutomationHost(), {
			startProcess: async () => {
				throw new Error("startProcess must NOT be called for a chrome launch");
			},
		}) as DesktopAutomationHost;
		const tools = createDesktopToolDefinitions({
			host,
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
			openInDefaultBrowser: async (url) => {
				calls.push(url);
				return { stdout: "默认浏览器已打开", stderr: "" };
			},
		});
		const tool = tools.find((entry) => entry.name === "open_app");
		if (!tool) throw new Error("open_app tool missing");

		const response = await tool.execute("t", { app: "Chrome" }, undefined, undefined, stubContext());
		expect((response.details as DesktopToolResult).status).toBe("succeeded");
		expect(calls).toEqual([undefined]);
	});

	it("does not route a normal app launch to the browser", async () => {
		let browserCalled = false;
		const tools = createDesktopToolDefinitions({
			host: new DryRunDesktopAutomationHost(),
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
			openInDefaultBrowser: async () => {
				browserCalled = true;
				return { stdout: "", stderr: "" };
			},
		});
		const tool = tools.find((entry) => entry.name === "open_app");
		if (!tool) throw new Error("open_app tool missing");

		const response = await tool.execute("t", { app: "notepad.exe" }, undefined, undefined, stubContext());
		expect((response.details as DesktopToolResult).status).toBe("succeeded");
		expect(browserCalled).toBe(false);
	});

	it("does not relaunch an app that is already running (focuses instead)", async () => {
		const host = Object.assign(new DryRunDesktopAutomationHost(), {
			// Simulate the process check returning RUNNING (whole-line output, as the real shell would).
			runPowerShell: async () => ({ stdout: "RUNNING\n", stderr: "" }),
			focusWindow: async (target: string) => ({ stdout: `focused ${target}`, stderr: "" }),
			startProcess: async () => {
				throw new Error("startProcess must NOT be called when the app is already running");
			},
		}) as DesktopAutomationHost;
		const tools = createDesktopToolDefinitions({
			host,
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "open_app");
		if (!tool) throw new Error("open_app tool missing");

		const response = await tool.execute("tool-1", { app: "notepad.exe" }, undefined, undefined, stubContext());
		const details = response.details as DesktopToolResult;
		expect(details.status).toBe("succeeded");
		expect(details.stdout).toContain("已在运行");
	});

	it("blocks high-risk shell commands in tiered mode", async () => {
		const tools = createDesktopToolDefinitions({
			host: new DryRunDesktopAutomationHost(),
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "shell_command_safe");
		if (!tool) throw new Error("shell_command_safe tool missing");

		const response = await tool.execute(
			"tool-1",
			{ command: "Remove-Item C:\\important -Recurse" },
			undefined,
			undefined,
			stubContext(),
		);
		const details = response.details as DesktopToolResult;

		expect(details.status).toBe("blocked");
		expect(details.riskLevel).toBe("high");
		expect(details.requiresConfirmation).toBe(true);
	});

	it("wait pauses server-side and returns a minimal result", async () => {
		vi.useFakeTimers();
		try {
			const tools = createDesktopToolDefinitions({
				host: new DryRunDesktopAutomationHost(),
				permissionMode: () => "tiered",
				systemCapability: () => enabledSystemCapability,
			});
			const tool = tools.find((entry) => entry.name === "wait");
			if (!tool) throw new Error("wait tool missing");

			const promise = tool.execute(
				"tool-wait",
				{ seconds: 2, reason: "job progress" },
				undefined,
				undefined,
				stubContext(),
			);
			await vi.advanceTimersByTimeAsync(2_000);
			const response = await promise;
			const details = response.details as DesktopToolResult;

			expect(details.status).toBe("succeeded");
			expect(details.stdout).toContain('"waited":2');
			expect(details.requiresConfirmation).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("wait aborts promptly", async () => {
		vi.useFakeTimers();
		try {
			const tools = createDesktopToolDefinitions({
				host: new DryRunDesktopAutomationHost(),
				permissionMode: () => "tiered",
				systemCapability: () => enabledSystemCapability,
			});
			const tool = tools.find((entry) => entry.name === "wait");
			if (!tool) throw new Error("wait tool missing");

			const controller = new AbortController();
			const promise = tool.execute("tool-wait", { seconds: 30 }, controller.signal, undefined, stubContext());
			await vi.advanceTimersByTimeAsync(1_000);
			controller.abort();
			await expect(promise).rejects.toThrow("Aborted");
		} finally {
			vi.useRealTimers();
		}
	});

	it("blocks AI shell mutations of built-in desktop assistant skills", async () => {
		const tools = createDesktopToolDefinitions({
			host: new DryRunDesktopAutomationHost(),
			permissionMode: () => "full_access",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "shell_command_safe");
		if (!tool) throw new Error("shell_command_safe tool missing");

		const response = await tool.execute(
			"tool-system-skill",
			{
				command: "Set-Content packages\\desktop-assistant\\skills\\system-operation\\SKILL.md '# changed'",
			},
			undefined,
			undefined,
			stubContext(),
		);
		const details = response.details as DesktopToolResult;

		expect(
			isSystemSkillMutationCommand("Get-Content packages\\desktop-assistant\\skills\\system-operation\\SKILL.md"),
		).toBe(false);
		expect(isSystemSkillMutationCommand("Set-Content data\\personal-skills\\handoff\\SKILL.md '# ok'")).toBe(false);
		expect(details.status).toBe("blocked");
		expect(details.requiresConfirmation).toBe(false);
		expect(details.stderr).toContain("AI cannot maintain built-in Desktop Assistant system skills");
	});

	it("runs high-risk shell commands without confirmation in full access mode", async () => {
		const tools = createDesktopToolDefinitions({
			host: new DryRunDesktopAutomationHost(),
			permissionMode: () => "full_access",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "shell_command_safe");
		if (!tool) throw new Error("shell_command_safe tool missing");

		const response = await tool.execute(
			"tool-1",
			{ command: "Remove-Item C:\\important -Recurse" },
			undefined,
			undefined,
			stubContext(),
		);
		const details = response.details as DesktopToolResult;

		expect(details.status).toBe("succeeded");
		expect(details.riskLevel).toBe("high");
		expect(details.requiresConfirmation).toBe(false);
		expect(details.stdout).toContain("DRY RUN powershell managed");
	});

	it("mutes audio in the background without opening settings", async () => {
		const tools = createDesktopToolDefinitions({
			host: new DryRunDesktopAutomationHost(),
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "set_audio_device_or_volume");
		if (!tool) throw new Error("set_audio_device_or_volume tool missing");

		const response = await tool.execute("tool-1", { muted: true }, undefined, undefined, stubContext());
		const details = response.details as DesktopToolResult;

		expect(details.status).toBe("succeeded");
		expect(details.requiresConfirmation).toBe(false);
		expect(details.stdout).toContain("SetMute");
		expect(details.stdout).not.toContain("Start-Process ms-settings:sound");
	});

	it("sets zero volume as mute without opening settings", async () => {
		const tools = createDesktopToolDefinitions({
			host: new DryRunDesktopAutomationHost(),
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "set_audio_device_or_volume");
		if (!tool) throw new Error("set_audio_device_or_volume tool missing");

		const response = await tool.execute("tool-1", { volumePercent: 0 }, undefined, undefined, stubContext());
		const details = response.details as DesktopToolResult;

		expect(details.status).toBe("succeeded");
		expect(details.requiresConfirmation).toBe(false);
		expect(details.stdout).toContain("[AudioEndpoint]::Volume = 0.0000");
		expect(details.stdout).toContain("[AudioEndpoint]::Mute = $true");
		expect(details.stdout).not.toContain("Start-Process ms-settings:sound");
	});

	it("sets brightness in the background without opening display settings", async () => {
		const tools = createDesktopToolDefinitions({
			host: new DryRunDesktopAutomationHost(),
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "set_display_brightness_or_scale");
		if (!tool) throw new Error("set_display_brightness_or_scale tool missing");

		const response = await tool.execute("tool-1", { brightnessPercent: 40 }, undefined, undefined, stubContext());
		const details = response.details as DesktopToolResult;

		expect(details.status).toBe("succeeded");
		expect(details.requiresConfirmation).toBe(false);
		expect(details.stdout).toContain("WmiMonitorBrightnessMethods");
		expect(details.stdout).toContain("Brightness = 40");
		expect(details.stdout).not.toContain("Start-Process ms-settings:display");
	});

	it("passes keyboard modifiers through as a full chord", async () => {
		const chords: Array<{ key: string; modifiers: string[] }> = [];
		const host = Object.assign(new DryRunDesktopAutomationHost(), {
			keyTap: async (key: string, modifiers: string[] = []) => {
				chords.push({ key, modifiers });
				return { stdout: `key ${[...modifiers, key].join("+")}`, stderr: "" };
			},
		}) as DesktopAutomationHost;
		const tools = createDesktopToolDefinitions({
			host,
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "keyboard_mouse");
		if (!tool) throw new Error("keyboard_mouse tool missing");

		const response = await tool.execute(
			"tool-1",
			{ action: "key", key: "f", modifiers: ["LeftControl"] },
			undefined,
			undefined,
			stubContext(),
		);
		const details = response.details as DesktopToolResult;

		expect(chords).toEqual([{ key: "f", modifiers: ["LeftControl"] }]);
		expect(details.stdout).toContain("LeftControl+f");
	});

	it("focuses windows instead of listing them for window_control focus", async () => {
		const focused: string[] = [];
		const host = Object.assign(new DryRunDesktopAutomationHost(), {
			focusWindow: async (target: string) => {
				focused.push(target);
				return { stdout: `focused ${target}`, stderr: "" };
			},
			getActiveWindow: async () => ({
				title: "Crying Over You - 网易云音乐",
				processName: "cloudmusic",
				isActive: true,
			}),
		}) as DesktopAutomationHost;
		const tools = createDesktopToolDefinitions({
			host,
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "window_control");
		if (!tool) throw new Error("window_control tool missing");

		const response = await tool.execute(
			"tool-1",
			{ action: "focus", title: "网易云音乐" },
			undefined,
			undefined,
			stubContext(),
		);
		const details = response.details as DesktopToolResult;

		expect(focused).toEqual(["网易云音乐"]);
		expect(details.confidence).toBe("high");
		expect(details.observedState).toMatchObject({
			activeWindow: { processName: "cloudmusic" },
		});
	});

	it("sends media play commands and returns observable state instead of a raw space press", async () => {
		const mediaCommands: string[] = [];
		const host = Object.assign(new DryRunDesktopAutomationHost(), {
			sendMediaCommand: async (command: string) => {
				mediaCommands.push(command);
				return { stdout: `media ${command}`, stderr: "" };
			},
			getActiveWindow: async () => ({
				title: "Crying Over You - 网易云音乐",
				processName: "cloudmusic",
				isActive: true,
			}),
			listWindows: async () => [
				{ title: "Crying Over You - 网易云音乐", processName: "cloudmusic", isActive: true },
			],
		}) as DesktopAutomationHost;
		const tools = createDesktopToolDefinitions({
			host,
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "media_control");
		if (!tool) throw new Error("media_control tool missing");

		const response = await tool.execute("tool-1", { command: "play" }, undefined, undefined, stubContext());
		const details = response.details as DesktopToolResult;

		expect(mediaCommands).toEqual(["play"]);
		expect(details.stdout).not.toContain("Pressed space");
		expect(details.confidence).toBe("medium");
		expect(details.observedState).toMatchObject({
			activeWindow: { processName: "cloudmusic" },
		});
	});

	it("returns low confidence and fallback actions when media playback has no visible player", async () => {
		const tools = createDesktopToolDefinitions({
			host: new DryRunDesktopAutomationHost(),
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "media_control");
		if (!tool) throw new Error("media_control tool missing");

		const response = await tool.execute("tool-1", { command: "play" }, undefined, undefined, stubContext());
		const details = response.details as DesktopToolResult;

		expect(details.confidence).toBe("low");
		expect(details.nextActions?.join("\n")).toContain("Open or focus the media player");
	});

	it("plays a NetEase Cloud Music query through a high-level app workflow", async () => {
		const actions: string[] = [];
		const host = Object.assign(new DryRunDesktopAutomationHost(), {
			listWindows: async () => [{ title: "网易云音乐", processName: "cloudmusic", isActive: true }],
			getActiveWindow: async () => ({
				title: "Crying Over You - HONNE - 网易云音乐",
				processName: "cloudmusic",
				isActive: true,
			}),
			focusWindow: async (target: string) => {
				actions.push(`focus:${target}`);
				return { stdout: `focused ${target}`, stderr: "" };
			},
			sendKeyChord: async (key: string, modifiers: string[] = []) => {
				actions.push(`key:${[...modifiers, key].join("+")}`);
				return { stdout: `key ${[...modifiers, key].join("+")}`, stderr: "" };
			},
			typeText: async (text: string) => {
				actions.push(`type:${text}`);
				return { stdout: `typed ${text}`, stderr: "" };
			},
			sendMediaCommand: async (command: string) => {
				actions.push(`media:${command}`);
				return { stdout: `media ${command}`, stderr: "" };
			},
		}) as DesktopAutomationHost;
		const tools = createDesktopToolDefinitions({
			host,
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "app_interaction");
		if (!tool) throw new Error("app_interaction tool missing");

		const response = await tool.execute(
			"tool-1",
			{ app: "netease_cloud_music", action: "play_song", query: "Crying Over You" },
			undefined,
			undefined,
			stubContext(),
		);
		const details = response.details as DesktopToolResult;

		expect(actions).toEqual([
			"focus:网易云音乐",
			"key:LeftControl+f",
			"type:Crying Over You",
			"key:Enter",
			"key:Enter",
			"media:play",
		]);
		expect(details.confidence).toBe("medium");
		expect(details.observedState).toMatchObject({
			expectedQuery: "Crying Over You",
		});
	});

	it("redirects NetEase app_interaction to the mcp_ncm_* plugin when it is active", async () => {
		const actions: string[] = [];
		const host = Object.assign(new DryRunDesktopAutomationHost(), {
			focusWindow: async (target: string) => {
				actions.push(`focus:${target}`);
				return { stdout: "", stderr: "" };
			},
			typeText: async (text: string) => {
				actions.push(`type:${text}`);
				return { stdout: "", stderr: "" };
			},
		}) as DesktopAutomationHost;
		const tools = createDesktopToolDefinitions({
			host,
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
			activeMcpToolNames: () => ["mcp_ncm_search", "mcp_ncm_play_song_by_name", "media_control"],
		});
		const tool = tools.find((entry) => entry.name === "app_interaction");
		if (!tool) throw new Error("app_interaction tool missing");

		const response = await tool.execute(
			"tool-1",
			{ app: "netease_cloud_music", action: "play_song", query: "稻香" },
			undefined,
			undefined,
			stubContext(),
		);
		const details = response.details as DesktopToolResult;

		// no primitive UI automation happened
		expect(actions).toEqual([]);
		expect(details.status).toBe("blocked");
		expect(details.stderr).toContain("mcp_ncm_");
		expect(JSON.stringify(details.nextActions)).toContain("mcp_ncm_play_song_by_name");
		expect(JSON.stringify(details.nextActions)).toContain("稻香");
	});

	it("uses display settings only as fallback for scale changes", () => {
		const script = createDisplayPowerShell({ scalePercent: 125 });

		expect(script).toContain("Start-Process ms-settings:display");
		expect(script).toContain("Display scale 125%");
	});

	it("reuses existing Office application instances and quits only agent-created ones", async () => {
		const capturedScripts: string[] = [];
		const host = Object.assign(new DryRunDesktopAutomationHost(), {
			runPowerShellManaged: async (script: string) => {
				capturedScripts.push(script);
				return { stdout: "ok", stderr: "" };
			},
		}) as DesktopAutomationHost;
		const tools = createDesktopToolDefinitions({
			host,
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});

		await tools
			.find((entry) => entry.name === "doc_read")
			?.execute("tool-1", { path: "C:\\temp\\a.docx" }, undefined, undefined, stubContext());
		await tools
			.find((entry) => entry.name === "excel_read")
			?.execute("tool-2", { path: "C:\\temp\\a.xlsx" }, undefined, undefined, stubContext());
		await tools
			.find((entry) => entry.name === "ppt_read")
			?.execute("tool-3", { path: "C:\\temp\\a.pptx" }, undefined, undefined, stubContext());

		expect(capturedScripts[0]).toContain("GetActiveObject('Word.Application')");
		expect(capturedScripts[0]).toContain("$createdByAgent = $false");
		expect(capturedScripts[0]).toContain("if ($createdByAgent)");
		expect(capturedScripts[0]).toContain("$Word.Quit($false)");

		expect(capturedScripts[1]).toContain("GetActiveObject('Excel.Application')");
		expect(capturedScripts[1]).toContain("if ($createdByAgent)");
		expect(capturedScripts[1]).toContain("$Excel.Quit()");

		expect(capturedScripts[2]).toContain("GetActiveObject('PowerPoint.Application')");
		expect(capturedScripts[2]).toContain("if ($createdByAgent)");
		expect(capturedScripts[2]).toContain("$Ppt.Quit()");
	});

	it("tells custom Office scripts not to quit the shared Office application", () => {
		const tools = createDesktopToolDefinitions({
			host: new DryRunDesktopAutomationHost(),
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const wordScriptTool = tools.find((entry) => entry.name === "office_word_run");
		const excelScriptTool = tools.find((entry) => entry.name === "office_excel_run");
		const pptScriptTool = tools.find((entry) => entry.name === "office_ppt_run");
		const wordSchema = wordScriptTool?.parameters as { properties: { script: { description?: string } } };
		const excelSchema = excelScriptTool?.parameters as { properties: { script: { description?: string } } };
		const pptSchema = pptScriptTool?.parameters as { properties: { script: { description?: string } } };

		expect(wordSchema.properties.script.description).toContain("Do NOT call $Word.Quit()");
		expect(excelSchema.properties.script.description).toContain("Do NOT call $Excel.Quit()");
		expect(pptSchema.properties.script.description).toContain("Do NOT call $Ppt.Quit()");
	});

	it("normalizes excel_write cell value types before writing through COM", async () => {
		let captured = "";
		const host = Object.assign(new DryRunDesktopAutomationHost(), {
			runPowerShellManaged: async (script: string) => {
				captured = script;
				return { stdout: "ok", stderr: "" };
			},
		}) as DesktopAutomationHost;
		const tools = createDesktopToolDefinitions({
			host,
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "excel_write");
		if (!tool) throw new Error("excel_write tool missing");
		const data = [
			["时间节点", "总人数", "变化", "比例", "启用"],
			["2026年6月", 548, -5, 12.5, true],
			["空值", null, null, null, false],
		];

		await tool.execute(
			"tool-excel-write",
			{ path: "C:\\temp\\report.xlsx", data },
			undefined,
			undefined,
			stubContext(),
		);

		expect(captured).toContain(Buffer.from(JSON.stringify(data), "utf-8").toString("base64"));
		expect(captured).toContain("function Set-ExcelCellValue($cell, $value)");
		expect(captured).toContain("'Int32' { $cell.Value = [double]$value; return }");
		expect(captured).toContain("'Double' { $cell.Value = [double]$value; return }");
		expect(captured).toContain("'Boolean' { $cell.Value = [bool]$value; return }");
		expect(captured).toContain("'String' { $cell.Value2 = [string]$value; return }");
		expect(captured).toContain("Set-ExcelCellValue ($ws.Cells.Item($row, $col)) $val");
		expect(captured).not.toContain("$ws.Cells.Item($row, $col).Value2 = $val");
	});

	it("guides office_excel_run scripts away from raw integer Value2 writes", () => {
		const tools = createDesktopToolDefinitions({
			host: new DryRunDesktopAutomationHost(),
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "office_excel_run");
		if (!tool) throw new Error("office_excel_run tool missing");
		const schema = tool.parameters as { properties: { script: { description?: string } } };
		const guidance = [schema.properties.script.description, ...(tool.promptGuidelines ?? [])].join("\n");

		expect(guidance).toContain("$ws.Cells.Item(row,col) = 123");
		expect(guidance).toContain("$cell.Value = [double]$n");
		expect(guidance).toContain("avoid raw .Value2 = [int]");
	});

	it("wraps Excel COM script failures with exception type and source location", async () => {
		let captured = "";
		const host = Object.assign(new DryRunDesktopAutomationHost(), {
			runPowerShellManaged: async (script: string) => {
				captured = script;
				return { stdout: "ok", stderr: "" };
			},
		}) as DesktopAutomationHost;
		const tools = createDesktopToolDefinitions({
			host,
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "office_excel_run");
		if (!tool) throw new Error("office_excel_run tool missing");

		await tool.execute(
			"tool-excel-wrapper",
			{ script: "$ws.Cells.Item(1,1).Value2 = [int]1" },
			undefined,
			undefined,
			stubContext(),
		);

		expect(captured).toContain("Excel error ({0}): {1}");
		expect(captured).toContain("$err.InvocationInfo.ScriptLineNumber");
		expect(captured).toContain("$err.InvocationInfo.OffsetInLine");
		expect(captured).toContain("$err.InvocationInfo.Line");
		expect(captured).not.toContain('Write-Error "Excel error: $_"');
	});

	it("exposes the new inspect-first document tools when document capability is enabled", () => {
		const names = getActiveDesktopToolNames({
			system: { enabled: false, commandFirst: true, skillName: "system-operation" },
			document: { enabled: true, commandFirst: true, skillName: "document-operation" },
			ppt: { enabled: false, commandFirst: true, skillName: "ppt-operation" },
			excel: { enabled: false, commandFirst: true, skillName: "excel-operation" },
		});

		expect(names).toContain("doc_inspect");
		expect(names).toContain("doc_plan_edits");
		expect(names).toContain("doc_apply_edits");
		expect(names).toContain("doc_verify");
	});

	it("returns executionId when office tools time out under managed timeout", async () => {
		const host = Object.assign(new DryRunDesktopAutomationHost(), {
			runPowerShellManaged: async () => ({
				status: "timeout" as const,
				executionId: "word-timeout-1",
				elapsedSeconds: 30,
				currentStdout: "partial",
				currentStderr: "",
				message: "timed out",
			}),
		}) as DesktopAutomationHost;
		const tools = createDesktopToolDefinitions({
			host,
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "doc_read");
		if (!tool) throw new Error("doc_read tool missing");

		const response = await tool.execute(
			"tool-timeout",
			{ path: "C:\\temp\\a.docx" },
			undefined,
			undefined,
			stubContext(),
		);
		const details = response.details as DesktopToolResult;

		expect(details.status).toBe("timeout");
		expect(details.executionId).toBe("word-timeout-1");
		expect(details.stdout).toContain("partial");
	});

	it("adds Word COM recovery guidance when office tools time out", async () => {
		const host = Object.assign(new DryRunDesktopAutomationHost(), {
			runPowerShellManaged: async () => ({
				status: "timeout" as const,
				executionId: "word-timeout-2",
				elapsedSeconds: 30,
				currentStdout: "partial",
				currentStderr: "",
				message: "timed out",
			}),
		}) as DesktopAutomationHost;
		const tools = createDesktopToolDefinitions({
			host,
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "doc_read");
		if (!tool) throw new Error("doc_read tool missing");

		const response = await tool.execute(
			"tool-timeout-guidance",
			{ path: "C:\\temp\\a.docx" },
			undefined,
			undefined,
			stubContext(),
		);
		const details = response.details as DesktopToolResult;

		expect(details.status).toBe("timeout");
		expect(details.stderr).toContain("Word COM automation timed out");
		expect(details.nextActions?.join("\n")).toContain("shell_command_continue");
		expect(details.nextActions?.join("\n")).toContain("assistant-created");
	});

	it("inspects Word tables through Range.Cells instead of row/column Cell indexing", async () => {
		let captured = "";
		const host = Object.assign(new DryRunDesktopAutomationHost(), {
			runPowerShellManaged: async (script: string) => {
				captured = script;
				return { stdout: JSON.stringify({ blocks: [], tables: [], warnings: [] }), stderr: "" };
			},
		}) as DesktopAutomationHost;
		const tools = createDesktopToolDefinitions({
			host,
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "doc_inspect");
		if (!tool) throw new Error("doc_inspect tool missing");

		await tool.execute("tool-inspect", { path: "C:\\temp\\a.docx" }, undefined, undefined, stubContext());

		expect(captured).toContain("foreach ($cell in $table.Range.Cells)");
		expect(captured).toContain("merged=$merged");
		expect(captured).not.toContain("for ($row = 1; $row -le $table.Rows.Count; $row++)");
		expect(captured).not.toContain("$table.Cell($row, $col)");
	});

	it("blocks office_word_run scripts that open Word read-only and then write or save", async () => {
		let ran = false;
		const host = Object.assign(new DryRunDesktopAutomationHost(), {
			runPowerShellManaged: async () => {
				ran = true;
				return { stdout: "ok", stderr: "" };
			},
		}) as DesktopAutomationHost;
		const tools = createDesktopToolDefinitions({
			host,
			permissionMode: () => "full_access",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "office_word_run");
		if (!tool) throw new Error("office_word_run tool missing");

		const response = await tool.execute(
			"tool-word-block",
			{
				script: [
					"$doc = $Word.Documents.Open('C:\\temp\\a.docx', $false, $true)",
					"$doc.Tables.Item(1).Cell(1,1).Range.Text = 'x'",
					"$doc.Save()",
				].join("\n"),
			},
			undefined,
			undefined,
			stubContext(),
		);
		const details = response.details as DesktopToolResult;

		expect(ran).toBe(false);
		expect(details.status).toBe("blocked");
		expect(details.stderr).toContain("read-only");
		expect(details.stderr).toContain("doc_inspect -> doc_apply_edits -> doc_verify");
	});

	it("allows office_word_run read-only reads and editable writes", async () => {
		const capturedScripts: string[] = [];
		const host = Object.assign(new DryRunDesktopAutomationHost(), {
			runPowerShellManaged: async (script: string) => {
				capturedScripts.push(script);
				return { stdout: "ok", stderr: "" };
			},
		}) as DesktopAutomationHost;
		const tools = createDesktopToolDefinitions({
			host,
			permissionMode: () => "full_access",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "office_word_run");
		if (!tool) throw new Error("office_word_run tool missing");

		const readResponse = await tool.execute(
			"tool-word-read",
			{
				script: [
					"$doc = $Word.Documents.Open('C:\\temp\\a.docx', $false, $true)",
					"$text = $doc.Content.Text",
					"$doc.Close($false)",
				].join("\n"),
			},
			undefined,
			undefined,
			stubContext(),
		);
		const writeResponse = await tool.execute(
			"tool-word-write",
			{
				script: [
					"$doc = $Word.Documents.Open('C:\\temp\\a.docx', $false, $false)",
					"$doc.Range.Text = 'x'",
					"$doc.Save()",
					"$doc.Close($false)",
				].join("\n"),
			},
			undefined,
			undefined,
			stubContext(),
		);

		expect((readResponse.details as DesktopToolResult).status).toBe("succeeded");
		expect((writeResponse.details as DesktopToolResult).status).toBe("succeeded");
		expect(capturedScripts).toHaveLength(2);
		expect(capturedScripts[0]).toContain("$doc.Content.Text");
		expect(capturedScripts[1]).toContain("$doc.Range.Text = 'x'");
	});

	it("classifies RPC_E_CALL_REJECTED as word_busy for structured Word tools", async () => {
		const host = Object.assign(new DryRunDesktopAutomationHost(), {
			runPowerShellManaged: async () => ({
				stdout: "",
				stderr: "Call was rejected by callee. (HRESULT: 0x80010001 (RPC_E_CALL_REJECTED))",
			}),
		}) as DesktopAutomationHost;
		const tools = createDesktopToolDefinitions({
			host,
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "doc_inspect");
		if (!tool) throw new Error("doc_inspect tool missing");

		const response = await tool.execute(
			"tool-word-busy",
			{ path: "C:\\temp\\a.docx" },
			undefined,
			undefined,
			stubContext(),
		);
		const details = response.details as DesktopToolResult;

		expect(details.status).toBe("failed");
		expect(details.stderr).toContain("errorCategory=word_busy");
		expect(details.nextActions?.join("\n")).toContain("Word finishes");
	});

	it("documents the Word fast path and structured edit guidance for the model", () => {
		const tools = createDesktopToolDefinitions({
			host: new DryRunDesktopAutomationHost(),
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const inspectTool = tools.find((entry) => entry.name === "doc_inspect");
		const createTool = tools.find((entry) => entry.name === "doc_create_from_html");
		const fallbackTool = tools.find((entry) => entry.name === "office_word_run");

		const documentGuidelines = inspectTool?.promptGuidelines?.join("\n") ?? "";
		expect(documentGuidelines).toContain("Fast path");
		expect(documentGuidelines).toContain("prefer office_word_run");
		expect(documentGuidelines).toContain("Structured path");
		expect(documentGuidelines).toContain("doc_inspect -> doc_apply_edits -> doc_verify");
		expect(documentGuidelines).toContain("$table.Cell($row,$col) loops");
		expect(createTool).toBeDefined();
		const createGuidelines = createTool?.promptGuidelines?.join("\n") ?? "";
		expect(createGuidelines).toContain("doc_create_from_html");
		expect(createGuidelines).toContain("page-break-before");
		expect(createGuidelines).toContain("flexbox");
		expect(createGuidelines).toContain("<h1>");
		expect(fallbackTool?.description).toContain("Advanced fallback");

		// The old markdown doc_create is gone; HTML create is the only new-document tool.
		const docNames = getActiveDesktopToolNames({
			system: { enabled: false, commandFirst: true, skillName: "system-operation" },
			document: { enabled: true, commandFirst: true, skillName: "document-operation" },
			ppt: { enabled: false, commandFirst: true, skillName: "ppt-operation" },
			excel: { enabled: false, commandFirst: true, skillName: "excel-operation" },
		});
		expect(docNames).toContain("doc_create_from_html");
		expect(docNames).not.toContain("doc_create");
	});

	it("creates a new document by importing model-authored HTML into Word (localized-safe, editable)", async () => {
		let captured = "";
		const host = Object.assign(new DryRunDesktopAutomationHost(), {
			runPowerShellManaged: async (script: string) => {
				captured = script;
				return {
					status: "succeeded" as const,
					executionId: "doc-html-1",
					elapsedSeconds: 1,
					currentStdout: "Document created",
					currentStderr: "",
					message: "",
				};
			},
		}) as DesktopAutomationHost;
		const tools = createDesktopToolDefinitions({
			host,
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const tool = tools.find((entry) => entry.name === "doc_create_from_html");
		if (!tool) throw new Error("doc_create_from_html tool missing");

		const html =
			'<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><h1>标题</h1><p>正文</p></body></html>';
		await tool.execute(
			"doc-html",
			{
				path: "C:\\temp\\report.docx",
				html,
				pageSetup: { orientation: "landscape", margin: "narrow", pageSize: "Letter" },
			},
			undefined,
			undefined,
			stubContext(),
		);

		// HTML is base64-embedded and round-trips (no fragile escaping / encoding).
		expect(captured).toContain(Buffer.from(html, "utf-8").toString("base64"));
		// UTF-8 BOM temp file → Chinese-safe; Word opens with ConfirmConversions=$false; saves a real .docx; cleans up.
		expect(captured).toContain("System.Text.UTF8Encoding($true)");
		expect(captured).toContain("$Word.Documents.Open($tmp, $false)");
		expect(captured).toContain("$doc.SaveAs2($outPath, 16)");
		expect(captured).toContain("Remove-Item -LiteralPath $tmp");
		// pageSetup mapped to COM (landscape=1, Letter=2, narrow=36pt); never relies on CSS @page.
		expect(captured).toContain("$doc.PageSetup.Orientation = 1");
		expect(captured).toContain("$doc.PageSetup.PaperSize = 2");
		expect(captured).toContain("$doc.PageSetup.TopMargin = 36");
		expect(captured).not.toContain("@page");
	});

	it("does not hardcode user audio requests in the service layer", () => {
		const service = new DesktopAgentService({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			host: new DryRunDesktopAutomationHost(),
		});
		const snapshot = service.snapshot();

		expect(snapshot.sessionId).toBe("bootstrap");
		expect(snapshot.messages).toEqual([]);
		expect(snapshot.timeline).toEqual([]);
	});

	it("creates a real new conversation session and clears local transcript state", async () => {
		const service = new DesktopAgentService({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			host: new DryRunDesktopAutomationHost(),
		});

		await service.initialize();
		const before = service.snapshot();
		const after = await service.newConversation();

		expect(after.sessionId).not.toBe(before.sessionId);
		expect(after.messages).toEqual([]);
		expect(after.timeline).toEqual([]);
		expect(after.pendingConfirmations).toEqual([]);
	});

	it("continues the agent turn after approval with the action result", async () => {
		const prompts: string[] = [];
		const hostCalls: Array<{ action: string; target: string }> = [];
		const service = new DesktopAgentService({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			host: {
				runDesktopAction: async (action: string, target: string) => {
					hostCalls.push({ action, target });
					return { stdout: "command completed", stderr: "" };
				},
			} as never,
		});
		const internal = service as unknown as {
			pendingConfirmations: Array<{
				id: string;
				intent: string;
				action: string;
				target: string;
				riskLevel: "low" | "medium" | "high";
				createdAt: number;
			}>;
			session: { prompt: (message: string, options?: unknown) => Promise<void> };
		};

		internal.pendingConfirmations = [
			{
				id: "approval-1",
				intent: "Open Notepad",
				action: "open_app",
				target: "notepad.exe",
				riskLevel: "medium",
				createdAt: Date.now(),
			},
		];
		internal.session = {
			prompt: async (message: string) => {
				prompts.push(message);
			},
		};

		await service.approveConfirmation("approval-1");

		expect(hostCalls).toEqual([{ action: "open_app", target: "notepad.exe" }]);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("<desktop_action_approved_result>");
		expect(prompts[0]).toContain("intent: Open Notepad");
		expect(prompts[0]).toContain("stdout: command completed");
		expect(service.snapshot().pendingConfirmations).toEqual([]);
	});

	it("keeps isRunning true while an approved action is still executing", async () => {
		let resolveAction: ((value: { stdout: string; stderr: string }) => void) | undefined;
		const service = new DesktopAgentService({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			host: {
				runDesktopAction: () =>
					new Promise<{ stdout: string; stderr: string }>((resolve) => {
						resolveAction = resolve;
					}),
			} as never,
		});
		const internal = service as unknown as {
			pendingConfirmations: Array<{
				id: string;
				intent: string;
				action: string;
				target: string;
				riskLevel: "low" | "medium" | "high";
				createdAt: number;
			}>;
			session: { prompt: (_message: string, _options?: unknown) => Promise<void> };
		};

		internal.pendingConfirmations = [
			{
				id: "approval-2",
				intent: "Adjust volume",
				action: "set_volume",
				target: "30%",
				riskLevel: "medium",
				createdAt: Date.now(),
			},
		];
		internal.session = {
			prompt: async () => {},
		};

		const approvalPromise = service.approveConfirmation("approval-2");
		await Promise.resolve();

		expect(service.snapshot().isRunning).toBe(true);

		resolveAction?.({ stdout: "ok", stderr: "" });
		await approvalPromise;

		expect(service.snapshot().isRunning).toBe(false);
	});

	it("surfaces empty assistant errors instead of only showing agent finished", () => {
		const service = new DesktopAgentService({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			host: new DryRunDesktopAutomationHost(),
		});
		const internal = service as unknown as {
			handleSessionEvent: (event: unknown) => void;
		};
		const assistantError = {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "deepseek",
			model: "deepseek-v4-pro",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "DeepSeek rejected the tool-result continuation",
			timestamp: Date.now(),
		};

		internal.handleSessionEvent({ type: "message_end", message: assistantError });
		internal.handleSessionEvent({ type: "agent_end", messages: [assistantError], willRetry: false });

		const snapshot = service.snapshot();
		expect(snapshot.messages.at(-1)).toMatchObject({
			role: "system",
			text: expect.stringContaining("DeepSeek rejected the tool-result continuation"),
		});
		expect(snapshot.timeline.at(-1)).toMatchObject({
			kind: "error",
			title: "模型响应失败",
			status: "failed",
		});
	});

	it("refreshes web_search provider after search settings change", async () => {
		const fetchCalls: Array<{ input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] }> = [];
		const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			fetchCalls.push({ input, init });
			return new Response(
				JSON.stringify({
					results: [{ title: "Result", url: "https://example.com/news", content: "Latest news" }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const service = new DesktopAgentService({
				cwd: process.cwd(),
				agentDir: process.cwd(),
				host: new DryRunDesktopAutomationHost(),
			});
			await service.initialize();
			await service.updateSettings({
				webSearch: { mode: "auto", provider: "tavily", apiKey: "tvly-test" },
			});
			const internal = service as unknown as {
				session?: { getToolDefinition: (name: string) => ToolDefinition | undefined };
			};
			const webSearchTool = internal.session?.getToolDefinition("web_search");
			if (!webSearchTool) throw new Error("web_search tool missing");

			const response = await webSearchTool.execute(
				"tool-search",
				{ query: "today news", maxResults: 1 },
				undefined,
				undefined,
				stubContext(),
			);
			const details = response.details as DesktopToolResult;

			expect(String(fetchCalls[0]?.input)).toBe("https://api.tavily.com/search");
			expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toMatchObject({
				api_key: "tvly-test",
				query: "today news",
				max_results: 1,
			});
			expect(details.stdout).toContain('"provider":"Tavily"');
			expect(webSearchTool.promptGuidelines?.join("\n")).toContain("tavily");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("repairs http port 443 redirects while fetching web pages", async () => {
		const fetchCalls: string[] = [];
		const fetchImpl = mockFetchSequence(fetchCalls, [
			new Response("", {
				status: 301,
				headers: { location: "http://www.xiaoxiongyouhao.com:443/fprice/" },
			}),
			new Response("<html><body>today price</body></html>", {
				status: 200,
				headers: { "content-type": "text/html; charset=UTF-8" },
			}),
		]);
		const tool = webFetchTool(fetchImpl);

		const response = await tool.execute(
			"tool-web-fetch",
			{ url: "https://www.xiaoxiongyouhao.com/fprice" },
			undefined,
			undefined,
			stubContext(),
		);
		const details = response.details as DesktopToolResult;

		expect(fetchCalls).toEqual(["https://www.xiaoxiongyouhao.com/fprice", "https://www.xiaoxiongyouhao.com/fprice/"]);
		expect(details.status).toBe("succeeded");
		expect(details.stdout).toContain("today price");
	});

	it("tries a trailing slash web_fetch candidate after direct network failure", async () => {
		const fetchCalls: string[] = [];
		const fetchImpl = mockFetchSequence(fetchCalls, [
			new TypeError("net::ERR_QUIC_PROTOCOL_ERROR"),
			new Response("slash ok", { status: 200, headers: { "content-type": "text/plain" } }),
		]);
		const tool = webFetchTool(fetchImpl);

		const response = await tool.execute(
			"tool-web-fetch",
			{ url: "https://example.com/path" },
			undefined,
			undefined,
			stubContext(),
		);
		const details = response.details as DesktopToolResult;

		expect(fetchCalls).toEqual(["https://example.com/path", "https://example.com/path/"]);
		expect(details.status).toBe("succeeded");
		expect(details.stdout).toBe("slash ok");
	});

	it("blocks web_fetch redirects rejected by sandbox network policy", async () => {
		const fetchCalls: string[] = [];
		const fetchImpl = mockFetchSequence(fetchCalls, [
			new Response("", { status: 302, headers: { location: "https://blocked.example/page" } }),
		]);
		const tool = webFetchTool(fetchImpl, {
			domainAllowList: ["allowed.example"],
			domainDenyList: [],
			blockPrivateIps: true,
		});

		const response = await tool.execute(
			"tool-web-fetch",
			{ url: "https://allowed.example/start" },
			undefined,
			undefined,
			stubContext(),
		);
		const details = response.details as DesktopToolResult;

		expect(fetchCalls).toEqual(["https://allowed.example/start"]);
		expect(details.status).toBe("failed");
		expect(details.stderr).toContain("blocked.example");
	});

	it("fails web_fetch clearly after too many redirects", async () => {
		const fetchCalls: string[] = [];
		const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			fetchCalls.push(url);
			return new Response("", { status: 302, headers: { location: `${url}/next` } });
		};
		const tool = webFetchTool(fetchImpl as typeof fetch);

		const response = await tool.execute(
			"tool-web-fetch",
			{ url: "https://example.com/start/" },
			undefined,
			undefined,
			stubContext(),
		);
		const details = response.details as DesktopToolResult;

		expect(fetchCalls).toHaveLength(7);
		expect(details.status).toBe("failed");
		expect(details.stderr).toContain("Too many redirects");
	});

	it("reports both direct and Jina web_fetch failures", async () => {
		const fetchCalls: string[] = [];
		const fetchImpl = mockFetchSequence(fetchCalls, [
			new TypeError("net::ERR_QUIC_PROTOCOL_ERROR"),
			new TypeError("slash still failed"),
			new Response("", { status: 502 }),
		]);
		const tool = webFetchTool(fetchImpl);

		const response = await tool.execute(
			"tool-web-fetch",
			{ url: "https://example.com/path" },
			undefined,
			undefined,
			stubContext(),
		);
		const details = response.details as DesktopToolResult;

		expect(fetchCalls).toEqual([
			"https://example.com/path",
			"https://example.com/path/",
			"https://r.jina.ai/https://example.com/path",
		]);
		expect(details.status).toBe("failed");
		expect(details.stderr).toContain("Direct fetch failed:");
		expect(details.stderr).toContain("net::ERR_QUIC_PROTOCOL_ERROR");
		expect(details.stderr).toContain("slash retry failed: slash still failed");
		expect(details.stderr).toContain("Jina fallback failed: Jina 502");
	});

	it("disables system operation tools when the system capability is disabled", () => {
		expect(getActiveDesktopToolNames({ enabled: false, commandFirst: true, skillName: "system-operation" })).toEqual(
			[],
		);
	});

	it("documents command-first system operation behavior for the model", () => {
		const tools = createDesktopToolDefinitions({
			host: new DryRunDesktopAutomationHost(),
			permissionMode: () => "tiered",
			systemCapability: () => enabledSystemCapability,
		});
		const settingsTool = tools.find((entry) => entry.name === "open_windows_settings");
		const audioTool = tools.find((entry) => entry.name === "set_audio_device_or_volume");

		expect(settingsTool?.promptSnippet).toContain("Fallback-only");
		expect(audioTool?.promptGuidelines?.join("\n")).toContain("prefer direct background command or API tools");
		expect(audioTool?.promptGuidelines?.join("\n")).toContain("Do not open sound settings");
	});

	it("loads the system operation skill for desktop control guidance", async () => {
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			additionalSkillPaths: [join(process.cwd(), "packages", "desktop-assistant", "skills", "system-operation")],
		});
		await loader.reload();

		const skill = loader.getSkills().skills.find((item) => item.name === "system-operation");

		expect(skill?.description).toContain("Windows system operation capability");
		expect(skill?.filePath.replace(/\\/g, "/")).toContain("skills/system-operation/SKILL.md");
	});

	it("resolves distinct skill files for every desktop capability", () => {
		const files = resolveDesktopSkillFiles(process.cwd());

		expect(files.system.replace(/\\/g, "/")).toContain("skills/system-operation/SKILL.md");
		expect(files.document.replace(/\\/g, "/")).toContain("skills/document-operation/SKILL.md");
		expect(files.ppt.replace(/\\/g, "/")).toContain("skills/ppt-operation/SKILL.md");
		expect(files.excel.replace(/\\/g, "/")).toContain("skills/excel-operation/SKILL.md");
	});

	it("classifies user requests to the matching enabled skill", () => {
		const enabled: DesktopCapabilityId[] = ["system", "document", "ppt", "excel"];

		expect(classifySkillHeuristically("帮我做一份项目汇报 PPT", enabled)).toBe("ppt");
		expect(classifySkillHeuristically("整理这个 Excel 表格公式", enabled)).toBe("excel");
		expect(classifySkillHeuristically("润色这份合同文档", enabled)).toBe("document");
		expect(classifySkillHeuristically("把音量调到 30%", enabled)).toBe("system");
	});

	it("does not select a disabled capability during heuristic routing", () => {
		expect(classifySkillHeuristically("帮我做一份项目汇报 PPT", ["system", "document"])).toBeUndefined();
	});

	it("wraps the selected skill content before the user request", () => {
		const prompt = buildSkillRoutedPrompt("做一份幻灯片", {
			capabilityId: "ppt",
			skillName: "ppt-operation",
			path: "C:\\skills\\ppt-operation\\SKILL.md",
			content: "# PPT Operation Capability",
			editable: true,
		});

		expect(prompt).toContain('<selected_desktop_skill capability="ppt" name="ppt-operation"');
		expect(prompt).toContain("# PPT Operation Capability");
		expect(prompt.endsWith("做一份幻灯片")).toBe(true);
	});

	it("reads and updates skill files through the service", async () => {
		const service = new DesktopAgentService({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			host: new DryRunDesktopAutomationHost(),
		});
		const before = service.getSkillFile("ppt");

		const updated = await service.updateSkillFile("ppt", before.content);

		expect(updated.capabilityId).toBe("ppt");
		expect(updated.skillName).toBe("ppt-operation");
		expect(updated.content).toBe(before.content);
		expect(updated.path).toBe(before.path);
	});

	it("injects system operation skill content even without the read tool", () => {
		const skillFile = resolveSystemOperationSkillFile(process.cwd());
		const prompt = buildSystemOperationAppendPrompt(skillFile);

		expect(prompt).toContain("<desktop_system_operation_skill>");
		expect(prompt).toContain("System Operation Capability");
		expect(prompt).toContain("must call an appropriate desktop tool");
	});

	it("loads inspect-first document skill guidance", () => {
		const files = resolveDesktopSkillFiles(process.cwd());
		const prompt = buildSkillRoutedPrompt("修改这份 Word 文档", {
			capabilityId: "document",
			skillName: "document-operation",
			path: files.document,
			content: readFileSync(files.document, "utf-8"),
			editable: true,
		});

		expect(prompt).toContain("doc_inspect");
		expect(prompt).toContain("doc_apply_edits");
		expect(prompt).toContain("office_word_run");
	});

	it("remembers find_app results as launch aliases", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-app-cache-"));
		try {
			const cachePath = getAppLaunchCachePath(dir);
			rememberFindAppResults(
				cachePath,
				"QQ",
				JSON.stringify({
					found: true,
					count: 1,
					results: [{ name: "TIM", launch: "shell:AppsFolder\\Tencent.TIM!App", kind: "app" }],
				}),
			);

			const cache = readAppLaunchCache(cachePath);
			expect(cache.aliases.qq?.launch).toBe("shell:AppsFolder\\Tencent.TIM!App");
			expect(cache.aliases.qq?.targetType).toBe("app");
			expect(cache.aliases.qq?.sourceQueries).toContain("QQ");
			expect(resolveRememberedLaunch(cachePath, "腾讯QQ")?.entry.launch).toBe("shell:AppsFolder\\Tencent.TIM!App");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("deletes one app launch cache alias without clearing the rest", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-app-cache-delete-"));
		try {
			const cachePath = getAppLaunchCachePath(dir);
			rememberSuccessfulLaunch(cachePath, {
				query: "QQ",
				displayName: "TIM",
				launch: "shell:AppsFolder\\Tencent.TIM!App",
				kind: "app",
			});
			rememberSuccessfulLaunch(cachePath, {
				query: "Google Translate",
				displayName: "Google Translate",
				launch: "https://translate.google.com/",
				kind: "url",
				targetType: "url",
			});

			const cache = deleteAppLaunchCacheEntry(cachePath, "qq");

			expect(cache.aliases.qq).toBeUndefined();
			expect(cache.aliases.googletranslate?.launch).toBe("https://translate.google.com/");
			expect(cache.aliases.googletranslate?.targetType).toBe("url");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("learns known website targets when app lookup fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-site-cache-"));
		try {
			const cachePath = getAppLaunchCachePath(dir);
			const host = new FailingNameThenWebsiteHost();
			const tools = createDesktopToolDefinitions({
				host,
				permissionMode: () => "tiered",
				systemCapability: () => enabledSystemCapability,
				appLaunchCachePath: cachePath,
			});
			const tool = tools.find((entry) => entry.name === "open_app");
			if (!tool) throw new Error("open_app tool missing");

			const response = await tool.execute("tool-1", { app: "谷歌翻译" }, undefined, undefined, stubContext());
			const details = response.details as DesktopToolResult;
			const cache = readAppLaunchCache(cachePath);

			expect(details.status).toBe("succeeded");
			expect(host.started).toContain("https://translate.google.com/");
			expect(cache.aliases.谷歌翻译?.launch).toBe("https://translate.google.com/");
			expect(cache.aliases.谷歌翻译?.targetType).toBe("url");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exposes app launch cache management through the service", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-app-cache-service-"));
		try {
			const service = new DesktopAgentService({
				cwd: process.cwd(),
				agentDir: dir,
				host: new DryRunDesktopAutomationHost(),
			});

			const cachePath = getAppLaunchCachePath(dir);
			rememberFindAppResults(
				cachePath,
				"微信",
				JSON.stringify({
					found: true,
					count: 1,
					results: [{ name: "微信", launch: "shell:AppsFolder\\Tencent.WeChat!App", kind: "app" }],
				}),
			);

			expect(service.getAppLaunchCache().aliases.wechat?.displayName).toBe("微信");
			expect(service.deleteAppLaunchCacheEntry("wechat").aliases.wechat).toBeUndefined();
			expect(service.getAppLaunchCache().aliases.wechat).toBeUndefined();
			expect(service.clearAppLaunchCache().aliases).toEqual({});
			expect(service.getAppLaunchCache().aliases).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("renders cache delete buttons safely for aliases containing quotes", () => {
		const html = buildAppLaunchCacheHtml({
			path: "C:\\temp\\app-launch-cache.json",
			version: 1,
			updatedAt: 0,
			aliases: {
				'foo"bar': {
					displayName: 'Foo "Bar"',
					launch: "https://example.com/",
					kind: "url",
					targetType: "url",
					sourceQueries: ['foo"bar'],
					successCount: 1,
					failCount: 0,
					lastSucceededAt: 1,
					lastFailedAt: undefined,
				},
			},
		});

		expect(html).toContain('data-alias="foo&quot;bar"');
		expect(html).toContain('onclick="deleteEntry(this.dataset.alias)"');
		expect(html).not.toContain('onclick="deleteEntry("foo');
	});
});

class FailingNameThenWebsiteHost implements DesktopAutomationHost {
	started: string[] = [];

	async startProcess(file: string): Promise<CommandResult> {
		this.started.push(file);
		if (!/^https?:/i.test(file)) throw new Error(`Cannot start ${file}`);
		return { stdout: `Started ${file}`, stderr: "" };
	}

	async runPowerShell(): Promise<CommandResult> {
		return { stdout: '{"found":false,"count":0,"results":[]}', stderr: "" };
	}

	async runPowerShellManaged(): Promise<CommandResult> {
		return { stdout: '{"found":false,"count":0,"results":[]}', stderr: "" };
	}

	async continuePowerShell(): Promise<CommandResult> {
		return { stdout: '{"found":false,"count":0,"results":[]}', stderr: "" };
	}

	abortPowerShell(): void {}

	async runDesktopAction(action: string, target: string): Promise<CommandResult> {
		return { stdout: `approved ${action} ${target}`, stderr: "" };
	}

	async typeText(text: string): Promise<CommandResult> {
		return { stdout: `typed ${text}`, stderr: "" };
	}

	async keyTap(key: string, modifiers: string[] = []): Promise<CommandResult> {
		return { stdout: `key ${[...modifiers, key].join("+")}`, stderr: "" };
	}

	async sendKeyChord(key: string, modifiers: string[] = []): Promise<CommandResult> {
		return { stdout: `key ${[...modifiers, key].join("+")}`, stderr: "" };
	}

	async sendMediaCommand(command: "play" | "pause" | "toggle" | "next" | "previous"): Promise<CommandResult> {
		return { stdout: `media ${command}`, stderr: "" };
	}

	async mouseClick(button: "left" | "right" | "middle"): Promise<CommandResult> {
		return { stdout: `click ${button}`, stderr: "" };
	}

	async listWindows(): Promise<Array<{ title: string; processName?: string; isActive?: boolean }>> {
		return [{ title: "Google Translate", processName: "msedge" }];
	}

	async focusWindow(titleOrProcess: string): Promise<CommandResult> {
		return { stdout: `focus ${titleOrProcess}`, stderr: "" };
	}

	async getActiveWindow(): Promise<{ title: string; processName?: string; isActive?: boolean } | undefined> {
		return { title: "Google Translate", processName: "msedge", isActive: true };
	}
}

function webFetchTool(
	fetchImpl: typeof fetch,
	network?: Parameters<typeof createWebTools>[0]["network"],
): ToolDefinition {
	const tool = createWebTools({
		mode: "auto",
		provider: "duckduckgo",
		fetchImpl,
		network,
	}).find((entry) => entry.name === "web_fetch");
	if (!tool) throw new Error("web_fetch tool missing");
	return tool;
}

function mockFetchSequence(calls: string[], responses: Array<Response | Error>): typeof fetch {
	return (async (input: Parameters<typeof fetch>[0]) => {
		calls.push(String(input));
		const next = responses.shift();
		if (!next) throw new Error(`Unexpected fetch call: ${String(input)}`);
		if (next instanceof Error) throw next;
		return next;
	}) as typeof fetch;
}

function stubContext() {
	return {
		cwd: process.cwd(),
		hasUI: false,
		model: undefined,
		signal: undefined,
		sessionManager: {},
		modelRegistry: {},
		ui: {},
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as never;
}
