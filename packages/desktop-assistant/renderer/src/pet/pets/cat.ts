// The pixel cat — sprite art + animation layout adapted from KINGS-MZ/PixelCat
// (MIT, © Imad El Khaider). See ../assets/CREDITS.md. The autonomous behavior is
// our own engine; this file only describes how to read the cat spritesheet.

import { registerPet } from "../registry.ts";
import type { PetDefinition } from "../types.ts";
import catSheet from "../assets/cat.png";

// Skin filters lifted from the source project so recolors look identical.
const ORANGE_FILTER = "sepia(1) saturate(8) hue-rotate(-35deg) brightness(0.95) contrast(1.1)";
const RAINBOW_FILTER = "sepia(1) saturate(7) hue-rotate(0deg) brightness(1.08) contrast(1.08)";

export const CAT: PetDefinition = {
	id: "cat",
	label: "猫",
	sheet: catSheet,
	cell: 32,
	cols: 8,
	rows: 10,
	scale: 2.3,
	anchorY: 26, // cat art sits in the lower 26px of each 32px cell
	anims: {
		idle1: { row: 0, frames: 4, fps: 2 },
		idle2: { row: 1, frames: 4, fps: 2 },
		clean1: { row: 2, frames: 4, fps: 3 },
		clean2: { row: 3, frames: 4, fps: 3 },
		walk: { row: 4, frames: 8, fps: 8 },
		run: { row: 5, frames: 8, fps: 9 },
		sleep: { row: 6, frames: 4, fps: 1.5 },
		paw: { row: 7, frames: 6, fps: 6 },
		jump: { row: 8, frames: 7, fps: 10 },
		scared: { row: 9, frames: 8, fps: 6 },
	},
	behaviorAnim: {
		loaf: "idle1",
		sit: "idle1",
		watch: "idle2",
		stretch: "idle2",
		groom: "clean1",
		knead: "clean2",
		sleep: "sleep",
		doze: "sleep",
		walk: "walk",
		run: "run",
		chaseTail: "run",
		jump: "jump",
		pounce: "jump",
		falling: "jump",
		startled: "scared",
		grabbed: "scared",
		play: "paw",
	},
	fallbackAnim: "idle1",
	skins: [
		{ id: "white", label: "白猫", filter: "none" },
		{ id: "orange", label: "橘猫", filter: ORANGE_FILTER },
		{ id: "rainbow", label: "彩虹猫", filter: RAINBOW_FILTER, animatedHue: true },
	],
	defaultSkinId: "white",
	physics: { gravity: 1500, walkSpeed: 46, runSpeed: 150, jumpSpeed: 470 },
};

registerPet(CAT);
