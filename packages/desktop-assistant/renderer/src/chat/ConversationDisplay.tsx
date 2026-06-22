import { Brain, Check, ChevronDown, ChevronUp, Loader2, Sparkles, Square, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessageView, TimelineItem } from "../../../src/shared/types.ts";
import { AssistantMessageMarkdown } from "../AssistantMessageMarkdown.tsx";
import { buildDisplayItems, type DisplayItem } from "../display-items.ts";

function formatToolName(rawTitle: string): string {
	const m = rawTitle.match(/Tool (?:started|finished|running):\s*(.+)/i);
	const name = m ? m[1] : rawTitle;
	return name.replace(/_/g, " ");
}

export function formatTokenCount(tokens: number): string {
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

interface ToolDetail {
	preview: string;
	full: string;
}

function parseToolDetail(detail: string | undefined): ToolDetail {
	if (!detail) return { preview: "", full: "" };
	try {
		const parsed = JSON.parse(detail) as Record<string, unknown>;
		const d = parsed.details as Record<string, unknown> | undefined;
		if (d && typeof d === "object") {
			const target = String(d.target ?? "").trim();
			const stdout = String(d.stdout ?? "").trim();
			const stderr = String(d.stderr ?? "").trim();
			const intent = String(d.intent ?? "").trim();
			const previewSource = target || stdout.split("\n")[0] || intent;
			const preview = previewSource.replace(/[\r\n]+/g, " ").slice(0, 120);
			const sections: string[] = [];
			if (intent && intent !== target) sections.push(`意图: ${intent}`);
			if (target) sections.push(`目标: ${target}`);
			if (stdout) sections.push(`输出:\n${stdout}`);
			if (stderr) sections.push(`错误:\n${stderr}`);
			return { preview, full: sections.join("\n\n") || target };
		}

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
			{expanded ? (
				<div className="tool-call-body">
					<pre>{detail.full || item.detail || "(无详情)"}</pre>
				</div>
			) : null}
		</div>
	);
}

const MemoToolCallEntry = memo(ToolCallEntry);

export function ThinkingBlock({
	text,
	expanded,
	onToggle,
	streaming,
}: {
	text: string;
	expanded: boolean;
	onToggle: () => void;
	streaming?: boolean;
}) {
	return (
		<div className={`thinking-block ${streaming ? "streaming" : "static"}`}>
			<button className="thinking-block-header" type="button" onClick={onToggle} aria-expanded={expanded}>
				<span className="thinking-block-icon">
					<Brain size={12} />
				</span>
				<span className="thinking-block-title">{streaming ? "思考中..." : "已深度思考"}</span>
				<span className="thinking-block-chevron">
					{expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
				</span>
			</button>
			{expanded ? (
				<div className="thinking-block-body">
					<pre>{text}{streaming ? <span className="streaming-cursor" /> : null}</pre>
				</div>
			) : null}
		</div>
	);
}

const MemoThinkingBlock = memo(ThinkingBlock);

export function ThinkingDots() {
	return (
		<div className="thinking-dots" aria-label="思考中">
			<span />
			<span />
			<span />
		</div>
	);
}

export function TimelineStrip({ items }: { items: TimelineItem[] }) {
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

export const MessageBubbleRow = memo(function MessageBubbleRow({
	message,
}: {
	message: ChatMessageView;
}) {
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

export function displayItemKey(item: DisplayItem): string {
	if (item.kind === "message") return `message-${item.message.id}`;
	return `${item.kind}-${item.item.id}-${item.item.timestamp}`;
}

export function DisplayItemRow({
	item,
	expandedTools,
	expandedThinking,
	onToggleTool,
	onToggleThinking,
}: {
	item: DisplayItem;
	expandedTools: Set<string>;
	expandedThinking: Set<string>;
	onToggleTool: (id: string) => void;
	onToggleThinking: (id: string) => void;
}) {
	if (item.kind === "notice") {
		return <MemoThreadNotice item={item.item} />;
	}
	if (item.kind === "thinking") {
		const t = item.item;
		return (
			<div className="bubble-row assistant">
				<MemoThinkingBlock
					text={t.detail ?? ""}
					expanded={expandedThinking.has(t.id)}
					onToggle={() => onToggleThinking(t.id)}
				/>
			</div>
		);
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

export function LiveAssistantResponse({
	isRunning,
	streamingText,
	streamingThinking,
	liveThinkingExpanded,
	onToggleLiveThinking,
}: {
	isRunning: boolean;
	streamingText: string;
	streamingThinking: string;
	liveThinkingExpanded: boolean;
	onToggleLiveThinking: () => void;
}) {
	if (!isRunning) return null;
	return (
		<div className="bubble-row assistant">
			<div className="bubble assistant">
				{streamingText ? (
					<>
						<div className="bubble-meta">
							<Sparkles size={11} />
							<span>助手</span>
						</div>
						{streamingThinking ? (
							<MemoThinkingBlock
								text={streamingThinking}
								expanded={liveThinkingExpanded}
								onToggle={onToggleLiveThinking}
							/>
						) : null}
						<p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{streamingText}</p>
						<span className="streaming-cursor" />
					</>
				) : (
					<>
						{streamingThinking ? (
							<MemoThinkingBlock
								streaming
								text={streamingThinking}
								expanded={liveThinkingExpanded}
								onToggle={onToggleLiveThinking}
							/>
						) : (
							<ThinkingDots />
						)}
					</>
				)}
			</div>
		</div>
	);
}

export function ConversationDisplay({
	messages,
	timeline = [],
	isRunning,
	streamingText,
	streamingThinking = "",
}: {
	messages: ChatMessageView[];
	timeline?: TimelineItem[];
	isRunning: boolean;
	streamingText: string;
	streamingThinking?: string;
}) {
	const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
	const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set());
	const [liveThinkingExpanded, setLiveThinkingExpanded] = useState(true);
	const previousStreamingTextRef = useRef(streamingText);
	const previousStreamingThinkingRef = useRef(streamingThinking);
	const previousIsRunningRef = useRef(isRunning);
	const displayItems = useMemo(() => buildDisplayItems(messages, timeline), [messages, timeline]);

	useEffect(() => {
		const previousStreamingText = previousStreamingTextRef.current;
		const previousStreamingThinking = previousStreamingThinkingRef.current;
		const previousIsRunning = previousIsRunningRef.current;
		if ((!previousIsRunning && isRunning) || (!previousStreamingThinking && streamingThinking)) {
			setLiveThinkingExpanded(true);
		}
		if (!previousStreamingText && streamingText) {
			setLiveThinkingExpanded(false);
		}
		previousStreamingTextRef.current = streamingText;
		previousStreamingThinkingRef.current = streamingThinking;
		previousIsRunningRef.current = isRunning;
	}, [isRunning, streamingText, streamingThinking]);

	const toggleTool = (id: string) => {
		setExpandedTools((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const toggleThinking = (id: string) => {
		setExpandedThinking((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	return (
		<>
			{displayItems.map((item) => (
				<DisplayItemRow
					key={displayItemKey(item)}
					item={item}
					expandedTools={expandedTools}
					expandedThinking={expandedThinking}
					onToggleTool={toggleTool}
					onToggleThinking={toggleThinking}
				/>
			))}
			<LiveAssistantResponse
				isRunning={isRunning}
				streamingText={streamingText}
				streamingThinking={streamingThinking}
				liveThinkingExpanded={liveThinkingExpanded}
				onToggleLiveThinking={() => setLiveThinkingExpanded((current) => !current)}
			/>
		</>
	);
}
