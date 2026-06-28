import type {
	AbortRequest,
	ApiKeyUpdateRequest,
	AutomationCancelRunRequest,
	AutomationCreateRequest,
	AutomationDeleteRequest,
	AutomationDesignChatRequest,
	AutomationDesignChatResponse,
	AutomationDesignStateResponse,
	AutomationDraft,
	AutomationDraftApplyRequest,
	AutomationDraftGetRequest,
	AutomationDraftSaveRequest,
	AutomationDraftSaveResponse,
	AutomationFlow,
	AutomationGetRequest,
	AutomationListResponse,
	AutomationPermissionMode,
	AutomationRiskLevel,
	AutomationRunRecord,
	AutomationRunRequest,
	AutomationRunResponse,
	AutomationSetEnabledRequest,
	AutomationStatus,
	AutomationUpdateRequest,
	AppLaunchCacheView,
	BrowserClearStorageRequest,
	BrowserClearStorageResponse,
	BrowserCookieRequest,
	BrowserCookieView,
	BrowserElementActionRequest,
	BrowserElementSnapshot,
	BrowserKeyRequest,
	BrowserNavigateRequest,
	BrowserNativeStatus,
	BrowserPageSnapshot,
	BrowserQueryElementsRequest,
	BrowserReadPageRequest,
	BrowserScreenshotRequest,
	BrowserScreenshotResponse,
	BrowserScrollRequest,
	BrowserSetBoundsRequest,
	BrowserTabRequest,
	BrowserVirtualMouseRequest,
	BuiltInBrowserEvent,
	BuiltInBrowserStatus,
	ClearConversationHistoryResponse,
	CloseSessionRequest,
	ConfirmationUpdateRequest,
	ConversationThinkingUpdateRequest,
	ConversationHistoryListResponse,
	DeleteConversationRequest,
	DeleteForgeExtensionRequest,
	FocusSessionRequest,
	ForgeExtensionMutationResponse,
	ListForgeExtensionsResponse,
	ListSessionsResponse,
	SetForgeExtensionTrustRequest,
	DeleteConversationResponse,
	DeleteAppLaunchCacheEntryRequest,
	DesktopAssistantEvent,
	DesktopAssistantSnapshot,
	GlobalMemoryClearResponse,
	GlobalMemoryDeleteRequest,
	GlobalMemoryEntry,
	GlobalMemoryListResponse,
	GlobalMemoryUpdateRequest,
	HomeWeatherView,
	LoadConversationPageRequest,
	LoadConversationPageResponse,
	LogEntry,
	McpEnabledUpdateRequest,
	McpServerActionRequest,
	McpServerDeleteRequest,
	McpServerListResponse,
	McpServerStatus,
	McpServerUpsertRequest,
	MemoCompleteRequest,
	MemoCreateRequest,
	MemoDeleteRequest,
	MemoItem,
	MemoAttachment,
	MemoAttachmentAddRequest,
	MemoAttachmentRemoveRequest,
	MemoBatchRequest,
	MemoBatchResult,
	MemoList,
	MemoListCreateRequest,
	MemoListDeleteRequest,
	MemoListReorderRequest,
	MemoListRequest,
	MemoListResponse,
	MemoListUpdateRequest,
	MemoReorderRequest,
	MemoRunAutoRequest,
	MemoSetReminderRequest,
	FileActionResponse,
	FilePathRequest,
	MemoSnoozeRequest,
	MemoStatsResult,
	MemoUpdateRequest,
	ExternalAppConfig,
	MoreAppEvent,
	MoreAppTerminalResponse,
	MoreAppView,
	OpenBuiltInBrowserRequest,
	OpenUrlInDefaultBrowserRequest,
	PersonalSkillArchiveRequest,
	PersonalSkillFileView,
	PersonalSkillListResponse,
	PersonalSkillReadRequest,
	PersonalSkillSaveRequest,
	PersonalSkillSearchRequest,
	PetDebugSnapshot,
	PetDebugStateEvent,
	PetDebugUpdateRequest,
	PromptRequest,
	QueuedPreInputRequest,
	RefreshHomeWelcomeRequest,
	ResumeConversationRequest,
	SandboxCleanRequest,
	SandboxCleanResponse,
	SandboxStatus,
	SettingsUpdateRequest,
	SkillFileRequest,
	SkillFileUpdateRequest,
	SkillFileView,
	InstallSoftwarePluginRequest,
	InstallSoftwarePluginResponse,
	SoftwarePluginListResponse,
	SoftwarePluginOperationProgress,
	SoftwarePluginTargetValidation,
	TestSoftwarePluginBridgeRequest,
	TestSoftwarePluginBridgeResponse,
	UninstallSoftwarePluginRequest,
	UninstallSoftwarePluginResponse,
	ValidateSoftwarePluginTargetRequest,
	StartVoiceRequest,
	StartWakeKwsRequest,
	StartWakeKwsResponse,
	TranscribeAudioRequest,
	TranscribeAudioResponse,
	VoiceApiKeyUpdateRequest,
	VoiceOverlayState,
	VoiceOverlayUpdateRequest,
	WakeKwsAudioFrame,
	WakeKwsWakeEvent,
	WakeWordModelDeleteRequest,
	WakeWordModelImportRequest,
	WakeWordModelImportResponse,
	WakeWordModelListResponse,
	WakeWordModelReadRequest,
	WakeWordModelReadResponse,
	WindowMode,
	WithdrawQueuedPreInputResponse,
} from "../../src/shared/types.ts";

export type {
	AutomationCancelRunRequest,
	AutomationCreateRequest,
	AutomationDeleteRequest,
	AutomationDesignChatRequest,
	AutomationDesignChatResponse,
	AutomationDesignStateResponse,
	AutomationDraft,
	AutomationDraftApplyRequest,
	AutomationDraftGetRequest,
	AutomationDraftSaveRequest,
	AutomationDraftSaveResponse,
	AutomationFlow,
	AutomationListResponse,
	AutomationRunRequest,
	AutomationRunRecord,
	AutomationRunResponse,
	AutomationSetEnabledRequest,
	AutomationUpdateRequest,
};
export type { AutomationPermissionMode, AutomationRiskLevel, AutomationStatus };

interface DesktopAssistantApi {
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
	automationOpenEditor(request?: { flowId?: string; id?: string }): Promise<void>;
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

declare global {
	interface Window {
		desktopAssistant: DesktopAssistantApi;
	}
}

export {};
