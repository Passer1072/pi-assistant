import type { ChatMessageView, ConversationHistoryEntry, TimelineItem } from "../../src/shared/types.ts";
import type { StoredConversation } from "./app-types.ts";

export function toStoredConversation(entry: ConversationHistoryEntry): StoredConversation {
	return {
		sessionId: entry.sessionId,
		title: entry.title,
		preview: entry.preview,
		updatedAt: entry.updatedAt,
		messageCount: entry.messageCount,
	};
}

export function mergeHistoryItems<T extends { id: string; order: number; timestamp: number }>(
	older: T[],
	current: T[],
): T[] {
	const byKey = new Map<string, T>();
	for (const item of [...older, ...current]) {
		byKey.set(`${item.id}:${item.order}`, item);
	}
	return [...byKey.values()].sort((left, right) => {
		if (left.order !== right.order) return left.order - right.order;
		return left.timestamp - right.timestamp;
	});
}
