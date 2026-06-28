import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { BrowserWindow, dialog, type IpcMain, Notification, shell } from "electron";
import type { DesktopAgentService } from "../agent/desktop-agent-service.ts";
import {
	type AbortRequest,
	type ApiKeyUpdateRequest,
	type AutomationCancelRunRequest,
	type AutomationCreateRequest,
	type AutomationDeleteRequest,
	type AutomationFlow,
	type AutomationOpenEditorRequest,
	type AutomationRunRequest,
	type AutomationSetEnabledRequest,
	type AutomationUpdateRequest,
	type BrowserClearStorageRequest,
	type BrowserCookieRequest,
	type BrowserElementActionRequest,
	type BrowserKeyRequest,
	type BrowserNavigateRequest,
	type BrowserQueryElementsRequest,
	type BrowserReadPageRequest,
	type BrowserScreenshotRequest,
	type BrowserScrollRequest,
	type BrowserSetBoundsRequest,
	type BrowserTabRequest,
	type BrowserVirtualMouseRequest,
	type ClearConversationHistoryResponse,
	type CloseSessionRequest,
	type ConfirmationUpdateRequest,
	type ConversationThinkingUpdateRequest,
	DESKTOP_ASSISTANT_CHANNELS,
	type DeleteAppLaunchCacheEntryRequest,
	type DeleteConversationRequest,
	type DeleteConversationResponse,
	type DeleteForgeExtensionRequest,
	type DesktopAssistantEvent,
	type FileActionResponse,
	type FilePathRequest,
	type FocusSessionRequest,
	type GlobalMemoryDeleteRequest,
	type GlobalMemoryUpdateRequest,
	type InstallSoftwarePluginRequest,
	type LoadConversationPageRequest,
	type LogEntry,
	type McpEnabledUpdateRequest,
	type McpServerActionRequest,
	type McpServerDeleteRequest,
	type McpServerUpsertRequest,
	type MemoAttachmentAddRequest,
	type MemoAttachmentRemoveRequest,
	type MemoBatchRequest,
	type MemoCompleteRequest,
	type MemoCreateRequest,
	type MemoDeleteRequest,
	type MemoItem,
	type MemoListCreateRequest,
	type MemoListDeleteRequest,
	type MemoListReorderRequest,
	type MemoListRequest,
	type MemoListUpdateRequest,
	type MemoReorderRequest,
	type MemoRunAutoRequest,
	type MemoSetReminderRequest,
	type MemoSnoozeRequest,
	type MemoUpdateRequest,
	type MoreAppActionRequest,
	type OpenBuiltInBrowserRequest,
	type OpenMoreAppAtPathRequest,
	type OpenUrlInDefaultBrowserRequest,
	type PersonalSkillArchiveRequest,
	type PersonalSkillReadRequest,
	type PersonalSkillSaveRequest,
	type PersonalSkillSearchRequest,
	type PetDebugSnapshot,
	type PetDebugStateEvent,
	type PetDebugUpdateRequest,
	type PromptRequest,
	type QueuedPreInputRequest,
	type RefreshHomeWelcomeRequest,
	type ResumeConversationRequest,
	type SandboxCleanRequest,
	type SetForgeExtensionTrustRequest,
	type SettingsUpdateRequest,
	type SkillFileRequest,
	type SkillFileUpdateRequest,
	type StartVoiceRequest,
	type StartWakeKwsRequest,
	type TestSoftwarePluginBridgeRequest,
	type TranscribeAudioRequest,
	type UninstallSoftwarePluginRequest,
	type UpdateMoreAppConfigRequest,
	type ValidateSoftwarePluginTargetRequest,
	type VoiceApiKeyUpdateRequest,
	type VoiceOverlayUpdateRequest,
	type WakeKwsAudioFrame,
	type WakeWordModelDeleteRequest,
	type WakeWordModelImportRequest,
	type WakeWordModelReadRequest,
	type WindowMode,
} from "../shared/types.ts";
import { syncVoiceWakeWordUpdate } from "../shared/wake-word-settings.ts";
import type { KwsService } from "../voice/kws-service.ts";
import { transcribeAudio } from "../voice/stt-client.ts";
import type { VoiceBridge } from "../voice/voice-bridge.ts";
import type { BuiltInBrowserController } from "./built-in-browser-controller.ts";
import type { ExternalAppController } from "./external-app-controller.ts";
import type { LogStore } from "./log-store.ts";
import type { WakeWordModelStore } from "./wake-word-model-store.ts";
import { applyWindowMode } from "./window-mode.ts";

