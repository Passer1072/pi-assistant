import type { ApiKeyValidationStatus } from "../../src/shared/types.ts";

export function formatTime(ts: number): string {
	const diff = Date.now() - ts;
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	return new Date(ts).toLocaleDateString("zh-CN");
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatImportedAt(timestamp: number): string {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return "unknown";
	return new Date(timestamp).toLocaleDateString("zh-CN");
}

export function apiKeyStatusText(status: ApiKeyValidationStatus): string {
	if (status.state === "validating") return "正在验证 API Key...";
	if (status.state === "valid") return "API Key 验证成功，已安全保存到本机。";
	if (status.state === "invalid") return status.detail || "API Key 验证失败，请检查后重试。";
	if (status.code === "cleared") return "已清除本机保存的 API Key。";
	return "";
}
