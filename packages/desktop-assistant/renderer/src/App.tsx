import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	DEFAULT_API_KEY_STATUS,
	DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
	type ChatMessageView,
	DesktopAssistantSettings,
	DesktopAssistantSnapshot,
	PendingPromptAttachment,
	PetDebugSnapshot,
	type TimelineItem,
	WakeWordModelMetadata,
	type WindowMode,
} from "../../src/shared/types.ts";
import type { AppWarning, Route, StoredConversation } from "./app-types.ts";
import {
	loadStoredSettings,
	loadWindowAlwaysOnTop,
	loadWindowMode,
	persistSettings,
	persistWindowAlwaysOnTop,
	persistWindowMode,
} from "./app-storage.ts";
import { ChatView } from "./chat/ChatView.tsx";
import { Drawer } from "./components/Drawer.tsx";
import { SandboxInitModal } from "./components/SandboxInitModal.tsx";
import { StartupSplash, type StartupPhase } from "./components/StartupSplash.tsx";
import { WarningToasts } from "./components/WarningToasts.tsx";
import { mergeHistoryItems, toStoredConversation } from "./conversation-history.ts";
import type { PetEngine } from "./pet/engine/PetEngine.ts";
import { isCatCommand, runCatCommand } from "./pet/pet-commands.ts";
import { loadPetConfig, persistPetConfig } from "./pet/pet-storage.ts";
import type { PetConfig } from "./pet/types.ts";
import type { VoiceController } from "./voice/voice-controller.ts";
import { voiceToneOf } from "./voice-ui.ts";
import "./styles.css";

const WINDOW_MODE = new URLSearchParams(window.location.search).get("window");
const loadHomeView = () => import("./home/HomeView.tsx").then((module) => ({ default: module.HomeView }));
const loadMemoView = () => import("./memo/MemoView.tsx").then((module) => ({ default: module.MemoView }));
const loadSettingsView = () =>
	import("./settings/SettingsView.tsx").then((module) => ({ default: module.SettingsView }));
const loadMcpManagerView = () => import("./mcp/McpManagerView.tsx").then((module) => ({ default: module.McpManagerView }));
const loadToolsetManagerView = () =>
	import("./toolset/ToolsetManagerView.tsx").then((module) => ({ default: module.ToolsetManagerView }));
const loadPluginManagerView = () =>
	import("./plugins/PluginManagerView.tsx").then((module) => ({ default: module.PluginManagerView }));
const loadPersonalSkillManagerView = () =>
	import("./personal-skills/PersonalSkillManagerView.tsx").then((module) => ({
		default: module.PersonalSkillManagerView,
	}));
const loadSandboxSettingsView = () =>
	import("./settings/SandboxSettingsView.tsx").then((module) => ({ default: module.SandboxSettingsView }));
const HomeView = lazy(loadHomeView);
const MemoView = lazy(loadMemoView);
const SettingsView = lazy(loadSettingsView);
const McpManagerView = lazy(loadMcpManagerView);
const ToolsetManagerView = lazy(loadToolsetManagerView);
const PluginManagerView = lazy(loadPluginManagerView);
const PersonalSkillManagerView = lazy(loadPersonalSkillManagerView);
const SandboxSettingsView = lazy(loadSandboxSettingsView);

type LiveSnapshotUpdate =
	| DesktopAssistantSnapshot
	| undefined
	| ((current: DesktopAssistantSnapshot | undefined) => DesktopAssistantSnapshot | undefined);

type IdleWindow = Window & {
	requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
	cancelIdleCallback?: (handle: number) => void;
};

type WindowTransitionPhase = "idle" | "blur-in" | "resizing" | "blur-out";

const WINDOW_BLUR_MS = 120;
const WINDOW_RESIZE_MS = 460;
/** Idle delay before a voice conversation clears itself off the home page. */
const HOME_IDLE_CLEAR_MS = 5000;

