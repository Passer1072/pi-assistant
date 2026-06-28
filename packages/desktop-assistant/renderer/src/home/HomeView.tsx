import {
	BellRing,
	Check,
	ChevronRight,
	Cloud,
	CloudDrizzle,
	CloudFog,
	CloudLightning,
	CloudMoon,
	CloudOff,
	CloudRain,
	CloudSnow,
	CloudSun,
	Droplets,
	FileText,
	Loader2,
	MapPin,
	MessageSquarePlus,
	Mic,
	Moon,
	Send,
	Settings as SettingsIcon,
	Sparkles,
	Sun,
	Wind,
	X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
	DesktopAssistantSnapshot,
	HomeWeatherView,
	MemoItem,
	PendingPromptAttachment,
	WakeWordModelMetadata,
	WindowMode,
} from "../../../src/shared/types.ts";
import type { StoredConversation } from "../app-types.ts";
import { attachmentsFromFiles, attachmentsFromText, formatAttachmentSize } from "../chat/attachments.ts";
import { ConversationThread } from "../chat/ConversationThread.tsx";
import { TitleBar } from "../components/TitleBar.tsx";
import { formatDueLabel } from "../memo/memo-view-model.ts";
import { PetLayer, type PetLayerHandle } from "../pet/PetLayer.tsx";
import type { PetConfig } from "../pet/types.ts";
import { voiceToneOf } from "../voice-ui.ts";

const SUGGESTIONS = [
	"帮我整理一下今天的待办",
	"提醒我下午 6 点给妈妈打电话",
	"打开网易云音乐播放我的歌单",
	"总结一下我桌面上的这份文档",
];

/** Map a WeatherAPI.com condition code (+ day/night) to a lucide icon, so the widget matches the app's icon set. */
function weatherIcon(code: number | undefined, isDay: boolean) {
	const props = { size: 34, className: "home-weather-icon", "aria-hidden": true } as const;
	switch (code) {
		case 1000: // sunny / clear
			return isDay ? <Sun {...props} /> : <Moon {...props} />;
		case 1003: // partly cloudy
			return isDay ? <CloudSun {...props} /> : <CloudMoon {...props} />;
		case 1006: // cloudy
		case 1009: // overcast
			return <Cloud {...props} />;
		case 1030: // mist
		case 1135: // fog
		case 1147: // freezing fog
			return <CloudFog {...props} />;
		case 1063: // patchy rain
		case 1150: // patchy light drizzle
		case 1153: // light drizzle
		case 1180: // patchy light rain
		case 1183: // light rain
		case 1240: // light rain shower
			return <CloudDrizzle {...props} />;
		case 1186: // moderate rain
		case 1189:
		case 1192: // heavy rain
		case 1195:
		case 1243: // moderate/heavy rain shower
		case 1246:
			return <CloudRain {...props} />;
		case 1087: // thundery outbreaks
		case 1273: // patchy light rain w/ thunder
		case 1276: // moderate/heavy rain w/ thunder
			return <CloudLightning {...props} />;
		case 1066: // patchy snow
		case 1114: // blowing snow
		case 1210: // patchy light snow
		case 1213: // light snow
		case 1216: // patchy moderate snow
		case 1219: // moderate snow
		case 1222: // patchy heavy snow
		case 1225: // heavy snow
		case 1255: // light snow showers
		case 1258: // moderate/heavy snow showers
			return <CloudSnow {...props} />;
		default:
			return <Cloud {...props} />;
	}
}

/**
 * Weather card for the home hero. Pulls structured weather via IPC (2h main-process cache),
 * refreshes every 30 min. Renders nothing when no WeatherAPI key is configured, and degrades
 * silently to a muted "unavailable" pill on fetch failure.
 */
