// Pet species registry. Definitions register themselves on import; the engine and
// command layer look them up by id. Keeping this a tiny module (no engine deps)
// means future pets only import `registerPet`.

import type { PetDefinition } from "./types.ts";

const registry = new Map<string, PetDefinition>();

export function registerPet(definition: PetDefinition): void {
	registry.set(definition.id, definition);
}

export function getPet(id: string): PetDefinition | undefined {
	return registry.get(id);
}

export function listPets(): PetDefinition[] {
	return [...registry.values()];
}

/** First registered pet — used as a fallback when a stored species id is gone. */
export function defaultPet(): PetDefinition | undefined {
	return registry.values().next().value;
}
