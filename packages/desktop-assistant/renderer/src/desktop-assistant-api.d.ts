import type {
	AbortRequest,
	ApiKeyUpdateRequest,
	AppLaunchCacheView,
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
	MemoListRequest,
	MemoListResponse,
	MemoSetReminderRequest,
	MemoSnoozeRequest,
	MemoUpdateRequest,
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
} from "../../src/shared/types.ts";

interface DesktopAssistantApi {
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

declare global {
	interface Window {
		desktopAssistant: DesktopAssistantApi;
	}
}

export {};
