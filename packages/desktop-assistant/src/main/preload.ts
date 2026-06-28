import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
	type AbortRequest,
	type ApiKeyUpdateRequest,
	type AppLaunchCacheView,
	type AutomationCancelRunRequest,
	type AutomationCreateRequest,
	type AutomationDeleteRequest,
	type AutomationDesignChatRequest,
	type AutomationDesignChatResponse,
	type AutomationDesignStateResponse,
	type AutomationDraft,
	type AutomationDraftApplyRequest,
	type AutomationDraftGetRequest,
	type AutomationDraftSaveRequest,
	type AutomationDraftSaveResponse,
	type AutomationFlow,
	type AutomationGetRequest,
	type AutomationListResponse,
	type AutomationOpenEditorRequest,
	type AutomationRunRecord,
	type AutomationRunRequest,
	type AutomationRunResponse,
	type AutomationSetEnabledRequest,
	type AutomationUpdateRequest,
	type BrowserClearStorageRequest,
	type BrowserClearStorageResponse,
	type BrowserCookieRequest,
	type BrowserCookieView,
	type BrowserElementActionRequest,
	type BrowserElementSnapshot,
	type BrowserKeyRequest,
	type BrowserNativeStatus,
	type BrowserNavigateRequest,
	type BrowserPageSnapshot,
	type BrowserQueryElementsRequest,
	type BrowserReadPageRequest,
	type BrowserScreenshotRequest,
	type BrowserScreenshotResponse,
	type BrowserScrollRequest,
	type BrowserSetBoundsRequest,
	type BrowserTabRequest,
	type BrowserVirtualMouseRequest,
	type BuiltInBrowserEvent,
	type BuiltInBrowserStatus,
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
	type ExternalAppConfig,
	type FileActionResponse,
	type FilePathRequest,
	type FocusSessionRequest,
	type ForgeExtensionMutationResponse,
	type GlobalMemoryClearResponse,
	type GlobalMemoryDeleteRequest,
	type GlobalMemoryEntry,
	type GlobalMemoryListResponse,
	type GlobalMemoryUpdateRequest,
	type HomeWeatherView,
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
	type MemoAttachment,
	type MemoAttachmentAddRequest,
	type MemoAttachmentRemoveRequest,
	type MemoBatchRequest,
	type MemoBatchResult,
	type MemoCompleteRequest,
	type MemoCreateRequest,
	type MemoDeleteRequest,
	type MemoItem,
	type MemoList,
	type MemoListCreateRequest,
	type MemoListDeleteRequest,
	type MemoListReorderRequest,
	type MemoListRequest,
	type MemoListResponse,
	type MemoListUpdateRequest,
	type MemoReorderRequest,
	type MemoRunAutoRequest,
	type MemoSetReminderRequest,
	type MemoSnoozeRequest,
	type MemoStatsResult,
	type MemoUpdateRequest,
	type MoreAppEvent,
	type MoreAppTerminalResponse,
	type MoreAppView,
	type OpenBuiltInBrowserRequest,
	type OpenUrlInDefaultBrowserRequest,
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
	type QueuedPreInputRequest,
	type RefreshHomeWelcomeRequest,
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
	type WithdrawQueuedPreInputResponse,
} from "../shared/types.ts";

