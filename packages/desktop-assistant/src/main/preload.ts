import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
	type AbortRequest,
	type ApiKeyUpdateRequest,
	type AppLaunchCacheView,
	type ClearConversationHistoryResponse,
	type CloseSessionRequest,
	type ConfirmationUpdateRequest,
	type ConversationHistoryListResponse,
	type ConversationThinkingUpdateRequest,
	DESKTOP_ASSISTANT_CHANNELS,
	type DeleteAppLaunchCacheEntryRequest,
	type DeleteConversationRequest,
	type DeleteConversationResponse,
	type DeleteForgeExtensionRequest,
	type DesktopAssistantEvent,
	type DesktopAssistantSnapshot,
	type FocusSessionRequest,
	type ForgeExtensionMutationResponse,
	type GlobalMemoryClearResponse,
	type GlobalMemoryDeleteRequest,
	type GlobalMemoryEntry,
	type GlobalMemoryListResponse,
	type GlobalMemoryUpdateRequest,
	type InstallSoftwarePluginRequest,
	type InstallSoftwarePluginResponse,
	type ListForgeExtensionsResponse,
	type ListSessionsResponse,
	type LoadConversationPageRequest,
	type LoadConversationPageResponse,
	type LogEntry,
	type McpEnabledUpdateRequest,
	type McpServerActionRequest,
	type McpServerDeleteRequest,
	type McpServerListResponse,
	type McpServerStatus,
	type McpServerUpsertRequest,
	type MemoCompleteRequest,
	type MemoCreateRequest,
	type MemoDeleteRequest,
	type MemoItem,
	type MemoListRequest,
	type MemoListResponse,
	type MemoSetReminderRequest,
	type MemoSnoozeRequest,
	type MemoUpdateRequest,
	type PersonalSkillArchiveRequest,
	type PersonalSkillFileView,
	type PersonalSkillListResponse,
	type PersonalSkillReadRequest,
	type PersonalSkillSaveRequest,
	type PersonalSkillSearchRequest,
	type PetDebugSnapshot,
	type PetDebugStateEvent,
	type PetDebugUpdateRequest,
	type PromptRequest,
	type ResumeConversationRequest,
	type SandboxCleanRequest,
	type SandboxCleanResponse,
	type SandboxStatus,
	type SetForgeExtensionTrustRequest,
	type SettingsUpdateRequest,
	type SkillFileRequest,
	type SkillFileUpdateRequest,
	type SkillFileView,
	type SoftwarePluginListResponse,
	type SoftwarePluginOperationProgress,
	type SoftwarePluginTargetValidation,
	type StartVoiceRequest,
	type StartWakeKwsRequest,
	type StartWakeKwsResponse,
	type TestSoftwarePluginBridgeRequest,
	type TestSoftwarePluginBridgeResponse,
	type TranscribeAudioRequest,
	type TranscribeAudioResponse,
	type UninstallSoftwarePluginRequest,
	type UninstallSoftwarePluginResponse,
	type ValidateSoftwarePluginTargetRequest,
	type VoiceApiKeyUpdateRequest,
	type VoiceOverlayState,
	type VoiceOverlayUpdateRequest,
	type WakeKwsAudioFrame,
	type WakeKwsWakeEvent,
	type WakeWordModelDeleteRequest,
	type WakeWordModelImportRequest,
	type WakeWordModelImportResponse,
	type WakeWordModelListResponse,
	type WakeWordModelReadRequest,
	type WakeWordModelReadResponse,
	type WindowMode,
} from "../shared/types.ts";

