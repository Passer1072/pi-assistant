// Reads the live chat DOM and turns it into a world for the pet: message bubbles
// become jumpable platforms and the composer (input box) is the home perch + floor.
// Everything is expressed in chat-screen-local coordinates so it lines up with the
// overlay canvas. Coordinates are recomputed each scan because the thread scrolls.

import type { Bounds, Platform } from "../types.ts";

export interface Terrain {
	platforms: Platform[];
	bounds: Bounds;
	/** Top edge of the composer — the pet's default resting/home surface. */
	homeTop: number;
	/** Center x of the composer perch. */
	homeX: number;
}

// Only the top slice of a bubble is "standable", and we ignore slivers.
const MIN_PLATFORM_WIDTH = 40;
const VIEW_MARGIN = 6;

export function scanTerrain(chatScreen: HTMLElement): Terrain | undefined {
	const cs = chatScreen.getBoundingClientRect();
	const thread = chatScreen.querySelector<HTMLElement>(".thread");
	const composer = chatScreen.querySelector<HTMLElement>(".composer");
	if (!thread || !composer) return undefined;

	const threadRect = thread.getBoundingClientRect();
	const composerRect = composer.getBoundingClientRect();

	const toLocalX = (clientX: number) => clientX - cs.left;
	const toLocalY = (clientY: number) => clientY - cs.top;

	const homeTop = toLocalY(composerRect.top);
	const homeX = toLocalX(composerRect.left + composerRect.width / 2);

	// The pet stays within the visible thread band so it never wanders off-screen,
	// and rests on the composer top as the floor.
	const bounds: Bounds = {
		left: toLocalX(threadRect.left) + VIEW_MARGIN,
		right: toLocalX(threadRect.right) - VIEW_MARGIN,
		top: toLocalY(threadRect.top) + VIEW_MARGIN,
		bottom: homeTop,
	};

	const platforms: Platform[] = [
		{ id: "composer", kind: "composer", left: bounds.left, right: bounds.right, top: homeTop },
	];

	const visibleTop = threadRect.top;
	const visibleBottom = composerRect.top;
	const bubbles = chatScreen.querySelectorAll<HTMLElement>(".thread .bubble");
	let i = 0;
	for (const bubble of Array.from(bubbles)) {
		const r = bubble.getBoundingClientRect();
		if (r.width < MIN_PLATFORM_WIDTH) continue;
		// Skip bubbles scrolled out of (or mostly out of) the visible thread band.
		if (r.top < visibleTop + VIEW_MARGIN || r.top > visibleBottom - VIEW_MARGIN) continue;
		platforms.push({
			id: `bubble-${i++}`,
			kind: "bubble",
			left: Math.max(toLocalX(r.left), bounds.left),
			right: Math.min(toLocalX(r.right), bounds.right),
			top: toLocalY(r.top),
		});
	}

	return { platforms, bounds, homeTop, homeX };
}
