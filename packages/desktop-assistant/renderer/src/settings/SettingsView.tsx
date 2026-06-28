import type React from "react";
import { ArrowLeft, BookOpen, Brain, Check, ChevronRight, Eye, EyeOff, Globe, KeyRound, Loader2, Minus, Pin, PinOff, Plus, Plug, RefreshCw, Trash2, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_DEEPSEEK_RELAY_URL } from "../../../src/shared/deepseek-connection.ts";
import { DEFAULT_VOICE_STT_BASE_URL_BY_PROVIDER, type AiBrowserPreference, type BrowserNativeStatus, type BrowserStorageClearScope, type BrowserTarget, type DesktopAssistantSettings, type DesktopAssistantSnapshot, type GlobalMemoryEntry, type WakeWordModelMetadata, type WebSearchProvider } from "../../../src/shared/types.ts";
import { resolveWakeWordModelWakeWord } from "../../../src/shared/wake-word-settings.ts";
import { cloneSettings, normalizeDraftSettingsBeforeApply, settingsKey } from "../settings-draft.ts";
import { apiKeyStatusText, formatBytes, formatImportedAt } from "../formatters.ts";
import { PROVIDERS, updateVoiceSettings, VOICE_PROVIDER_LABEL, VOICE_STT_MODEL_HINT } from "../settings-view-model.ts";