export interface DesktopAssistantApi {
	getSnapshot(): Promise<DesktopAssistantSnapshot>;
	newConversation(): Promise<DesktopAssistantSnapshot>;
	listSessions(): Promise<ListSessionsResponse>;
	focusSession(request: FocusSessionRequest): Promise<DesktopAssistantSnapshot>;
	closeSession(request: CloseSessionRequest): Promise<DesktopAssistantSnapshot>;
	prompt(request: PromptRequest): Promise<DesktopAssistantSnapshot>;
	abort(request?: AbortRequest): Promise<DesktopAssistantSnapshot>;
	updateConversationThinking(request: ConversationThinkingUpdateRequest): Promise<DesktopAssistantSnapshot>;
	updateApiKey(request: ApiKeyUpdateRequest): Promise<DesktopAssistantSnapshot>;
	updateSettings(request: SettingsUpdateRequest): Promise<DesktopAssistantSnapshot>;
	listMcpServers(): Promise<McpServerListResponse>;
	upsertMcpServer(request: McpServerUpsertRequest): Promise<McpServerListResponse>;
	deleteMcpServer(request: McpServerDeleteRequest): Promise<McpServerListResponse>;
	testMcpServer(request: McpServerActionRequest): Promise<McpServerStatus>;
	refreshMcpServer(request: McpServerActionRequest): Promise<McpServerListResponse>;
	setMcpEnabled(request: McpEnabledUpdateRequest): Promise<McpServerListResponse>;
	listSoftwarePlugins(): Promise<SoftwarePluginListResponse>;
	validateSoftwarePluginTarget(request: ValidateSoftwarePluginTargetRequest): Promise<SoftwarePluginTargetValidation>;
	installSoftwarePlugin(request: InstallSoftwarePluginRequest): Promise<InstallSoftwarePluginResponse>;
	uninstallSoftwarePlugin(request: UninstallSoftwarePluginRequest): Promise<UninstallSoftwarePluginResponse>;
	testSoftwarePluginBridge(request: TestSoftwarePluginBridgeRequest): Promise<TestSoftwarePluginBridgeResponse>;
	getSoftwarePluginProgress(): Promise<SoftwarePluginOperationProgress | undefined>;
	listForgeExtensions(): Promise<ListForgeExtensionsResponse>;
	setForgeExtensionTrust(request: SetForgeExtensionTrustRequest): Promise<ForgeExtensionMutationResponse>;
	deleteForgeExtension(request: DeleteForgeExtensionRequest): Promise<ForgeExtensionMutationResponse>;
	approveConfirmation(request: ConfirmationUpdateRequest): Promise<DesktopAssistantSnapshot>;
	rejectConfirmation(request: ConfirmationUpdateRequest): Promise<DesktopAssistantSnapshot>;
	getSkillFile(request: SkillFileRequest): Promise<SkillFileView>;
	updateSkillFile(request: SkillFileUpdateRequest): Promise<SkillFileView>;
	listPersonalSkills(): Promise<PersonalSkillListResponse>;
	searchPersonalSkills(request: PersonalSkillSearchRequest): Promise<PersonalSkillListResponse>;
	readPersonalSkill(request: PersonalSkillReadRequest): Promise<PersonalSkillFileView>;
	savePersonalSkill(request: PersonalSkillSaveRequest): Promise<PersonalSkillFileView>;
	archivePersonalSkill(request: PersonalSkillArchiveRequest): Promise<PersonalSkillListResponse>;
	refreshPersonalSkills(): Promise<PersonalSkillListResponse>;
	listConversationHistory(): Promise<ConversationHistoryListResponse>;
	resumeConversation(request: ResumeConversationRequest): Promise<DesktopAssistantSnapshot>;
	loadConversationPage(request: LoadConversationPageRequest): Promise<LoadConversationPageResponse>;
	deleteConversation(request: DeleteConversationRequest): Promise<DeleteConversationResponse>;
	clearConversationHistory(): Promise<ClearConversationHistoryResponse>;
	listGlobalMemories(): Promise<GlobalMemoryListResponse>;
	deleteGlobalMemory(request: GlobalMemoryDeleteRequest): Promise<GlobalMemoryListResponse>;
	clearGlobalMemories(): Promise<GlobalMemoryClearResponse>;
	updateGlobalMemory(request: GlobalMemoryUpdateRequest): Promise<GlobalMemoryEntry | undefined>;
	listMemos(request?: MemoListRequest): Promise<MemoListResponse>;
	createMemo(request: MemoCreateRequest): Promise<MemoItem>;
	updateMemo(request: MemoUpdateRequest): Promise<MemoItem>;
	completeMemo(request: MemoCompleteRequest): Promise<MemoItem>;
	snoozeMemo(request: MemoSnoozeRequest): Promise<MemoItem>;
	setMemoReminder(request: MemoSetReminderRequest): Promise<MemoItem>;
	deleteMemo(request: MemoDeleteRequest): Promise<boolean>;
	getAppLaunchCache(): Promise<AppLaunchCacheView>;
	clearAppLaunchCache(): Promise<AppLaunchCacheView>;
	deleteAppLaunchCacheEntry(request: DeleteAppLaunchCacheEntryRequest): Promise<AppLaunchCacheView>;
	openAppLaunchCacheWindow(): Promise<void>;
	getSandboxStatus(): Promise<SandboxStatus>;
	initSandbox(): Promise<SandboxStatus>;
	resetSandbox(): Promise<SandboxStatus>;
	cleanSandbox(request: SandboxCleanRequest): Promise<SandboxCleanResponse>;
	openSandboxFolder(): Promise<void>;
	openSandboxSettingsWindow(): Promise<void>;
	openMcpManagerWindow(): Promise<void>;
	openToolsetManagerWindow(): Promise<void>;
	openPluginManagerWindow(): Promise<void>;
	openPersonalSkillManagerWindow(): Promise<void>;
	openLogWindow(): Promise<void>;
	getLogEntries(): Promise<LogEntry[]>;
	updatePetDebug(request: PetDebugUpdateRequest): Promise<void>;
	getPetDebug(): Promise<PetDebugSnapshot | undefined>;
	startVoice(request?: StartVoiceRequest): Promise<VoiceOverlayState>;
	stopVoice(): Promise<VoiceOverlayState>;
	updateVoiceOverlay(request: VoiceOverlayUpdateRequest): Promise<VoiceOverlayState>;
	transcribeAudio(request: TranscribeAudioRequest): Promise<TranscribeAudioResponse>;
	updateVoiceApiKey(request: VoiceApiKeyUpdateRequest): Promise<DesktopAssistantSnapshot>;
	listWakeWordModels(): Promise<WakeWordModelListResponse>;
	importWakeWordModel(request: WakeWordModelImportRequest): Promise<WakeWordModelImportResponse>;
	deleteWakeWordModel(request: WakeWordModelDeleteRequest): Promise<WakeWordModelListResponse>;
	readWakeWordModel(request: WakeWordModelReadRequest): Promise<WakeWordModelReadResponse>;
	startWakeKws(request: StartWakeKwsRequest): Promise<StartWakeKwsResponse>;
	sendWakeKwsAudio(frame: WakeKwsAudioFrame): void;
	stopWakeKws(): void;
	onWakeKwsWake(listener: (event: WakeKwsWakeEvent) => void): () => void;
	onEvent(listener: (event: DesktopAssistantEvent) => void): () => void;
	onLogEvent(listener: (entry: LogEntry) => void): () => void;
	onPetDebugEvent(listener: (entry: PetDebugStateEvent) => void): () => void;
	getPathForFile(file: File): string;
	minimizeWindow(): void;
	closeWindow(): void;
	setWindowMode(mode: WindowMode, animate?: boolean): void;
	setWindowAlwaysOnTop(enabled: boolean): void;
}

