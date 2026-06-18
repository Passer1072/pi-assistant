export const RETRYABLE_VOICE_STT_ERROR_MESSAGE = "语音识别网络连接中断，请重试。";

const RETRYABLE_VOICE_STT_ERROR_MARKERS = [
	RETRYABLE_VOICE_STT_ERROR_MESSAGE,
	"fetch failed",
	"ECONNRESET",
	"ETIMEDOUT",
	"ECONNREFUSED",
	"ENOTFOUND",
	"AbortError",
	"network socket disconnected",
	"secure TLS connection",
] as const;

export function isRetryableVoiceSttError(error: unknown): boolean {
	const text = collectErrorText(error).toLowerCase();
	return RETRYABLE_VOICE_STT_ERROR_MARKERS.some((marker) => text.includes(marker.toLowerCase()));
}

function collectErrorText(error: unknown, seen = new Set<unknown>()): string {
	if (error === undefined || error === null) return "";
	if (typeof error !== "object") return String(error);
	if (seen.has(error)) return "";
	seen.add(error);

	const record = error as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of ["name", "message", "code", "host"]) {
		const value = record[key];
		if (typeof value === "string") parts.push(value);
	}
	if (record.cause !== undefined) {
		parts.push(collectErrorText(record.cause, seen));
	}
	return parts.filter(Boolean).join(" ");
}
