// The pixel fox — an alternate species (switch with `/cat switch fox`). Art from
// KINGS-MZ/PixelCat (MIT). The fox sheet is natively orange; "white" is a
// grayscale+brighten filter, matching the source project.

import { registerPet } from "../registry.ts";
import type { PetDefinition } from "../types.ts";
import foxSheet from "../assets/fox.png";

const RAINBOW_FILTER = "sepia(1) saturate(7) hue-rotate(0deg) brightness(1.08) contrast(1.08)";

export const FOX: PetDefinition = {
	id: "fox",
	label: "狐狸",
	sheet: foxSheet,
	cell: 32,
	cols: 14,
	rows: 7,
	scale: 2.0,
	anchorY: 30, // fox fills more of the cell than the cat
	anims: {
		idle1: { row: 0, frames: 5, fps: 2.5 },
		idle2: { row: 1, frames: 14, fps: 7 },
		walk: { row: 2, frames: 8, fps: 8 },
		run: { row: 2, frames: 8, fps: 11 },
		catch: { row: 3, frames: 11, fps: 14 },
		paw: { row: 3, frames: 11, fps: 11 },
		scared: { row: 4, frames: 5, fps: 6 },
		sleep: { row: 5, frames: 6, fps: 1.5 },
	},
	behaviorAnim: {
		loaf: "idle1",
		sit: "idle1",
		watch: "idle2",
		stretch: "idle2",
		groom: "idle2",
		knead: "idle2",
		sleep: "sleep",
		doze: "sleep",
		walk: "walk",
		run: "run",
		chaseTail: "run",
		jump: "run",
		pounce: "catch",
		falling: "run",
		startled: "scared",
		grabbed: "scared",
		play: "paw",
	},
	fallbackAnim: "idle1",
	skins: [
		{ id: "orange", label: "橘狐", filter: "none" },
		{ id: "white", label: "白狐", filter: "grayscale(1) brightness(1.9) contrast(1.06)" },
		{ id: "rainbow", label: "彩虹狐", filter: RAINBOW_FILTER, animatedHue: true },
	],
	defaultSkinId: "orange",
	physics: { gravity: 1500, walkSpeed: 52, runSpeed: 165, jumpSpeed: 470 },
};

registerPet(FOX);