function HomeWeatherWidget() {
	const [weather, setWeather] = useState<HomeWeatherView | null>(null);
	const [status, setStatus] = useState<"loading" | "ready" | "error" | "absent">("loading");

	const load = useCallback(async () => {
		if (!window.desktopAssistant?.getHomeWeather) {
			setStatus("absent");
			return;
		}
		setStatus((prev) => (prev === "ready" ? prev : "loading"));
		try {
			const result = await window.desktopAssistant.getHomeWeather();
			if (result) {
				setWeather(result);
				setStatus("ready");
			} else {
				setStatus("absent");
			}
		} catch {
			setStatus("error");
		}
	}, []);

	useEffect(() => {
		void load();
		const timer = window.setInterval(() => void load(), 30 * 60 * 1000);
		return () => window.clearInterval(timer);
	}, [load]);

	if (status === "absent") return null;

	if (status === "loading") {
		return (
			<div className="home-weather is-muted" aria-live="polite">
				<Loader2 size={15} className="home-weather-spin" aria-hidden />
				<span>天气加载中…</span>
			</div>
		);
	}

	if (status === "error" || !weather) {
		return (
			<button type="button" className="home-weather is-muted is-button" onClick={() => void load()}>
				<CloudOff size={15} aria-hidden />
				<span>天气暂不可用 · 点击重试</span>
			</button>
		);
	}

	const { city, tempC, feelsLikeC, conditionText, conditionCode, isDay, humidity, windKph } = weather;
	const updatedLabel = `更新于 ${new Date(weather.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
	return (
		<div className="home-weather" title={updatedLabel}>
			<div className="home-weather-main">
				{weatherIcon(conditionCode, isDay)}
				<div className="home-weather-readout">
					<div className="home-weather-temp">{Math.round(tempC)}°</div>
					<div className="home-weather-cond">
						{conditionText ?? "—"}
						{feelsLikeC !== undefined ? ` · 体感 ${Math.round(feelsLikeC)}°` : ""}
					</div>
				</div>
			</div>
			{city ? (
				<div className="home-weather-city">
					<MapPin size={13} aria-hidden />
					<span className="home-weather-city-name">{city}</span>
				</div>
			) : null}
			{humidity !== undefined || windKph !== undefined ? (
				<div className="home-weather-detail">
					{humidity !== undefined ? (
						<span>
							<Droplets size={13} aria-hidden /> 湿度 {humidity}%
						</span>
					) : null}
					{windKph !== undefined ? (
						<span>
							<Wind size={13} aria-hidden /> {Math.round(windKph)} km/h
						</span>
					) : null}
				</div>
			) : null}
		</div>
	);
}

interface HomeViewProps {
	snapshot: DesktopAssistantSnapshot;
	/** True only when the focused conversation is one home started via voice. */
	homeConversationActive: boolean;
	conversations: StoredConversation[];
	onSubmit: (text: string, attachments: PendingPromptAttachment[]) => void;
	onNewChat: () => void;
	onOpenMemo: () => void;
	onOpenSettings: () => void;
	onOpenSession: (sessionId: string) => void;
	onCompleteMemo: (id: string) => void;
	onStartVoice: () => void;
	onExpandToChat: () => void;
	onMenu: () => void;
	wakeModels: WakeWordModelMetadata[];
	windowMode: WindowMode;
	onToggleWindowMode: () => void;
	petConfig: PetConfig;
	petEngineRef: PetLayerHandle;
	petLayerActive: boolean;
}

function greeting(date: Date): string {
	const hour = date.getHours();
	if (hour < 5) return "夜深了";
	if (hour < 11) return "早上好";
	if (hour < 13) return "中午好";
	if (hour < 18) return "下午好";
	return "晚上好";
}

function formatToday(date: Date): string {
	const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
	return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${week}`;
}

