// Sprite resolution for spritesheet pets: pick the animation for a behavior and
// the skin for a color id. The validator (DOM-free, testable) checks the
// definition is internally consistent.

import type { BehaviorId, PetDefinition, SpriteAnim, SpriteSkin } from "./types.ts";

/** The animation a behavior should play, falling back to the definition default. */
export function animFor(def: PetDefinition, behavior: BehaviorId): SpriteAnim {
	const name = def.behaviorAnim[behavior] ?? def.fallbackAnim;
	return def.anims[name] ?? def.anims[def.fallbackAnim];
}

/** The skin for a color id, falling back to the definition default. */
export function skinFor(def: PetDefinition, colorId: string): SpriteSkin {
	return def.skins.find((s) => s.id === colorId) ?? def.skins.find((s) => s.id === def.defaultSkinId) ?? def.skins[0];
}

export interface DefinitionError {
	where: string;
	message: string;
}

/** Validate a definition: every behavior maps to a real animation that fits the
 * sheet, the fallback + default skin exist, and frames stay within the grid. */
export function validateDefinition(def: PetDefinition): DefinitionError[] {
	const errors: DefinitionError[] = [];
	if (!def.anims[def.fallbackAnim]) {
		errors.push({ where: def.id, message: `fallbackAnim "${def.fallbackAnim}" missing` });
	}
	if (!def.skins.some((s) => s.id === def.defaultSkinId)) {
		errors.push({ where: def.id, message: `defaultSkinId "${def.defaultSkinId}" not found` });
	}
	for (const [name, anim] of Object.entries(def.anims)) {
		if (anim.row < 0 || anim.row >= def.rows) {
			errors.push({ where: `${def.id}.${name}`, message: `row ${anim.row} out of range (0..${def.rows - 1})` });
		}
		if (anim.frames < 1 || anim.frames > def.cols) {
			errors.push({ where: `${def.id}.${name}`, message: `frames ${anim.frames} out of range (1..${def.cols})` });
		}
	}
	for (const [behavior, name] of Object.entries(def.behaviorAnim)) {
		if (!def.anims[name]) {
			errors.push({ where: `${def.id}.${behavior}`, message: `maps to unknown animation "${name}"` });
		}
	}
	return errors;
}