function App() {
	const [liveSnapshot, setLiveSnapshotState] = useState<DesktopAssistantSnapshot | undefined>();
	const [prompt, setPrompt] = useState("");
	const [attachments, setAttachments] = useState<PendingPromptAttachment[]>([]);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [windowMode, setWindowMode] = useState<WindowMode>(() => loadWindowMode());
	const [windowAlwaysOnTop, setWindowAlwaysOnTop] = useState(() => loadWindowAlwaysOnTop());
	const [windowTransitionPhase, setWindowTransitionPhase] = useState<WindowTransitionPhase>("idle");
	const [dockOpen, setDockOpen] = useState(false);
	const [route, setRoute] = useState<Route>("home");
	// Overlay pages mount on first visit and stay mounted so their slide-out animates.
	const [mountedRoutes, setMountedRoutes] = useState<Record<string, boolean>>({ home: true });
	const [conversations, setConversations] = useState<StoredConversation[]>([]);
	const [resumedConversationSessionId, setResumedConversationSessionId] = useState<string | undefined>();
	const [loadingConversationSessionId, setLoadingConversationSessionId] = useState<string | undefined>();
	const [loadingEarlierHistory, setLoadingEarlierHistory] = useState(false);
	const [warnings, setWarnings] = useState<AppWarning[]>([]);
	const [wakeModels, setWakeModels] = useState<WakeWordModelMetadata[]>([]);
	const [petConfig, setPetConfig] = useState<PetConfig>(() => loadPetConfig());
	const [startupPhase, setStartupPhase] = useState<StartupPhase>("shell");
	const [sandboxModalDismissed, setSandboxModalDismissed] = useState(false);
	const [sandboxModalBusy, setSandboxModalBusy] = useState(false);
	const petEngineRef = useRef<PetEngine | null>(null);
	const routeRef = useRef<Route>(route);
	routeRef.current = route;
	const settingsAppliedRef = useRef(false);
	const backgroundStartedRef = useRef(false);
	const appliedStartupModeRef = useRef(false);
	const liveSnapshotRef = useRef<DesktopAssistantSnapshot | undefined>(undefined);
	const voiceControllerRef = useRef<VoiceController | undefined>(undefined);
	const voiceDraftTextRef = useRef("");
	const voiceDisplayedTextRef = useRef("");
	const voiceTranscriptTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const windowTransitionTimersRef = useRef<number[]>([]);
	const warningTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
	const isMcpWindow = WINDOW_MODE === "mcp";
	const isToolsetWindow = WINDOW_MODE === "toolset";
	const isPluginWindow = WINDOW_MODE === "plugins";
	const isPersonalSkillWindow = WINDOW_MODE === "personal-skills";
	const isSandboxWindow = WINDOW_MODE === "sandbox";
	const isUtilityWindow = isMcpWindow || isToolsetWindow || isPluginWindow || isPersonalSkillWindow || isSandboxWindow;
	const viewingHistory = resumedConversationSessionId !== undefined && resumedConversationSessionId === liveSnapshot?.sessionId;

	const setLiveSnapshot = (update: LiveSnapshotUpdate): void => {
		const next = typeof update === "function" ? update(liveSnapshotRef.current) : update;
		liveSnapshotRef.current = next;
		setLiveSnapshotState(next);
	};

	const dismissWarning = (id: string) => {
		const timeout = warningTimeoutsRef.current.get(id);
		if (timeout) clearTimeout(timeout);
		warningTimeoutsRef.current.delete(id);
		setWarnings((current) => current.filter((warning) => warning.id !== id));
	};

	const pushToast = (toast: Omit<AppWarning, "id">, ttlMs = 5200) => {
		const id = crypto.randomUUID();
		setWarnings((current) => [...current.slice(-2), { id, ...toast }]);
		const timeout = setTimeout(() => dismissWarning(id), ttlMs);
		warningTimeoutsRef.current.set(id, timeout);
	};

	const pushWarning = (message: string) => pushToast({ message });

	useEffect(() => {
		setMountedRoutes((current) => (current[route] ? current : { ...current, [route]: true }));
	}, [route]);

	// Remember which base page (home/chat) an overlay was opened from, so "返回" lands there.
	const returnRouteRef = useRef<Route>("home");
	const openOverlay = (next: Route) => {
		if (route === "home" || route === "chat") returnRouteRef.current = route;
		setRoute(next);
		setDrawerOpen(false);
	};
	const closeOverlay = () => setRoute(returnRouteRef.current);

	useEffect(() => {
		liveSnapshotRef.current = liveSnapshot;
		if (liveSnapshot) {
			voiceControllerRef.current?.updateFromSnapshot(liveSnapshot);
		}
	}, [liveSnapshot]);

	useEffect(() => {
		if (windowMode !== "expanded") {
			setDockOpen(false);
			return;
		}
		const id = requestAnimationFrame(() => setDockOpen(true));
		return () => cancelAnimationFrame(id);
	}, [windowMode]);

	useEffect(() => {
		if (isUtilityWindow || !liveSnapshot || appliedStartupModeRef.current) return;
		appliedStartupModeRef.current = true;
		if (windowMode === "expanded") window.desktopAssistant?.setWindowMode?.("expanded", false);
		window.desktopAssistant?.setWindowAlwaysOnTop?.(windowAlwaysOnTop);
	}, [isUtilityWindow, liveSnapshot, windowAlwaysOnTop, windowMode]);

	const refreshHistory = async () => {
		if (!window.desktopAssistant) return;
		try {
			const history = await window.desktopAssistant.listConversationHistory();
			setConversations(history.conversations.map(toStoredConversation));
		} catch (error) {
			console.warn("Failed to load conversation history:", error);
		}
	};

	const ensureVoiceController = async (isCancelled: () => boolean = () => false): Promise<VoiceController | undefined> => {
		if (isUtilityWindow || !liveSnapshotRef.current) return undefined;
		if (voiceControllerRef.current) return voiceControllerRef.current;
		const { VoiceController } = await import("./voice/voice-controller.ts");
		if (isCancelled() || voiceControllerRef.current) return voiceControllerRef.current;
		voiceControllerRef.current = new VoiceController({
			getSnapshot: () => liveSnapshotRef.current,
			setSnapshot: setLiveSnapshot,
			refreshHistory,
			onWarning: pushWarning,
			onPartialTranscript: animateVoiceTranscript,
			// On the home page every voice input (mic or wake word) starts a fresh
			// conversation and is shown inline — never auto-navigating to chat.
			onBeforeInput: async () => {
				if (routeRef.current !== "home" || !window.desktopAssistant) return;
				const created = await window.desktopAssistant.newConversation();
				setLiveSnapshot(created);
				setResumedConversationSessionId(undefined);
				setLoadingConversationSessionId(undefined);
			},
		});
		return voiceControllerRef.current;
	};

	useEffect(() => {
		if (!window.desktopAssistant) return undefined;
		let cancelled = false;
		setStartupPhase("snapshot");
		window.desktopAssistant
			.getSnapshot()
			.then((initial) => {
				if (cancelled) return;
				setLiveSnapshot(initial);
				setStartupPhase("ready");
			})
			.catch((error) => {
				if (cancelled) return;
				console.warn("Failed to load initial snapshot:", error);
				pushWarning(`启动会话加载失败：${error instanceof Error ? error.message : String(error)}`);
				setLiveSnapshot(createFallbackSnapshot());
				setStartupPhase("ready");
			});
		const unsubscribe = window.desktopAssistant.onEvent((event) => {
			if (event.snapshot) {
				setLiveSnapshot(event.snapshot);
			}
			if (event.route) {
				if (event.route === "mcp") {
					void window.desktopAssistant.openMcpManagerWindow();
				} else {
					setRoute(event.route);
				}
				setDrawerOpen(false);
			}
			if (event.type === "session_status" && event.sessions) {
				const nextSessions = event.sessions;
				setLiveSnapshot((current) => (current ? { ...current, sessions: nextSessions } : current));
			}
			if (event.type === "session_notification" && event.sessionNotification) {
				const note = event.sessionNotification;
				if (event.sessions) {
					const nextSessions = event.sessions;
					setLiveSnapshot((current) => (current ? { ...current, sessions: nextSessions } : current));
				}
				// The focused session's detail is already on screen — only toast for
				// background sessions so the user knows another conversation needs them.
				if (note.sessionId !== liveSnapshotRef.current?.focusedSessionId) {
					pushToast(
						{
							tone: note.kind,
							message:
								note.kind === "awaiting"
									? `会话「${note.title}」需要批准操作`
									: `会话「${note.title}」已完成`,
							sessionId: note.sessionId,
						},
						note.kind === "awaiting" ? 8000 : 5200,
					);
				}
			}
			if (event.type === "streaming_text" && event.streamingText !== undefined) {
				// Ignore a background session's streaming so it never overwrites the
				// focused conversation's text in the chat view.
				if (event.sessionId && event.sessionId !== liveSnapshotRef.current?.sessionId) return;
				setLiveSnapshot((current) => (current ? { ...current, streamingText: event.streamingText! } : current));
			}
			if (event.type === "streaming_thinking" && event.streamingThinking !== undefined) {
				if (event.sessionId && event.sessionId !== liveSnapshotRef.current?.sessionId) return;
				setLiveSnapshot((current) =>
					current ? { ...current, streamingThinking: event.streamingThinking! } : current,
				);
			}
			if (event.voiceOverlay) {
				if (!voiceControllerRef.current?.shouldApplyExternalOverlay(event.voiceOverlay)) return;
				setLiveSnapshot((current) => (current ? { ...current, voiceOverlay: event.voiceOverlay! } : current));
			}
			if ((event.type === "memo_changed" || event.type === "memo_reminder") && event.memoSummary) {
				const memoSummary = event.memoSummary;
				setLiveSnapshot((current) => (current ? { ...current, memoSummary } : current));
			}
			if (event.type === "memo_reminder" && event.memo) {
				const memo = event.memo;
				const heading = memo.reminderMissed ? "错过的提醒" : "待办提醒";
				pushToast({ tone: "awaiting", title: heading, message: memo.title }, 9000);
				petEngineRef.current?.speak(`⏰ ${memo.title}`);
			}
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [isUtilityWindow]);

	useEffect(() => {
		return () => {
			if (voiceTranscriptTimerRef.current) clearTimeout(voiceTranscriptTimerRef.current);
			for (const timeout of windowTransitionTimersRef.current) clearTimeout(timeout);
			windowTransitionTimersRef.current = [];
			void voiceControllerRef.current?.stop();
			voiceControllerRef.current = undefined;
			for (const timeout of warningTimeoutsRef.current.values()) clearTimeout(timeout);
			warningTimeoutsRef.current.clear();
		};
	}, []);

	function animateVoiceTranscript(text: string): void {
		voiceDraftTextRef.current = text;
		if (!text) {
			if (voiceTranscriptTimerRef.current) {
				clearTimeout(voiceTranscriptTimerRef.current);
				voiceTranscriptTimerRef.current = undefined;
			}
			voiceDisplayedTextRef.current = "";
			setPrompt("");
			return;
		}
		if (voiceTranscriptTimerRef.current) return;
		const tick = () => {
			const target = voiceDraftTextRef.current;
			const current = voiceDisplayedTextRef.current;
			if (!target.startsWith(current)) {
				voiceDisplayedTextRef.current = target;
				setPrompt(target);
			} else if (current.length < target.length) {
				const next = target.slice(0, current.length + 1);
				voiceDisplayedTextRef.current = next;
				setPrompt(next);
			}
			if (voiceDisplayedTextRef.current.length < voiceDraftTextRef.current.length) {
				voiceTranscriptTimerRef.current = setTimeout(tick, 24);
			} else {
				voiceTranscriptTimerRef.current = undefined;
			}
		};
		voiceTranscriptTimerRef.current = setTimeout(tick, 0);
	}

	useEffect(() => {
		if (isUtilityWindow || !liveSnapshot || !window.desktopAssistant || backgroundStartedRef.current) return undefined;
		backgroundStartedRef.current = true;
		let cancelled = false;
		setStartupPhase("background");

		const runBackgroundStartup = async () => {
			await afterFirstPaint();
			if (cancelled) return;

			void window.desktopAssistant
				.listWakeWordModels()
				.then((result) => {
					if (!cancelled) setWakeModels(result.models);
				})
				.catch((error) => console.warn("Failed to load wake word models:", error));

			const stored = loadStoredSettings();
			if (stored && !settingsAppliedRef.current) {
				settingsAppliedRef.current = true;
				void window.desktopAssistant
					.updateSettings({ settings: stored })
					.then((merged) => {
						if (cancelled) return;
						setLiveSnapshot(merged);
						persistSettings(merged.settings);
						void refreshHistory();
					})
					.catch((error) => console.warn("Failed to replay stored settings:", error));
			}

			runWhenIdle(() => {
				if (cancelled) return;
				void ensureVoiceController(() => cancelled)
					.then((controller) => {
						if (!cancelled) return controller?.startWakeListening();
						return undefined;
					})
					.catch((error) => console.warn("Failed to start wake listening:", error));
			}, 1200);
			runWhenIdle(() => {
				if (cancelled) return;
				void loadSettingsView().catch((error) => console.warn("Failed to prefetch settings view:", error));
			}, 1600);
		};

		void runBackgroundStartup();
		return () => {
			cancelled = true;
		};
	}, [isUtilityWindow, liveSnapshot?.sessionId]);

	useEffect(() => {
		if (!liveSnapshot) return;
		void refreshHistory();
	}, [liveSnapshot?.sessionId, liveSnapshot?.messages.length, liveSnapshot?.timeline.length]);

	useEffect(() => {
		if (!liveSnapshot || !resumedConversationSessionId) return;
		if (liveSnapshot.sessionId !== resumedConversationSessionId) {
			setResumedConversationSessionId(undefined);
		}
	}, [liveSnapshot?.sessionId, resumedConversationSessionId]);

	useEffect(() => {
		if (isUtilityWindow || !window.desktopAssistant) return undefined;
		let stopped = false;
		let disabledSent = false;

		const publishPetDebug = () => {
			if (stopped || !window.desktopAssistant) return;
			const engine = petEngineRef.current;
			if (petConfig.enabled && engine) {
				disabledSent = false;
				void window.desktopAssistant
					.updatePetDebug({
						snapshot: engine.getDebugSnapshot(true),
						events: engine.flushDebugEvents(),
					})
					.catch((error) => console.warn("Failed to update pet debug state:", error));
				return;
			}
			if (disabledSent) return;
			disabledSent = true;
			const snapshot: PetDebugSnapshot = {
				enabled: false,
				updatedAt: Date.now(),
				behaviorLabel: petConfig.enabled ? "未挂载" : "已关闭",
				behaviorStartReason: petConfig.enabled ? "pet engine is not mounted yet" : "pet disabled by config",
				speciesId: petConfig.speciesId,
				colorId: petConfig.colorId,
			};
			void window.desktopAssistant
				.updatePetDebug({ snapshot })
				.catch((error) => console.warn("Failed to update disabled pet debug state:", error));
		};

		publishPetDebug();
		const interval = setInterval(() => {
			if (document.visibilityState !== "visible") return;
			publishPetDebug();
		}, 1000);
		return () => {
			stopped = true;
			clearInterval(interval);
		};
	}, [isUtilityWindow, petConfig.enabled, petConfig.speciesId, petConfig.colorId]);

	const sandboxStatus = liveSnapshot?.sandboxStatus;
	const sandboxPhase = sandboxStatus?.phase;
	useEffect(() => {
		// A fresh initialization cycle re-opens the popup.
		if (sandboxPhase === "initializing") setSandboxModalDismissed(false);
	}, [sandboxPhase]);

	// Reset the home inline conversation back to a clean landing page by starting a
	// fresh (empty) conversation. The prior conversation stays in history.
	const clearHomeConversation = async () => {
		if (!window.desktopAssistant) return;
		const created = await window.desktopAssistant.newConversation();
		setLiveSnapshot(created);
		setResumedConversationSessionId(undefined);
		setLoadingConversationSessionId(undefined);
		await refreshHistory();
	};

	// On the home page, an idle voice conversation clears itself after 5s so the
	// landing page returns to a clean state. Any in-app activity (mouse move while
	// focused, click, key, wheel) or a new voice turn resets the countdown; while the
	// window is unfocused those events don't fire, so the timer simply runs out.
	// NOTE: must stay above the `!liveSnapshot` early return so hook order is stable.
	useEffect(() => {
		if (route !== "home" || !liveSnapshot || liveSnapshot.messages.length === 0 || liveSnapshot.isRunning) {
			return undefined;
		}
		const tone = voiceToneOf(liveSnapshot.voiceOverlay.state);
		if (tone === "capturing" || tone === "processing" || tone === "speaking") return undefined;
		let timer: number | undefined;
		const arm = () => {
			if (timer !== undefined) window.clearTimeout(timer);
			timer = window.setTimeout(() => void clearHomeConversation(), HOME_IDLE_CLEAR_MS);
		};
		const onMove = () => {
			if (document.hasFocus()) arm();
		};
		const onActivity = () => arm();
		arm();
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mousedown", onActivity);
		window.addEventListener("keydown", onActivity);
		window.addEventListener("wheel", onActivity, { passive: true });
		return () => {
			if (timer !== undefined) window.clearTimeout(timer);
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mousedown", onActivity);
			window.removeEventListener("keydown", onActivity);
			window.removeEventListener("wheel", onActivity);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [route, liveSnapshot?.messages.length, liveSnapshot?.isRunning, liveSnapshot?.voiceOverlay.state]);

	if (!liveSnapshot) {
		return <StartupSplash phase={startupPhase} />;
	}

	const addAttachments = (incoming: PendingPromptAttachment[]) => {
		setAttachments((current) => {
			const existingPaths = new Set(current.map((attachment) => attachment.path));
			const next = [...current];
			for (const attachment of incoming) {
				if (existingPaths.has(attachment.path)) continue;
				existingPaths.add(attachment.path);
				next.push(attachment);
			}
			return next.slice(0, 10);
		});
	};

	const removeAttachment = (id: string) => {
		setAttachments((current) => current.filter((attachment) => attachment.id !== id));
	};

	const clearAttachments = () => {
		setAttachments([]);
	};

	const sendPrompt = async () => {
		const text = prompt.trim();
		// `/cat ...` controls the desktop pet — it never reaches the agent or history.
		if (isCatCommand(text)) {
			const result = runCatCommand(text, petConfig);
			if (result.nextConfig) {
				setPetConfig(result.nextConfig);
				persistPetConfig(result.nextConfig);
			}
			if (result.nudge) petEngineRef.current?.nudge(result.nudge);
			pushToast({ message: result.feedback, tone: result.tone === "error" ? "error" : "completed" }, 6000);
			setPrompt("");
			return;
		}
		if ((!text && attachments.length === 0) || !window.desktopAssistant) return;
		voiceDraftTextRef.current = "";
		voiceDisplayedTextRef.current = "";
		setPrompt("");
		const pendingAttachments = attachments;
		clearAttachments();
		const next = await window.desktopAssistant.prompt({ message: text, source: "text", attachments: pendingAttachments });
		setLiveSnapshot(next);
		await refreshHistory();
	};

	const toggleWindowMode = () => {
		if (windowTransitionPhase !== "idle") return;
		const next = windowMode === "expanded" ? "compact" : "expanded";
		setWindowTransitionPhase("blur-in");
		const resizeTimer = window.setTimeout(() => {
			setWindowMode(next);
			persistWindowMode(next);
			window.desktopAssistant?.setWindowMode?.(next, true);
			setWindowTransitionPhase("resizing");
		}, WINDOW_BLUR_MS);
		const blurOutTimer = window.setTimeout(() => {
			setWindowTransitionPhase("blur-out");
		}, WINDOW_BLUR_MS + WINDOW_RESIZE_MS);
		const doneTimer = window.setTimeout(() => {
			setWindowTransitionPhase("idle");
			windowTransitionTimersRef.current = [];
		}, WINDOW_BLUR_MS + WINDOW_RESIZE_MS + WINDOW_BLUR_MS);
		windowTransitionTimersRef.current = [resizeTimer, blurOutTimer, doneTimer];
	};

	const updateWindowAlwaysOnTop = (enabled: boolean) => {
		setWindowAlwaysOnTop(enabled);
		persistWindowAlwaysOnTop(enabled);
		window.desktopAssistant?.setWindowAlwaysOnTop?.(enabled);
	};

	const updateSettings = async (settings: Partial<DesktopAssistantSettings>) => {
		if (!window.desktopAssistant) return undefined;
		try {
			const next = await window.desktopAssistant.updateSettings({ settings });
			setLiveSnapshot(next);
			// Persist the latest full settings so they survive restarts.
			persistSettings(next.settings);
			return next;
		} catch (error) {
			console.error("Failed to save settings:", error);
			return undefined;
		}
	};

	const updateConversationThinking = async (enabled: boolean) => {
		if (!window.desktopAssistant) return undefined;
		try {
			const next = await window.desktopAssistant.updateConversationThinking({ enabled });
			setLiveSnapshot(next);
			return next;
		} catch (error) {
			console.error("Failed to update conversation thinking:", error);
			return undefined;
		}
	};

	const openMcpManager = async () => {
		if (!window.desktopAssistant) return;
		await window.desktopAssistant.openMcpManagerWindow();
	};

	const openToolsetManager = async () => {
		if (!window.desktopAssistant) return;
		await window.desktopAssistant.openToolsetManagerWindow();
	};

	const openPluginManager = async () => {
		if (!window.desktopAssistant) return;
		await window.desktopAssistant.openPluginManagerWindow();
	};

	const openPersonalSkillManager = async () => {
		if (!window.desktopAssistant) return;
		await window.desktopAssistant.openPersonalSkillManagerWindow();
	};

	const saveApiKey = async (key: string) => {
		if (!window.desktopAssistant) return undefined;
		const next = await window.desktopAssistant.updateApiKey({ apiKey: key });
		setLiveSnapshot(next);
		persistSettings(next.settings);
		return next;
	};

	const saveVoiceApiKey = async (key: string) => {
		if (!window.desktopAssistant) return;
		setLiveSnapshot(await window.desktopAssistant.updateVoiceApiKey({ apiKey: key }));
	};

	const startVoice = async () => {
		if (!window.desktopAssistant) return;
		voiceDraftTextRef.current = "";
		voiceDisplayedTextRef.current = "";
		setPrompt("");
		clearAttachments();
		const controller = await ensureVoiceController();
		await controller?.manualInput();
	};

	const onAbort = async () => {
		if (!window.desktopAssistant) return;
		try {
			const next = await window.desktopAssistant.abort();
			setLiveSnapshot(next);
		} catch (error) {
			console.warn("Abort failed:", error);
		}
	};

	const approveConfirmation = async (id: string) => {
		if (!window.desktopAssistant) return;
		// Route the approval to the focused conversation so session A's request can
		// never be approved against session B.
		const sessionId = liveSnapshotRef.current?.focusedSessionId;
		setLiveSnapshot(await window.desktopAssistant.approveConfirmation({ id, sessionId }));
	};

	const rejectConfirmation = async (id: string) => {
		if (!window.desktopAssistant) return;
		const sessionId = liveSnapshotRef.current?.focusedSessionId;
		setLiveSnapshot(await window.desktopAssistant.rejectConfirmation({ id, sessionId }));
	};

	const loadEarlierHistory = async () => {
		if (!window.desktopAssistant || !liveSnapshot?.historyWindow?.hasMoreBefore || loadingEarlierHistory) return;
		const { sessionId, oldestOrder } = liveSnapshot.historyWindow;
		setLoadingEarlierHistory(true);
		try {
			const page = await window.desktopAssistant.loadConversationPage({
				sessionId,
				beforeOrder: oldestOrder,
			});
			setLiveSnapshot((current) => {
				if (!current || current.sessionId !== sessionId) return current;
				return {
					...current,
					messages: mergeHistoryItems(page.messages, current.messages),
					timeline: mergeHistoryItems(page.timeline, current.timeline),
					historyWindow: {
						sessionId,
						hasMoreBefore: page.hasMoreBefore,
						oldestOrder: page.oldestOrder,
						loadedFrom: page.loadedFrom,
					},
				};
			});
		} catch (error) {
			console.warn("Failed to load earlier conversation history:", error);
		} finally {
			setLoadingEarlierHistory(false);
		}
	};

	const startNewChat = () => {
		if (!window.desktopAssistant) return;
		void window.desktopAssistant.newConversation().then(async (next) => {
			setLiveSnapshot(next);
			setResumedConversationSessionId(undefined);
			setLoadingConversationSessionId(undefined);
			setRoute("chat");
			setDrawerOpen(false);
			await refreshHistory();
		});
	};

	// Home page: submitting a question (with optional attachments) opens a fresh
	// conversation, then sends it.
	const submitHomePrompt = async (text: string, homeAttachments: PendingPromptAttachment[] = []) => {
		const trimmed = text.trim();
		if ((!trimmed && homeAttachments.length === 0) || !window.desktopAssistant) return;
		const created = await window.desktopAssistant.newConversation();
		setLiveSnapshot(created);
		setResumedConversationSessionId(undefined);
		setLoadingConversationSessionId(undefined);
		setRoute("chat");
		setDrawerOpen(false);
		const next = await window.desktopAssistant.prompt({
			message: trimmed,
			source: "text",
			attachments: homeAttachments,
		});
		setLiveSnapshot(next);
		await refreshHistory();
	};

	const completeMemoQuick = async (id: string) => {
		if (!window.desktopAssistant) return;
		await window.desktopAssistant.completeMemo({ id, completed: true });
		// memo_changed event refreshes memoSummary on the snapshot.
	};

	const deleteConversation = async (sessionId: string) => {
		if (!window.desktopAssistant) return;
		// Optimistic: drop it from the list immediately so the click feels instant.
		// The backend delete (archive teardown + disk removal, occasionally slow on
		// Windows) and the history refresh reconcile in the background; if the delete
		// fails, refreshHistory restores the item.
		setConversations((current) => current.filter((conversation) => conversation.sessionId !== sessionId));
		if (sessionId === resumedConversationSessionId) {
			setResumedConversationSessionId(undefined);
		}
		try {
			const result = await window.desktopAssistant.deleteConversation({ sessionId });
			if (result.activeSessionId !== liveSnapshotRef.current?.sessionId) {
				setLiveSnapshot(await window.desktopAssistant.getSnapshot());
			}
		} catch (error) {
			console.warn("Failed to delete conversation:", error);
		} finally {
			await refreshHistory();
		}
	};

	const clearAllConversations = async () => {
		if (!window.desktopAssistant) return;
		await window.desktopAssistant.clearConversationHistory();
		setResumedConversationSessionId(undefined);
		setLiveSnapshot(await window.desktopAssistant.getSnapshot());
		await refreshHistory();
	};

	// Open a conversation. Live (running/background) sessions switch focus instantly
	// with no teardown; archived-only sessions are rebuilt from disk via resume.
	const selectSession = (id: string) => {
		if (!window.desktopAssistant) return;
		setDrawerOpen(false);
		setRoute("chat");
		const isLive = liveSnapshotRef.current?.sessions.some((session) => session.sessionId === id);
		if (isLive) {
			void window.desktopAssistant
				.focusSession({ sessionId: id })
				.then(async (next) => {
					setLiveSnapshot(next);
					setResumedConversationSessionId(undefined);
					await refreshHistory();
				})
				.catch((error) => console.warn("Failed to focus session:", error));
			return;
		}
		setLoadingConversationSessionId(id);
		void window.desktopAssistant
			.resumeConversation({ sessionId: id })
			.then(async (next) => {
				setLiveSnapshot(next);
				setResumedConversationSessionId(id);
				await refreshHistory();
			})
			.catch((error) => console.warn("Failed to resume conversation:", error))
			.finally(() => {
				setLoadingConversationSessionId((current) => (current === id ? undefined : current));
			});
	};

	const closeSession = async (id: string) => {
		if (!window.desktopAssistant) return;
		const next = await window.desktopAssistant.closeSession({ sessionId: id });
		setLiveSnapshot(next);
		setResumedConversationSessionId(undefined);
		await refreshHistory();
	};

	const showSandboxModal =
		!isUtilityWindow &&
		!!sandboxStatus &&
		sandboxPhase !== "uninitialized" &&
		!sandboxModalDismissed;
	const shellClasses = [
		"app-shell",
		!isUtilityWindow && windowMode === "expanded" ? "expanded" : "",
		!isUtilityWindow && windowTransitionPhase !== "idle" ? "window-transition-blur" : "",
		!isUtilityWindow && windowTransitionPhase === "resizing" ? "window-transitioning" : "",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<main className={shellClasses}>
			<div className="glass-bg" aria-hidden />
			<WarningToasts warnings={warnings} onDismiss={dismissWarning} onSelect={selectSession} />
			{showSandboxModal && sandboxStatus ? (
				<SandboxInitModal
					status={sandboxStatus}
					busy={sandboxModalBusy}
					onClose={() => setSandboxModalDismissed(true)}
					onOpenSettings={() => {
						setSandboxModalDismissed(true);
						setRoute("settings");
					}}
					onRetry={async () => {
						setSandboxModalBusy(true);
						try {
							await window.desktopAssistant.initSandbox();
						} finally {
							setSandboxModalBusy(false);
						}
					}}
				/>
			) : null}
			{isMcpWindow ? (
				<Suspense fallback={<StartupFallback label="加载 MCP 管理器" />}>
					<McpManagerView
						snapshot={liveSnapshot}
						onBack={() => window.desktopAssistant.closeWindow()}
						onSnapshot={setLiveSnapshot}
						windowed
					/>
				</Suspense>
			) : isToolsetWindow ? (
				<Suspense fallback={<StartupFallback label="加载工具集" />}>
					<ToolsetManagerView
						snapshot={liveSnapshot}
						onBack={() => window.desktopAssistant.closeWindow()}
						onSnapshot={setLiveSnapshot}
						windowed
					/>
				</Suspense>
			) : isPluginWindow ? (
				<Suspense fallback={<StartupFallback label="加载插件管理器" />}>
					<PluginManagerView windowed />
				</Suspense>
			) : isPersonalSkillWindow ? (
				<Suspense fallback={<StartupFallback label="加载个人技能库" />}>
					<PersonalSkillManagerView windowed />
				</Suspense>
			) : isSandboxWindow ? (
				<Suspense fallback={<StartupFallback label="加载沙箱设置" />}>
					<SandboxSettingsView
						snapshot={liveSnapshot}
						onBack={() => window.desktopAssistant.closeWindow()}
						onSnapshot={setLiveSnapshot}
						windowed
					/>
				</Suspense>
			) : (
				<div className="app-main">
					{/* Chat is the always-mounted base layer; home/memo/settings slide over it. */}
					<div className="page-base">
						<ChatView
							snapshot={liveSnapshot}
							prompt={prompt}
							attachments={attachments}
							viewingHistory={viewingHistory}
							loadingHistory={loadingConversationSessionId !== undefined}
							loadingEarlierHistory={loadingEarlierHistory}
							wakeModels={wakeModels}
							petConfig={petConfig}
							petEngineRef={petEngineRef}
							setPrompt={setPrompt}
							onAddAttachments={addAttachments}
							onRemoveAttachment={removeAttachment}
							onToggleConversationThinking={updateConversationThinking}
							onSend={sendPrompt}
							onStartVoice={startVoice}
							onAbort={onAbort}
							onMenu={() => {
								setDrawerOpen(true);
								void refreshHistory();
							}}
							onOpenMemo={() => openOverlay("memo")}
							windowMode={windowMode}
							onToggleWindowMode={toggleWindowMode}
							onLoadEarlierHistory={loadEarlierHistory}
							onApprove={approveConfirmation}
							onReject={rejectConfirmation}
						/>
					</div>

					<div className={`overlay-page overlay-home ${route === "home" ? "active" : ""}`}>
						{mountedRoutes.home ? (
							<Suspense fallback={<StartupFallback label="加载首页" />}>
								<HomeView
									snapshot={liveSnapshot}
									conversations={conversations}
									onSubmit={submitHomePrompt}
									onNewChat={startNewChat}
									onOpenMemo={() => openOverlay("memo")}
									onOpenSettings={() => openOverlay("settings")}
									onOpenSession={selectSession}
									onCompleteMemo={completeMemoQuick}
									onStartVoice={startVoice}
									onExpandToChat={() => setRoute("chat")}
									onMenu={() => {
										setDrawerOpen(true);
										void refreshHistory();
									}}
									wakeModels={wakeModels}
									windowMode={windowMode}
									onToggleWindowMode={toggleWindowMode}
								/>
							</Suspense>
						) : null}
					</div>

					<div className={`overlay-page overlay-right overlay-memo ${route === "memo" ? "active" : ""}`}>
						{mountedRoutes.memo ? (
							<Suspense fallback={<StartupFallback label="加载备忘录" />}>
								<MemoView
									snapshot={liveSnapshot}
									onBack={closeOverlay}
									onMenu={() => {
										setDrawerOpen(true);
										void refreshHistory();
									}}
									wakeModels={wakeModels}
									windowMode={windowMode}
									onToggleWindowMode={toggleWindowMode}
									onOpenSession={selectSession}
								/>
							</Suspense>
						) : null}
					</div>

					<div className={`overlay-page overlay-right overlay-settings ${route === "settings" ? "active" : ""}`}>
						{mountedRoutes.settings ? (
							<Suspense fallback={<StartupFallback label="加载设置" />}>
								<SettingsView
									snapshot={liveSnapshot}
									onBack={closeOverlay}
									onOpenMcp={() => void openMcpManager()}
									onOpenToolset={() => void openToolsetManager()}
									onOpenPlugins={() => void openPluginManager()}
									onOpenPersonalSkills={() => void openPersonalSkillManager()}
									onUpdate={updateSettings}
									onSaveApiKey={saveApiKey}
									onSaveVoiceApiKey={saveVoiceApiKey}
									historyCount={conversations.length}
									wakeModels={wakeModels}
									onWakeModels={setWakeModels}
									onClearHistory={clearAllConversations}
									windowAlwaysOnTop={windowAlwaysOnTop}
									onWindowAlwaysOnTopChange={updateWindowAlwaysOnTop}
								/>
							</Suspense>
						) : null}
					</div>
				</div>
			)}

			{isUtilityWindow ? null : (
				<Drawer
					open={windowMode === "expanded" ? dockOpen : drawerOpen}
					onClose={() => setDrawerOpen(false)}
					docked={windowMode === "expanded"}
					sessions={liveSnapshot.sessions}
					focusedSessionId={liveSnapshot.focusedSessionId}
					conversations={conversations}
					activeRoute={route}
					memoSummary={liveSnapshot.memoSummary}
					onOpenHome={() => {
						setDrawerOpen(false);
						setRoute("home");
					}}
					onOpenMemo={() => openOverlay("memo")}
					onOpenSettings={() => openOverlay("settings")}
					activeId={liveSnapshot.sessionId}
					loadingId={loadingConversationSessionId}
					onSelect={selectSession}
					onSelectSession={selectSession}
					onCloseSession={closeSession}
					onDelete={deleteConversation}
				/>
			)}

		</main>
	);
}

function StartupFallback({ label }: { label: string }) {
	return (
		<section className="startup-fallback" aria-live="polite">
			<div className="startup-progress compact" aria-hidden>
				<span />
			</div>
			<span>{label}</span>
		</section>
	);
}

function afterFirstPaint(callback?: () => void | Promise<void>): Promise<void> {
	return new Promise((resolve) => {
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				void callback?.();
				resolve();
			});
		});
	});
}

function runWhenIdle(callback: () => void, timeout = 900): () => void {
	const idleWindow = window as IdleWindow;
	if (idleWindow.requestIdleCallback) {
		const handle = idleWindow.requestIdleCallback(callback, { timeout });
		return () => idleWindow.cancelIdleCallback?.(handle);
	}
	const handle = window.setTimeout(callback, Math.min(timeout, 200));
	return () => window.clearTimeout(handle);
}

function createFallbackSnapshot(): DesktopAssistantSnapshot {
	const now = Date.now();
	const sessionId = `startup-${now}`;
	return {
		sessionId,
		sessions: [
			{
				sessionId,
				title: "新会话",
				status: "idle",
				isRunning: false,
				lastActivityAt: now,
				pendingConfirmationCount: 0,
				unreadCompletion: false,
			},
		],
		focusedSessionId: sessionId,
		settings: DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
		authStatus: {
			configured: false,
			needsRotationWarning: false,
		},
		voiceAuthStatus: {
			configured: false,
			needsRotationWarning: false,
		},
		apiKeyStatus: DEFAULT_API_KEY_STATUS,
		isRunning: false,
		streamingText: "",
		streamingThinking: "",
		messages: [] satisfies ChatMessageView[],
		timeline: [] satisfies TimelineItem[],
		pendingConfirmations: [],
		voiceOverlay: {
			visible: false,
			state: "idle",
			transcript: "",
		},
		conversationThinking: {
			enabled: true,
			effectiveLevel: DEFAULT_DESKTOP_ASSISTANT_SETTINGS.thinkingLevel,
			supported: true,
		},
		memoryEnabled: DEFAULT_DESKTOP_ASSISTANT_SETTINGS.memory.enabled,
		lastInjectedMemoryCount: 0,
	};
}

createRoot(document.getElementById("root")!).render(<App />);
