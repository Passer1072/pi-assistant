import type React from "react";
import { ArrowLeft, Check, Loader2, Minus, Plug, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_DEEPSEEK_RELAY_URL } from "../../../src/shared/deepseek-connection.ts";
import type {
	BrowserNativeStatus,
	BrowserStorageClearScope,
	DesktopAssistantSettings,
	DesktopAssistantSnapshot,
	GlobalMemoryEntry,
	WakeWordModelMetadata,
} from "../../../src/shared/types.ts";
import { resolveWakeWordModelWakeWord } from "../../../src/shared/wake-word-settings.ts";
import { apiKeyStatusText, formatBytes } from "../formatters.ts";
import { cloneSettings, normalizeDraftSettingsBeforeApply, settingsKey } from "../settings-draft.ts";
import { PROVIDERS, updateVoiceSettings } from "../settings-view-model.ts";
import { GlobalMemoryModal } from "./modals/GlobalMemoryModal.tsx";
import { WakeModelModal } from "./modals/WakeModelModal.tsx";
import type { SettingsSectionCtx } from "./section-ctx.ts";
import { type SettingsCategoryId, SettingsNav } from "./section-kit.tsx";
import { BrowserWebSection } from "./sections/BrowserWebSection.tsx";
import { CapabilitiesSection } from "./sections/CapabilitiesSection.tsx";
import { ExperimentalSection } from "./sections/ExperimentalSection.tsx";
import { GeneralSection } from "./sections/GeneralSection.tsx";
import { MemoryPersonalSection } from "./sections/MemoryPersonalSection.tsx";
import { ModelSection } from "./sections/ModelSection.tsx";
import { VoiceSection } from "./sections/VoiceSection.tsx";

function browserStorageScopeLabel(scope: BrowserStorageClearScope): string {
	switch (scope) {
		case "cookies":
			return "Cookie";
		case "cache":
			return "缓存";
		case "site_data":
			return "站点数据";
		case "all":
			return "全部浏览器存储";
	}
}