const SEARCH_ENGINE_OPTIONS: { label: string; template: string }[] = [
	{ label: "Google", template: "https://www.google.com/search?q=%s" },
	{ label: "必应 Bing", template: "https://www.bing.com/search?q=%s" },
	{ label: "百度 Baidu", template: "https://www.baidu.com/s?wd=%s" },
	{ label: "DuckDuckGo", template: "https://duckduckgo.com/?q=%s" },
];

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
	const [nativeBrowserStatus, setNativeBrowserStatus] = useState<BrowserNativeStatus | undefined>();
	const [globalMemories, setGlobalMemories] = useState<GlobalMemoryEntry[]>([]);
	const [memoryBusy, setMemoryBusy] = useState(false);
	const [memoryStatus, setMemoryStatus] = useState("");

	const snapshotSettingsKey = useMemo(() => settingsKey(snapshot.settings), [snapshot.settings]);
	const draftSettingsKey = useMemo(() => settingsKey(draftSettings), [draftSettings]);
	const hasDraftChanges = draftSettingsKey !== baselineSettingsKey;

	useEffect(() => {
		if (snapshotSettingsKey === baselineSettingsKey || hasDraftChanges) return;
		setDraftSettings(cloneSettings(snapshot.settings));
		setBaselineSettingsKey(snapshotSettingsKey);
		setSettingsStatus("");
	}, [baselineSettingsKey, hasDraftChanges, snapshot.settings, snapshotSettingsKey]);

	// Web search: local state mirrors snapshot so inputs are always controlled.
	const ws = draftSettings.webSearch ?? { mode: "auto" as const, provider: "duckduckgo" as const };
	const [wsApiKey, setWsApiKey] = useState(ws.apiKey ?? "");
	const [wsGoogleCx, setWsGoogleCx] = useState(ws.googleCx ?? "");
	const [wsSearxngUrl, setWsSearxngUrl] = useState(ws.searxngUrl ?? "");

	// Weather API key: local state mirrors homeWelcome.weatherApiKey.
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
		setDraftSettings((current) => ({
			...current,
			personalization: { ...current.personalization, ...update },
		}));
	};

	const restoreDraft = () => {
		setDraftSettings(cloneSettings(snapshot.settings));
		const nextKey = settingsKey(snapshot.settings);
		setBaselineSettingsKey(nextKey);
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
			const nextKey = settingsKey(appliedSettings);
			setBaselineSettingsKey(nextKey);
			setSettingsStatus("设置已应用。");
			return nextSnapshot;
		} finally {
			setSettingsApplying(false);
		}
	};

	/** Save web search key/url fields. Called by each field's Save button. */
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

	/** Save the WeatherAPI.com API key into the draft. */
	const saveWeatherApiKey = () => {
		updateDraft({
			homeWelcome: {
				...draftSettings.homeWelcome,
				weatherApiKey: weatherApiKey.trim() || undefined,
			},
		});
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
		const nextBaseUrl =
			mode === "relay" ? draftSettings.apiBaseUrl?.trim() || DEFAULT_DEEPSEEK_RELAY_URL : draftSettings.apiBaseUrl;
		setSettingsStatus("");
		setDraftSettings((current) => ({
			...current,
			apiConnectionMode: mode,
			apiBaseUrl: nextBaseUrl,
		}));
		setSettingsApplying(true);
		try {
			const nextSnapshot = await onUpdate({
				apiConnectionMode: mode,
				apiBaseUrl: nextBaseUrl,
			});
			if (!nextSnapshot) {
				setSettingsStatus("切换失败，请查看控制台或日志窗口。");
				return;
			}
			const nextKey = settingsKey(nextSnapshot.settings);
			setBaselineSettingsKey(nextKey);
			setDraftSettings((current) => {
				if (settingsKey(current) === baselineSettingsKey) {
					return cloneSettings(nextSnapshot.settings);
				}
				return {
					...current,
					apiConnectionMode: nextSnapshot.settings.apiConnectionMode,
					apiBaseUrl: nextSnapshot.settings.apiBaseUrl,
				};
			});
			setSettingsStatus(`${mode === "relay" ? "中转站" : "官方API"}已切换。`);
		} finally {
			setSettingsApplying(false);
		}
	};

	const provider = draftSettings.provider ?? "deepseek";
	const browserSettings = draftSettings.browser;
	const currentProvider = PROVIDERS.find((item) => item.id === provider) ?? PROVIDERS[0];
	const isCustom = provider === "custom";
	const apiConnectionMode = draftSettings.apiConnectionMode ?? "official";
	const apiKeyLabel = apiConnectionMode === "relay" ? "中转站 API Key" : "官方 API Key";
	const relayModelOptions = apiConnectionMode === "relay" ? (draftSettings.deepseekRelayModels ?? []) : [];
	const displayedModels = (() => {
		const isDeepSeekRelay = provider === "deepseek" && apiConnectionMode === "relay";
		if (isDeepSeekRelay && relayModelOptions.length === 0) {
			return [
				{
					id: draftSettings.modelId,
					label: "保存中转站 API Key 后自动发现模型",
				},
			];
		}
		const models = isDeepSeekRelay
			? relayModelOptions.map((model) => ({ id: model.id, label: model.label || model.id }))
			: currentProvider.models;
		if (!draftSettings.modelId || models.some((model) => model.id === draftSettings.modelId)) {
			return models;
		}
		return [{ id: draftSettings.modelId, label: draftSettings.modelId }, ...models];
	})();
	const statusText = apiKeyStatusText(snapshot.apiKeyStatus);
	const activeWakeModel = wakeModels.find((model) => model.id === draftSettings.voice.activeOwwModelId);
	const capabilityIds = ["system", "document", "ppt", "excel"] as const;
	const enabledCapabilityCount = capabilityIds.filter((id) => draftSettings.capabilities[id]?.enabled).length;

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
			updateDraftVoice({
				wakeEngine: "openwakeword",
				activeOwwModelId: selected.id,
				wakeWord: resolveWakeWordModelWakeWord(selected),
			});
			return;
		}
		await importWakeModel("openwakeword");
	};

	const switchWakeModel = (model: WakeWordModelMetadata) => {
		updateDraftVoice({
			wakeEngine: "openwakeword",
			activeOwwModelId: model.id,
			wakeWord: resolveWakeWordModelWakeWord(model),
		});
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

	const renderBrowserSection = () => (
		<section className="set-section">
			<h3>浏览器</h3>
			<label className="set-row">
				<span className="setting-label-with-icon">
					<Globe size={14} />
					<span>默认浏览器</span>
				</span>
				<select
					value={browserSettings.defaultBrowser}
					onChange={(event) => updateDraftBrowser({ defaultBrowser: event.target.value as BrowserTarget })}
				>
					<option value="built_in">内置浏览器</option>
					<option value="chrome">本机浏览器（Chrome）</option>
					<option value="edge">本机浏览器（Edge）</option>
				</select>
			</label>
			<label className="set-row toggle-row">
				<span>允许 AI 控制浏览器</span>
				<button
					type="button"
					className={`toggle ${browserSettings.allowAiControl ? "on" : ""}`}
					onClick={() => updateDraftBrowser({ allowAiControl: !browserSettings.allowAiControl })}
					aria-pressed={browserSettings.allowAiControl}
				>
					<span className="toggle-thumb" />
				</button>
			</label>
			<label className="set-row">
				<span>模型浏览器偏好</span>
				<select
					value={browserSettings.aiBrowserPreference}
					disabled={!browserSettings.allowAiControl}
					onChange={(event) =>
						updateDraftBrowser({ aiBrowserPreference: event.target.value as AiBrowserPreference })
					}
				>
					<option value="built_in">内置浏览器</option>
					<option value="external">外置浏览器（Chrome / Edge）</option>
					<option value="auto">自动（由模型决定）</option>
				</select>
			</label>
			<p className="set-hint">
				内置：只用内置浏览器工具；外置：用外部浏览器扩展 MCP 控制本机 Chrome/Edge（需已启用该 MCP）；自动：两者都给模型自行选择。
			</p>
			<label className="set-row">
				<span>内置浏览器首页</span>
				<input
					type="text"
					value={browserSettings.homeUrl}
					onChange={(event) => updateDraftBrowser({ homeUrl: event.target.value })}
					placeholder="https://www.google.com"
				/>
			</label>
			<label className="set-row">
				<span>默认搜索引擎</span>
				<select
					value={SEARCH_ENGINE_OPTIONS.some((opt) => opt.template === browserSettings.searchTemplate) ? browserSettings.searchTemplate : "custom"}
					onChange={(event) => {
						if (event.target.value !== "custom") updateDraftBrowser({ searchTemplate: event.target.value });
					}}
				>
					{SEARCH_ENGINE_OPTIONS.map((opt) => (
						<option key={opt.template} value={opt.template}>
							{opt.label}
						</option>
					))}
					{SEARCH_ENGINE_OPTIONS.some((opt) => opt.template === browserSettings.searchTemplate) ? null : (
						<option value="custom">自定义</option>
					)}
				</select>
			</label>
			<label className="set-row">
				<span>最大标签页</span>
				<input
					type="number"
					min={1}
					max={32}
					value={browserSettings.maxTabs}
					onChange={(event) => updateDraftBrowser({ maxTabs: Number(event.target.value) })}
				/>
			</label>
			<div className="mcp-entry-row">
				<div>
					<strong>内置浏览器</strong>
					<p className="set-hint">使用助手专用持久 profile，保存 Cookie、站点数据、缓存和标签页控制状态。</p>
				</div>
				<button type="button" className="primary-btn" onClick={() => void openBuiltInBrowser()} disabled={browserBusy}>
					{browserBusy ? <Loader2 size={14} className="spin" /> : <Globe size={14} />}
					<span>打开内置浏览器</span>
				</button>
			</div>
			<div className="browser-native-grid">
				<NativeBrowserRow icon={<Globe size={14} />} label="Chrome" status={nativeBrowserStatus?.chrome} />
				<NativeBrowserRow icon={<Globe size={14} />} label="Edge" status={nativeBrowserStatus?.edge} />
			</div>
			<div className="browser-clear-row">
				<button
					type="button"
					className="ghost-btn wide"
					disabled={browserBusy}
					onClick={() => {
						if (window.confirm("确定要清理内置浏览器 Cookie 吗？")) void clearBuiltInBrowserStorage("cookies");
					}}
				>
					Cookies
				</button>
				<button
					type="button"
					className="ghost-btn wide"
					disabled={browserBusy}
					onClick={() => {
						if (window.confirm("确定要清理内置浏览器缓存吗？")) void clearBuiltInBrowserStorage("cache");
					}}
				>
					缓存
				</button>
				<button
					type="button"
					className="ghost-btn wide"
					disabled={browserBusy}
					onClick={() => {
						if (window.confirm("确定要清理内置浏览器站点数据吗？")) void clearBuiltInBrowserStorage("site_data");
					}}
				>
					站点数据
				</button>
				<button
					type="button"
					className="danger-btn"
					disabled={browserBusy}
					onClick={() => {
						if (window.confirm("确定要清理内置浏览器全部存储吗？这会清除登录态和站点数据。")) {
							void clearBuiltInBrowserStorage("all");
						}
					}}
				>
					<Trash2 size={13} />
					<span>全部清理</span>
				</button>
			</div>
			<p className="set-hint">
				AI 未被用户指定浏览器时会使用默认浏览器；显式说“用 Chrome / Edge / 内置浏览器”只覆盖本次操作，不修改设置。
			</p>
			{browserStatus ? <div className="skill-editor-status">{browserStatus}</div> : null}
		</section>
	);

	return (
		<div className="screen settings-screen">
			<div className="titlebar" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
				<button
					className="title-btn"
					onClick={onBack}
					type="button"
					aria-label="返回"
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					<ArrowLeft size={16} />
				</button>
				<div className="title-label">设置</div>
				<button
					className="title-btn"
					onClick={onOpenPlugins}
					type="button"
					aria-label="插件管理"
					title="插件管理"
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					<Plug size={15} />
				</button>
				<div className="title-window-controls" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
					<button
						className="title-btn"
						onClick={() => window.desktopAssistant?.minimizeWindow?.()}
						type="button"
						aria-label="最小化"
					>
						<Minus size={14} />
					</button>
					<button
						className="title-btn danger"
						onClick={() => window.desktopAssistant?.closeWindow?.()}
						type="button"
						aria-label="关闭"
					>
						<X size={14} />
					</button>
				</div>
			</div>

			<div className="settings-scroll">
				<section className="set-section">
					<h3>窗口</h3>
					<label className="set-row toggle-row">
						<span className="setting-label-with-icon">
							{windowAlwaysOnTop ? <Pin size={14} /> : <PinOff size={14} />}
							<span>窗口置顶</span>
						</span>
						<button
							type="button"
							className={`toggle ${windowAlwaysOnTop ? "on" : ""}`}
							onClick={() => onWindowAlwaysOnTopChange(!windowAlwaysOnTop)}
							aria-pressed={windowAlwaysOnTop}
						>
							<span className="toggle-thumb" />
						</button>
					</label>
				</section>
				{renderBrowserSection()}
				<section className="set-section">
					<h3>插件</h3>
					<div className="mcp-entry-row">
						<div>
							<strong>插件管理</strong>
							<p className="set-hint">安装、验证、测试和删除仅通过 API 控制的软件插件。</p>
						</div>
						<button type="button" className="primary-btn" onClick={onOpenPlugins}>
							<Plug size={14} />
							<span>插件管理</span>
						</button>
					</div>
				</section>
				<section className="set-section">
					<h3>个人 Skill 仓库</h3>
					<div className="mcp-entry-row">
						<div>
							<strong>个人定制 Skill</strong>
							<p className="set-hint">保存个人流程、交接文档和任务经验。AI 只能维护这里，不能维护系统自带 skill。</p>
						</div>
						<button type="button" className="primary-btn" onClick={onOpenPersonalSkills}>
							<BookOpen size={14} />
							<span>个人 Skill 仓库</span>
						</button>
					</div>
				</section>
				<section className="set-section">
					<h3>MCP</h3>
					<div className="mcp-entry-row">
						<div>
							<strong>{draftSettings.mcp.enabled ? "MCP 已启用" : "MCP 已关闭"}</strong>
							<p className="set-hint">
								管理 MCP 总开关、服务器、工具发现，以及内置 Desktop Assistant MCP 示例。
							</p>
						</div>
						<button type="button" className="primary-btn" onClick={onOpenMcp}>
							<ChevronRight size={14} />
							<span>MCP 管理</span>
						</button>
					</div>
					<label className="set-row toggle-row">
						<span>节省 Token</span>
						<button
							type="button"
							className={`toggle ${draftSettings.tokenSaving.enabled ? "on" : ""}`}
							onClick={() =>
								updateDraft({
									tokenSaving: {
										...draftSettings.tokenSaving,
										enabled: !draftSettings.tokenSaving.enabled,
									},
								})
							}
							aria-pressed={draftSettings.tokenSaving.enabled}
						>
							<span className="toggle-thumb" />
						</button>
					</label>
					<p className="set-hint">
						开启后只压缩发送给模型的浏览器 MCP 大结果、HTML、长链接列表和旧工具结果；聊天历史和工具详情仍保留原始内容。
					</p>
				</section>
				<section className="set-section">
					<h3>首页智能问候</h3>
					<label className="set-row toggle-row">
						<span>启用 AI 动态问候</span>
						<button
							type="button"
							className={`toggle ${draftSettings.homeWelcome.enabled ? "on" : ""}`}
							onClick={() =>
								updateDraft({
									homeWelcome: {
										...draftSettings.homeWelcome,
										enabled: !draftSettings.homeWelcome.enabled,
									},
								})
							}
							aria-pressed={draftSettings.homeWelcome.enabled}
						>
							<span className="toggle-thumb" />
						</button>
					</label>
					<p className="set-hint">
						开启后，首页问候由 DeepSeek Flash 根据日期/时段/节日和你的待办、自动化生成，启动时一次、运行中最多每
						30 分钟刷新一次（仅在内容变化时才真正调用模型，省 token）。关闭则显示固定问候。
					</p>
					<label className="set-row toggle-row">
						<span>结合天气</span>
						<button
							type="button"
							className={`toggle ${draftSettings.homeWelcome.includeWeather ? "on" : ""}`}
							onClick={() =>
								updateDraft({
									homeWelcome: {
										...draftSettings.homeWelcome,
										includeWeather: !draftSettings.homeWelcome.includeWeather,
									},
								})
							}
							aria-pressed={draftSettings.homeWelcome.includeWeather}
							disabled={!draftSettings.homeWelcome.enabled}
						>
							<span className="toggle-thumb" />
						</button>
					</label>
					{draftSettings.homeWelcome.enabled && (
						<>
							<label className="set-row">
								<span>WeatherAPI Key</span>
								<div className="input-with-btn">
									<input
										type="password"
										placeholder="请输入 WeatherAPI.com API Key"
										value={weatherApiKey}
										onChange={(e) => setWeatherApiKey(e.target.value)}
									/>
									<button type="button" className="ghost-btn" onClick={saveWeatherApiKey} title="保存">
										<Check size={14} />
									</button>
								</div>
							</label>
							{draftSettings.homeWelcome.weatherApiKey &&
								weatherApiKey === draftSettings.homeWelcome.weatherApiKey && (
									<div className="key-status-chip ok" style={{ margin: "0 4px 6px" }}>
										<Check size={12} />
										<span>已配置</span>
									</div>
								)}
							<p className="set-hint">
								在{" "}
								<a
									href="https://www.weatherapi.com/my/"
									target="_blank"
									rel="noreferrer"
									onClick={(e) => {
										e.preventDefault();
										window.open("https://www.weatherapi.com/my/");
									}}
								>
									weatherapi.com/my
								</a>{" "}
								获取免费 API Key（每月 100 万次免费调用）。填写后首页右上角会显示天气卡片；开启上面「结合天气」还会把天气写进问候语。未填写则两者都略过。
							</p>
						</>
					)}
					<label className="set-row toggle-row">
						<span>结合邮箱未读</span>
						<button
							type="button"
							className={`toggle ${draftSettings.homeWelcome.includeEmail ? "on" : ""}`}
							onClick={() =>
								updateDraft({
									homeWelcome: {
										...draftSettings.homeWelcome,
										includeEmail: !draftSettings.homeWelcome.includeEmail,
									},
								})
							}
							aria-pressed={draftSettings.homeWelcome.includeEmail}
							disabled={!draftSettings.homeWelcome.enabled}
						>
							<span className="toggle-thumb" />
						</button>
					</label>
					<p className="set-hint">
						天气通过 WeatherAPI.com 按 IP 位置获取（需配置 API Key）；邮箱仅在「邮箱管家」应用已在运行时读取未读概览，不会为此启动它。两者均为尽力而为，失败时自动略过。
					</p>
				</section>
				<section className="set-section">
					<h3>个性化</h3>
					<label className="set-row toggle-row">
						<span>启用个性化</span>
						<button
							type="button"
							className={`toggle ${draftSettings.personalization.enabled ? "on" : ""}`}
							onClick={() => updateDraftPersonalization({ enabled: !draftSettings.personalization.enabled })}
							aria-pressed={draftSettings.personalization.enabled}
						>
							<span className="toggle-thumb" />
						</button>
					</label>
					<p className="set-hint">
						开启后，下面的称呼、角色、语气与所在地会注入到对话与首页问候，让小派按你的设定回应。改动对新建的对话生效。
					</p>
					{draftSettings.personalization.enabled && (
						<>
							<label className="set-row">
								<span>对你的称呼</span>
								<input
									type="text"
									placeholder="例如：主人 / 老板 / 你的名字"
									value={draftSettings.personalization.userAddressing ?? ""}
									onChange={(e) =>
										updateDraftPersonalization({ userAddressing: e.target.value || undefined })
									}
								/>
							</label>

							<label className="set-row">
								<span>扮演角色</span>
								<input
									type="text"
									placeholder="例如：资深程序员 / 贴心助理 / 英语老师"
									value={draftSettings.personalization.rolePlay ?? ""}
									onChange={(e) => updateDraftPersonalization({ rolePlay: e.target.value || undefined })}
								/>
							</label>
							<div className="set-chip-row">
								{["资深程序员", "贴心助理", "英语老师", "猫娘", "知心朋友"].map((role) => (
									<button
										key={role}
										type="button"
										className="set-chip"
										onClick={() => updateDraftPersonalization({ rolePlay: role })}
									>
										{role}
									</button>
								))}
							</div>

							<label className="set-row">
								<span>语气</span>
								<input
									type="text"
									placeholder="例如：友好亲切 / 专业严谨"
									value={draftSettings.personalization.tone ?? ""}
									onChange={(e) => updateDraftPersonalization({ tone: e.target.value || undefined })}
								/>
							</label>
							<div className="set-chip-row">
								{["专业严谨", "友好亲切", "简洁高效", "幽默风趣", "温柔体贴"].map((tone) => (
									<button
										key={tone}
										type="button"
										className="set-chip"
										onClick={() => updateDraftPersonalization({ tone })}
									>
										{tone}
									</button>
								))}
							</div>

							<label className="set-row toggle-row">
								<span>所在地</span>
								<div className="seg-control">
									<button
										type="button"
										className={`seg-btn ${draftSettings.personalization.locationMode === "auto" ? "on" : ""}`}
										onClick={() => updateDraftPersonalization({ locationMode: "auto" })}
									>
										自动检测
									</button>
									<button
										type="button"
										className={`seg-btn ${draftSettings.personalization.locationMode === "manual" ? "on" : ""}`}
										onClick={() => updateDraftPersonalization({ locationMode: "manual" })}
									>
										手动设置
									</button>
								</div>
							</label>
							{draftSettings.personalization.locationMode === "manual" ? (
								<label className="set-row">
									<span>城市/地区</span>
									<input
										type="text"
										placeholder="例如：北京市 / 上海 浦东"
										value={draftSettings.personalization.manualLocation ?? ""}
										onChange={(e) =>
											updateDraftPersonalization({ manualLocation: e.target.value || undefined })
										}
									/>
								</label>
							) : (
								<p className="set-hint">
									将复用「首页智能问候」的 WeatherAPI 按 IP 自动定位（需在上方配置 WeatherAPI Key）。未配置时所在地会自动略过。
								</p>
							)}
						</>
					)}
				</section>
				<section className="set-section">
					<h3>实验性功能</h3>
					<label className="set-row toggle-row">
						<span>模型自动总结改进方案（出错自我总结）</span>
						<button
							type="button"
							className={`toggle ${draftSettings.experimental.errorSelfSummary.enabled ? "on" : ""}`}
							onClick={() =>
								updateDraft({
									experimental: {
										...draftSettings.experimental,
										errorSelfSummary: {
											...draftSettings.experimental.errorSelfSummary,
											enabled: !draftSettings.experimental.errorSelfSummary.enabled,
										},
									},
								})
							}
							aria-pressed={draftSettings.experimental.errorSelfSummary.enabled}
						>
							<span className="toggle-thumb" />
						</button>
					</label>
					<p className="set-hint">
						开启后，模型在某一轮调用工具遇到报错（工具失败，或工具成功但返回内容含报错）时，会在答完该轮后自动做一次「流程回顾自我总结」，并记成一条标题为「会话
						xxx 出错总结」的备忘录，方便后续交给 Claude/ChatGPT 分析修复。用户拒绝确认或主动中止造成的失败不会被总结。属实验功能，会略增 token 消耗。
					</p>
					<label className="set-row toggle-row">
						<span>实时流程化（边规划边执行的流程图浮窗）</span>
						<button
							type="button"
							className={`toggle ${draftSettings.experimental.liveFlow.enabled ? "on" : ""}`}
							onClick={() =>
								updateDraft({
									experimental: {
										...draftSettings.experimental,
										liveFlow: {
											...draftSettings.experimental.liveFlow,
											enabled: !draftSettings.experimental.liveFlow.enabled,
										},
									},
								})
							}
							aria-pressed={draftSettings.experimental.liveFlow.enabled}
						>
							<span className="toggle-thumb" />
						</button>
					</label>
					<p className="set-hint">
						开启后，普通会话里遇到多步骤、有明确执行步骤的任务时，模型会先设计一张流程图（显示在右下角可拖动、可折叠的浮窗里），再照着流程图逐步执行——每完成一步会自动把「下一步」回传给模型，避免跑偏；中途遇到问题会研究方案并修改流程图后继续。步骤不清晰时模型会先调研清楚再画。对新建/刷新的会话生效，会略增
						token 消耗。
					</p>
				</section>
				<section className="set-section">
					<h3>跨对话记忆（实验）</h3>
					<label className="set-row toggle-row">
						<span>启用跨对话记忆</span>
						<button
							type="button"
							className={`toggle ${draftSettings.memory.enabled ? "on" : ""}`}
							onClick={() => updateDraftMemory({ enabled: !draftSettings.memory.enabled })}
							aria-pressed={draftSettings.memory.enabled}
						>
							<span className="toggle-thumb" />
						</button>
					</label>
					<p className="set-hint">
						本地 JSONL 记忆，默认关闭。开启后会在新请求前检索相关记忆并注入模型；当前用户消息始终优先于旧记忆。
					</p>
					<label className="set-row">
						<span>每次最多注入</span>
						<input
							type="number"
							min={0}
							max={20}
							value={draftSettings.memory.maxInjected}
							onChange={(event) => updateDraftMemory({ maxInjected: Number(event.target.value) })}
						/>
					</label>
					<label className="set-row toggle-row">
						<span>自动提取记忆</span>
						<button
							type="button"
							className={`toggle ${draftSettings.memory.autoExtract ? "on" : ""}`}
							onClick={() => updateDraftMemory({ autoExtract: !draftSettings.memory.autoExtract })}
							aria-pressed={draftSettings.memory.autoExtract}
							disabled={!draftSettings.memory.enabled}
						>
							<span className="toggle-thumb" />
						</button>
					</label>
					<label className="set-row toggle-row">
						<span>允许从外部上下文提取</span>
						<button
							type="button"
							className={`toggle ${draftSettings.memory.allowExternalContextExtraction ? "on" : ""}`}
							onClick={() =>
								updateDraftMemory({
									allowExternalContextExtraction: !draftSettings.memory.allowExternalContextExtraction,
								})
							}
							aria-pressed={draftSettings.memory.allowExternalContextExtraction}
							disabled={!draftSettings.memory.enabled || !draftSettings.memory.autoExtract}
						>
							<span className="toggle-thumb" />
						</button>
					</label>
					<label className="set-row toggle-row">
						<span>允许保存 AI 推导事实</span>
						<button
							type="button"
							className={`toggle ${draftSettings.memory.allowAssistantDerivedFacts ? "on" : ""}`}
							onClick={() =>
								updateDraftMemory({
									allowAssistantDerivedFacts: !draftSettings.memory.allowAssistantDerivedFacts,
								})
							}
							aria-pressed={draftSettings.memory.allowAssistantDerivedFacts}
							disabled={!draftSettings.memory.enabled || !draftSettings.memory.autoExtract}
						>
							<span className="toggle-thumb" />
						</button>
					</label>
					<div className="history-controls">
						<div className="history-info">
							<span>已保存</span>
							<strong>{globalMemories.length}</strong>
							<small>条记忆</small>
						</div>
						<div className="cache-controls">
							<button type="button" className="ghost-btn wide" onClick={() => void loadGlobalMemories()} disabled={memoryBusy}>
								{memoryBusy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
								<span>刷新</span>
							</button>
							<button
								type="button"
								className="danger-btn"
								disabled={memoryBusy || globalMemories.length === 0}
								onClick={async () => {
									if (window.confirm("确定要清空所有跨对话记忆吗？")) {
										await clearGlobalMemories();
									}
								}}
							>
								<Trash2 size={13} />
								<span>清空</span>
							</button>
						</div>
					</div>
					<div className="memory-list">
						{globalMemories.slice(0, 8).map((memory) => (
							<div className="memory-list-item" key={memory.id}>
								<Brain size={14} />
								<div>
									<strong>{memory.kind}</strong>
									<span>{memory.text}</span>
									<small>
										{memory.scope} / {memory.source} / {memory.confidence.toFixed(2)}
									</small>
								</div>
								<button
									type="button"
									className="ghost-btn"
									onClick={() => void deleteGlobalMemory(memory.id)}
									disabled={memoryBusy}
									aria-label="删除记忆"
								>
									<X size={13} />
								</button>
							</div>
						))}
						{globalMemories.length === 0 ? <p className="set-hint">暂无跨对话记忆。</p> : null}
					</div>
					{memoryStatus ? <div className="skill-editor-status">{memoryStatus}</div> : null}
				</section>
				<section className="set-section">
					<h3>应用启动记忆</h3>
					<div className="history-controls">
						<div className="history-info">
							<span>已学习</span>
							<strong>{appCacheAliasCount ?? "?"}</strong>
							<small>个应用别名</small>
						</div>
						<div className="cache-controls">
							<button type="button" className="ghost-btn wide" onClick={openAppCache} disabled={appCacheBusy}>
								{appCacheBusy ? <Loader2 size={14} className="spin" /> : <Eye size={14} />}
								<span>浏览记忆</span>
							</button>
							<button
								type="button"
								className="danger-btn"
								disabled={appCacheBusy}
								onClick={async () => {
									if (window.confirm("确定要清空 app-launch-cache 记忆吗？之后 AI 会重新学习应用路径。")) {
										await clearAppCache();
									}
								}}
							>
								<Trash2 size={13} />
								<span>清空记忆</span>
							</button>
						</div>
					</div>
					<p className="set-hint">用于记住 QQ、微信等应用的真实启动路径，避免新对话重复 open_app 失败再 find_app。</p>
					{appCacheStatus ? <div className="skill-editor-status">{appCacheStatus}</div> : null}
				</section>
				<section className="set-section">
					<h3>模型</h3>
					<label className="set-row">
						<span>模型提供商</span>
						<select
							value={provider}
							onChange={(event) => {
								const nextProvider = event.target.value;
								const providerConfig = PROVIDERS.find((item) => item.id === nextProvider);
								updateDraft({
									provider: nextProvider as DesktopAssistantSettings["provider"],
									modelId: providerConfig?.models[0]?.id ?? draftSettings.modelId,
								});
							}}
						>
							{PROVIDERS.map((item) => (
								<option key={item.id} value={item.id}>
									{item.label}
								</option>
							))}
						</select>
					</label>

					{provider === "deepseek" ? (
						<>
							<div className="set-row">
								<span>API 连接方式</span>
								<div className="segmented-control" role="group" aria-label="API 连接方式">
									<button
										type="button"
										className={apiConnectionMode === "official" ? "active" : ""}
										onClick={() => void switchApiConnectionMode("official")}
										disabled={settingsApplying}
									>
										官方API
									</button>
									<button
										type="button"
										className={apiConnectionMode === "relay" ? "active" : ""}
										onClick={() => void switchApiConnectionMode("relay")}
										disabled={settingsApplying}
									>
										中转站
									</button>
								</div>
							</div>
							{apiConnectionMode === "relay" ? (
								<>
									<label className="set-row">
										<span>中转站 URL</span>
										<input
											type="text"
											placeholder={DEFAULT_DEEPSEEK_RELAY_URL}
											value={draftSettings.apiBaseUrl ?? DEFAULT_DEEPSEEK_RELAY_URL}
											onChange={(event) =>
												updateDraft({ apiBaseUrl: event.target.value, deepseekRelayModels: undefined })
											}
										/>
									</label>
									<p className="set-hint">
										保存中转站 API Key 后会自动探测 /v1/models，并把该 Key 授权的模型放入下方模型列表。
									</p>
								</>
							) : null}
						</>
					) : null}

					{isCustom ? (
						<>
							<label className="set-row">
								<span>API Base URL</span>
								<input
									type="text"
									placeholder="https://api.example.com/v1"
									value={draftSettings.apiBaseUrl ?? ""}
									onChange={(event) => updateDraft({ apiBaseUrl: event.target.value })}
								/>
							</label>
							<label className="set-row">
								<span>模型 ID</span>
								<input
									type="text"
									placeholder="gpt-4o / llama3-70b / ..."
									value={draftSettings.modelId}
									onChange={(event) => updateDraft({ modelId: event.target.value })}
								/>
							</label>
						</>
					) : (
						<label className="set-row">
							<span>模型</span>
							<select
								value={draftSettings.modelId}
								disabled={provider === "deepseek" && apiConnectionMode === "relay" && relayModelOptions.length === 0}
								onChange={(event) => updateDraft({ modelId: event.target.value })}
							>
								{displayedModels.map((model) => (
									<option key={model.id} value={model.id}>
										{model.label}
									</option>
								))}
							</select>
						</label>
					)}
					{provider === "deepseek" && apiConnectionMode === "relay" && relayModelOptions.length === 0 ? (
						<p className="set-hint">当前还没有探测到中转站授权模型；请先填写 URL 和 API Key 并保存验证。</p>
					) : null}

					<label className="set-row">
						<span>新会话默认思考强度</span>
						<select
							value={draftSettings.thinkingLevel}
							onChange={(event) =>
								updateDraft({
									thinkingLevel: event.target.value as DesktopAssistantSettings["thinkingLevel"],
								})
							}
						>
							<option value="off">关闭</option>
							<option value="minimal">极简</option>
							<option value="low">低</option>
							<option value="medium">中</option>
							<option value="high">高</option>
							<option value="xhigh">极高</option>
						</select>
					</label>
					<p className="set-hint">聊天页里的深度思考开关只影响当前会话；这里决定之后新会话的默认值。</p>
				</section>

				<section className="set-section">
					<h3>{apiKeyLabel}</h3>
					<div className="set-key-block">
						<div className={`key-status-chip ${snapshot.authStatus.configured ? "ok" : "warn"}`}>
							{snapshot.authStatus.configured ? <Check size={12} /> : <KeyRound size={12} />}
							<span>{snapshot.authStatus.configured ? `${apiKeyLabel} 已配置` : `${apiKeyLabel} 未配置`}</span>
						</div>
						<div className="key-input-row">
							<input
								type={showKey ? "text" : "password"}
								placeholder={snapshot.authStatus.configured ? `输入新的${apiKeyLabel}以替换` : `请输入 ${apiKeyLabel}`}
								value={apiKey}
								onChange={(event) => setApiKey(event.target.value)}
							/>
							<button
								type="button"
								className="ghost-btn"
								onClick={() => setShowKey((value) => !value)}
								aria-label={showKey ? "隐藏" : "显示"}
							>
								{showKey ? <EyeOff size={14} /> : <Eye size={14} />}
							</button>
							<button
								type="button"
								className="primary-btn"
								disabled={saving || settingsApplying || !apiKey.trim()}
								onClick={async () => {
									setSaving(true);
									try {
										if (hasDraftChanges) {
											const nextSnapshot = await applyDraft();
											if (!nextSnapshot) return;
										}
										const nextSnapshot = await onSaveApiKey(apiKey.trim());
										if (nextSnapshot) {
											setDraftSettings(cloneSettings(nextSnapshot.settings));
											setBaselineSettingsKey(settingsKey(nextSnapshot.settings));
										}
										setApiKey("");
									} finally {
										setSaving(false);
									}
								}}
							>
								{saving || snapshot.apiKeyStatus.state === "validating" ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
								<span>保存并验证</span>
							</button>
						</div>
						{statusText ? <div className={`set-key-status ${snapshot.apiKeyStatus.state}`}>{statusText}</div> : null}
						<p className="set-hint">
							官方 API Key 和中转站 API Key 会分开保存；切换连接方式并应用后会立即使用对应 Key。当前对话里已经暴露过 Key，建议轮换后再保存。
						</p>
					</div>
				</section>

				<section className="set-section">
					<h3>工具集</h3>
					<div className="mcp-entry-row">
						<div>
							<strong>
								{enabledCapabilityCount}/{capabilityIds.length} 组能力已启用
							</strong>
							<p className="set-hint">
								按能力分组管理 AI 可调用的内置工具（系统操作、文档、Excel、PPT）。可逐项开关、查看每个工具的用途，并编辑对应的 skill。
							</p>
						</div>
						<button type="button" className="primary-btn" onClick={onOpenToolset}>
							<Wrench size={14} />
							<span>工具集</span>
						</button>
					</div>
				</section>

				<section className="set-section">
					<h3>系统操作权限</h3>
					<label className="set-row">
						<span>权限模式</span>
						<select
							value={draftSettings.permissionMode}
							onChange={(event) =>
								updateDraft({
									permissionMode: event.target.value as DesktopAssistantSettings["permissionMode"],
								})
							}
						>
							<option value="full_access">完全控制</option>
							<option value="automatic">替我审批</option>
							<option value="tiered">请求批准</option>
							<option value="sandbox">仅沙盒</option>
						</select>
					</label>
					<p className="set-hint">
						沙箱内的安全操作始终免审批；下列模式只决定「跨到真实系统」的动作如何处理：完全控制=模型优先用沙箱、必须用真实系统时自动放行；替我审批=模型裁决，拿不准的升级给你；请求批准=所有真实系统动作都要你批准；仅沙盒=禁止一切真实系统动作。
					</p>
				</section>

				<section className="set-section">
					<h3>沙箱</h3>
					<p className="set-hint">
						沙箱把文档处理、临时文件、试探性命令等中间工作隔离在工作区内完成，只把最终成果交付真实系统。完整配置（开关 / 预设 / 根目录 / 命令 / 网络 / 资源上限 / 状态）在独立窗口里。
					</p>
					<label className="set-row">
						<span>沙箱设置</span>
						<button
							type="button"
							className="ghost-btn wide"
							onClick={() => window.desktopAssistant.openSandboxSettingsWindow()}
						>
							打开沙箱设置…
						</button>
					</label>
					{snapshot.sandboxStatus ? (
						<p className="set-hint">
							当前{snapshot.settings.sandbox.enabled ? "已启用" : "已关闭"} · 用量 {snapshot.sandboxStatus.usageMb}MB /{" "}
							{snapshot.sandboxStatus.quotaMb}MB
						</p>
					) : null}
				</section>

				<section className="set-section">
					<h3>语音</h3>
					<label className="set-row toggle-row">
						<span>启用语音输入</span>
						<button
							type="button"
							className={`toggle ${draftSettings.voice.enabled ? "on" : ""}`}
							onClick={() => updateDraftVoice({ enabled: !draftSettings.voice.enabled })}
							aria-pressed={draftSettings.voice.enabled}
						>
							<span className="toggle-thumb" />
						</button>
					</label>
					<label className="set-row toggle-row">
						<span>常驻监听唤醒词</span>
						<button
							type="button"
							className={`toggle ${draftSettings.voice.wakeWordEnabled ? "on" : ""}`}
							onClick={() => updateDraftVoice({ wakeWordEnabled: !draftSettings.voice.wakeWordEnabled })}
							aria-pressed={draftSettings.voice.wakeWordEnabled}
						>
							<span className="toggle-thumb" />
						</button>
					</label>
					<label className="set-row">
						<span>唤醒词</span>
						<input
							type="text"
							value={draftSettings.voice.wakeWord}
							readOnly={(draftSettings.voice.wakeEngine ?? "kws") === "openwakeword"}
							title={(draftSettings.voice.wakeEngine ?? "kws") === "openwakeword" ? "openWakeWord 模式下唤醒词来自模型文件名" : undefined}
							onChange={(event) => updateDraftVoice({ wakeWord: event.target.value })}
						/>
					</label>
					<div className="set-row">
						<span>唤醒方案</span>
						<div className="segmented-control" role="group" aria-label="唤醒方案">
							<button
								type="button"
								className={
									(draftSettings.voice.wakeEngine ?? "kws") === "kws" ||
									(draftSettings.voice.wakeEngine ?? "kws") === "auto"
										? "active"
										: ""
								}
								onClick={() => void switchWakeEngine("kws")}
							>
								本地唤醒
							</button>
							<button
								type="button"
								className={(draftSettings.voice.wakeEngine ?? "kws") === "openwakeword" ? "active" : ""}
								onClick={() => void switchWakeEngine("openwakeword")}
								disabled={wakeModelBusy}
							>
								openWakeWord
							</button>
							<button
								type="button"
								className={(draftSettings.voice.wakeEngine ?? "kws") === "vosk" ? "active" : ""}
								onClick={() => void switchWakeEngine("vosk")}
							>
								兜底识别
							</button>
						</div>
					</div>
					{(draftSettings.voice.wakeEngine ?? "kws") === "kws" ||
					(draftSettings.voice.wakeEngine ?? "kws") === "auto" ? (
						<>
							<label className="set-row">
								<span>唤醒灵敏度</span>
								<input
									type="number"
									min={0}
									max={1}
									step={0.05}
									value={draftSettings.voice.kwsSensitivity ?? 0.6}
									onChange={(event) =>
										updateDraftVoice({
											kwsSensitivity: Math.max(0, Math.min(1, Number(event.target.value || 0.6))),
										})
									}
								/>
							</label>
							<p className="set-hint" style={{ margin: "0 4px 10px" }}>
								本地关键词唤醒（sherpa-onnx，离线）。可在上方「唤醒词」填任意中文词，自动转拼音匹配（默认「小派」）；
								数值越高越容易唤醒。首次使用需运行<code> npm run fetch:kws </code>下载模型。
							</p>
						</>
					) : null}
					<label className="set-row">
						<span>语音语言</span>
						<select
							value={draftSettings.voice.language}
							onChange={(event) => updateDraftVoice({ language: event.target.value })}
						>
							<option value="zh-CN">中文（普通话）</option>
							<option value="en-US">English (US)</option>
							<option value="ja-JP">日本語</option>
						</select>
					</label>
					<label className="set-row">
						<span>唤醒后等待</span>
						<input
							type="number"
							min={1}
							max={30}
							value={Math.round(draftSettings.voice.postWakeWaitMs / 1000)}
							onChange={(event) =>
								updateDraftVoice({
									postWakeWaitMs: Math.max(1, Number(event.target.value || 5)) * 1000,
								})
							}
						/>
					</label>
					<label className="set-row">
						<span>停顿结束</span>
						<input
							type="number"
							min={0.3}
							max={5}
							step={0.1}
							value={draftSettings.voice.endSilenceMs / 1000}
							onChange={(event) =>
								updateDraftVoice({
									endSilenceMs: Math.max(0.3, Number(event.target.value || 1)) * 1000,
								})
							}
						/>
					</label>
					<label className="set-row">
						<span>模糊阈值</span>
						<input
							type="number"
							min={0.1}
							max={1}
							step={0.05}
							disabled={(draftSettings.voice.wakeEngine ?? "kws") === "openwakeword"}
							value={draftSettings.voice.fuzzyThreshold}
							onChange={(event) =>
								updateDraftVoice({
									fuzzyThreshold: Math.max(0.1, Math.min(1, Number(event.target.value || 0.6))),
								})
							}
						/>
					</label>
					<div className="subsection-divider">openWakeWord</div>
					<div className="wake-model-panel">
						<div className="wake-model-summary">
							<div>
								<strong>{activeWakeModel ? activeWakeModel.label : "未选择模型"}</strong>
								<small>
									{activeWakeModel
										? `${resolveWakeWordModelWakeWord(activeWakeModel)} · ${formatBytes(activeWakeModel.sizeBytes)}`
										: "导入 .onnx 后可切换到 openWakeWord"}
								</small>
							</div>
							<button
								type="button"
								className="primary-btn"
								onClick={() => void importWakeModel("openwakeword")}
								disabled={wakeModelBusy}
							>
								{wakeModelBusy ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
								<span>导入模型</span>
							</button>
						</div>
						{wakeModels.length ? (
							<div className="wake-model-list">
								{wakeModels.map((model) => {
									const active = model.id === draftSettings.voice.activeOwwModelId;
									return (
										<div className={`wake-model-item ${active ? "active" : ""}`} key={model.id}>
											<button type="button" onClick={() => void switchWakeModel(model)} disabled={wakeModelBusy}>
												<strong>{model.label}</strong>
												<small>
													{formatBytes(model.sizeBytes)} · {formatImportedAt(model.importedAt)}
												</small>
											</button>
											<button
												type="button"
												className="wake-model-delete"
												aria-label={`删除 ${model.label}`}
												title="删除模型"
												onClick={() => void deleteWakeModel(model.id)}
												disabled={wakeModelBusy}
											>
												<Trash2 size={13} />
											</button>
										</div>
									);
								})}
							</div>
						) : (
							<p className="set-hint">尚未导入 openWakeWord 模型。选择 openWakeWord 时会打开文件选择器。</p>
						)}
						<label className="set-row wake-threshold-row">
							<span>激活阈值</span>
							<input
								type="number"
								min={0.05}
								max={1}
								step={0.05}
								value={draftSettings.voice.owwThreshold ?? 0.5}
								onChange={(event) =>
									updateDraftVoice({
										owwThreshold: Math.max(0.05, Math.min(1, Number(event.target.value || 0.5))),
									})
								}
							/>
						</label>
						{wakeModelStatus ? <div className="skill-editor-status">{wakeModelStatus}</div> : null}
					</div>
					<div className="subsection-divider">语音识别</div>
					<label className="set-row">
						<span>STT Provider</span>
						<select
							value={draftSettings.voice.sttProvider}
							onChange={(event) =>
								updateDraftVoice({
									sttProvider: event.target.value as DesktopAssistantSettings["voice"]["sttProvider"],
								})
							}
						>
							{Object.entries(VOICE_PROVIDER_LABEL).map(([value, label]) => (
								<option key={value} value={value}>
									{label}
								</option>
							))}
						</select>
					</label>
					<label className="set-row">
						<span>STT Base URL</span>
						<input
							type="text"
							placeholder={
								DEFAULT_VOICE_STT_BASE_URL_BY_PROVIDER[draftSettings.voice.sttProvider] ||
								"https://example.test/v1"
							}
							value={draftSettings.voice.sttBaseUrl ?? ""}
							onChange={(event) =>
								updateDraftVoice({ sttBaseUrl: event.target.value || undefined })
							}
						/>
					</label>
					<label className="set-row">
						<span>STT Model</span>
						<input
							type="text"
							value={draftSettings.voice.sttModel}
							onChange={(event) => updateDraftVoice({ sttModel: event.target.value })}
						/>
					</label>
					<p className="set-hint" style={{ margin: "0 4px 10px" }}>
						{VOICE_STT_MODEL_HINT}
					</p>
					<div className="set-key-block voice-key-block">
						<div className={`key-status-chip ${snapshot.voiceAuthStatus.configured ? "ok" : "warn"}`}>
							{snapshot.voiceAuthStatus.configured ? <Check size={12} /> : <KeyRound size={12} />}
							<span>{snapshot.voiceAuthStatus.configured ? "语音 Key 已配置" : "语音 Key 未配置"}</span>
						</div>
						<div className="key-input-row">
							<input
								type={showVoiceKey ? "text" : "password"}
								placeholder="STT API Key"
								value={voiceApiKey}
								onChange={(event) => setVoiceApiKey(event.target.value)}
							/>
							<button
								type="button"
								className="ghost-btn"
								onClick={() => setShowVoiceKey((value) => !value)}
								aria-label={showVoiceKey ? "隐藏" : "显示"}
							>
								{showVoiceKey ? <EyeOff size={14} /> : <Eye size={14} />}
							</button>
							<button
								type="button"
								className="primary-btn"
								disabled={savingVoiceKey || !voiceApiKey.trim()}
								onClick={async () => {
									setSavingVoiceKey(true);
									try {
										await onSaveVoiceApiKey(voiceApiKey.trim());
										setVoiceApiKey("");
									} finally {
										setSavingVoiceKey(false);
									}
								}}
							>
								{savingVoiceKey ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
								<span>保存语音 Key</span>
							</button>
						</div>
					</div>
					<label className="set-row toggle-row">
						<span>启用语音播报</span>
						<button
							type="button"
							className={`toggle ${draftSettings.ttsEnabled ? "on" : ""}`}
							onClick={() => updateDraft({ ttsEnabled: !draftSettings.ttsEnabled })}
							aria-pressed={draftSettings.ttsEnabled}
						>
							<span className="toggle-thumb" />
						</button>
					</label>
				</section>

				<section className="set-section">
					<h3>联网搜索</h3>

					{/* ── Mode ── */}
					<label className="set-row">
						<span>搜索模式</span>
						<select
							value={ws.mode}
							onChange={(e) =>
								updateDraft({ webSearch: { ...ws, mode: e.target.value as "off" | "auto" | "on" } })
							}
						>
							<option value="off">关闭</option>
							<option value="auto">自动（推荐）</option>
							<option value="on">始终开启</option>
						</select>
					</label>
					<p className="set-hint" style={{ margin: "0 4px 10px" }}>
						<strong>关闭</strong>：禁用联网。
						<strong>自动</strong>：AI 按需判断是否搜索。
						<strong>始终开启</strong>：每次对话优先搜索。
					</p>

					{ws.mode !== "off" && (
						<>
							{/* ── Provider ── */}
							<label className="set-row">
								<span>搜索引擎</span>
								<select
									value={ws.provider ?? "duckduckgo"}
									onChange={(e) =>
										updateDraft({ webSearch: { ...ws, provider: e.target.value as WebSearchProvider } })
									}
								>
									<option value="tavily">Tavily（推荐·1000次/月免费）</option>
									<option value="brave">Brave Search（2000次/月免费）</option>
									<option value="duckduckgo">DuckDuckGo（免费·无需 Key）</option>
									<option value="bing">Bing（Azure，1000次/月免费）</option>
									<option value="google">Google（每日100次免费）</option>
									<option value="serper">Serper.dev（2500次免费额度）</option>
									<option value="searxng">SearXNG（自托管）</option>
								</select>
							</label>

							{/* ── Provider-specific fields ── */}

							{(ws.provider === "tavily" || ws.provider === "brave" || ws.provider === "bing" || ws.provider === "serper" || ws.provider === "google") && (
								<div className="ws-provider-fields">
									<label className="set-row">
										<span>
											{ws.provider === "tavily"
												? "Tavily API Key"
												: ws.provider === "brave"
												? "Brave API Key"
												: ws.provider === "bing"
												? "Bing API Key"
												: ws.provider === "serper"
												? "Serper API Key"
												: "Google API Key"}
										</span>
										<div className="key-input-row" style={{ flex: 1, minWidth: 0 }}>
											<input
												type="password"
												placeholder={
													ws.provider === "tavily"
														? "tvly-xxxxxxxxxxxxxxxxxxxx"
														: ws.provider === "brave"
														? "BSA-xxxxxxxxxxxxxxxxxxxxxxxx"
														: ws.provider === "bing"
														? "Ocp-Apim-Subscription-Key"
														: ws.provider === "serper"
														? "serper.dev API Key"
														: "Google Cloud API Key"
												}
												value={wsApiKey}
												onChange={(e) => setWsApiKey(e.target.value)}
											/>
											<button
												type="button"
												className="ghost-btn"
												onClick={saveWsFields}
												title="保存"
											>
												<Check size={14} />
											</button>
										</div>
									</label>
									{ws.apiKey && wsApiKey === ws.apiKey && (
										<div className="key-status-chip ok" style={{ margin: "0 4px 6px" }}>
											<Check size={12} />
											<span>已配置</span>
										</div>
									)}
								</div>
							)}

							{ws.provider === "google" && (
								<div className="ws-provider-fields">
									<label className="set-row">
										<span>搜索引擎 ID（cx）</span>
										<div className="key-input-row" style={{ flex: 1, minWidth: 0 }}>
											<input
												type="text"
												placeholder="cx: 017576662512468239146:omuauf_lfve"
												value={wsGoogleCx}
												onChange={(e) => setWsGoogleCx(e.target.value)}
											/>
											<button type="button" className="ghost-btn" onClick={saveWsFields} title="保存">
												<Check size={14} />
											</button>
										</div>
									</label>
								</div>
							)}

							{ws.provider === "searxng" && (
								<div className="ws-provider-fields">
									<label className="set-row">
										<span>实例 URL</span>
										<div className="key-input-row" style={{ flex: 1, minWidth: 0 }}>
											<input
												type="text"
												placeholder="https://searx.example.com"
												value={wsSearxngUrl}
												onChange={(e) => setWsSearxngUrl(e.target.value)}
											/>
											<button type="button" className="ghost-btn" onClick={saveWsFields} title="保存">
												<Check size={14} />
											</button>
										</div>
									</label>
								</div>
							)}

							{/* ── Provider hints ── */}
							<div className="ws-hint-block">
								{ws.provider === "tavily" && (
									<p className="set-hint">
										专为 AI Agent 设计，返回内容已提炼，无需额外抓取页面。在{" "}
										<a href="https://app.tavily.com" target="_blank" rel="noopener noreferrer" className="set-link">
											app.tavily.com
										</a>{" "}
										注册，免费每月 1000 次。推荐首选。
									</p>
								)}
								{ws.provider === "brave" && (
									<p className="set-hint">
										独立搜索索引，不依赖 Google/Bing，结果质量高。在{" "}
										<a href="https://brave.com/search/api/" target="_blank" rel="noopener noreferrer" className="set-link">
											brave.com/search/api
										</a>{" "}
										注册，免费每月 2000 次。
									</p>
								)}
								{ws.provider === "duckduckgo" && (
									<p className="set-hint">
										免费使用，无需注册。返回即时答案和相关词条，适合事实查询。如需完整网页搜索结果，请切换到其他引擎。
									</p>
								)}
								{ws.provider === "bing" && (
									<p className="set-hint">
										在{" "}
										<a href="https://portal.azure.com/" target="_blank" rel="noopener noreferrer" className="set-link">
											Azure 控制台
										</a>{" "}
										创建「Bing Search v7」资源，免费层每月 1000 次查询。Key 类型：Ocp-Apim-Subscription-Key。
									</p>
								)}
								{ws.provider === "google" && (
									<p className="set-hint">
										需要两样东西：①{" "}
										<a href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer" className="set-link">
											Cloud Console
										</a>{" "}
										创建 Custom Search JSON API 并获取 API Key；②在{" "}
										<a href="https://programmablesearchengine.google.com/" target="_blank" rel="noopener noreferrer" className="set-link">
											Programmable Search Engine
										</a>{" "}
										创建搜索引擎并复制 cx 值。每日免费 100 次。
									</p>
								)}
								{ws.provider === "serper" && (
									<p className="set-hint">
										在{" "}
										<a href="https://serper.dev/" target="_blank" rel="noopener noreferrer" className="set-link">
											serper.dev
										</a>{" "}
										注册并获取 API Key。新用户免费 2500 次，返回 Google 搜索结果，速度快质量高。
									</p>
								)}
								{ws.provider === "searxng" && (
									<p className="set-hint">
										填入你自建的 SearXNG 实例地址（需开启 JSON API）。公共实例列表：{" "}
										<a href="https://searx.space/" target="_blank" rel="noopener noreferrer" className="set-link">
											searx.space
										</a>
										。注意：公共实例可能有访问限制。
									</p>
								)}
							</div>
						</>
					)}
				</section>

				<section className="set-section">
					<h3>历史对话</h3>
					<div className="history-controls">
						<div className="history-info">
							<span>本机已保存</span>
							<strong>{historyCount}</strong>
							<small>条对话记录</small>
						</div>
						<button
							type="button"
							className="danger-btn"
							disabled={historyCount === 0}
							onClick={() => {
								if (historyCount === 0) return;
								if (window.confirm(`确定要清空全部 ${historyCount} 条历史对话吗？此操作无法撤销。`)) {
									onClearHistory();
								}
							}}
						>
							<Trash2 size={13} />
							<span>清空全部</span>
						</button>
					</div>
					<p className="set-hint">历史对话仅保存在本机浏览器存储中，清空后无法恢复。</p>
				</section>

				<section className="set-section">
					<h3>开发者工具</h3>
					<div className="history-controls">
						<div className="history-info">
							<span>后端服务响应日志</span>
						</div>
						<button
							type="button"
							className="ghost-btn wide"
							onClick={() => window.desktopAssistant?.openLogWindow?.()}
						>
							<Eye size={14} />
							<span>打开日志窗口</span>
						</button>
					</div>
					<p className="set-hint">实时显示所有后端事件：用户输入、工具调用、AI 响应、重试、错误等。</p>
				</section>

				<section className="set-section">
					<h3>关于</h3>
					<div className="about-row">
						<span>Pi 桌面助手</span>
						<small>v0.1.0 · Windows 系统操作能力</small>
					</div>
				</section>
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
		</div>
	);
}

function NativeBrowserRow({
	icon,
	label,
	status,
}: {
	icon: React.ReactNode;
	label: string;
	status?: BrowserNativeStatus["chrome"];
}) {
	return (
		<div className="browser-native-row">
			<span className="setting-label-with-icon">
				{icon}
				<strong>{label}</strong>
			</span>
			<small className={status?.available ? "ok" : "missing"}>
				{status?.available ? (status.aiProfileRunning ? "AI profile 已启动" : "已找到") : "未找到"}
			</small>
		</div>
	);
}

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
