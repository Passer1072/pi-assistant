import { BellRing, Brain, Check, ChevronDown, ChevronUp, FileText, Loader2, Mic, Send, Sparkles, Square, Volume2, X } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
	DesktopAssistantSnapshot,
	PendingConfirmation,
	PendingPromptAttachment,
	WakeWordModelMetadata,
	WindowMode,
} from "../../../src/shared/types.ts";
import { attachmentsFromFiles, attachmentsFromText, formatAttachmentSize } from "./attachments.ts";
import { buildDisplayItems, type DisplayItem } from "../display-items.ts";
import { PetLayer, type PetLayerHandle } from "../pet/PetLayer.tsx";
import type { PetConfig } from "../pet/types.ts";
import { TitleBar } from "../components/TitleBar.tsx";
import { voiceToneLabels, voiceToneOf } from "../voice-ui.ts";
import { buildVirtualListLayout, calculateVirtualWindowFromLayout } from "./virtual-list.ts";
import {
	DisplayItemRow as SharedDisplayItemRow,
	displayItemKey as sharedDisplayItemKey,
	formatTokenCount,
	LiveAssistantResponse,
	TimelineStrip as SharedTimelineStrip,
} from "./ConversationDisplay.tsx";

function formatContextUsage(snapshot: DesktopAssistantSnapshot): string | undefined {
	const usage = snapshot.contextUsage;
	if (!usage) return undefined;
	const windowText = formatTokenCount(usage.contextWindow);
	const cacheText =
		usage.cacheHitRatio !== null && usage.cacheHitRatio !== undefined
			? ` · 缓存命中 ${(usage.cacheHitRatio * 100).toFixed(0)}%`
			: "";
	if (usage.tokens === null || usage.percent === null) {
		return `上下文：已压缩，等待下次回复更新 / ${windowText}${cacheText}`;
	}
	return `上下文：${formatTokenCount(usage.tokens)} / ${windowText} (${usage.percent.toFixed(1)}%)${cacheText}`;
}

const THREAD_BOTTOM_THRESHOLD_PX = 48;
const THREAD_ITEM_GAP_PX = 10;
const VIRTUAL_ITEM_ESTIMATED_HEIGHT_PX = 92;
const VIRTUAL_OVERSCAN_PX = 720;
const VIRTUALIZATION_THRESHOLD = 80;

function isThreadAtBottom(el: HTMLElement): boolean {
	return el.scrollHeight - el.scrollTop - el.clientHeight <= THREAD_BOTTOM_THRESHOLD_PX;
}