export function SettingsView({
	snapshot,
	onBack,
	onOpenMcp,
	onOpenToolset,
	onOpenPlugins,
	onOpenPersonalSkills,
	onUpdate,
	onSaveApiKey,
	onSaveVoiceApiKey,
	historyCount,
	wakeModels,
	onWakeModels,
	onClearHistory,
	windowAlwaysOnTop,
	onWindowAlwaysOnTopChange,
}: {
	snapshot: DesktopAssistantSnapshot;
	onBack: () => void;
	onOpenMcp: () => void;
	onOpenToolset: () => void;
	onOpenPlugins: () => void;
	onOpenPersonalSkills: () => void;
	onUpdate: (s: Partial<DesktopAssistantSettings>) => Promise<DesktopAssistantSnapshot | undefined>;
	onSaveApiKey: (key: string) => Promise<DesktopAssistantSnapshot | undefined>;
	onSaveVoiceApiKey: (key: string) => Promise<void>;
	historyCount: number;
	wakeModels: WakeWordModelMetadata[];
	onWakeModels: (models: WakeWordModelMetadata[]) => void;
	onClearHistory: () => void;
	windowAlwaysOnTop: boolean;
	onWindowAlwaysOnTopChange: (enabled: boolean) => void;
}) {
	const [draftSettings, setDraftSettings] = useState<DesktopAssistantSettings>(() => cloneSettings(snapshot.settings));
	const [baselineSettingsKey, setBaselineSettingsKey] = useState(() => settingsKey(snapshot.settings));
	const [settingsStatus, setSettingsStatus] = useState("");
	const [settingsApplying, setSettingsApplying] = useState(false);
	const [apiKey, setApiKey] = useState("");
	const [voiceApiKey, setVoiceApiKey] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [showVoiceKey, setShowVoiceKey] = useState(false);
	const [saving, setSaving] = useState(false);
	const [savingVoiceKey, setSavingVoiceKey] = useState(false);
	const [appCacheAliasCount, setAppCacheAliasCount] = useState<number | undefined>();
	const [appCacheBusy, setAppCacheBusy] = useState(false);
	const [appCacheStatus, setAppCacheStatus] = useState("");
	const [wakeModelBusy, setWakeModelBusy] = useState(false);
	const [wakeModelStatus, setWakeModelStatus] = useState("");
	const [browserBusy, setBrowserBusy] = useState(false);
	const [browserStatus, setBrowserStatus] = useState("");
	const [nativeBrowserStatus, setNativeBrowserStatus] = useState<BrowserNativeStatus | undefined>(undefined);
	const [globalMemories, setGlobalMemories] = useState<GlobalMemoryEntry[]>([]);
	const [memoryBusy, setMemoryBusy] = useState(false);
	const [memoryStatus, setMemoryStatus] = useState("");
	const [modelsRefreshing, setModelsRefreshing] = useState(false);
	const [modelStatus, setModelStatus] = useState("");

	// Navigation / overlays
	const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>("model");
	const [query, setQuery] = useState("");
	const [memoryModalOpen, setMemoryModalOpen] = useState(false);
	const [wakeModalOpen, setWakeModalOpen] = useState(false);

	const snapshotSettingsKey = useMemo(() => settingsKey(snapshot.settings), [snapshot.settings]);
	const draftSettingsKey = useMemo(() => settingsKey(draftSettings), [draftSettings]);
	const hasDraftChanges = draftSettingsKey !== baselineSettingsKey;

	useEffect(() => {
		if (snapshotSettingsKey === baselineSettingsKey || hasDraftChanges) return;
		setDraftSettings(cloneSettings(snapshot.settings));
		setBaselineSettingsKey(snapshotSettingsKey);
		setSettingsStatus("");
	}, [baselineSettingsKey, hasDraftChanges, snapshot.settings, snapshotSettingsKey]);

	// Web search local mirror so inputs are always controlled.
	const ws = draftSettings.webSearch ?? { mode: "auto" as const, provider: "duckduckgo" as const };
	const [wsApiKey, setWsApiKey] = useState(ws.apiKey ?? "");
	const [wsGoogleCx, setWsGoogleCx] = useState(ws.googleCx ?? "");
	const [wsSearxngUrl, setWsSearxngUrl] = useState(ws.searxngUrl ?? "");
	const [weatherApiKey, setWeatherApiKey] = useState(draftSettings.homeWelcome?.weatherApiKey ?? "");

	const updateDraft = (update: Partial<DesktopAssistantSettings>) => {
		setSettingsStatus("");
		setDraftSettings((current) => ({ ...current, ...update }));
	};
	const updateDraftVoice = (update: Partial<DesktopAssistantSettings["voice"]>) => {
		setSettingsStatus("");
		setDraftSettings((current) => ({ ...current, ...updateVoiceSettings(current, update) }));
	};
	const updateDraftBrowser = (update: Partial<DesktopAssistantSettings["browser"]>) => {
		setSettingsStatus("");
		setDraftSettings((current) => ({ ...current, browser: { ...current.browser, ...update, persistStorage: true } }));
	};
	const updateDraftMemory = (update: Partial<DesktopAssistantSettings["memory"]>) => {
		setSettingsStatus("");
		setDraftSettings((current) => ({ ...current, memory: { ...current.memory, ...update } }));
	};
	const updateDraftPersonalization = (update: Partial<DesktopAssistantSettings["personalization"]>) => {
		setSettingsStatus("");
		setDraftSettings((current) => ({ ...current, personalization: { ...current.personalization, ...update } }));
	};

	const restoreDraft = () => {
		setDraftSettings(cloneSettings(snapshot.settings));
		setBaselineSettingsKey(settingsKey(snapshot.settings));
		setWsApiKey(snapshot.settings.webSearch?.apiKey ?? "");
		setWsGoogleCx(snapshot.settings.webSearch?.googleCx ?? "");
		setWsSearxngUrl(snapshot.settings.webSearch?.searxngUrl ?? "");
		setWeatherApiKey(snapshot.settings.homeWelcome?.weatherApiKey ?? "");
		setSettingsStatus("已恢复到当前已应用设置。");
	};

	const applyDraft = async (): Promise<DesktopAssistantSnapshot | undefined> => {
		setSettingsStatus("");
		const settingsToApply = normalizeDraftSettingsBeforeApply(draftSettings, wakeModels);
		setDraftSettings(settingsToApply);
		setSettingsApplying(true);
		try {
			const nextSnapshot = await onUpdate(settingsToApply);
			if (!nextSnapshot) {
				setSettingsStatus("应用失败，请查看控制台或日志窗口。");
				return undefined;
			}
			const appliedSettings = nextSnapshot.settings;
			setDraftSettings(cloneSettings(appliedSettings));
			setBaselineSettingsKey(settingsKey(appliedSettings));
			setSettingsStatus("设置已应用。");
			return nextSnapshot;
		} finally {
			setSettingsApplying(false);
		}
	};

	const saveWsFields = () => {
		updateDraft({
			webSearch: {
				...ws,
				apiKey: wsApiKey.trim() || undefined,
				googleCx: wsGoogleCx.trim() || undefined,
				searxngUrl: wsSearxngUrl.trim() || undefined,
			},
		});
	};

	const saveWeatherApiKey = () => {
		updateDraft({ homeWelcome: { ...draftSettings.homeWelcome, weatherApiKey: weatherApiKey.trim() || undefined } });
	};

	const refreshNativeBrowserStatus = async () => {
		if (!window.desktopAssistant) return;
		setNativeBrowserStatus(await window.desktopAssistant.builtInBrowserGetNativeStatus());
	};

	const openBuiltInBrowser = async () => {
		if (!window.desktopAssistant) return;
		setBrowserBusy(true);
		setBrowserStatus("");
		try {
			await window.desktopAssistant.openBuiltInBrowser();
			await refreshNativeBrowserStatus();
			setBrowserStatus("内置浏览器已打开。");
		} catch (error) {
			setBrowserStatus(error instanceof Error ? error.message : String(error));
		} finally {
			setBrowserBusy(false);
		}
	};

	const clearBuiltInBrowserStorage = async (scope: BrowserStorageClearScope) => {
		if (!window.desktopAssistant) return;
		setBrowserBusy(true);
		setBrowserStatus("");
		try {
			const result = await window.desktopAssistant.builtInBrowserClearStorage({ scope });
			setBrowserStatus(`已清理 ${browserStorageScopeLabel(scope)}，当前 profile 约 ${formatBytes(result.profileSizeBytes)}。`);
		} catch (error) {
			setBrowserStatus(error instanceof Error ? error.message : String(error));
		} finally {
			setBrowserBusy(false);
		}
	};

	const switchApiConnectionMode = async (mode: DesktopAssistantSettings["apiConnectionMode"]) => {
		const nextBaseUrl = mode === "relay" ? draftSettings.apiBaseUrl?.trim() || DEFAULT_DEEPSEEK_RELAY_URL : draftSettings.apiBaseUrl;
		setSettingsStatus("");
		setDraftSettings((current) => ({ ...current, apiConnectionMode: mode, apiBaseUrl: nextBaseUrl }));
		setSettingsApplying(true);
		try {
			const nextSnapshot = await onUpdate({ apiConnectionMode: mode, apiBaseUrl: nextBaseUrl });
			if (!nextSnapshot) {
				setSettingsStatus("切换失败，请查看控制台或日志窗口。");
				return;
			}
			setBaselineSettingsKey(settingsKey(nextSnapshot.settings));
			setDraftSettings((current) => {
				if (settingsKey(current) === baselineSettingsKey) return cloneSettings(nextSnapshot.settings);
				return { ...current, apiConnectionMode: nextSnapshot.settings.apiConnectionMode, apiBaseUrl: nextSnapshot.settings.apiBaseUrl };
			});
			setSettingsStatus(`${mode === "relay" ? "中转站" : "官方API"}已切换。`);
		} finally {
			setSettingsApplying(false);
		}
	};

	const refreshModels = () => {
		if (!window.desktopAssistant) return;
		setModelsRefreshing(true);
		setModelStatus("");
		void (async () => {
			try {
				const next = await window.desktopAssistant.discoverModels();
				if (!next) {
					setModelStatus("刷新失败，请确认已配置 API Key。");
					return;
				}
				setBaselineSettingsKey(settingsKey(next.settings));
				setDraftSettings((current) => {
					if (settingsKey(current) === baselineSettingsKey) return cloneSettings(next.settings);
					return { ...current, deepseekRelayModels: next.settings.deepseekRelayModels, modelId: next.settings.modelId };
				});
				setModelStatus(`已从 API 获取 ${next.settings.deepseekRelayModels?.length ?? 0} 个模型。`);
			} catch (error) {
				setModelStatus(error instanceof Error ? error.message : String(error));
			} finally {
				setModelsRefreshing(false);
			}
		})();
	};

	const loadGlobalMemories = async () => {
		if (!window.desktopAssistant) return;
		setMemoryBusy(true);
		setMemoryStatus("");
		try {
			const result = await window.desktopAssistant.listGlobalMemories();
			setGlobalMemories(result.memories);
		} catch (error) {
			setMemoryStatus(error instanceof Error ? error.message : String(error));
		} finally {
			setMemoryBusy(false);
		}
	};

	const deleteGlobalMemory = async (id: string) => {
		if (!window.desktopAssistant) return;
		setMemoryBusy(true);
		setMemoryStatus("");
		try {
			const result = await window.desktopAssistant.deleteGlobalMemory({ id });
			setGlobalMemories(result.memories);
			setMemoryStatus("记忆已删除。");
		} catch (error) {
			setMemoryStatus(error instanceof Error ? error.message : String(error));
		} finally {
			setMemoryBusy(false);
		}
	};

	const clearGlobalMemories = async () => {
		if (!window.desktopAssistant) return;
		setMemoryBusy(true);
		setMemoryStatus("");
		try {
			const result = await window.desktopAssistant.clearGlobalMemories();
			setGlobalMemories([]);
			setMemoryStatus(`已清空 ${result.deletedCount} 条记忆。`);
		} catch (error) {
			setMemoryStatus(error instanceof Error ? error.message : String(error));
		} finally {
			setMemoryBusy(false);
		}
	};

	const openAppCache = async () => {
		if (!window.desktopAssistant) return;
		setAppCacheBusy(true);
		setAppCacheStatus("");
		try {
			const cache = await window.desktopAssistant.getAppLaunchCache();
			setAppCacheAliasCount(Object.keys(cache.aliases).length);
			await window.desktopAssistant.openAppLaunchCacheWindow();
		} catch (error) {
			setAppCacheStatus(error instanceof Error ? error.message : String(error));
		} finally {
			setAppCacheBusy(false);
		}
	};

	const clearAppCache = async () => {
		if (!window.desktopAssistant) return;
		setAppCacheBusy(true);
		setAppCacheStatus("");
		try {
			await window.desktopAssistant.clearAppLaunchCache();
			setAppCacheAliasCount(0);
			setAppCacheStatus("应用启动记忆已清空。");
		} catch (error) {
			setAppCacheStatus(error instanceof Error ? error.message : String(error));
		} finally {
			setAppCacheBusy(false);
		}
	};

	const importWakeModel = async (targetEngine: "openwakeword" | "vosk" = "openwakeword") => {
		if (!window.desktopAssistant) return undefined;
		setWakeModelBusy(true);
		setWakeModelStatus("");
		try {
			const result = await window.desktopAssistant.importWakeWordModel({});
			onWakeModels(result.models);
			if (!result.model) {
				setWakeModelStatus("已取消导入。");
				return undefined;
			}
			updateDraftVoice({
				wakeEngine: targetEngine,
				activeOwwModelId: result.model.id,
				wakeWord: resolveWakeWordModelWakeWord(result.model),
			});
			setWakeModelStatus(`已导入 ${result.model.label}。`);
			return result.model;
		} catch (error) {
			setWakeModelStatus(error instanceof Error ? error.message : String(error));
			return undefined;
		} finally {
			setWakeModelBusy(false);
		}
	};

	const switchWakeEngine = async (engine: "kws" | "openwakeword" | "vosk") => {
		if (engine === "kws") {
			updateDraftVoice({ wakeEngine: "kws", wakeWord: "小派" });
			return;
		}
		if (engine === "vosk") {
			updateDraftVoice({ wakeEngine: "vosk" });
			return;
		}
		const selected = activeWakeModel ?? wakeModels[0];
		if (selected) {
			updateDraftVoice({ wakeEngine: "openwakeword", activeOwwModelId: selected.id, wakeWord: resolveWakeWordModelWakeWord(selected) });
			return;
		}
		await importWakeModel("openwakeword");
	};

	const switchWakeModel = (model: WakeWordModelMetadata) => {
		updateDraftVoice({ wakeEngine: "openwakeword", activeOwwModelId: model.id, wakeWord: resolveWakeWordModelWakeWord(model) });
	};

	const deleteWakeModel = async (id: string) => {
		if (!window.desktopAssistant) return;
		setWakeModelBusy(true);
		setWakeModelStatus("");
		try {
			const result = await window.desktopAssistant.deleteWakeWordModel({ id });
			onWakeModels(result.models);
			setDraftSettings((current) => {
				if (current.voice.activeOwwModelId !== id) return current;
				const nextModel = result.models[0];
				return {
					...current,
					...updateVoiceSettings(current, {
						wakeEngine: nextModel ? "openwakeword" : "vosk",
						activeOwwModelId: nextModel?.id,
						wakeWord: nextModel ? resolveWakeWordModelWakeWord(nextModel) : current.voice.wakeWord,
					}),
				};
			});
			setWakeModelStatus("唤醒词模型已删除。");
		} catch (error) {
			setWakeModelStatus(error instanceof Error ? error.message : String(error));
		} finally {
			setWakeModelBusy(false);
		}
	};

	useEffect(() => {
		if (!window.desktopAssistant) return;
		let cancelled = false;
		window.desktopAssistant
			.getAppLaunchCache()
			.then((cache) => {
				if (!cancelled) setAppCacheAliasCount(Object.keys(cache.aliases).length);
			})
			.catch(() => {
				if (!cancelled) setAppCacheAliasCount(undefined);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		void loadGlobalMemories();
	}, []);

	useEffect(() => {
		if (!window.desktopAssistant) return;
		let cancelled = false;
		window.desktopAssistant
			.builtInBrowserGetNativeStatus()
			.then((status) => {
				if (!cancelled) setNativeBrowserStatus(status);
			})
			.catch(() => {
				if (!cancelled) setNativeBrowserStatus(undefined);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!window.desktopAssistant) return;
		let cancelled = false;
		window.desktopAssistant
			.listWakeWordModels()
			.then((result) => {
				if (!cancelled) onWakeModels(result.models);
			})
			.catch((error) => {
				if (!cancelled) setWakeModelStatus(error instanceof Error ? error.message : String(error));
			});
		return () => {
			cancelled = true;
		};
	}, [onWakeModels]);

	// Derived model/provider values
	const provider = draftSettings.provider ?? "deepseek";
	const currentProvider = PROVIDERS.find((item) => item.id === provider) ?? PROVIDERS[0];
	const isCustom = provider === "custom";
	const apiConnectionMode = draftSettings.apiConnectionMode ?? "official";
	const apiKeyLabel = apiConnectionMode === "relay" ? "中转站 API Key" : "官方 API Key";
	const relayModelOptions = apiConnectionMode === "relay" ? (draftSettings.deepseekRelayModels ?? []) : [];
	const discoveredModels = draftSettings.deepseekRelayModels ?? [];
	const displayedModels = (() => {
		const isDeepSeekRelay = provider === "deepseek" && apiConnectionMode === "relay";
		if (isDeepSeekRelay && relayModelOptions.length === 0) {
			return [{ id: draftSettings.modelId, label: "保存中转站 API Key 后自动发现模型" }];
		}
		const base =
			provider === "deepseek" && discoveredModels.length > 0
				? discoveredModels.map((model) => ({ id: model.id, label: model.label || model.id }))
				: currentProvider.models;
		if (!draftSettings.modelId || base.some((model) => model.id === draftSettings.modelId)) return base;
		return [{ id: draftSettings.modelId, label: draftSettings.modelId }, ...base];
	})();
	const statusText = apiKeyStatusText(snapshot.apiKeyStatus);
	const activeWakeModel = wakeModels.find((model) => model.id === draftSettings.voice.activeOwwModelId);
	const capabilityIds = ["system", "document", "ppt", "excel"] as const;
	const enabledCapabilityCount = capabilityIds.filter((id) => draftSettings.capabilities[id]?.enabled).length;

	const ctx: SettingsSectionCtx = {
		draft: draftSettings,
		snapshot,
		setDraftSettings,
		updateDraft,
		updateDraftVoice,
		updateDraftBrowser,
		updateDraftMemory,
		updateDraftPersonalization,
		settingsApplying,
		hasDraftChanges,
		applyDraft,
		setBaselineSettingsKey,
		windowAlwaysOnTop,
		onWindowAlwaysOnTopChange,
		historyCount,
		onClearHistory,
		provider,
		apiConnectionMode,
		apiKeyLabel,
		isCustom,
		displayedModels,
		relayModelOptions,
		switchApiConnectionMode,
		statusText,
		apiKey,
		setApiKey,
		showKey,
		setShowKey,
		saving,
		setSaving,
		onSaveApiKey,
		refreshModels,
		modelsRefreshing,
		modelStatus,
		enabledCapabilityCount,
		capabilityCount: capabilityIds.length,
		onOpenMcp,
		onOpenToolset,
		onOpenPlugins,
		onOpenPersonalSkills,
		wakeModels,
		activeWakeModel,
		wakeModelBusy,
		wakeModelStatus,
		switchWakeEngine,
		importWakeModel,
		openWakeModelModal: () => setWakeModalOpen(true),
		voiceApiKey,
		setVoiceApiKey,
		showVoiceKey,
		setShowVoiceKey,
		savingVoiceKey,
		setSavingVoiceKey,
		onSaveVoiceApiKey,
		browserBusy,
		browserStatus,
		nativeBrowserStatus,
		openBuiltInBrowser,
		clearBuiltInBrowserStorage,
		wsApiKey,
		setWsApiKey,
		wsGoogleCx,
		setWsGoogleCx,
		wsSearxngUrl,
		setWsSearxngUrl,
		saveWsFields,
		weatherApiKey,
		setWeatherApiKey,
		saveWeatherApiKey,
		globalMemories,
		openMemoryModal: () => {
			void loadGlobalMemories();
			setMemoryModalOpen(true);
		},
		appCacheAliasCount,
		appCacheBusy,
		appCacheStatus,
		openAppCache,
		clearAppCache,
	};

	const renderActive = () => {
		switch (activeCategory) {
			case "general":
				return <GeneralSection ctx={ctx} />;
			case "model":
				return <ModelSection ctx={ctx} />;
			case "voice":
				return <VoiceSection ctx={ctx} />;
			case "web":
				return <BrowserWebSection ctx={ctx} />;
			case "memory":
				return <MemoryPersonalSection ctx={ctx} />;
			case "caps":
				return <CapabilitiesSection ctx={ctx} />;
			case "exp":
				return <ExperimentalSection ctx={ctx} />;
		}
	};

	return (
		<div className="screen settings-screen">
			<div className="titlebar" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
				<button className="title-btn" onClick={onBack} type="button" aria-label="返回" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
					<ArrowLeft size={16} />
				</button>
				<div className="title-label">设置</div>
				<button className="title-btn" onClick={onOpenPlugins} type="button" aria-label="插件管理" title="插件管理" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
					<Plug size={15} />
				</button>
				<div className="title-window-controls" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
					<button className="title-btn" onClick={() => window.desktopAssistant?.minimizeWindow?.()} type="button" aria-label="最小化">
						<Minus size={14} />
					</button>
					<button className="title-btn danger" onClick={() => window.desktopAssistant?.closeWindow?.()} type="button" aria-label="关闭">
						<X size={14} />
					</button>
				</div>
			</div>

			<div className="settings-body">
				<SettingsNav active={activeCategory} onSelect={setActiveCategory} query={query} onQuery={setQuery} />
				<div className="settings-content" key={activeCategory}>
					{renderActive()}
				</div>
			</div>

			<div className="settings-apply-bar">
				<div>
					<strong>{hasDraftChanges ? "有未应用的设置" : "设置已同步"}</strong>
					<span>{settingsStatus || (hasDraftChanges ? "点击应用后才会立即生效。" : "当前显示的是已应用配置。")}</span>
				</div>
				<div className="settings-apply-actions">
					<button type="button" className="ghost-btn wide" onClick={restoreDraft} disabled={!hasDraftChanges || settingsApplying}>
						<RefreshCw size={14} />
						<span>恢复 / Restore</span>
					</button>
					<button type="button" className="primary-btn" onClick={() => void applyDraft()} disabled={!hasDraftChanges || settingsApplying}>
						{settingsApplying ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
						<span>应用 / Apply</span>
					</button>
				</div>
			</div>

			{memoryModalOpen ? (
				<GlobalMemoryModal
					memories={globalMemories}
					busy={memoryBusy}
					status={memoryStatus}
					onClose={() => setMemoryModalOpen(false)}
					onRefresh={() => void loadGlobalMemories()}
					onClear={() => {
						if (window.confirm("确定要清空所有跨对话记忆吗？")) void clearGlobalMemories();
					}}
					onDelete={(id) => void deleteGlobalMemory(id)}
				/>
			) : null}

			{wakeModalOpen ? (
				<WakeModelModal
					models={wakeModels}
					activeId={draftSettings.voice.activeOwwModelId}
					busy={wakeModelBusy}
					status={wakeModelStatus}
					onClose={() => setWakeModalOpen(false)}
					onImport={() => void importWakeModel("openwakeword")}
					onSwitch={switchWakeModel}
					onDelete={(id) => void deleteWakeModel(id)}
				/>
			) : null}
		</div>
	);
}
