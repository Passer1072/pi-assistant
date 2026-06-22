import { memo } from "react";
import type { ChatMessageView, TimelineItem } from "../../../src/shared/types.ts";
import { ConversationDisplay } from "./ConversationDisplay.tsx";

/**
 * Read-only conversation thread using the same message, timeline detail, and
 * streaming rendering as the full chat view.
 */
export const ConversationThread = memo(function ConversationThread({
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
	return (
		<ConversationDisplay
			messages={messages}
			timeline={timeline}
			isRunning={isRunning}
			streamingText={streamingText}
			streamingThinking={streamingThinking}
		/>
	);
});