function VirtualChatList({
	items,
	scrollTop,
	viewportHeight,
	threadVersion,
	expandedTools,
	expandedThinking,
	onToggleTool,
	onToggleThinking,
}: {
	items: DisplayItem[];
	scrollTop: number;
	viewportHeight: number;
	threadVersion: number;
	expandedTools: Set<string>;
	expandedThinking: Set<string>;
	onToggleTool: (id: string) => void;
	onToggleThinking: (id: string) => void;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	const itemRefs = useRef(new Map<string, HTMLDivElement>());
	const measuredHeightsRef = useRef(new Map<string, number>());
	const [measurementVersion, setMeasurementVersion] = useState(0);
	const useVirtualization = items.length > VIRTUALIZATION_THRESHOLD;
	const virtualItems = useMemo(() => items.map((item) => ({ key: sharedDisplayItemKey(item) })), [items]);
	const [listTop, setListTop] = useState(0);
	const virtualLayout = useMemo(
		() =>
			buildVirtualListLayout({
				items: virtualItems,
				measuredHeights: measuredHeightsRef.current,
				estimatedItemHeight: VIRTUAL_ITEM_ESTIMATED_HEIGHT_PX,
				gap: THREAD_ITEM_GAP_PX,
			}),
		[measurementVersion, virtualItems],
	);

	useLayoutEffect(() => {
		const list = listRef.current;
		const thread = list?.closest(".thread");
		if (!list || !(thread instanceof HTMLElement)) {
			setListTop(0);
			return;
		}
		setListTop(list.offsetTop);
	}, [threadVersion, items.length]);

	const virtualWindow = useMemo(
		() =>
			useVirtualization
				? calculateVirtualWindowFromLayout({
						layout: virtualLayout,
						scrollTop,
						viewportHeight,
						listTop,
						overscan: VIRTUAL_OVERSCAN_PX,
					})
				: {
						startIndex: 0,
						endIndex: items.length,
						topSpacerHeight: 0,
						bottomSpacerHeight: 0,
						totalHeight: 0,
					},
		[items.length, listTop, scrollTop, useVirtualization, viewportHeight, virtualLayout],
	);
	const visibleItems = items.slice(virtualWindow.startIndex, virtualWindow.endIndex);

	useLayoutEffect(() => {
		if (!useVirtualization) return;
		let changed = false;
		for (const [key, node] of itemRefs.current) {
			const height = node.getBoundingClientRect().height;
			const previous = measuredHeightsRef.current.get(key);
			if (height > 0 && (previous === undefined || Math.abs(previous - height) > 1)) {
				measuredHeightsRef.current.set(key, height);
				changed = true;
			}
		}
		if (changed) setMeasurementVersion((version) => version + 1);
	}, [useVirtualization, visibleItems]);

	const setItemRef = useCallback(
		(key: string) => (node: HTMLDivElement | null) => {
			if (node) {
				itemRefs.current.set(key, node);
			} else {
				itemRefs.current.delete(key);
			}
		},
		[],
	);

	return (
		<div ref={listRef} className={useVirtualization ? "virtual-chat-list virtualized" : "virtual-chat-list"}>
			{virtualWindow.topSpacerHeight > 0 ? (
				<div className="virtual-chat-spacer" style={{ height: virtualWindow.topSpacerHeight }} />
			) : null}
			{visibleItems.map((item) => {
				const key = sharedDisplayItemKey(item);
				return (
					<div key={key} ref={setItemRef(key)} className="virtual-chat-item">
						<SharedDisplayItemRow
							item={item}
							expandedTools={expandedTools}
							expandedThinking={expandedThinking}
							onToggleTool={onToggleTool}
							onToggleThinking={onToggleThinking}
						/>
					</div>
				);
			})}
			{virtualWindow.bottomSpacerHeight > 0 ? (
				<div className="virtual-chat-spacer" style={{ height: virtualWindow.bottomSpacerHeight }} />
			) : null}
		</div>
	);
}

const MemoVirtualChatList = memo(VirtualChatList);

function ApprovalPanel({
	items,
	onApprove,
	onReject,
}: {
	items: PendingConfirmation[];
	onApprove: (id: string) => void;
	onReject: (id: string) => void;
}) {
	if (!items.length) return null;
	return (
		<section className="approval-panel">
			<header>
				<strong>等待批准</strong>
				<span>{items.length} 个命令需要确认</span>
			</header>
			<div className="approval-items-scroll">
			{items.map((item) => (
				<div className="approval-item" key={item.id}>
					<div>
						<strong>{item.intent}</strong>
						<p>
							{item.action} {item.target}
						</p>
						<small>风险级别：{item.riskLevel}</small>
					</div>
					<div className="approval-actions">
						<button className="approve-btn" type="button" onClick={() => onApprove(item.id)}>
							<Check size={14} />
							批准
						</button>
						<button className="reject-btn" type="button" onClick={() => onReject(item.id)}>
							<X size={14} />
							拒绝
						</button>
					</div>
				</div>
			))}
			</div>
		</section>
	);
}

export function ChatView({
	snapshot,
	prompt,
	attachments,
	viewingHistory,
	loadingHistory,
	loadingEarlierHistory,
	wakeModels,
	petConfig,
	petEngineRef,
	petLayerActive,
	setPrompt,
	onAddAttachments,
	onRemoveAttachment,
	onToggleConversationThinking,
	onSend,
	onStartVoice,
	onAbort,
	onMenu,
	onOpenMemo,
	windowMode,
	onToggleWindowMode,
	onLoadEarlierHistory,
	onApprove,
	onReject,
}: {
	snapshot: DesktopAssistantSnapshot;
	prompt: string;
	attachments: PendingPromptAttachment[];
	viewingHistory: boolean;
	loadingHistory: boolean;
	loadingEarlierHistory: boolean;
	wakeModels: WakeWordModelMetadata[];
	petConfig: PetConfig;
	petEngineRef: PetLayerHandle;
	petLayerActive: boolean;
	setPrompt: (p: string) => void;
	onAddAttachments: (attachments: PendingPromptAttachment[]) => void;
	onRemoveAttachment: (id: string) => void;
	onToggleConversationThinking: (enabled: boolean) => Promise<DesktopAssistantSnapshot | undefined> | void;
	onSend: () => void;
	onStartVoice: () => void;
	onAbort: () => void;
	onMenu: () => void;
	onOpenMemo: () => void;
	windowMode: WindowMode;
	onToggleWindowMode: () => void;
	onLoadEarlierHistory: () => void;
	onApprove: (id: string) => void;
	onReject: (id: string) => void;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const prependScrollAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | undefined>(undefined);
	const wasLoadingEarlierHistoryRef = useRef(false);
	const skipNextAutoScrollRef = useRef(false);
	const isFollowingLatestRef = useRef(true);
	const suppressStreamingAutoScrollRef = useRef(false);
	const [showJumpToLatest, setShowJumpToLatest] = useState(false);
	const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
	const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set());
	const [liveThinkingExpanded, setLiveThinkingExpanded] = useState(true);
	const previousStreamingTextRef = useRef(snapshot.streamingText);
	const previousStreamingThinkingRef = useRef(snapshot.streamingThinking);
	const previousIsAnsweringRef = useRef(snapshot.isRunning || loadingHistory);
	const [threadScrollState, setThreadScrollState] = useState({ scrollTop: 0, viewportHeight: 0, version: 0 });
	const [memoBannerDismissed, setMemoBannerDismissed] = useState(false);

	// 输入框随内容自然增高，最多 6 行；第 7 行起停止增高并显示滚动条。
	useLayoutEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		const MAX_ROWS = 6;
		el.style.height = "auto";
		const style = window.getComputedStyle(el);
		const lineHeight = parseFloat(style.lineHeight);
		const paddingTop = parseFloat(style.paddingTop);
		const paddingBottom = parseFloat(style.paddingBottom);
		const borderTop = parseFloat(style.borderTopWidth);
		const borderBottom = parseFloat(style.borderBottomWidth);
		const maxHeight = lineHeight * MAX_ROWS + paddingTop + paddingBottom + borderTop + borderBottom;
		el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
		el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
	}, [prompt]);

	const toggleTool = useCallback((id: string) => {
		setExpandedTools((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const toggleThinking = useCallback((id: string) => {
		setExpandedThinking((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const displayItems = useMemo(
		() => (loadingHistory ? [] : buildDisplayItems(snapshot.messages, snapshot.timeline)),
		[loadingHistory, snapshot.messages, snapshot.timeline],
	);
	const hasMessages = snapshot.messages.length > 0;

	const updateThreadScrollState = (el: HTMLDivElement) => {
		setThreadScrollState((current) => {
			const next = {
				scrollTop: el.scrollTop,
				viewportHeight: el.clientHeight,
				version: current.version + 1,
			};
			if (current.scrollTop === next.scrollTop && current.viewportHeight === next.viewportHeight) {
				return current;
			}
			return next;
		});
	};

	const setFollowMode = (next: boolean) => {
		isFollowingLatestRef.current = next;
		const shouldShowJump = !next && hasMessages;
		setShowJumpToLatest((current) => (current === shouldShowJump ? current : shouldShowJump));
	};

	const syncFollowModeFromScroll = (el: HTMLDivElement) => {
		setFollowMode(isThreadAtBottom(el));
	};

	const scrollToLatest = () => {
		const el = scrollRef.current;
		setFollowMode(true);
		if (el) {
			el.scrollTop = el.scrollHeight;
			updateThreadScrollState(el);
		}
	};

	useLayoutEffect(() => {
		setFollowMode(true);
		const el = scrollRef.current;
		if (el) {
			el.scrollTop = el.scrollHeight;
			updateThreadScrollState(el);
		}
	}, [snapshot.sessionId]);

	useLayoutEffect(() => {
		const el = scrollRef.current;
		const wasLoadingEarlierHistory = wasLoadingEarlierHistoryRef.current;
		if (el && loadingEarlierHistory && !wasLoadingEarlierHistory) {
			prependScrollAnchorRef.current = {
				scrollTop: el.scrollTop,
				scrollHeight: el.scrollHeight,
			};
		}
		if (el && !loadingEarlierHistory && wasLoadingEarlierHistory) {
			const anchor = prependScrollAnchorRef.current;
			if (anchor) {
				el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
				skipNextAutoScrollRef.current = true;
				syncFollowModeFromScroll(el);
				updateThreadScrollState(el);
			}
			prependScrollAnchorRef.current = undefined;
		}
		wasLoadingEarlierHistoryRef.current = loadingEarlierHistory;
	}, [displayItems.length, loadingEarlierHistory]);

	useLayoutEffect(() => {
		if (loadingEarlierHistory) return;
		if (!isFollowingLatestRef.current) return;
		const el = scrollRef.current;
		if (!el) return;
		const id = requestAnimationFrame(() => {
			if (!isFollowingLatestRef.current) return;
			suppressStreamingAutoScrollRef.current = true;
			el.scrollTop = el.scrollHeight;
			requestAnimationFrame(() => {
				suppressStreamingAutoScrollRef.current = false;
			});
		});
		return () => cancelAnimationFrame(id);
	}, [snapshot.streamingText, snapshot.streamingThinking, loadingEarlierHistory]);

	useLayoutEffect(() => {
		if (loadingEarlierHistory) return;
		if (skipNextAutoScrollRef.current) {
			skipNextAutoScrollRef.current = false;
			const el = scrollRef.current;
			if (el) {
				syncFollowModeFromScroll(el);
				updateThreadScrollState(el);
			}
			return;
		}
		const el = scrollRef.current;
		if (!el) return;
		if (isFollowingLatestRef.current) {
			el.scrollTop = el.scrollHeight;
			setFollowMode(true);
			updateThreadScrollState(el);
			return;
		}
		syncFollowModeFromScroll(el);
		updateThreadScrollState(el);
	}, [
		displayItems.length,
		snapshot.isRunning,
		snapshot.pendingConfirmations.length,
		loadingEarlierHistory,
	]);

	const handleThreadScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		if (
			suppressStreamingAutoScrollRef.current ||
			((snapshot.streamingText || snapshot.streamingThinking) && isFollowingLatestRef.current && isThreadAtBottom(el))
		) {
			suppressStreamingAutoScrollRef.current = false;
			return;
		}
		syncFollowModeFromScroll(el);
		updateThreadScrollState(el);
		if (loadingHistory || loadingEarlierHistory || !snapshot.historyWindow?.hasMoreBefore) return;
		if (el.scrollTop < 120) {
			onLoadEarlierHistory();
		}
	};

	const isAnswering = snapshot.isRunning || loadingHistory;
	useEffect(() => {
		const previousStreamingText = previousStreamingTextRef.current;
		const previousStreamingThinking = previousStreamingThinkingRef.current;
		const previousIsAnswering = previousIsAnsweringRef.current;
		if ((!previousIsAnswering && isAnswering) || (!previousStreamingThinking && snapshot.streamingThinking)) {
			setLiveThinkingExpanded(true);
		}
		if (!previousStreamingText && snapshot.streamingText) {
			setLiveThinkingExpanded(false);
		}
		previousStreamingTextRef.current = snapshot.streamingText;
		previousStreamingThinkingRef.current = snapshot.streamingThinking;
		previousIsAnsweringRef.current = isAnswering;
	}, [isAnswering, snapshot.streamingText, snapshot.streamingThinking]);
	const canSend = prompt.trim().length > 0 || attachments.length > 0;
	const conversationThinking = snapshot.conversationThinking;
	const thinkingSupported = conversationThinking.supported;
	const voiceTone = voiceToneOf(snapshot.voiceOverlay.state);
	const contextUsageText = formatContextUsage(snapshot);
	const voiceComposerClass =
		voiceTone === "capturing"
			? " voice-capturing"
			: voiceTone === "processing"
				? " voice-processing"
				: voiceTone === "error"
					? " voice-error"
					: "";

	return (
		<div className="screen chat-screen">
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
			<div className="thread" ref={scrollRef} onScroll={handleThreadScroll}>
				{(() => {
					const due = (snapshot.memoSummary?.overdueCount ?? 0) + (snapshot.memoSummary?.dueTodayCount ?? 0);
					if (due === 0 || memoBannerDismissed) return null;
					const overdue = snapshot.memoSummary?.overdueCount ?? 0;
					return (
						<div className="chat-memo-banner" onClick={onOpenMemo}>
							<BellRing size={14} />
							<span className="chat-memo-banner-text">
								{overdue > 0 ? `有 ${overdue} 项待办已逾期` : `今天有 ${due} 项待办`}，点击查看
							</span>
							<button
								type="button"
								className="chat-memo-banner-close"
								onClick={(event) => {
									event.stopPropagation();
									setMemoBannerDismissed(true);
								}}
								aria-label="关闭提醒"
							>
								<X size={13} />
							</button>
						</div>
					);
				})()}
				{loadingHistory ? (
					<div className="history-loading">
						<Loader2 size={14} className="spin" />
						<span>正在加载历史会话...</span>
					</div>
				) : null}
				{!loadingHistory && snapshot.historyWindow?.hasMoreBefore ? (
					<div className="history-load-more">
						<button type="button" onClick={onLoadEarlierHistory} disabled={loadingEarlierHistory}>
							{loadingEarlierHistory ? <Loader2 size={12} className="spin" /> : <ChevronUp size={12} />}
							<span>{loadingEarlierHistory ? "正在加载..." : "加载更早消息"}</span>
						</button>
					</div>
				) : null}
				{viewingHistory ? <div className="history-banner">当前正在这个历史会话中继续交流。</div> : null}
				{!hasMessages ? (
					<div className="welcome">
						<div className="welcome-icon">
							<Sparkles size={28} />
						</div>
						<h2>你好，我是 Pi</h2>
						<p>自然语言控制 Windows 桌面。系统操作会优先用后台命令完成，设置页只在需要时打开。</p>
						<div className="suggest-chips">
							<button type="button" onClick={() => setPrompt("帮我打开记事本")}>
								打开记事本
							</button>
							<button type="button" onClick={() => setPrompt("调整系统音频")}>
								音频控制
							</button>
							<button type="button" onClick={() => setPrompt("把音量调到 30%")}>
								音量 30%
							</button>
						</div>
					</div>
				) : null}

				{displayItems.length > 0 ? (
					<MemoVirtualChatList
						items={displayItems}
						scrollTop={threadScrollState.scrollTop}
						viewportHeight={threadScrollState.viewportHeight}
						threadVersion={threadScrollState.version}
						expandedTools={expandedTools}
						expandedThinking={expandedThinking}
						onToggleTool={toggleTool}
						onToggleThinking={toggleThinking}
					/>
				) : null}

				<ApprovalPanel items={snapshot.pendingConfirmations} onApprove={onApprove} onReject={onReject} />

				<LiveAssistantResponse
					isRunning={isAnswering}
					streamingText={snapshot.streamingText}
					streamingThinking={snapshot.streamingThinking}
					liveThinkingExpanded={liveThinkingExpanded}
					onToggleLiveThinking={() => setLiveThinkingExpanded((current) => !current)}
				/>

				<SharedTimelineStrip items={snapshot.timeline} />
				{contextUsageText ? <div className="context-usage-footer">{contextUsageText}</div> : null}
			</div>
			{showJumpToLatest ? (
				<button type="button" className="jump-to-latest" onClick={scrollToLatest} aria-label="回到最新消息" title="回到最新消息">
					<ChevronDown size={14} />
					<span>最新消息</span>
				</button>
			) : null}

			<form
				className={`composer${voiceComposerClass}`}
				onSubmit={(event) => {
					event.preventDefault();
					if (isAnswering) {
						onAbort();
					} else {
						onSend();
					}
				}}
				onDragOver={(event) => {
					if (isAnswering) return;
					if (event.dataTransfer.types.includes("Files")) {
						event.preventDefault();
					}
				}}
				onDrop={(event) => {
					if (isAnswering) return;
					const next = attachmentsFromFiles(event.dataTransfer.files);
					if (next.length === 0) return;
					event.preventDefault();
					onAddAttachments(next);
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
									onClick={() => onRemoveAttachment(attachment.id)}
								>
									<X size={12} />
								</button>
							</div>
						))}
					</div>
				) : null}
				<textarea
					ref={textareaRef}
					value={prompt}
					onChange={(event) => setPrompt(event.target.value)}
					onPaste={(event) => {
						if (isAnswering) return;
						const fileAttachments = attachmentsFromFiles(event.clipboardData.files);
						const textAttachments =
							fileAttachments.length === 0 ? attachmentsFromText(event.clipboardData.getData("text/plain")) : [];
						const next = [...fileAttachments, ...textAttachments];
						if (next.length === 0) return;
						event.preventDefault();
						onAddAttachments(next);
					}}
					placeholder={
						isAnswering
							? "正在回答中…按 Esc 或点击停止以中断"
							: snapshot.authStatus.configured
								? "向 Pi 提问或下达任务..."
								: "请先在设置中配置 API Key"
					}
					rows={1}
					onKeyDown={(event) => {
						if (event.key === "Escape" && isAnswering) {
							event.preventDefault();
							onAbort();
							return;
						}
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							if (!isAnswering && canSend) onSend();
						}
					}}
				/>
				<div className="composer-bar">
					<div className="composer-left">
						<button type="button" className="circle-btn" onClick={onStartVoice} aria-label="语音输入" title="语音输入">
							<Mic size={15} />
						</button>
						<span className={`status-pill ${isAnswering ? "answering" : ""}`}>
							{isAnswering ? (
								<>
									<Loader2 size={11} className="spin" />
									<span>正在回答…</span>
								</>
							) : (
								<>
									<Volume2 size={11} />
									<span>{voiceToneLabels[voiceToneOf(snapshot.voiceOverlay.state)]}</span>
								</>
							)}
						</span>
					</div>
					<button
						type="button"
						className={`conversation-thinking-toggle ${conversationThinking.enabled ? "on" : ""}`}
						disabled={!thinkingSupported}
						onClick={() => void onToggleConversationThinking(!conversationThinking.enabled)}
						aria-pressed={conversationThinking.enabled}
						aria-label={thinkingSupported ? "切换深度思考" : "当前模型不支持深度思考"}
						title={
							thinkingSupported
								? conversationThinking.enabled
									? "深度思考已开启：后续消息使用 high"
									: "深度思考已关闭：后续消息不使用深度思考"
								: "当前模型不支持深度思考"
						}
					>
						<Brain size={13} />
						<span>{conversationThinking.enabled ? "深度思考开" : "深度思考关"}</span>
					</button>
					<button
						type="submit"
						className={`send-btn ${isAnswering ? "stop" : ""}`}
						disabled={loadingHistory || (!isAnswering && !canSend)}
						aria-label={isAnswering ? "停止" : "发送"}
						title={isAnswering ? "停止当前回答（Esc）" : "发送"}
					>
						{isAnswering ? <Square size={14} fill="currentColor" /> : <Send size={15} />}
					</button>
				</div>
			</form>
			{petConfig.enabled && petLayerActive ? (
				<PetLayer config={petConfig} engineRef={petEngineRef} messageCount={snapshot.messages.length} />
			) : null}
		</div>
	);
}
