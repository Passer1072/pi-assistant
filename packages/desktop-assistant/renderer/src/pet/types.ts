// Core types for the desktop-pet framework.
//
// Pets are spritesheet-driven: a PetDefinition points at a sheet image, lays out
// its animation rows, maps each behavior onto an animation, and lists CSS-filter
// "skins" (recolors). The autonomous brain (behavior/physics) is shared,
// so adding a species or color is pure data.
//
// Sprite art is adapted from KINGS-MZ/PixelCat (MIT) — see assets/CREDITS.md.

export interface Vec2 {
	x: number;
	y: number;
}

/** Rectangular world bounds in chat-screen-local pixels. The pet stays inside. */
export interface Bounds {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/**
 * A standable surface in chat-screen-local coordinates. `top` is the surface the
 * pet's feet rest on; `left`/`right` bound where it can stand. Derived each frame
 * from the live chat DOM (message bubbles + the composer input box).
 */
export interface Platform {
	id: string;
	left: number;
	right: number;
	top: number;
	kind: "composer" | "bubble";
}

/**
 * Behaviors the state machine can be in. Each maps onto a sprite animation via
 * the definition's behaviorAnim table.
 */
export type BehaviorId =
	| "loaf"
	| "sit"
	| "sleep"
	| "doze"
	| "groom"
	| "stretch"
	| "walk"
	| "run"
	| "jump"
	| "knead"
	| "watch"
	| "play"
	| "pounce"
	| "startled"
	| "chaseTail"
	| "falling"
	| "grabbed";

/** One animation = a row in the sheet, a frame count, and a playback rate. */
export interface SpriteAnim {
	row: number;
	frames: number;
	fps: number;
}

/** A recolor applied as a CSS filter on the sprite element. */
export interface SpriteSkin {
	id: string;
	label: string;
	/** CSS filter string ("none" for the native art). */
	filter: string;
	/** When true, the engine animates hue-rotate for a shifting rainbow. */
	animatedHue?: boolean;
}

export interface PetPhysics {
	/** Downward acceleration, world px/s². */
	gravity: number;
	/** Horizontal speed while walking, world px/s. */
	walkSpeed: number;
	/** Horizontal speed while running / chasing, world px/s. */
	runSpeed: number;
	/** Initial upward velocity for a hop, world px/s (magnitude). */
	jumpSpeed: number;
}

export interface PetDefinition {
	id: string;
	label: string;
	/** Imported spritesheet URL. */
	sheet: string;
	/** Square cell size in source px. */
	cell: number;
	/** Columns / rows in the sheet. */
	cols: number;
	rows: number;
	/** Source-px → screen-px multiplier for display. */
	scale: number;
	/** Feet y within a cell, in source px (art may sit above the cell bottom). */
	anchorY: number;
	anims: Record<string, SpriteAnim>;
	behaviorAnim: Record<BehaviorId, string>;
	fallbackAnim: string;
	skins: SpriteSkin[];
	defaultSkinId: string;
	physics: PetPhysics;
}

/** Persisted, user-facing pet configuration (localStorage). */
export interface PetConfig {
	enabled: boolean;
	speciesId: string;
	/** The chosen skin id. */
	colorId: string;
}

/** Imperative pokes the UI can send the engine (e.g. from `/cat sleep`). */
export type NudgeAction = "sleep" | "play" | "come" | "wake";

export const DEFAULT_PET_CONFIG: PetConfig = {
	enabled: true,
	speciesId: "cat",
	colorId: "orange",
};
