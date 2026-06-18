// Persists the pet's user-facing config (on/off, species, color) across restarts,
// mirroring the renderer's existing app-storage pattern.

import { DEFAULT_PET_CONFIG, type PetConfig } from "./types.ts";

export const PET_STORAGE_KEY = "pi-pet";

export function persistPetConfig(config: PetConfig): void {
	try {
		localStorage.setItem(PET_STORAGE_KEY, JSON.stringify(config));
	} catch {
		// Ignore storage errors (private mode, quota, …).
	}
}

export function loadPetConfig(): PetConfig {
	try {
		const raw = localStorage.getItem(PET_STORAGE_KEY);
		if (!raw) return { ...DEFAULT_PET_CONFIG };
		const parsed = JSON.parse(raw) as Partial<PetConfig>;
		return {
			enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_PET_CONFIG.enabled,
			speciesId: typeof parsed.speciesId === "string" ? parsed.speciesId : DEFAULT_PET_CONFIG.speciesId,
			colorId: typeof parsed.colorId === "string" ? parsed.colorId : DEFAULT_PET_CONFIG.colorId,
		};
	} catch {
		return { ...DEFAULT_PET_CONFIG };
	}
}