function getHomeReminderTime(memo: MemoItem): string | undefined {
	const dueAtMs = memo.dueAt ? Date.parse(memo.dueAt) : Number.NaN;
	const reminderAtMs =
		memo.reminderAt && (memo.reminderState === "pending" || memo.reminderState === "snoozed")
			? Date.parse(memo.reminderAt)
			: Number.NaN;
	const hasDueAt = !Number.isNaN(dueAtMs);
	const hasReminderAt = !Number.isNaN(reminderAtMs);
	if (hasDueAt && hasReminderAt) {
		return reminderAtMs <= dueAtMs ? memo.reminderAt : memo.dueAt;
	}
	if (hasReminderAt) return memo.reminderAt;
	if (hasDueAt) return memo.dueAt;
	return undefined;
}

function isHomeReminderOverdue(memo: MemoItem, now: Date = new Date()): boolean {
	const reminderTime = getHomeReminderTime(memo);
	if (!reminderTime || memo.status !== "active") return false;
	const target = Date.parse(reminderTime);
	if (Number.isNaN(target)) return false;
	const startOfToday = new Date(now);
	startOfToday.setHours(0, 0, 0, 0);
	return target < startOfToday.getTime();
}

function voiceComposerClass(state: DesktopAssistantSnapshot["voiceOverlay"]["state"]): string {
	const tone = voiceToneOf(state);
	if (tone === "capturing") return " voice-capturing";
	if (tone === "processing") return " voice-processing";
	if (tone === "error") return " voice-error";
	return "";
}

// Shown the instant the home page mounts; the AI greeting fake-types in over it.
const HOME_WELCOME_PLACEHOLDER = "HELLO";
const TYPEWRITER_DELETE_MS = 26;
const TYPEWRITER_TYPE_MS = 55;

function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Split the welcome into a title (first line) and an overview body (the rest). */
function splitHomeWelcome(text: string): { title: string; body: string } {
	const newline = text.indexOf("\n");
	if (newline >= 0) return { title: text.slice(0, newline), body: text.slice(newline + 1) };
	return { title: text, body: "" };
}

/**
 * Drives a "fake input" replacement: whenever `target` changes, backspace-delete the
 * current text down to empty, then type the new text out one character at a time. The
 * initial value renders instantly (no animation) so the hero is never blank. Honors
 * prefers-reduced-motion by snapping straight to the target.
 */
function useTypewriter(target: string): string {
	const [display, setDisplay] = useState(target);
	const displayRef = useRef(target);
	const targetRef = useRef(target);

	useEffect(() => {
		if (target === targetRef.current) return undefined;
		targetRef.current = target;
		if (prefersReducedMotion()) {
			displayRef.current = target;
			setDisplay(target);
			return undefined;
		}
		const targetChars = Array.from(target);
		let timer = 0;
		const step = () => {
			const current = Array.from(displayRef.current);
			let next: string;
			let delay: number;
			if (current.length > 0) {
				// Phase 1: backspace the previous text away, character by character.
				next = current.slice(0, -1).join("");
				delay = TYPEWRITER_DELETE_MS;
			} else if (current.length < targetChars.length) {
				// Phase 2: type the new text in, character by character.
				next = targetChars.slice(0, current.length + 1).join("");
				delay = TYPEWRITER_TYPE_MS;
			} else {
				return;
			}
			displayRef.current = next;
			setDisplay(next);
			timer = window.setTimeout(step, delay);
		};
		step();
		return () => window.clearTimeout(timer);
	}, [target]);

	return display;
}

