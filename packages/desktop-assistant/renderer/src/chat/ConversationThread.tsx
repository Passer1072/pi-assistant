import { Sparkles } from "lucide-react";
import { memo } from "react";
import type { ChatMessageView } from "../../../src/shared/types.ts";
import { AssistantMessageMarkdown } from "../AssistantMessageMarkdown.tsx";

/**
 * Lightweight read-only conversation thread (message bubbles + live streaming),
 * reusing the chat `.bubble-row`/`.bubble` styles. Used by the home page to show
 * the active conversation inline. Tool calls / thinking detail are intentionally
 * omitted here — that depth lives in the full chat view.
 */
export const ConversationThread = memo(function ConversationThread({
	messages,
	isRunning,
	streamingText,
}: {
	messages: ChatMessageView[];
	isRunning: boolean;
	streamingText: string;
}) {
	return (
		<>
			{messages.map((message) => (
				<div key={message.id} className={`bubble-row ${message.role}`}>
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
					</div>
				</div>
			))}
			{isRunning ? (
				<div className="bubble-row assistant">
					<div className="bubble assistant">
						<div className="bubble-meta">
							<Sparkles size={11} />
							<span>助手</span>
						</div>
						{streamingText ? (
							<p className="stream-text" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
								{/* Each character keyed by index so React only mounts (and fades in)
								    newly-streamed glyphs; already-shown ones never re-animate. */}
								{Array.from(streamingText).map((char, index) => (
									<span key={index} className="stream-char">
										{char}
									</span>
								))}
							</p>
						) : null}
						<span className="streaming-cursor" />
					</div>
				</div>
			) : null}
		</>
	);
});
