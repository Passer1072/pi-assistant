import type { DesktopAssistantSettings, WindowMode } from "../../src/shared/types.ts";

export const SETTINGS_STORAGE_KEY = "pi-settings";
export const WINDOW_MODE_STORAGE_KEY = "pi-window-mode";
export const WINDOW_ALWAYS_ON_TOP_STORAGE_KEY = "pi-window-always-on-top";

export function persistSettings(settings: DesktopAssistantSettings): void {
	try {
		const persistable = {
			provider: settings.provider,
			apiConnectionMode: settings.apiConnectionMode,
			modelId: settings.modelId,
			thinkingLevel: settings.thinkingLevel,
			permissionMode: settings.permissionMode,
			capabilities: settings.capabilities,
			webSearch: settings.webSearch,
			voice: settings.voice,
			tokenSaving: settings.tokenSaving,
			// Browser settings are authoritative in the main process
			// (agent/browser-settings.json). Browser utility windows can update them
			// without touching this localStorage cache, so replaying a cached browser
			// block on startup would clobber shortcuts added from the built-in browser.
			// Sandbox config is intentionally NOT persisted here: it is authoritative in
			// the main process (agent/sandbox.json). Mirroring it in localStorage would
			// let the renderer re-push stale values on startup and clobber sandbox.json.
			wakeWord: settings.wakeWord,
			voiceLanguage: settings.voiceLanguage,
			ttsEnabled: settings.ttsEnabled,
			apiBaseUrl: settings.apiBaseUrl,
			deepseekRelayModels: settings.deepseekRelayModels,
			customModelId: settings.customModelId,
		};
		localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(persistable));
	} catch {
		// Ignore storage errors.
	}
}
export function loadStoredSettings(): Partial<DesktopAssistantSettings> | undefined {
	try {
		const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
		if (!raw) return undefined;
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		// Drop any browser key that older builds wrote, so stale localStorage never
		// overwrites the main-process browser settings on startup.
		delete (parsed as Record<string, unknown>).browser;
		// Drop any sandbox key that older builds wrote, so the renderer never pushes
		// stale sandbox settings over the main-process authority on startup.
		delete (parsed as Record<string, unknown>).sandbox;
		return parsed as Partial<DesktopAssistantSettings>;
	} catch {
		return undefined;
	}
}

export function persistWindowMode(mode: WindowMode): void {
	try {
		localStorage.setItem(WINDOW_MODE_STORAGE_KEY, mode);
	} catch {
		// Ignore storage errors.
	}
}

export function loadWindowMode(): WindowMode {
	try {
		return localStorage.getItem(WINDOW_MODE_STORAGE_KEY) === "expanded" ? "expanded" : "compact";
	} catch {
		return "compact";
	}
}

export function persistWindowAlwaysOnTop(enabled: boolean): void {
	try {
		localStorage.setItem(WINDOW_ALWAYS_ON_TOP_STORAGE_KEY, enabled ? "true" : "false");
	} catch {
		// Ignore storage errors.
	}
}

export function loadWindowAlwaysOnTop(): boolean {
	try {
		return localStorage.getItem(WINDOW_ALWAYS_ON_TOP_STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}
