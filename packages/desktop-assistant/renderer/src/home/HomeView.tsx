import {
	BellRing,
	Check,
	ChevronRight,
	FileText,
	MessageSquarePlus,
	Mic,
	Send,
	Settings as SettingsIcon,
	Sparkles,
	X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
	DesktopAssistantSnapshot,
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
						<div className="home-greeting">
							<span className="home-greeting-main">{greeting(now)}</span>
							<span className="home-greeting-wave">👋</span>
						</div>
						<p className="home-tagline">我是小派，你的桌面 AI 伙伴。说出你想做的，我来处理。</p>
						<p className="home-date">{formatToday(now)}</p>
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