export interface DesktopAssistantApi {
	getSnapshot(): Promise<DesktopAssistantSnapshot>;
	newConversation(): Promise<DesktopAssistantSnapshot>;
	listSessions(): Promise<ListSessionsResponse>;
	focusSession(request: FocusSessionRequest): Promise<DesktopAssistantSnapshot>;
	closeSession(request: CloseSessionRequest): Promise<DesktopAssistantSnapshot>;
	prompt(request: PromptRequest): Promise<DesktopAssistantSnapshot>;
	deleteQueuedPreInput(request: QueuedPreInputRequest): Promise<DesktopAssistantSnapshot>;
	withdrawQueuedPreInput(request: QueuedPreInputRequest): Promise<WithdrawQueuedPreInputResponse>;
	abort(request?: AbortRequest): Promise<DesktopAssistantSnapshot>;
	updateConversationThinking(request: ConversationThinkingUpdateRequest): Promise<DesktopAssistantSnapshot>;
	updateApiKey(request: ApiKeyUpdateRequest): Promise<DesktopAssistantSnapshot>;
	discoverModels(): Promise<DesktopAssistantSnapshot>;
	updateSettings(request: SettingsUpdateRequest): Promise<DesktopAssistantSnapshot>;
	refreshHomeWelcome(request?: RefreshHomeWelcomeRequest): Promise<void>;
	getHomeWeather(): Promise<HomeWeatherView | undefined>;
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
	automationList(): Promise<AutomationListResponse>;
	automationGet(request: AutomationGetRequest): Promise<AutomationFlow | undefined>;
	automationCreate(request: AutomationCreateRequest): Promise<AutomationFlow>;
	automationUpdate(request: AutomationUpdateRequest): Promise<AutomationFlow>;
	automationDelete(request: AutomationDeleteRequest): Promise<AutomationListResponse>;
	automationSetEnabled(request: AutomationSetEnabledRequest): Promise<AutomationFlow>;
	automationRun(request: AutomationRunRequest): Promise<AutomationRunResponse>;
	automationCancelRun(request: AutomationCancelRunRequest): Promise<AutomationRunRecord | undefined>;
	automationOpenEditor(request?: AutomationOpenEditorRequest): Promise<void>;
	automationDraftGet(request?: AutomationDraftGetRequest): Promise<AutomationDraft>;
	automationDraftApply(request: AutomationDraftApplyRequest): Promise<AutomationDraft>;
	automationDraftSave(request?: AutomationDraftSaveRequest): Promise<AutomationDraftSaveResponse>;
	automationDesignChat(request: AutomationDesignChatRequest): Promise<AutomationDesignChatResponse>;
	automationDesignState(): Promise<AutomationDesignStateResponse>;
	listMemos(request?: MemoListRequest): Promise<MemoListResponse>;
	createMemo(request: MemoCreateRequest): Promise<MemoItem>;
	updateMemo(request: MemoUpdateRequest): Promise<MemoItem>;
	reorderMemo(request: MemoReorderRequest): Promise<MemoItem[]>;
	completeMemo(request: MemoCompleteRequest): Promise<MemoItem>;
	snoozeMemo(request: MemoSnoozeRequest): Promise<MemoItem>;
	setMemoReminder(request: MemoSetReminderRequest): Promise<MemoItem>;
	runMemoAutoTaskNow(request: MemoRunAutoRequest): Promise<MemoItem>;
	deleteMemo(request: MemoDeleteRequest): Promise<boolean>;
	getMemoStats(): Promise<MemoStatsResult>;
	batchMemos(request: MemoBatchRequest): Promise<MemoBatchResult>;
	listMemoLists(): Promise<MemoList[]>;
	createMemoList(request: MemoListCreateRequest): Promise<MemoList>;
	updateMemoList(request: MemoListUpdateRequest): Promise<MemoList>;
	reorderMemoList(request: MemoListReorderRequest): Promise<MemoList>;
	deleteMemoList(request: MemoListDeleteRequest): Promise<boolean>;
	addMemoAttachment(request: MemoAttachmentAddRequest): Promise<MemoAttachment>;
	removeMemoAttachment(request: MemoAttachmentRemoveRequest): Promise<boolean>;
	getAppLaunchCache(): Promise<AppLaunchCacheView>;
	clearAppLaunchCache(): Promise<AppLaunchCacheView>;
	deleteAppLaunchCacheEntry(request: DeleteAppLaunchCacheEntryRequest): Promise<AppLaunchCacheView>;
	openAppLaunchCacheWindow(): Promise<void>;
	openUrlInDefaultBrowser(request: OpenUrlInDefaultBrowserRequest): Promise<unknown>;
	openPath(request: FilePathRequest): Promise<FileActionResponse>;
	showItemInFolder(request: FilePathRequest): Promise<FileActionResponse>;
	copyFileToClipboard(request: FilePathRequest): Promise<FileActionResponse>;
	listMoreApps(): Promise<MoreAppView[]>;
	startMoreApp(appId: string): Promise<MoreAppView[]>;
	stopMoreApp(appId: string): Promise<MoreAppView[]>;
	openMoreApp(appId: string): Promise<MoreAppView[]>;
	openMoreAppAtPath(appId: string, path: string): Promise<MoreAppView[]>;
	getMoreAppTerminal(appId: string): Promise<MoreAppTerminalResponse>;
	updateMoreAppConfig(appId: string, config: ExternalAppConfig): Promise<MoreAppView[]>;
	onMoreAppEvent(listener: (event: MoreAppEvent) => void): () => void;
	openBuiltInBrowser(request?: OpenBuiltInBrowserRequest): Promise<BuiltInBrowserStatus>;
	getBuiltInBrowserStatus(): Promise<BuiltInBrowserStatus>;
	builtInBrowserNavigate(request: BrowserNavigateRequest): Promise<BuiltInBrowserStatus>;
	builtInBrowserNewTab(request?: { url?: string }): Promise<BuiltInBrowserStatus>;
	builtInBrowserSwitchTab(request: BrowserTabRequest): Promise<BuiltInBrowserStatus>;
	builtInBrowserCloseTab(request: BrowserTabRequest): Promise<BuiltInBrowserStatus>;
	builtInBrowserCloseWindow(): Promise<{ ok: true; closed: boolean }>;
	builtInBrowserGoBack(request?: BrowserTabRequest): Promise<BuiltInBrowserStatus>;
	builtInBrowserGoForward(request?: BrowserTabRequest): Promise<BuiltInBrowserStatus>;
	builtInBrowserReload(request?: BrowserTabRequest): Promise<BuiltInBrowserStatus>;
	builtInBrowserStop(request?: BrowserTabRequest): Promise<BuiltInBrowserStatus>;
	builtInBrowserSetContentBounds(request: BrowserSetBoundsRequest): Promise<BuiltInBrowserStatus>;
	builtInBrowserClearStorage(request: BrowserClearStorageRequest): Promise<BrowserClearStorageResponse>;
	builtInBrowserGetNativeStatus(): Promise<BrowserNativeStatus>;
	builtInBrowserReadPage(request?: BrowserReadPageRequest): Promise<BrowserPageSnapshot>;
	builtInBrowserQueryElements(request?: BrowserQueryElementsRequest): Promise<BrowserElementSnapshot[]>;
	builtInBrowserClick(request: BrowserElementActionRequest): Promise<BrowserPageSnapshot>;
	builtInBrowserTypeText(request: BrowserElementActionRequest): Promise<BrowserPageSnapshot>;
	builtInBrowserPressKey(request: BrowserKeyRequest): Promise<BuiltInBrowserStatus>;
	builtInBrowserScroll(request?: BrowserScrollRequest): Promise<BrowserPageSnapshot>;
	builtInBrowserScreenshot(request?: BrowserScreenshotRequest): Promise<BrowserScreenshotResponse>;
	builtInBrowserGetCookies(request?: BrowserCookieRequest): Promise<BrowserCookieView[]>;
	builtInBrowserVirtualMouse(request: BrowserVirtualMouseRequest): Promise<BuiltInBrowserStatus>;
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
	onBuiltInBrowserEvent(listener: (event: BuiltInBrowserEvent) => void): () => void;
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
	deleteQueuedPreInput: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.deleteQueuedPreInput, request) as Promise<DesktopAssistantSnapshot>,
	withdrawQueuedPreInput: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.withdrawQueuedPreInput,
			request,
		) as Promise<WithdrawQueuedPreInputResponse>,
	abort: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.abort, request) as Promise<DesktopAssistantSnapshot>,
	updateConversationThinking: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.updateConversationThinking,
			request,
		) as Promise<DesktopAssistantSnapshot>,
	updateApiKey: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.updateApiKey, request) as Promise<DesktopAssistantSnapshot>,
	discoverModels: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.discoverModels) as Promise<DesktopAssistantSnapshot>,
	updateSettings: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.updateSettings, request) as Promise<DesktopAssistantSnapshot>,
	refreshHomeWelcome: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.refreshHomeWelcome, request) as Promise<void>,
	getHomeWeather: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.getHomeWeather) as Promise<HomeWeatherView | undefined>,
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
	automationList: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.automationList) as Promise<AutomationListResponse>,
	automationGet: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.automationGet, request) as Promise<AutomationFlow | undefined>,
	automationCreate: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.automationCreate, request) as Promise<AutomationFlow>,
	automationUpdate: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.automationUpdate, request) as Promise<AutomationFlow>,
	automationDelete: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.automationDelete, request) as Promise<AutomationListResponse>,
	automationSetEnabled: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.automationSetEnabled, request) as Promise<AutomationFlow>,
	automationRun: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.automationRun, request) as Promise<AutomationRunResponse>,
	automationCancelRun: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.automationCancelRun, request) as Promise<
			AutomationRunRecord | undefined
		>,
	automationOpenEditor: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.automationOpenEditor, request ?? {}) as Promise<void>,
	automationDraftGet: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.automationDraftGet, request ?? {}) as Promise<AutomationDraft>,
	automationDraftApply: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.automationDraftApply, request) as Promise<AutomationDraft>,
	automationDraftSave: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.automationDraftSave,
			request ?? {},
		) as Promise<AutomationDraftSaveResponse>,
	automationDesignChat: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.automationDesignChat,
			request,
		) as Promise<AutomationDesignChatResponse>,
	automationDesignState: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.automationDesignState) as Promise<AutomationDesignStateResponse>,
	listMemos: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoList, request ?? {}) as Promise<MemoListResponse>,
	createMemo: (request) => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoCreate, request) as Promise<MemoItem>,
	updateMemo: (request) => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoUpdate, request) as Promise<MemoItem>,
	reorderMemo: (request) => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoReorder, request) as Promise<MemoItem[]>,
	completeMemo: (request) => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoComplete, request) as Promise<MemoItem>,
	snoozeMemo: (request) => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoSnooze, request) as Promise<MemoItem>,
	setMemoReminder: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoSetReminder, request) as Promise<MemoItem>,
	runMemoAutoTaskNow: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoRunAutoNow, request) as Promise<MemoItem>,
	deleteMemo: (request) => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoDelete, request) as Promise<boolean>,
	getMemoStats: () => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoStats) as Promise<MemoStatsResult>,
	batchMemos: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoBatch, request) as Promise<MemoBatchResult>,
	listMemoLists: () => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoListList) as Promise<MemoList[]>,
	createMemoList: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoListCreate, request) as Promise<MemoList>,
	updateMemoList: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoListUpdate, request) as Promise<MemoList>,
	reorderMemoList: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoListReorder, request) as Promise<MemoList>,
	deleteMemoList: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoListDelete, request) as Promise<boolean>,
	addMemoAttachment: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoAttachmentAdd, request) as Promise<MemoAttachment>,
	removeMemoAttachment: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.memoAttachmentRemove, request) as Promise<boolean>,
	getAppLaunchCache: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.getAppLaunchCache) as Promise<AppLaunchCacheView>,
	clearAppLaunchCache: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.clearAppLaunchCache) as Promise<AppLaunchCacheView>,
	deleteAppLaunchCacheEntry: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.deleteAppLaunchCacheEntry, request) as Promise<AppLaunchCacheView>,
	openAppLaunchCacheWindow: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.openAppLaunchCacheWindow) as Promise<void>,
	openUrlInDefaultBrowser: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.openUrlInDefaultBrowser, request) as Promise<unknown>,
	openPath: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.openPath, request) as Promise<FileActionResponse>,
	showItemInFolder: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.showItemInFolder, request) as Promise<FileActionResponse>,
	copyFileToClipboard: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.copyFileToClipboard, request) as Promise<FileActionResponse>,
	listMoreApps: () => ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.listMoreApps) as Promise<MoreAppView[]>,
	startMoreApp: (appId) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.startMoreApp, { appId }) as Promise<MoreAppView[]>,
	stopMoreApp: (appId) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.stopMoreApp, { appId }) as Promise<MoreAppView[]>,
	openMoreApp: (appId) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.openMoreApp, { appId }) as Promise<MoreAppView[]>,
	openMoreAppAtPath: (appId, path) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.openMoreAppAtPath, { appId, path }) as Promise<MoreAppView[]>,
	getMoreAppTerminal: (appId) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.getMoreAppTerminal, { appId }) as Promise<MoreAppTerminalResponse>,
	updateMoreAppConfig: (appId, config) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.updateMoreAppConfig, { appId, config }) as Promise<MoreAppView[]>,
	onMoreAppEvent: (listener) => {
		const wrapped = (_event: Electron.IpcRendererEvent, payload: MoreAppEvent) => listener(payload);
		ipcRenderer.on(DESKTOP_ASSISTANT_CHANNELS.moreAppEvent, wrapped);
		return () => ipcRenderer.off(DESKTOP_ASSISTANT_CHANNELS.moreAppEvent, wrapped);
	},
	openBuiltInBrowser: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.openBuiltInBrowser, request ?? {}) as Promise<BuiltInBrowserStatus>,
	getBuiltInBrowserStatus: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.getBuiltInBrowserStatus) as Promise<BuiltInBrowserStatus>,
	builtInBrowserNavigate: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserNavigate, request) as Promise<BuiltInBrowserStatus>,
	builtInBrowserNewTab: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.builtInBrowserNewTab,
			request ?? {},
		) as Promise<BuiltInBrowserStatus>,
	builtInBrowserSwitchTab: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserSwitchTab, request) as Promise<BuiltInBrowserStatus>,
	builtInBrowserCloseTab: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserCloseTab, request) as Promise<BuiltInBrowserStatus>,
	builtInBrowserCloseWindow: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserCloseWindow) as Promise<{
			ok: true;
			closed: boolean;
		}>,
	builtInBrowserGoBack: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.builtInBrowserGoBack,
			request ?? {},
		) as Promise<BuiltInBrowserStatus>,
	builtInBrowserGoForward: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.builtInBrowserGoForward,
			request ?? {},
		) as Promise<BuiltInBrowserStatus>,
	builtInBrowserReload: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.builtInBrowserReload,
			request ?? {},
		) as Promise<BuiltInBrowserStatus>,
	builtInBrowserStop: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserStop, request ?? {}) as Promise<BuiltInBrowserStatus>,
	builtInBrowserSetContentBounds: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.builtInBrowserSetContentBounds,
			request,
		) as Promise<BuiltInBrowserStatus>,
	builtInBrowserClearStorage: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.builtInBrowserClearStorage,
			request,
		) as Promise<BrowserClearStorageResponse>,
	builtInBrowserGetNativeStatus: () =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserGetNativeStatus) as Promise<BrowserNativeStatus>,
	builtInBrowserReadPage: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.builtInBrowserReadPage,
			request ?? {},
		) as Promise<BrowserPageSnapshot>,
	builtInBrowserQueryElements: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserQueryElements, request ?? {}) as Promise<
			BrowserElementSnapshot[]
		>,
	builtInBrowserClick: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserClick, request) as Promise<BrowserPageSnapshot>,
	builtInBrowserTypeText: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserTypeText, request) as Promise<BrowserPageSnapshot>,
	builtInBrowserPressKey: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserPressKey, request) as Promise<BuiltInBrowserStatus>,
	builtInBrowserScroll: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.builtInBrowserScroll,
			request ?? {},
		) as Promise<BrowserPageSnapshot>,
	builtInBrowserScreenshot: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.builtInBrowserScreenshot,
			request ?? {},
		) as Promise<BrowserScreenshotResponse>,
	builtInBrowserGetCookies: (request) =>
		ipcRenderer.invoke(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserGetCookies, request ?? {}) as Promise<
			BrowserCookieView[]
		>,
	builtInBrowserVirtualMouse: (request) =>
		ipcRenderer.invoke(
			DESKTOP_ASSISTANT_CHANNELS.builtInBrowserVirtualMouse,
			request,
		) as Promise<BuiltInBrowserStatus>,
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
		const wrapped = (_event: Electron.IpcRendererEvent, payload: DesktopAssistantEvent) => {
			listener(payload);
		};
		ipcRenderer.on(DESKTOP_ASSISTANT_CHANNELS.events, wrapped);
		return () => ipcRenderer.off(DESKTOP_ASSISTANT_CHANNELS.events, wrapped);
	},
	onLogEvent: (listener) => {
		const wrapped = (_event: Electron.IpcRendererEvent, payload: LogEntry) => listener(payload);
		ipcRenderer.on(DESKTOP_ASSISTANT_CHANNELS.logEvent, wrapped);
		return () => ipcRenderer.off(DESKTOP_ASSISTANT_CHANNELS.logEvent, wrapped);
	},
	onBuiltInBrowserEvent: (listener) => {
		const wrapped = (_event: Electron.IpcRendererEvent, payload: BuiltInBrowserEvent) => listener(payload);
		ipcRenderer.on(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserEvent, wrapped);
		return () => ipcRenderer.off(DESKTOP_ASSISTANT_CHANNELS.builtInBrowserEvent, wrapped);
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