// ─── Log entry helpers ────────────────────────────────────────────────────────

function truncateJson(value: unknown, maxLen = 3000): string {
	const json = JSON.stringify(value, null, 2);
	return json.length > maxLen ? `${json.slice(0, maxLen)}\n…（省略 ${json.length - maxLen} 字符）` : json;
}

function agentEventToLogEntry(agentEvent: unknown): LogEntry | undefined {
	if (typeof agentEvent !== "object" || agentEvent === null) return undefined;
	const ev = agentEvent as Record<string, unknown>;
	const ts = Date.now();
	switch (ev.type) {
		case "agent_start":
			return { id: randomUUID(), ts, cat: "system", title: "Agent 开始" };
		case "agent_end": {
			const willRetry = Boolean(ev.willRetry);
			return {
				id: randomUUID(),
				ts,
				cat: willRetry ? "retry" : "system",
				title: willRetry ? "Agent 将重试" : "Agent 完成",
			};
		}
		case "tool_execution_start": {
			const toolName = String(ev.toolName ?? "");
			return {
				id: randomUUID(),
				ts,
				cat: "tool_call",
				title: toolName,
				detail: ev.args ? truncateJson(ev.args) : undefined,
			};
		}
		case "tool_execution_end": {
			const toolName = String(ev.toolName ?? "");
			const isError = Boolean(ev.isError);
			return {
				id: randomUUID(),
				ts,
				cat: "tool_result",
				title: `${toolName} → ${isError ? "error" : "ok"}`,
				detail: ev.result !== undefined ? truncateJson(ev.result) : undefined,
			};
		}
		case "message_end": {
			const msg = ev.message as Record<string, unknown> | undefined;
			if (!msg || msg.role !== "assistant") return undefined;
			const content = msg.content as Array<Record<string, unknown>> | undefined;
			if (!Array.isArray(content)) return undefined;
			const text = content
				.filter((c) => c.type === "text")
				.map((c) => String(c.text ?? ""))
				.join("");
			if (!text) return undefined;
			return {
				id: randomUUID(),
				ts,
				cat: "ai",
				title: text.length > 80 ? `${text.slice(0, 80)}…` : text,
				detail: text,
			};
		}
		case "message_update": {
			const ae = ev.assistantMessageEvent as Record<string, unknown> | undefined;
			if (!ae || ae.type !== "thinking_delta") return undefined;
			const delta = String(ae.delta ?? "");
			if (!delta.trim()) return undefined;
			return {
				id: randomUUID(),
				ts,
				cat: "think",
				title: delta.length > 80 ? `${delta.slice(0, 80)}…` : delta,
				detail: delta.length > 80 ? delta : undefined,
			};
		}
		case "auto_retry_start": {
			const attempt = Number(ev.attempt ?? 0);
			const maxAttempts = Number(ev.maxAttempts ?? 0);
			const errorMessage = String(ev.errorMessage ?? "");
			return {
				id: randomUUID(),
				ts,
				cat: "retry",
				title: `重试 ${attempt}/${maxAttempts}`,
				detail: errorMessage || undefined,
			};
		}
		case "auto_retry_end": {
			const success = Boolean(ev.success);
			return {
				id: randomUUID(),
				ts,
				cat: success ? "system" : "error",
				title: success ? "重试成功" : "重试失败",
				detail: String(ev.finalError ?? "") || undefined,
			};
		}
		default:
			return undefined;
	}
}

function desktopEventToLogEntry(event: DesktopAssistantEvent): LogEntry | undefined {
	if (event.type === "agent_event") {
		return agentEventToLogEntry(event.agentEvent);
	}
	if (event.type === "diagnostic" && event.diagnostic) {
		const diagnostic = event.diagnostic;
		return {
			id: randomUUID(),
			ts: Date.now(),
			cat: diagnostic.level === "error" ? "error" : "diagnostic",
			title: `[${diagnostic.source}] ${diagnostic.title}`,
			detail: diagnostic.details ? truncateJson(diagnostic.details, 6000) : undefined,
		};
	}
	if (event.type === "error") {
		return { id: randomUUID(), ts: Date.now(), cat: "error", title: event.error ?? "未知错误" };
	}
	if (event.type === "timeline" && event.timelineItem) {
		const item = event.timelineItem;
		if (item.title === "已停止执行") {
			return { id: randomUUID(), ts: Date.now(), cat: "abort", title: "已停止执行" };
		}
	}
	return undefined;
}