const api: DesktopAssistantApi = {
	getSnapshot: () => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.getSnapshot) as Promise<DesktopAssistantSnapshot>,
	newConversation: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.newConversation) as Promise<DesktopAssistantSnapshot>,
	listSessions: () => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.listSessions) as Promise<ListSessionsResponse>,
	focusSession: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.focusSession, request) as Promise<DesktopAssistantSnapshot>,
	closeSession: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.closeSession, request) as Promise<DesktopAssistantSnapshot>,
	prompt: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.prompt, request) as Promise<DesktopAssistantSnapshot>,
	abort: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.abort, request) as Promise<DesktopAssistantSnapshot>,
	updateConversationThinking: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.updateConversationThinking,
			request,
		) as Promise<DesktopAssistantSnapshot>,
	updateApiKey: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.updateApiKey, request) as Promise<DesktopAssistantSnapshot>,
	updateSettings: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.updateSettings, request) as Promise<DesktopAssistantSnapshot>,
	listMcpServers: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.listMcpServers) as Promise<McpServerListResponse>,
	upsertMcpServer: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.upsertMcpServer, request) as Promise<McpServerListResponse>,
	deleteMcpServer: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.deleteMcpServer, request) as Promise<McpServerListResponse>,
	testMcpServer: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.testMcpServer, request) as Promise<McpServerStatus>,
	refreshMcpServer: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.refreshMcpServer, request) as Promise<McpServerListResponse>,
	setMcpEnabled: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.setMcpEnabled, request) as Promise<McpServerListResponse>,
	listSoftwarePlugins: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.listSoftwarePlugins) as Promise<SoftwarePluginListResponse>,
	validateSoftwarePluginTarget: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.validateSoftwarePluginTarget,
			request,
		) as Promise<SoftwarePluginTargetValidation>,
	installSoftwarePlugin: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.installSoftwarePlugin,
			request,
		) as Promise<InstallSoftwarePluginResponse>,
	uninstallSoftwarePlugin: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.uninstallSoftwarePlugin,
			request,
		) as Promise<UninstallSoftwarePluginResponse>,
	testSoftwarePluginBridge: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.testSoftwarePluginBridge,
			request,
		) as Promise<TestSoftwarePluginBridgeResponse>,
	getSoftwarePluginProgress: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.softwarePluginProgress) as Promise<
			SoftwarePluginOperationProgress | undefined
		>,
	listForgeExtensions: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.listForgeExtensions) as Promise<ListForgeExtensionsResponse>,
	setForgeExtensionTrust: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.setForgeExtensionTrust,
			request,
		) as Promise<ForgeExtensionMutationResponse>,
	deleteForgeExtension: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.deleteForgeExtension,
			request,
		) as Promise<ForgeExtensionMutationResponse>,
	approveConfirmation: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.approveConfirmation, request) as Promise<DesktopAssistantSnapshot>,
	rejectConfirmation: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.rejectConfirmation, request) as Promise<DesktopAssistantSnapshot>,
	getSkillFile: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.getSkillFile, request) as Promise<SkillFileView>,
	updateSkillFile: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.updateSkillFile, request) as Promise<SkillFileView>,
	listPersonalSkills: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.listPersonalSkills) as Promise<PersonalSkillListResponse>,
	searchPersonalSkills: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.searchPersonalSkills,
			request,
		) as Promise<PersonalSkillListResponse>,
	readPersonalSkill: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.readPersonalSkill, request) as Promise<PersonalSkillFileView>,
	savePersonalSkill: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.savePersonalSkill, request) as Promise<PersonalSkillFileView>,
	archivePersonalSkill: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.archivePersonalSkill,
			request,
		) as Promise<PersonalSkillListResponse>,
	refreshPersonalSkills: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.refreshPersonalSkills) as Promise<PersonalSkillListResponse>,
	listConversationHistory: () =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.listConversationHistory,
		) as Promise<ConversationHistoryListResponse>,
	resumeConversation: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.resumeConversation, request) as Promise<DesktopAssistantSnapshot>,
	loadConversationPage: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.loadConversationPage,
			request,
		) as Promise<LoadConversationPageResponse>,
	deleteConversation: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.deleteConversation, request) as Promise<DeleteConversationResponse>,
	clearConversationHistory: () =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.clearConversationHistory,
		) as Promise<ClearConversationHistoryResponse>,
	listGlobalMemories: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.listGlobalMemories) as Promise<GlobalMemoryListResponse>,
	deleteGlobalMemory: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.deleteGlobalMemory, request) as Promise<GlobalMemoryListResponse>,
	clearGlobalMemories: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.clearGlobalMemories) as Promise<GlobalMemoryClearResponse>,
	updateGlobalMemory: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.updateGlobalMemory, request) as Promise<
			GlobalMemoryEntry | undefined
		>,
	listMemos: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoList, request ?? {}) as Promise<MemoListResponse>,
	createMemo: (request) => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoCreate, request) as Promise<MemoItem>,
	updateMemo: (request) => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoUpdate, request) as Promise<MemoItem>,
	completeMemo: (request) => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoComplete, request) as Promise<MemoItem>,
	snoozeMemo: (request) => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoSnooze, request) as Promise<MemoItem>,
	setMemoReminder: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoSetReminder, request) as Promise<MemoItem>,
	deleteMemo: (request) => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoDelete, request) as Promise<boolean>,
	getAppLaunchCache: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.getAppLaunchCache) as Promise<AppLaunchCacheView>,
	clearAppLaunchCache: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.clearAppLaunchCache) as Promise<AppLaunchCacheView>,
	deleteAppLaunchCacheEntry: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.deleteAppLaunchCacheEntry, request) as Promise<AppLaunchCacheView>,
	openAppLaunchCacheWindow: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.openAppLaunchCacheWindow) as Promise<void>,
	getSandboxStatus: () => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.getSandboxStatus) as Promise<SandboxStatus>,
	initSandbox: () => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.initSandbox) as Promise<SandboxStatus>,
	resetSandbox: () => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.resetSandbox) as Promise<SandboxStatus>,
	cleanSandbox: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.cleanSandbox, request) as Promise<SandboxCleanResponse>,
	openSandboxFolder: () => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.openSandboxFolder) as Promise<void>,
	openSandboxSettingsWindow: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.openSandboxSettingsWindow) as Promise<void>,
	openMcpManagerWindow: () => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.openMcpManagerWindow) as Promise<void>,
	openToolsetManagerWindow: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.openToolsetManagerWindow) as Promise<void>,
	openPluginManagerWindow: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.openPluginManagerWindow) as Promise<void>,
	openPersonalSkillManagerWindow: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.openPersonalSkillManagerWindow) as Promise<void>,
	openLogWindow: () => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.openLogWindow) as Promise<void>,
	getLogEntries: () => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.getLogEntries) as Promise<LogEntry[]>,
	updatePetDebug: (request) => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.updatePetDebug, request) as Promise<void>,
	getPetDebug: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.getPetDebug) as Promise<PetDebugSnapshot | undefined>,
	startVoice: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.startVoice, request) as Promise<VoiceOverlayState>,
	stopVoice: () => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.stopVoice) as Promise<VoiceOverlayState>,
	updateVoiceOverlay: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.updateVoiceOverlay, request) as Promise<VoiceOverlayState>,
	transcribeAudio: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.transcribeAudio, request) as Promise<TranscribeAudioResponse>,
	updateVoiceApiKey: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.updateVoiceApiKey, request) as Promise<DesktopAssistantSnapshot>,
	listWakeWordModels: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.listWakeWordModels) as Promise<WakeWordModelListResponse>,
	importWakeWordModel: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.importWakeWordModel,
			request,
		) as Promise<WakeWordModelImportResponse>,
	deleteWakeWordModel: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.deleteWakeWordModel, request) as Promise<WakeWordModelListResponse>,
	readWakeWordModel: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.readWakeWordModel, request) as Promise<WakeWordModelReadResponse>,
	startWakeKws: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.startWakeKws, request) as Promise<StartWakeKwsResponse>,
	sendWakeKwsAudio: (frame) => ipcRenderer.send(DESKTOP_ASSISTANT_CHANNELS.wakeKwsAudio, frame),
	stopWakeKws: () => ipcRenderer.send(DESKTOP_ASSISTANT_CHANNELS.stopWakeKws),
	onWakeKwsWake: (listener) => {
		const wrapped = (_event: Electron.IpcRendererEvent, payload: WakeKwsWakeEvent) => listener(payload);
		ipcRenderer.on(DESKTOP_ASSISTANT_CHANNELS.wakeKwsEvent, wrapped);
		return () => ipcRenderer.off(DESKTOP_ASSISTANT_CHANNELS.wakeKwsEvent, wrapped);
	},
	onEvent: (listener) => {
		const wrapped = (_event: Electron.IpcRendererEvent, payload: DesktopAssistantEvent) => listener(payload);
		ipcRenderer.on(DESKTOP_ASSISTANT_CHANNELS.events, wrapped);
		return () => ipcRenderer.off(DESKTOP_ASSISTANT_CHANNELS.events, wrapped);
	},
	onLogEvent: (listener) => {
		const wrapped = (_event: Electron.IpcRendererEvent, payload: LogEntry) => listener(payload);
		ipcRenderer.on(DESKTOP_ASSISTANT_CHANNELS.logEvent, wrapped);
		return () => ipcRenderer.off(DESKTOP_ASSISTANT_CHANNELS.logEvent, wrapped);
	},
	onPetDebugEvent: (listener) => {
		const wrapped = (_event: Electron.IpcRendererEvent, payload: PetDebugStateEvent) => listener(payload);
		ipcRenderer.on(DESKTOP_ASSISTANT_CHANNELS.petDebugEvent, wrapped);
		return () => ipcRenderer.off(DESKTOP_ASSISTANT_CHANNELS.petDebugEvent, wrapped);
	},
	getPathForFile: (file) => webUtils.getPathForFile(file),
	minimizeWindow: () => ipcRenderer.send("desktop-assistant:window-minimize"),
	closeWindow: () => ipcRenderer.send("desktop-assistant:window-close"),
	setWindowMode: (mode, animate = true) =>
		ipcRenderer.send(DESKTOP_ASSISTANT_CHANNELS.windowSetMode, { mode, animate }),
	setWindowAlwaysOnTop: (enabled) => ipcRenderer.send(DESKTOP_ASSISTANT_CHANNELS.windowSetAlwaysOnTop, { enabled }),
};

contextBridge.exposeInMainWorld("desktopAssistant", api);
