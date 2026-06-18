import { Brain, Check, ChevronDown, ChevronUp, FileText, Loader2, Mic, Send, Sparkles, Square, Volume2, X } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
	ChatMessageView,
	DesktopAssistantSnapshot,
	PendingConfirmation,
	PendingPromptAttachment,
	PromptAttachmentKind,
	TimelineItem,
	WakeWordModelMetadata,
	WindowMode,
} from "../../../src/shared/types.ts";
import { AssistantMessageMarkdown } from "../AssistantMessageMarkdown.tsx";
import { buildDisplayItems, type DisplayItem } from "../display-items.ts";
import { PetLayer, type PetLayerHandle } from "../pet/PetLayer.tsx";
import type { PetConfig } from "../pet/types.ts";
import { TitleBar } from "../components/TitleBar.tsx";
import { voiceToneLabels, voiceToneOf } from "../voice-ui.ts";
import { buildVirtualListLayout, calculateVirtualWindowFromLayout } from "./virtual-list.ts";

function formatToolName(rawTitle: string): string {
	const m = rawTitle.match(/Tool (?:started|finished|running):\s*(.+)/i);
	const name = m ? m[1] : rawTitle;
	return name.replace(/_/g, " ");
}

function inferAttachmentKind(name: string, mimeType?: string): PromptAttachmentKind {
	const lowerName = name.toLowerCase();
	if (lowerName.endsWith(".docx") || lowerName.endsWith(".doc")) return "word";
	if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls") || lowerName.endsWith(".xlsm")) return "excel";
	if (lowerName.endsWith(".pptx") || lowerName.endsWith(".ppt")) return "powerpoint";
	if (lowerName.endsWith(".pdf")) return "pdf";
	if (mimeType?.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return "image";
	if (
		mimeType?.startsWith("text/") ||
		/\.(txt|md|markdown|json|jsonl|csv|tsv|log|xml|html?|css|jsx?|tsx?|py|ps1|ya?ml|toml|ini)$/i.test(name)
	) {
		return "text";
	}
	return "unknown";
}

function formatAttachmentSize(sizeBytes: number): string {
	if (sizeBytes < 1024) return `${sizeBytes} B`;
	if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
	return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}K`;
	return tokens.toLocaleString();
}

type TokenUsageDisplay = { total: number; input: number; output: number; cacheRead: number; cacheWrite: number };

function formatMessageTokenUsage(message: { tokenUsage?: TokenUsageDisplay; turnTokenUsage?: TokenUsageDisplay }): string | undefined {
	const usage = message.tokenUsage;
	const parts: string[] = [];
	if (usage) {
		parts.push(`本次响应 ${formatTokenCount(usage.total)} tokens`);
	}
	if (message.turnTokenUsage && (!usage || message.turnTokenUsage.total !== usage.total)) {
		parts.push(`本轮合计 ${formatTokenCount(message.turnTokenUsage.total)} tokens`);
	}
	if (!usage) return parts.length > 0 ? parts.join(" · ") : undefined;
	parts.push(`输入 ${formatTokenCount(usage.input + usage.cacheRead + usage.cacheWrite)}`);
	parts.push(`输出 ${formatTokenCount(usage.output)}`);
	if (usage.cacheRead > 0) parts.push(`缓存读 ${formatTokenCount(usage.cacheRead)}`);
	if (usage.cacheWrite > 0) parts.push(`缓存写 ${formatTokenCount(usage.cacheWrite)}`);
	return parts.join(" · ");
}

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

function attachmentsFromFiles(files: Iterable<File>): PendingPromptAttachment[] {
	const attachments: PendingPromptAttachment[] = [];
	for (const file of files) {
		const path = window.desktopAssistant?.getPathForFile(file);
		if (!path) continue;
		attachments.push({
			id: crypto.randomUUID(),
			name: file.name,
			path,
			sizeBytes: file.size,
			mimeType: file.type || undefined,
			kind: inferAttachmentKind(file.name, file.type || undefined),
		});
	}
	return attachments;
}

function attachmentsFromText(text: string): PendingPromptAttachment[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /^[a-z]:\\.+\.[^\\/:*?"<>|]+$/i.test(line) || /^\\\\[^\\]+\\.+/i.test(line))
		.map((path) => ({
			id: crypto.randomUUID(),
			name: path.split(/[\\/]/).pop() ?? path,
			path,
			sizeBytes: 0,
			kind: inferAttachmentKind(path),
		}));
}

interface ToolDetail {
	preview: string; // one-line summary for collapsed state
	full: string; // full content shown when expanded
}

/**
 * Extract human-readable preview and full content from a timeline item's detail JSON.
 * detail is JSON.stringify(event.result) for end events → has .details.{stdout,stderr,target}
 * detail is JSON.stringify(event.args)  for start events → has raw tool params
 */
function parseToolDetail(detail: string | undefined): ToolDetail {
	if (!detail) return { preview: "", full: "" };
	try {
		const parsed = JSON.parse(detail) as Record<string, unknown>;

		// Completed result format: { content:[...], details: DesktopToolResult }
		const d = parsed.details as Record<string, unknown> | undefined;
		if (d && typeof d === "object") {
			const target = String(d.target ?? "").trim();
			const stdout = String(d.stdout ?? "").trim();
			const stderr = String(d.stderr ?? "").trim();
			const intent = String(d.intent ?? "").trim();

			// One-line preview: prefer target (the command/path/query)
			const previewSource = target || stdout.split("\n")[0] || intent;
			const preview = previewSource.replace(/[\r\n]+/g, " ").slice(0, 120);

			// Full detail
			const sections: string[] = [];
			if (intent && intent !== target) sections.push(`意图: ${intent}`);
			if (target) sections.push(`目标: ${target}`);
			if (stdout) sections.push(`输出:\n${stdout}`);
			if (stderr) sections.push(`错误:\n${stderr}`);
			return { preview, full: sections.join("\n\n") || target };
		}

		// Args format (tool not yet completed or start event)
		for (const key of ["script", "command", "content", "query", "path", "app", "url", "data", "slides"]) {
			if (key in parsed) {
				const val = String(parsed[key]);
				return { preview: val.replace(/[\r\n]+/g, " ").slice(0, 120), full: val };
			}
		}

		const json = JSON.stringify(parsed, null, 2);
		return { preview: json.slice(0, 120).replace(/[\r\n]+/g, " "), full: json };
	} catch {
		return { preview: detail.slice(0, 120).replace(/[\r\n]+/g, " "), full: detail };
	}
}

function ToolCallEntry({
	item,
	expanded,
	onToggle,
}: {
	item: TimelineItem;
	expanded: boolean;
	onToggle: () => void;
}) {
	const name = formatToolName(item.title);
	const detail = expanded ? parseToolDetail(item.detail) : { full: "" };

	return (
		<div className={`tool-call-item ${item.status}`}>
			<button className="tool-call-header" type="button" onClick={onToggle} aria-expanded={expanded}>
				<span className="tool-call-icon">
					{item.status === "running" ? (
						<Loader2 size={12} className="spin" />
					) : item.status === "succeeded" ? (
						<Check size={12} />
					) : item.status === "failed" ? (
						<X size={12} />
					) : (
						<Square size={12} />
					)}
				</span>
				<span className="tool-call-name">{name}</span>
				<span className="tool-call-chevron">
					{expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
				</span>
			</button>
			{expanded && (
				<div className="tool-call-body">
					<pre>{detail.full || item.detail || "(无详情)"}</pre>
				</div>
			)}
		</div>
	);
}

const MemoToolCallEntry = memo(ToolCallEntry);

// ─────────────────────────────────────────────────────────────────────────────

function ThinkingDots() {
	return (
		<div className="thinking-dots" aria-label="思考中">
			<span />
			<span />
			<span />
		</div>
	);
}

function TimelineStrip({ items }: { items: TimelineItem[] }) {
	// Exclude thinking_summary: it's internal reasoning detail and its "running"
	// state can outlive the agent turn due to no completion event being emitted.
	const display = items.filter((item) => item.kind !== "thinking_summary" && item.kind !== "compaction");
	if (!display.length) return null;
	return (
		<div className="timeline-strip">
			{display.slice(-3).map((item) => (
				<div key={item.id + item.timestamp} className={`tl-pill ${item.status}`}>
					{item.status === "running" ? (
						<Loader2 className="spin" size={12} />
					) : item.status === "succeeded" ? (
						<Check size={12} />
					) : item.status === "failed" ? (
						<X size={12} />
					) : (
						<Square size={12} />
					)}
					<span>{item.title}</span>
				</div>
			))}
		</div>
	);
}

function ThreadNotice({ item }: { item: TimelineItem }) {
	return (
		<div className={`thread-notice ${item.kind} ${item.status}`}>
			<span className="thread-notice-line" />
			<span className="thread-notice-content">
				{item.status === "running" ? <Loader2 size={12} className="spin" /> : null}
				<span>{item.title}</span>
			</span>
			<span className="thread-notice-line" />
		</div>
	);
}

const MemoThreadNotice = memo(ThreadNotice);

const MessageBubbleRow = memo(function MessageBubbleRow({ message }: { message: ChatMessageView }) {
	const tokenUsageText = message.role === "assistant" ? formatMessageTokenUsage(message) : undefined;
	return (
		<div className={`bubble-row ${message.role}`}>
			<div className={`bubble ${message.role}`}>
				{message.role === "assistant" ? (
					<div className="bubble-meta">
						<Sparkles size={11} />
						<span>助手</span>
					</div>
				) : null}
				{message.role === "assistant" ? (
					<AssistantMessageMarkdown text={message.text} />
				) : (
					<p>{message.text}</p>
				)}
				{tokenUsageText ? <div className="message-token-usage">{tokenUsageText}</div> : null}
			</div>
		</div>
	);
});

function displayItemKey(item: DisplayItem): string {
	if (item.kind === "message") return `message-${item.message.id}`;
	return `${item.kind}-${item.item.id}-${item.item.timestamp}`;
}

function VirtualChatList({
	items,
	scrollTop,
	viewportHeight,
	threadVersion,
	expandedTools,
	onToggleTool,
}: {
	items: DisplayItem[];
	scrollTop: number;
	viewportHeight: number;
	threadVersion: number;
	expandedTools: Set<string>;
	onToggleTool: (id: string) => void;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	const itemRefs = useRef(new Map<string, HTMLDivElement>());
	const measuredHeightsRef = useRef(new Map<string, number>());
	const [measurementVersion, setMeasurementVersion] = useState(0);
	const useVirtualization = items.length > VIRTUALIZATION_THRESHOLD;
	const virtualItems = useMemo(() => items.map((item) => ({ key: displayItemKey(item) })), [items]);
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
				const key = displayItemKey(item);
				return (
					<div key={key} ref={setItemRef(key)} className="virtual-chat-item">
						<DisplayItemRow item={item} expandedTools={expandedTools} onToggleTool={onToggleTool} />
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

function DisplayItemRow({
	item,
	expandedTools,
	onToggleTool,
}: {
	item: DisplayItem;
	expandedTools: Set<string>;
	onToggleTool: (id: string) => void;
}) {
	if (item.kind === "notice") {
		return <MemoThreadNotice item={item.item} />;
	}
	if (item.kind === "tool") {
		const t = item.item;
		return (
			<div className="bubble-row assistant">
				<MemoToolCallEntry item={t} expanded={expandedTools.has(t.id)} onToggle={() => onToggleTool(t.id)} />
			</div>
		);
	}
	return <MessageBubbleRow message={item.message} />;
}

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
	setPrompt,
	onAddAttachments,
	onRemoveAttachment,
	onToggleConversationThinking,
	onSend,
	onStartVoice,
	onAbort,
	onMenu,
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
	setPrompt: (p: string) => void;
	onAddAttachments: (attachments: PendingPromptAttachment[]) => void;
	onRemoveAttachment: (id: string) => void;
	onToggleConversationThinking: (enabled: boolean) => Promise<DesktopAssistantSnapshot | undefined> | void;
	onSend: () => void;
	onStartVoice: () => void;
	onAbort: () => void;
	onMenu: () => void;
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
	const [threadScrollState, setThreadScrollState] = useState({ scrollTop: 0, viewportHeight: 0, version: 0 });

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
	}, [snapshot.streamingText, loadingEarlierHistory]);

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
			(snapshot.streamingText && isFollowingLatestRef.current && isThreadAtBottom(el))
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
						onToggleTool={toggleTool}
					/>
				) : null}

				<ApprovalPanel items={snapshot.pendingConfirmations} onApprove={onApprove} onReject={onReject} />

				{isAnswering ? (
					<div className="bubble-row assistant">
						<div className="bubble assistant">
							{snapshot.streamingText ? (
								<>
									<div className="bubble-meta">
										<Sparkles size={11} />
										<span>助手</span>
									</div>
									<p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{snapshot.streamingText}</p>
									<span className="streaming-cursor" />
								</>
							) : (
								<ThinkingDots />
							)}
						</div>
					</div>
				) : null}

				<TimelineStrip items={snapshot.timeline} />
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
			{petConfig.enabled ? (
				<PetLayer config={petConfig} engineRef={petEngineRef} messageCount={snapshot.messages.length} />
			) : null}
		</div>
	);
}