/**
 * Put the real file onto the Windows clipboard (CF_HDROP) so the user can paste it
 * into Explorer or another app. Electron's clipboard can't write a file drop, so we
 * shell out to PowerShell's Set-Clipboard, which sets the file-drop list natively.
 */
function copyFileToClipboard(rawPath: string): Promise<FileActionResponse> {
	const target = rawPath?.trim();
	if (!target || !existsSync(target)) {
		return Promise.resolve({ ok: false, error: "文件不存在或已被移动" });
	}
	const escaped = target.replace(/'/g, "''");
	return new Promise((resolve) => {
		const child = spawn(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", `Set-Clipboard -LiteralPath '${escaped}'`],
			{ windowsHide: true },
		);
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => resolve({ ok: false, error: error.message }));
		child.on("close", (code) =>
			resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `退出码 ${code}` }),
		);
	});
}

// ─────────────────────────────────────────────────────────────────────────────

export function registerDesktopAssistantIpc(params: {
	ipcMain: IpcMain;
	mainWindow: BrowserWindow;
	getWindows?: () => Iterable<BrowserWindow>;
	service: DesktopAgentService;
	builtInBrowserController: BuiltInBrowserController;
	externalAppController: ExternalAppController;
	voiceBridge: VoiceBridge;
	logStore: LogStore;
	wakeWordModelStore: WakeWordModelStore;
	kwsService: KwsService;
	openAppLaunchCacheWindow: () => Promise<void>;
	openMcpManagerWindow: () => Promise<void>;
	openToolsetManagerWindow: () => Promise<void>;
	openPluginManagerWindow: () => Promise<void>;
	openPersonalSkillManagerWindow: () => Promise<void>;
	openFlowEditorWindow: (flowId?: string) => Promise<void>;
	openLogWindow: () => Promise<void>;
	openSandboxSettingsWindow: () => Promise<void>;
}): void {
	const {
		ipcMain,
		mainWindow,
		getWindows,
		service,
		builtInBrowserController,
		externalAppController,
		voiceBridge,
		logStore,
		wakeWordModelStore,
		kwsService,
		openAppLaunchCacheWindow,
		openMcpManagerWindow,
		openToolsetManagerWindow,
		openPluginManagerWindow,
		openPersonalSkillManagerWindow,
		openLogWindow,
		openSandboxSettingsWindow,
	} = params;

	// Throttle full-snapshot IPC events so that rapid back-to-back pushes during
	// tool calls / streaming don't flood the renderer with re-renders.
	// Non-snapshot event types (timeline, streaming_text, voice) are sent immediately.
	const SNAPSHOT_THROTTLE_MS = 80;
	let pendingSnapshot: DesktopAssistantEvent | undefined;
	let snapshotThrottleTimer: ReturnType<typeof setTimeout> | undefined;
	let latestPetDebug: PetDebugSnapshot | undefined;
	// Background sessions emit a lightweight roster ("session_status") on every
	// state change; coalesce those bursts on their own bucket so a busy background
	// agent can't flood the renderer with list re-renders.
	let pendingSessionStatus: DesktopAssistantEvent | undefined;
	let sessionStatusThrottleTimer: ReturnType<typeof setTimeout> | undefined;

	function sendToRenderer(event: DesktopAssistantEvent): void {
		for (const window of getWindows?.() ?? [mainWindow]) {
			if (window.isDestroyed()) continue;
			window.webContents.send(DESKTOP_ASSISTANT_CHANNELS.events, event);
		}
	}

	function sendPetDebugEvent(event: PetDebugStateEvent): void {
		for (const window of getWindows?.() ?? [mainWindow]) {
			if (window.isDestroyed()) continue;
			window.webContents.send(DESKTOP_ASSISTANT_CHANNELS.petDebugEvent, event);
		}
	}

	// OS-level reminder toast. Clicking it focuses the main window and opens the memo page.
	function showMemoReminderNotification(memo: MemoItem): void {
		if (!Notification.isSupported()) return;
		const prefix = memo.reminderMissed ? "错过的提醒 · " : "提醒 · ";
		const notification = new Notification({
			title: `${prefix}${memo.title}`,
			body: memo.notes?.slice(0, 200) || "点击查看备忘录",
			silent: false,
		});
		notification.on("click", () => {
			if (mainWindow.isDestroyed()) return;
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.show();
			mainWindow.focus();
			sendToRenderer({ type: "route", route: "memo" });
		});
		notification.show();
	}

	// OS-level alert for a scheduled automation that was missed while the app was closed.
	// Missed runs are never auto-executed (desktop actions firing late is disruptive), so we
	// just nudge the user; clicking opens the automation page to run it manually.
	function showAutomationMissedNotification(flow: AutomationFlow): void {
		if (!Notification.isSupported()) return;
		const notification = new Notification({
			title: `错过的自动化 · ${flow.name}`,
			body: "应用未运行期间错过了计划执行，点击查看。",
			silent: false,
		});
		notification.on("click", () => {
			if (mainWindow.isDestroyed()) return;
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.show();
			mainWindow.focus();
			sendToRenderer({ type: "route", route: "automation" });
		});
		notification.show();
	}

	function scheduleSnapshotSend(event: DesktopAssistantEvent): void {
		// Always keep the latest snapshot so the renderer sees fresh state.
		pendingSnapshot = event;
		if (snapshotThrottleTimer) return;
		snapshotThrottleTimer = setTimeout(() => {
			snapshotThrottleTimer = undefined;
			if (pendingSnapshot) {
				sendToRenderer(pendingSnapshot);
				pendingSnapshot = undefined;
			}
		}, SNAPSHOT_THROTTLE_MS);
	}

	function scheduleSessionStatusSend(event: DesktopAssistantEvent): void {
		pendingSessionStatus = event;
		if (sessionStatusThrottleTimer) return;
		sessionStatusThrottleTimer = setTimeout(() => {
			sessionStatusThrottleTimer = undefined;
			if (pendingSessionStatus) {
				sendToRenderer(pendingSessionStatus);
				pendingSessionStatus = undefined;
			}
		}, SNAPSHOT_THROTTLE_MS);
	}

	service.subscribe((event) => {
		// agent_event carries raw model deltas — filter from main renderer but keep for log store.
		if (event.type !== "agent_event") {
			if (event.type === "snapshot") {
				// Throttle: coalesce rapid snapshot bursts into a single IPC send.
				scheduleSnapshotSend(event);
			} else if (event.type === "session_status") {
				// Coalesce background roster updates on their own throttle bucket.
				scheduleSessionStatusSend(event);
			} else if (event.type === "timeline" && event.timelineItem?.kind === "thinking_summary") {
				// thinking_summary items are emitted at full token speed and are filtered
				// from the renderer display anyway — drop them to prevent IPC flooding.
			} else {
				// timeline, streaming_text, voice, session_notification etc. — send immediately.
				sendToRenderer(event);
				if (event.type === "memo_reminder" && event.memo) {
					showMemoReminderNotification(event.memo);
				}
				if (event.type === "automation_missed" && event.automation) {
					showAutomationMissedNotification(event.automation);
				}
			}
		}
		const entry = desktopEventToLogEntry(event);
		if (entry) logStore.push(entry);
	});

	voiceBridge.on("wake", (state) => service.updateVoiceOverlay(state));
	voiceBridge.on("transcript", (state) => service.updateVoiceOverlay(state));
	voiceBridge.on("error", (state) => service.updateVoiceOverlay(state));

	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.getSnapshot, () => service.snapshot());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.newConversation, async () => service.newConversation());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.listSessions, () => service.listSessions());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.focusSession, async (_event, request: FocusSessionRequest) =>
		service.focusSession(request.sessionId),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.closeSession, async (_event, request: CloseSessionRequest) =>
		service.closeSession(request.sessionId),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.prompt, async (_event, request: PromptRequest) => {
		logStore.push({
			id: randomUUID(),
			ts: Date.now(),
			cat: "user",
			title: request.message.length > 80 ? `${request.message.slice(0, 80)}…` : request.message,
			detail: request.message.length > 80 ? request.message : undefined,
		});
		await service.prompt(request.message, request.source, request.attachments, request.sessionId, request.delivery);
		return service.snapshot();
	});
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.deleteQueuedPreInput, (_event, request: QueuedPreInputRequest) =>
		service.deleteQueuedPreInput(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.withdrawQueuedPreInput, (_event, request: QueuedPreInputRequest) =>
		service.withdrawQueuedPreInput(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.abort, (_event, request?: AbortRequest) => {
		service.abort(request?.sessionId);
		return service.snapshot();
	});
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.updateConversationThinking,
		(_event, request: ConversationThinkingUpdateRequest) => service.updateConversationThinking(request.enabled),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.updateApiKey, async (_event, request: ApiKeyUpdateRequest) =>
		service.updateApiKey(request.apiKey),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.discoverModels, async () => service.discoverModels());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.updateSettings, async (_event, request: SettingsUpdateRequest) => {
		const settings = syncVoiceWakeWordUpdate(
			request.settings,
			service.snapshot().settings,
			await wakeWordModelStore.list(),
		);
		return service.updateSettings(settings);
	});
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.refreshHomeWelcome, (_event, request?: RefreshHomeWelcomeRequest) => {
		void service.refreshHomeWelcome(request);
	});
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.getHomeWeather, () => service.getHomeWeather());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.listMcpServers, () => service.listMcpServers());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.upsertMcpServer, (_event, request: McpServerUpsertRequest) =>
		service.upsertMcpServer(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.deleteMcpServer, (_event, request: McpServerDeleteRequest) =>
		service.deleteMcpServer(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.testMcpServer, (_event, request: McpServerActionRequest) =>
		service.testMcpServer(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.refreshMcpServer, (_event, request: McpServerActionRequest) =>
		service.refreshMcpServer(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.setMcpEnabled, (_event, request: McpEnabledUpdateRequest) =>
		service.setMcpEnabled(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.approveConfirmation, async (_event, request: ConfirmationUpdateRequest) =>
		service.approveConfirmation(request.id, request.sessionId),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.rejectConfirmation, async (_event, request: ConfirmationUpdateRequest) =>
		service.rejectConfirmation(request.id, request.sessionId),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.getSkillFile, (_event, request: SkillFileRequest) =>
		service.getSkillFile(request.capabilityId),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.updateSkillFile, (_event, request: SkillFileUpdateRequest) =>
		service.updateSkillFile(request.capabilityId, request.content),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.listPersonalSkills, () => service.listPersonalSkills());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.searchPersonalSkills, (_event, request: PersonalSkillSearchRequest) =>
		service.searchPersonalSkills(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.readPersonalSkill, (_event, request: PersonalSkillReadRequest) =>
		service.readPersonalSkill(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.savePersonalSkill, (_event, request: PersonalSkillSaveRequest) =>
		service.savePersonalSkill(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.archivePersonalSkill, (_event, request: PersonalSkillArchiveRequest) =>
		service.archivePersonalSkill(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.refreshPersonalSkills, () => service.refreshPersonalSkills());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.listConversationHistory, () => service.listConversationHistory());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.resumeConversation, (_event, request: ResumeConversationRequest) =>
		service.resumeConversation(request.sessionId),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.loadConversationPage, (_event, request: LoadConversationPageRequest) =>
		service.loadConversationPage(request),
	);
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.deleteConversation,
		async (_event, request: DeleteConversationRequest): Promise<DeleteConversationResponse> =>
			service.deleteConversation(request.sessionId),
	);
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.clearConversationHistory,
		async (): Promise<ClearConversationHistoryResponse> => service.clearConversationHistory(),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.listGlobalMemories, () => service.listGlobalMemories());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.deleteGlobalMemory, (_event, request: GlobalMemoryDeleteRequest) =>
		service.deleteGlobalMemory(request.id),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.clearGlobalMemories, () => service.clearGlobalMemories());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.updateGlobalMemory, (_event, request: GlobalMemoryUpdateRequest) => {
		const { id, ...update } = request;
		return service.updateGlobalMemory(id, update);
	});
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.memoList, (_event, request: MemoListRequest = {}) =>
		service.listMemos(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.memoCreate, (_event, request: MemoCreateRequest) =>
		service.createMemo(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.memoUpdate, (_event, request: MemoUpdateRequest) =>
		service.updateMemo(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.memoReorder, (_event, request: MemoReorderRequest) =>
		service.reorderMemo(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.memoComplete, (_event, request: MemoCompleteRequest) =>
		service.completeMemo(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.memoSnooze, (_event, request: MemoSnoozeRequest) =>
		service.snoozeMemo(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.memoSetReminder, (_event, request: MemoSetReminderRequest) =>
		service.setMemoReminder(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.memoRunAutoNow, (_event, request: MemoRunAutoRequest) =>
		service.runMemoAutoTaskNow(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.memoDelete, (_event, request: MemoDeleteRequest) =>
		service.deleteMemo(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.memoStats, () => service.getMemoStats());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.memoBatch, (_event, request: MemoBatchRequest) =>
		service.batchMemos(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.memoListList, () => service.listMemoLists());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.memoListCreate, (_event, request: MemoListCreateRequest) =>
		service.createMemoList(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.memoListUpdate, (_event, request: MemoListUpdateRequest) =>
		service.updateMemoList(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.memoListReorder, (_event, request: MemoListReorderRequest) =>
		service.reorderMemoList(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.memoListDelete, (_event, request: MemoListDeleteRequest) =>
		service.deleteMemoList(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.memoAttachmentAdd, (_event, request: MemoAttachmentAddRequest) =>
		service.addMemoAttachment(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.memoAttachmentRemove, (_event, request: MemoAttachmentRemoveRequest) =>
		service.removeMemoAttachment(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.automationList, () => service.listAutomations());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.automationGet, (_event, request: { id: string }) => {
		return service.getAutomation(request);
	});
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.automationCreate, (_event, request: AutomationCreateRequest) =>
		service.createAutomation(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.automationUpdate, (_event, request: AutomationUpdateRequest) =>
		service.updateAutomation(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.automationDelete, (_event, request: AutomationDeleteRequest) => {
		service.deleteAutomation(request);
		return service.listAutomations();
	});
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.automationSetEnabled, (_event, request: AutomationSetEnabledRequest) =>
		service.setAutomationEnabled(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.automationRun, async (_event, request: AutomationRunRequest) => {
		return service.runAutomation(request);
	});
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.automationCancelRun, (_event, request: AutomationCancelRunRequest) => {
		service.cancelAutomationRun(request);
		const flow = service.getAutomation({ id: request.flowId });
		return flow?.lastRun;
	});
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.automationOpenEditor,
		async (_event, request?: AutomationOpenEditorRequest) => {
			const flowId = request?.flowId ?? (request as { id?: string } | undefined)?.id;
			await service.openAutomationEditor({ flowId });
		},
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.automationDraftGet, (_event, request: { flowId?: string } = {}) =>
		service.getAutomationDraft(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.automationDraftApply, (_event, request: { ops: never[] }) =>
		service.applyAutomationDraft(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.automationDraftSave, (_event, request: { flowId?: string } = {}) =>
		service.saveAutomationDraft(request),
	);
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.automationDesignChat,
		(_event, request: { flowId?: string; message: string }) => service.designAutomation(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.automationDesignState, () => service.startAutomationDesignSession());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.getAppLaunchCache, () => service.getAppLaunchCache());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.clearAppLaunchCache, () => service.clearAppLaunchCache());
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.deleteAppLaunchCacheEntry,
		(_event, request: DeleteAppLaunchCacheEntryRequest) => service.deleteAppLaunchCacheEntry(request.alias),
	);
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.openUrlInDefaultBrowser,
		(_event, request: OpenUrlInDefaultBrowserRequest) =>
			builtInBrowserController.openUrl(
				request.browser ?? service.snapshot().settings.browser.defaultBrowser,
				request.url,
			),
	);
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.openPath,
		async (_event, request: FilePathRequest): Promise<FileActionResponse> => {
			const target = request.path?.trim();
			if (!target || !existsSync(target)) return { ok: false, error: "文件不存在或已被移动" };
			// shell.openPath returns "" on success, or an error string.
			const error = await shell.openPath(target);
			return error ? { ok: false, error } : { ok: true };
		},
	);
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.showItemInFolder,
		(_event, request: FilePathRequest): FileActionResponse => {
			const target = request.path?.trim();
			if (!target || !existsSync(target)) return { ok: false, error: "文件不存在或已被移动" };
			shell.showItemInFolder(target);
			return { ok: true };
		},
	);
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.copyFileToClipboard,
		(_event, request: FilePathRequest): Promise<FileActionResponse> => copyFileToClipboard(request.path),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.openBuiltInBrowser, (_event, request: OpenBuiltInBrowserRequest = {}) =>
		builtInBrowserController.open(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.getBuiltInBrowserStatus, () => builtInBrowserController.status());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserNavigate, (_event, request: BrowserNavigateRequest) =>
		builtInBrowserController.navigate(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserNewTab, (_event, request?: { url?: string }) =>
		builtInBrowserController.newTab(request?.url),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserSwitchTab, (_event, request: BrowserTabRequest) =>
		builtInBrowserController.switchTab(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserCloseTab, (_event, request: BrowserTabRequest) =>
		builtInBrowserController.closeTab(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserCloseWindow, () => builtInBrowserController.closeWindow());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserGoBack, (_event, request: BrowserTabRequest = {}) =>
		builtInBrowserController.goBack(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserGoForward, (_event, request: BrowserTabRequest = {}) =>
		builtInBrowserController.goForward(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserReload, (_event, request: BrowserTabRequest = {}) =>
		builtInBrowserController.reload(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserStop, (_event, request: BrowserTabRequest = {}) =>
		builtInBrowserController.stop(request),
	);
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.builtInBrowserSetContentBounds,
		(_event, request: BrowserSetBoundsRequest) => builtInBrowserController.setContentBounds(request),
	);
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.builtInBrowserClearStorage,
		(_event, request: BrowserClearStorageRequest) => builtInBrowserController.clearStorage(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserGetNativeStatus, () =>
		builtInBrowserController.getNativeStatus(),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserReadPage, (_event, request: BrowserReadPageRequest = {}) =>
		builtInBrowserController.readPage(request),
	);
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.builtInBrowserQueryElements,
		(_event, request: BrowserQueryElementsRequest = {}) => builtInBrowserController.queryElements(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserClick, (_event, request: BrowserElementActionRequest) =>
		builtInBrowserController.click(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserTypeText, (_event, request: BrowserElementActionRequest) =>
		builtInBrowserController.typeText(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserPressKey, (_event, request: BrowserKeyRequest) =>
		builtInBrowserController.pressKey(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserScroll, (_event, request: BrowserScrollRequest = {}) =>
		builtInBrowserController.scroll(request),
	);
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.builtInBrowserScreenshot,
		(_event, request: BrowserScreenshotRequest = {}) => builtInBrowserController.screenshot(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserGetCookies, (_event, request: BrowserCookieRequest = {}) =>
		builtInBrowserController.getCookies(request),
	);
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.builtInBrowserVirtualMouse,
		(_event, request: BrowserVirtualMouseRequest) => builtInBrowserController.virtualMouse(request),
	);
	// ── 更多应用 (external local web apps) ───────────────────────────────────────
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.listMoreApps, () => externalAppController.listApps());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.startMoreApp, (_event, request: MoreAppActionRequest) =>
		externalAppController.startApp(request.appId),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.stopMoreApp, (_event, request: MoreAppActionRequest) =>
		externalAppController.stopApp(request.appId),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.openMoreApp, (_event, request: MoreAppActionRequest) =>
		externalAppController.openApp(request.appId),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.openMoreAppAtPath, (_event, request: OpenMoreAppAtPathRequest) =>
		externalAppController.openAppAtPath(request.appId, request.path),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.getMoreAppTerminal, (_event, request: MoreAppActionRequest) =>
		externalAppController.getTerminal(request.appId),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.updateMoreAppConfig, (_event, request: UpdateMoreAppConfigRequest) =>
		externalAppController.updateConfig(request.appId, request.config),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.getSandboxStatus, () => service.getSandboxStatus());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.initSandbox, () => service.initSandbox());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.resetSandbox, () => service.resetSandbox());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.cleanSandbox, (_event, request: SandboxCleanRequest) =>
		service.cleanSandbox(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.openSandboxFolder, async () => {
		await shell.openPath(service.getSandboxRoot());
	});
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.openAppLaunchCacheWindow, () => openAppLaunchCacheWindow());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.openMcpManagerWindow, () => openMcpManagerWindow());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.openToolsetManagerWindow, () => openToolsetManagerWindow());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.openPluginManagerWindow, () => openPluginManagerWindow());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.openPersonalSkillManagerWindow, () => openPersonalSkillManagerWindow());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.listSoftwarePlugins, () => service.listSoftwarePlugins());
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.validateSoftwarePluginTarget,
		(_event, request: ValidateSoftwarePluginTargetRequest) => service.validateSoftwarePluginTarget(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.installSoftwarePlugin, (_event, request: InstallSoftwarePluginRequest) =>
		service.installSoftwarePlugin(request),
	);
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.uninstallSoftwarePlugin,
		(_event, request: UninstallSoftwarePluginRequest) => service.uninstallSoftwarePlugin(request),
	);
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.testSoftwarePluginBridge,
		(_event, request: TestSoftwarePluginBridgeRequest) => service.testSoftwarePluginBridge(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.softwarePluginProgress, () => service.getSoftwarePluginProgress());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.listForgeExtensions, () => service.listForgeExtensions());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.setForgeExtensionTrust, (_event, request: SetForgeExtensionTrustRequest) =>
		service.setForgeExtensionTrust(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.deleteForgeExtension, (_event, request: DeleteForgeExtensionRequest) =>
		service.deleteForgeExtension(request),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.openLogWindow, () => openLogWindow());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.openSandboxSettingsWindow, () => openSandboxSettingsWindow());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.getLogEntries, () => logStore.getAll());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.updatePetDebug, (_event, request: PetDebugUpdateRequest) => {
		latestPetDebug = request.snapshot;
		for (const petEvent of request.events ?? []) {
			logStore.push({
				id: petEvent.id,
				ts: petEvent.ts,
				cat: "pet",
				title: petEvent.title,
				detail: petEvent.detail,
			});
			sendPetDebugEvent(petEvent);
		}
	});
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.getPetDebug, () => latestPetDebug);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.startVoice, (_event, request?: StartVoiceRequest) => {
		const voice = service.snapshot().settings.voice;
		return voiceBridge.start(voice.wakeWord, voice.language, request?.mode ?? "wake-listening");
	});
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.stopVoice, () => voiceBridge.stop());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.updateVoiceOverlay, (_event, request: VoiceOverlayUpdateRequest) =>
		voiceBridge.update(request.update),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.updateVoiceApiKey, async (_event, request: VoiceApiKeyUpdateRequest) =>
		service.updateVoiceApiKey(request.apiKey),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.listWakeWordModels, async () => ({
		models: await wakeWordModelStore.list(),
	}));
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.importWakeWordModel,
		async (_event, request: WakeWordModelImportRequest) => {
			const result = await dialog.showOpenDialog(mainWindow, {
				title: "导入 openWakeWord 模型",
				properties: ["openFile"],
				filters: [{ name: "openWakeWord ONNX model", extensions: ["onnx"] }],
			});
			if (result.canceled || !result.filePaths[0]) {
				return { models: await wakeWordModelStore.list() };
			}
			const model = await wakeWordModelStore.importModel(result.filePaths[0], request);
			return { model, models: await wakeWordModelStore.list() };
		},
	);
	ipcMain.handle(
		DESKTOP_ASSISTANT_CHANNELS.deleteWakeWordModel,
		async (_event, request: WakeWordModelDeleteRequest) => {
			const models = await wakeWordModelStore.deleteModel(request.id);
			const voice = service.snapshot().settings.voice;
			if (voice.activeOwwModelId === request.id) {
				const nextModel = models[0];
				await service.updateSettings({
					voice: {
						...voice,
						wakeEngine: nextModel ? "openwakeword" : "vosk",
						activeOwwModelId: nextModel?.id,
						wakeWord: nextModel?.wakeWord ?? voice.wakeWord,
					},
				});
			}
			return { models };
		},
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.readWakeWordModel, async (_event, request: WakeWordModelReadRequest) =>
		wakeWordModelStore.readModel(request.id),
	);
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.startWakeKws, (event, request: StartWakeKwsRequest) => {
		const sender = event.sender;
		return kwsService.start({
			wakeWord: request.wakeWord,
			sensitivity: request.sensitivity,
			keywordsOverride: request.keywordsOverride,
			onWake: (keyword) => {
				if (!sender.isDestroyed()) {
					sender.send(DESKTOP_ASSISTANT_CHANNELS.wakeKwsEvent, { keyword });
				}
			},
		});
	});
	ipcMain.on(DESKTOP_ASSISTANT_CHANNELS.wakeKwsAudio, (_event, frame: WakeKwsAudioFrame) => {
		kwsService.acceptFrame(frame.samples, frame.sampleRate);
	});
	ipcMain.on(DESKTOP_ASSISTANT_CHANNELS.stopWakeKws, () => kwsService.stop());
	mainWindow.on("closed", () => kwsService.dispose());
	ipcMain.handle(DESKTOP_ASSISTANT_CHANNELS.transcribeAudio, async (_event, request: TranscribeAudioRequest) => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 60000);
		try {
			const text = await transcribeAudio({
				audioWav: request.audioWav,
				settings: service.snapshot().settings.voice,
				authStorage: service.getAuthStorage(),
				signal: controller.signal,
			});
			return { text };
		} finally {
			clearTimeout(timeout);
		}
	});

	ipcMain.on("desktop-assistant:window-minimize", (event) => {
		const window = BrowserWindow.fromWebContents(event.sender);
		if (window && !window.isDestroyed()) window.minimize();
	});
	ipcMain.on("desktop-assistant:window-close", (event) => {
		const window = BrowserWindow.fromWebContents(event.sender);
		if (window && !window.isDestroyed()) window.close();
	});
	ipcMain.on(DESKTOP_ASSISTANT_CHANNELS.windowSetMode, (event, payload: { mode: WindowMode; animate?: boolean }) => {
		const window = BrowserWindow.fromWebContents(event.sender);
		if (window && !window.isDestroyed()) applyWindowMode(window, payload.mode, { animate: payload.animate });
	});
	ipcMain.on(DESKTOP_ASSISTANT_CHANNELS.windowSetAlwaysOnTop, (event, payload: { enabled: boolean }) => {
		const window = BrowserWindow.fromWebContents(event.sender);
		if (window && !window.isDestroyed()) window.setAlwaysOnTop(payload.enabled, "floating");
	});
}
