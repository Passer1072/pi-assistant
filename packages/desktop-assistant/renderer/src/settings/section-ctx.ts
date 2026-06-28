import type { Dispatch, SetStateAction } from "react";
import type {
	BrowserNativeStatus,
	BrowserStorageClearScope,
	DesktopAssistantSettings,
	DesktopAssistantSnapshot,
	GlobalMemoryEntry,
	WakeWordModelMetadata,
} from "../../../src/shared/types.ts";

/**
 * Everything the per-category section components need. Built once in the SettingsView
 * shell (which owns all draft state and IPC) and passed down as a single `ctx` prop so
 * section signatures stay simple. The data flow is unchanged from the pre-refactor monolith.
 */
export interface SettingsSectionCtx {
	// Draft + snapshot
	draft: DesktopAssistantSettings;
	snapshot: DesktopAssistantSnapshot;
	setDraftSettings: Dispatch<SetStateAction<DesktopAssistantSettings>>;
	updateDraft: (update: Partial<DesktopAssistantSettings>) => void;
	updateDraftVoice: (update: Partial<DesktopAssistantSettings["voice"]>) => void;
	updateDraftBrowser: (update: Partial<DesktopAssistantSettings["browser"]>) => void;
	updateDraftMemory: (update: Partial<DesktopAssistantSettings["memory"]>) => void;
	updateDraftPersonalization: (update: Partial<DesktopAssistantSettings["personalization"]>) => void;

	// Apply lifecycle
	settingsApplying: boolean;
	hasDraftChanges: boolean;
	applyDraft: () => Promise<DesktopAssistantSnapshot | undefined>;
	setBaselineSettingsKey: (key: string) => void;

	// Window / history
	windowAlwaysOnTop: boolean;
	onWindowAlwaysOnTopChange: (enabled: boolean) => void;
	historyCount: number;
	onClearHistory: () => void;

	// Model + API key
	provider: string;
	apiConnectionMode: NonNullable<DesktopAssistantSettings["apiConnectionMode"]>;
	apiKeyLabel: string;
	isCustom: boolean;
	displayedModels: { id: string; label: string }[];
	relayModelOptions: NonNullable<DesktopAssistantSettings["deepseekRelayModels"]>;
	switchApiConnectionMode: (mode: DesktopAssistantSettings["apiConnectionMode"]) => Promise<void>;
	statusText: string;
	apiKey: string;
	setApiKey: (value: string) => void;
	showKey: boolean;
	setShowKey: Dispatch<SetStateAction<boolean>>;
	saving: boolean;
	setSaving: Dispatch<SetStateAction<boolean>>;
	onSaveApiKey: (key: string) => Promise<DesktopAssistantSnapshot | undefined>;
	refreshModels: () => void;
	modelsRefreshing: boolean;
	modelStatus: string;

	// Toolset / capabilities / managers
	enabledCapabilityCount: number;
	capabilityCount: number;
	onOpenMcp: () => void;
	onOpenToolset: () => void;
	onOpenPlugins: () => void;
	onOpenPersonalSkills: () => void;

	// Voice
	wakeModels: WakeWordModelMetadata[];
	activeWakeModel: WakeWordModelMetadata | undefined;
	wakeModelBusy: boolean;
	wakeModelStatus: string;
	switchWakeEngine: (engine: "kws" | "openwakeword" | "vosk") => Promise<void>;
	importWakeModel: (targetEngine?: "openwakeword" | "vosk") => Promise<WakeWordModelMetadata | undefined>;
	openWakeModelModal: () => void;
	voiceApiKey: string;
	setVoiceApiKey: (value: string) => void;
	showVoiceKey: boolean;
	setShowVoiceKey: Dispatch<SetStateAction<boolean>>;
	savingVoiceKey: boolean;
	setSavingVoiceKey: Dispatch<SetStateAction<boolean>>;
	onSaveVoiceApiKey: (key: string) => Promise<void>;

	// Browser
	browserBusy: boolean;
	browserStatus: string;
	nativeBrowserStatus: BrowserNativeStatus | undefined;
	openBuiltInBrowser: () => Promise<void>;
	clearBuiltInBrowserStorage: (scope: BrowserStorageClearScope) => Promise<void>;

	// Web search (local mirrored fields)
	wsApiKey: string;
	setWsApiKey: (value: string) => void;
	wsGoogleCx: string;
	setWsGoogleCx: (value: string) => void;
	wsSearxngUrl: string;
	setWsSearxngUrl: (value: string) => void;
	saveWsFields: () => void;

	// Home welcome weather key
	weatherApiKey: string;
	setWeatherApiKey: (value: string) => void;
	saveWeatherApiKey: () => void;

	// Memory + app cache
	globalMemories: GlobalMemoryEntry[];
	openMemoryModal: () => void;
	appCacheAliasCount: number | undefined;
	appCacheBusy: boolean;
	appCacheStatus: string;
	openAppCache: () => Promise<void>;
	clearAppCache: () => Promise<void>;
}