export function HomeView({
	snapshot,
	homeConversationActive,
	conversations,
	onSubmit,
	onNewChat,
	onOpenMemo,
	onOpenSettings,
	onOpenSession,
	onCompleteMemo,
	onStartVoice,
	onExpandToChat,
	onMenu,
	wakeModels,
	windowMode,
	onToggleWindowMode,
	petConfig,
	petEngineRef,
	petLayerActive,
}: HomeViewProps) {
	const [text, setText] = useState("");
	const [attachments, setAttachments] = useState<PendingPromptAttachment[]>([]);
	const [expanding, setExpanding] = useState(false);
	const [cardsH, setCardsH] = useState(150);
	const now = useMemo(() => new Date(), []);
	const welcomeEnabled = snapshot.settings.homeWelcome?.enabled ?? true;
	const welcomeText = useTypewriter(
		welcomeEnabled ? (snapshot.homeWelcome?.text ?? HOME_WELCOME_PLACEHOLDER) : HOME_WELCOME_PLACEHOLDER,
	);
	const { title: welcomeTitle, body: welcomeBody } = splitHomeWelcome(welcomeText);
	const summary = snapshot.memoSummary;
	const memoBadge = (summary?.overdueCount ?? 0) + (summary?.dueTodayCount ?? 0);
	const todayMemos: MemoItem[] = useMemo(
		() => (summary?.upcoming ?? []).filter((memo) => memo.status === "active").slice(0, 4),
		[summary],
	);
	const recent = conversations[0];
	// Only the home-owned (voice/wake) conversation is shown inline. A resumed history
	// conversation is focused but NOT home-owned, so it never surfaces here.
	const hasConvo = homeConversationActive && snapshot.messages.length > 0;

	const topRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Measure the quick-entry block so the dissolve mask ends exactly at its bottom.
	useLayoutEffect(() => {
		if (!hasConvo) return undefined;
		const el = topRef.current;
		if (!el) return undefined;
		const update = () => setCardsH(el.offsetHeight);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(el);
		return () => observer.disconnect();
	}, [hasConvo]);

	// Keep the inline thread pinned to the latest message / streaming token.
	useEffect(() => {
		if (!hasConvo) return;
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [hasConvo, snapshot.messages.length, snapshot.streamingText]);

	useLayoutEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		const MAX_ROWS = 5;
		el.style.height = "auto";
		const style = window.getComputedStyle(el);
		const lineHeight = parseFloat(style.lineHeight) || 20;
		const paddingTop = parseFloat(style.paddingTop) || 0;
		const paddingBottom = parseFloat(style.paddingBottom) || 0;
		const borderTop = parseFloat(style.borderTopWidth) || 0;
		const borderBottom = parseFloat(style.borderBottomWidth) || 0;
		const maxHeight = lineHeight * MAX_ROWS + paddingTop + paddingBottom + borderTop + borderBottom;
		el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
		el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
	}, [text]);

	// Once the inline thread is gone (expanded to chat, cleared, or a history session
	// took focus), drop the expanding state so the launcher is never left covered.
	useEffect(() => {
		if (!hasConvo) setExpanding(false);
	}, [hasConvo]);

	const addAttachments = (incoming: PendingPromptAttachment[]) => {
		if (incoming.length === 0) return;
		setAttachments((current) => {
			const seen = new Set(current.map((item) => item.path));
			return [...current, ...incoming.filter((item) => !seen.has(item.path))];
		});
	};
	const removeAttachment = (id: string) => setAttachments((current) => current.filter((item) => item.id !== id));

	const canSend = text.trim().length > 0 || attachments.length > 0;
	// Text send (button / Enter) starts a new conversation and JUMPS to chat (App side).
	const submit = (value: string) => {
		const trimmed = value.trim();
		if (!trimmed && attachments.length === 0) return;
		const pending = attachments;
		setText("");
		setAttachments([]);
		onSubmit(trimmed, pending);
	};
	const send = () => submit(text);

	// Click the inline thread → grow it to full-bleed, then switch to the chat page.
	const handleExpand = () => {
		if (expanding) return;
		setExpanding(true);
		window.setTimeout(() => onExpandToChat(), 360);
	};

	const cardsVar = { "--home-cards-h": `${cardsH}px` } as React.CSSProperties;

	const quickGrid = (
		<section className="home-quick">
			<button type="button" className="home-card" onClick={onNewChat}>
				<MessageSquarePlus size={18} />
				<span className="home-card-title">新建对话</span>
				<span className="home-card-sub">开一个并行会话</span>
			</button>
			<button type="button" className="home-card" onClick={onOpenMemo}>
				<BellRing size={18} />
				<span className="home-card-title">备忘录</span>
				<span className="home-card-sub">{memoBadge > 0 ? `${memoBadge} 项待处理` : "管理待办与提醒"}</span>
				{memoBadge > 0 ? <span className="home-card-badge">{memoBadge}</span> : null}
			</button>
			<button
				type="button"
				className="home-card"
				onClick={() => recent && onOpenSession(recent.sessionId)}
				disabled={!recent}
			>
				<Sparkles size={18} />
				<span className="home-card-title">继续上次</span>
				<span className="home-card-sub">{recent ? recent.title : "暂无历史会话"}</span>
			</button>
			<button type="button" className="home-card" onClick={onOpenSettings}>
				<SettingsIcon size={18} />
				<span className="home-card-title">设置</span>
				<span className="home-card-sub">模型、语音、能力</span>
			</button>
		</section>
	);

	return (
		<div className={`home-screen ${expanding ? "expanding" : ""}`}>
			<TitleBar
				onMenu={onMenu}
				title="Pi 桌面助手"
				webSearchMode={snapshot.settings.webSearch?.mode}
				voiceOverlay={snapshot.voiceOverlay}
				voiceSettings={snapshot.settings.voice}
				wakeModels={wakeModels}
				windowMode={windowMode}
				onToggleWindowMode={onToggleWindowMode}
			/>

			<div className="home-live">
				{/* The launcher (greeting + reminders + quick entry) stays put even after a
				    voice conversation begins — the inline thread dissolves under it. */}
				<div className={`home-live-top ${hasConvo ? "with-convo" : ""}`} ref={topRef}>
					<header className="home-hero">
						<div className="home-hero-text">
							{welcomeEnabled ? (
								<div className="home-welcome">
									<div className="home-welcome-line title">
										<span className="home-welcome-title">{welcomeTitle}</span>
										{welcomeBody ? null : <span className="home-welcome-caret" aria-hidden />}
									</div>
									{welcomeBody ? (
										<div className="home-welcome-line sub">
											<span className="home-welcome-sub">{welcomeBody}</span>
											<span className="home-welcome-caret" aria-hidden />
										</div>
									) : null}
								</div>
							) : (
								<>
									<div className="home-greeting">
										<span className="home-greeting-main">{greeting(now)}</span>
										<span className="home-greeting-wave">👋</span>
									</div>
									<p className="home-tagline">我是小派，你的桌面 AI 伙伴。说出你想做的，我来处理。</p>
								</>
							)}
							<p className="home-date">{formatToday(now)}</p>
						</div>
						<HomeWeatherWidget />
					</header>

					<section className="home-reminders">
						<div className="home-section-head">
							<span className="home-section-title">
								<BellRing size={14} /> 今日提醒
							</span>
							<button type="button" className="home-section-link" onClick={onOpenMemo}>
								全部待办 <ChevronRight size={13} />
							</button>
						</div>
						{todayMemos.length === 0 ? (
							<div className="home-reminders-empty">今天没有待办，享受当下。</div>
						) : (
							<div className="home-reminder-list">
								{todayMemos.map((memo) => {
									const reminderTime = getHomeReminderTime(memo);
									const overdue = isHomeReminderOverdue(memo, now);
									return (
										<div key={memo.id} className={`home-reminder ${overdue ? "overdue" : ""}`}>
											<button
												type="button"
												className="home-reminder-check"
												onClick={() => onCompleteMemo(memo.id)}
												aria-label="完成"
											>
												<Check size={12} />
											</button>
											<span className="home-reminder-title" onClick={onOpenMemo}>
												{memo.title}
											</span>
											{reminderTime ? (
												<span className="home-reminder-due">{formatDueLabel(reminderTime)}</span>
											) : null}
										</div>
									);
								})}
							</div>
						)}
					</section>

					{quickGrid}
				</div>

				{hasConvo ? (
					<>
						<div className="home-cards-shield" style={{ height: `${cardsH + 36}px` }} aria-hidden />
						<div
							className="home-convo"
							role="button"
							tabIndex={0}
							title="点击展开为完整对话"
							onClick={handleExpand}
							onKeyDown={(event) => {
								if (event.key === "Enter") handleExpand();
							}}
						>
							<div className="home-convo-scroll" ref={scrollRef} style={cardsVar}>
								<ConversationThread
									messages={snapshot.messages}
									isRunning={snapshot.isRunning}
									streamingText={snapshot.streamingText}
								/>
							</div>
							<div className="home-convo-frost" style={cardsVar} aria-hidden />
							<div className="home-convo-hint">
								点击展开为完整对话 <ChevronRight size={12} />
							</div>
						</div>
					</>
				) : null}
			</div>

			<div className="home-composer-wrap">
				{hasConvo ? null : (
					<div className="home-suggestions">
						{SUGGESTIONS.map((suggestion) => (
							<button
								key={suggestion}
								type="button"
								className="home-suggestion"
								onClick={() => submit(suggestion)}
							>
								{suggestion}
							</button>
						))}
					</div>
				)}
				<div
					className={`home-composer${voiceComposerClass(snapshot.voiceOverlay.state)}`}
					onDragOver={(event) => {
						if (event.dataTransfer.types.includes("Files")) event.preventDefault();
					}}
					onDrop={(event) => {
						const next = attachmentsFromFiles(event.dataTransfer.files);
						if (next.length === 0) return;
						event.preventDefault();
						addAttachments(next);
					}}
				>
					{attachments.length > 0 ? (
						<div className="attachment-list" aria-label="待发送附件">
							{attachments.map((attachment) => (
								<div className="attachment-chip" key={attachment.id} title={attachment.path}>
									<FileText size={13} />
									<span className="attachment-name">{attachment.name}</span>
									<span className="attachment-meta">
										{attachment.kind ?? "file"}
										{attachment.sizeBytes > 0 ? ` · ${formatAttachmentSize(attachment.sizeBytes)}` : ""}
									</span>
									<button
										type="button"
										aria-label={`移除 ${attachment.name}`}
										title="移除附件"
										onClick={() => removeAttachment(attachment.id)}
									>
										<X size={12} />
									</button>
								</div>
							))}
						</div>
					) : null}
					<div className="home-composer-row">
						<textarea
							ref={textareaRef}
							value={text}
							placeholder="问我任何事，回车开始新对话…"
							rows={1}
							onChange={(event) => setText(event.target.value)}
							onPaste={(event) => {
								const fileAttachments = attachmentsFromFiles(event.clipboardData.files);
								const textAttachments =
									fileAttachments.length === 0
										? attachmentsFromText(event.clipboardData.getData("text/plain"))
										: [];
								const next = [...fileAttachments, ...textAttachments];
								if (next.length === 0) return;
								event.preventDefault();
								addAttachments(next);
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									send();
								}
							}}
						/>
						<button type="button" className="home-mic" onClick={onStartVoice} aria-label="语音输入" title="语音输入">
							<Mic size={16} />
						</button>
						<button type="button" className="home-send" onClick={send} disabled={!canSend} aria-label="发送">
							<Send size={16} />
						</button>
					</div>
				</div>
			</div>
			{petConfig.enabled && petLayerActive ? (
				<PetLayer
					config={petConfig}
					engineRef={petEngineRef}
					messageCount={snapshot.messages.length}
					hostSelector=".home-screen"
					terrainSelectors={{
						thread: ".home-live",
						composer: ".home-composer",
						bubble: ".home-convo .bubble",
					}}
				/>
			) : null}
		</div>
	);
}
