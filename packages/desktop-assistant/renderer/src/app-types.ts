export type Route = "home" | "chat" | "settings" | "memo";

export interface StoredConversation {
	sessionId: string;
	title: string;
	preview: string;
	updatedAt: number;
	messageCount: number;
}

export type AppWarningTone = "error" | "awaiting" | "completed";

export interface AppWarning {
	id: string;
	message: string;
	/** Visual tone + heading. Defaults to "error" (e.g. voice-recognition failure). */
	tone?: AppWarningTone;
	/** Optional override for the toast heading. */
	title?: string;
	/** When set, the toast is clickable and focuses this conversation. */
	sessionId?: string;
}
