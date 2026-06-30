import { describe, expect, it, vi } from "vitest";
import {
	loadStoredSettings,
	loadWindowMode,
	persistSettings,
	persistWindowMode,
	SETTINGS_STORAGE_KEY,
	WINDOW_MODE_STORAGE_KEY,
} from "../renderer/src/app-storage.ts";
import { DEFAULT_DESKTOP_ASSISTANT_SETTINGS } from "../src/shared/types.ts";

describe("renderer app storage", () => {
	it("persists and restores token saving settings", () => {
		const store = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				store.set(key, value);
			},
		});
		try {
			persistSettings({
				...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
				apiConnectionMode: "relay",
				apiBaseUrl: "https://www.dreamfield.top",
				deepseekRelayModels: [{ id: "Deepseek-v4-flash", label: "Deepseek-v4-flash" }],
				tokenSaving: { enabled: true },
			});

			expect(JSON.parse(store.get(SETTINGS_STORAGE_KEY) ?? "{}")).toMatchObject({
				apiConnectionMode: "relay",
				apiBaseUrl: "https://www.dreamfield.top",
				deepseekRelayModels: [{ id: "Deepseek-v4-flash", label: "Deepseek-v4-flash" }],
				tokenSaving: { enabled: true },
			});
			expect(JSON.parse(store.get(SETTINGS_STORAGE_KEY) ?? "{}")).not.toHaveProperty("browser");
			expect(loadStoredSettings()).toMatchObject({
				apiConnectionMode: "relay",
				apiBaseUrl: "https://www.dreamfield.top",
				deepseekRelayModels: [{ id: "Deepseek-v4-flash", label: "Deepseek-v4-flash" }],
				tokenSaving: { enabled: true },
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("drops stale browser settings from older local storage snapshots", () => {
		const store = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				store.set(key, value);
			},
		});
		try {
			store.set(
				SETTINGS_STORAGE_KEY,
				JSON.stringify({
					modelId: "deepseek-v4-pro",
					browser: {
						...DEFAULT_DESKTOP_ASSISTANT_SETTINGS.browser,
						shortcuts: [{ id: "stale", label: "Stale", url: "https://stale.example" }],
					},
				}),
			);

			expect(loadStoredSettings()).toEqual({ modelId: "deepseek-v4-pro" });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("persists and restores expanded window mode", () => {
		const store = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				store.set(key, value);
			},
		});
		try {
			expect(loadWindowMode()).toBe("compact");

			persistWindowMode("expanded");

			expect(store.get(WINDOW_MODE_STORAGE_KEY)).toBe("expanded");
			expect(loadWindowMode()).toBe("expanded");

			store.set(WINDOW_MODE_STORAGE_KEY, "unexpected");

			expect(loadWindowMode()).toBe("compact");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
