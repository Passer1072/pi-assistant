import type { ApiConnectionMode, DesktopAssistantSettings } from "./types.ts";

export const DEEPSEEK_OFFICIAL_API_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_DEEPSEEK_RELAY_URL = "https://www.dreamfield.top";
export const DEFAULT_DEEPSEEK_RELAY_API_BASE_URL = `${DEFAULT_DEEPSEEK_RELAY_URL}/v1`;

export interface DeepSeekApiConnection {
	mode: ApiConnectionMode;
	baseUrl: string;
}

export function normalizeApiConnectionMode(mode: unknown): ApiConnectionMode {
	return mode === "relay" ? "relay" : "official";
}

export function normalizeDeepSeekApiBaseUrl(mode: ApiConnectionMode, rawBaseUrl?: string): string {
	if (mode === "official") return DEEPSEEK_OFFICIAL_API_BASE_URL;

	const raw = rawBaseUrl?.trim() || DEFAULT_DEEPSEEK_RELAY_API_BASE_URL;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Invalid relay API URL: ${raw}`);
	}

	url.hash = "";
	url.search = "";
	let pathname = url.pathname.replace(/\/+$/g, "");
	pathname = pathname.replace(/\/chat\/completions$/i, "");
	if (!pathname || pathname === "/") {
		pathname = "/v1";
	} else if (!/\/v\d+(?:beta\d*)?$/i.test(pathname)) {
		pathname = `${pathname}/v1`;
	}
	url.pathname = pathname;
	return url.toString().replace(/\/$/g, "");
}

export function normalizeDeepSeekRelayModelId(rawModelId?: string): string | undefined {
	const trimmed = rawModelId?.trim();
	return trimmed || undefined;
}

export function resolveDeepSeekApiConnection(settings: DesktopAssistantSettings): DeepSeekApiConnection {
	const mode = normalizeApiConnectionMode(settings.apiConnectionMode);
	const baseUrl = normalizeDeepSeekApiBaseUrl(mode, settings.apiBaseUrl);
	return {
		mode,
		baseUrl,
	};
}
