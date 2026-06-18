// Pure physics helpers for the pet. The pet's position anchor is its FEET:
// `x` is the horizontal center, `y` is the bottom of the sprite. Keeping these
// DOM-free makes the landing / clamping maths unit-testable.

import type { Bounds, Platform, Vec2 } from "../types.ts";

export interface Body {
	/** Center x, in chat-screen-local px. */
	x: number;
	/** Feet (bottom) y, in chat-screen-local px. */
	y: number;
	vx: number;
	vy: number;
}

/** Integrate velocity under gravity for `dt` seconds (mutates a copy). */
export function step(body: Body, gravity: number, dt: number): Body {
	const vy = body.vy + gravity * dt;
	return { x: body.x + body.vx * dt, y: body.y + vy * dt, vx: body.vx, vy };
}

const LANDING_TOLERANCE = 3;

/**
 * If the feet moved downward across a platform's top edge (within its x-span),
 * return the platform to land on 鈥?the highest such surface. Returns undefined
 * when the pet is rising or no surface was crossed.
 */
export function resolveLanding(prevY: number, nextY: number, x: number, platforms: Platform[]): Platform | undefined {
	if (nextY < prevY) return undefined; // moving up 鈥?no landing
	let best: Platform | undefined;
	for (const p of platforms) {
		if (x < p.left || x > p.right) continue;
		if (p.top + LANDING_TOLERANCE < prevY) continue; // surface already above the feet
		if (p.top > nextY + LANDING_TOLERANCE) continue; // not reached yet
		if (!best || p.top < best.top) best = p;
	}
	return best;
}

/** The platform the feet are resting on, or are close enough to settle onto. */
export function groundUnder(x: number, feetY: number, platforms: Platform[]): Platform | undefined {
	let best: Platform | undefined;
	for (const p of platforms) {
		if (x < p.left || x > p.right) continue;
		if (p.top < feetY - LANDING_TOLERANCE || p.top > feetY + LANDING_TOLERANCE) continue;
		if (!best || p.top < best.top) best = p;
	}
	return best;
}

/** The platform the feet are touching or slightly pressing through. */
export function standingSurface(x: number, feetY: number, platforms: Platform[]): Platform | undefined {
	let best: Platform | undefined;
	for (const p of platforms) {
		if (x < p.left || x > p.right) continue;
		if (Math.abs(p.top - feetY) > LANDING_TOLERANCE + 1) continue;
		if (!best || p.top < best.top) best = p;
	}
	return best;
}

/** True when the feet are resting on (鈮?at) the platform's top within its x-span. */
export function isStandingOn(body: Body, platform: Platform): boolean {
	return (
		body.x >= platform.left &&
		body.x <= platform.right &&
		Math.abs(body.y - platform.top) <= LANDING_TOLERANCE + 1
	);
}

/** Clamp the feet position so the sprite stays fully inside `bounds`. */
export function clampToBounds(pos: Vec2, bounds: Bounds, halfWidth: number, height: number): Vec2 {
	return {
		x: Math.min(Math.max(pos.x, bounds.left + halfWidth), bounds.right - halfWidth),
		y: Math.min(Math.max(pos.y, bounds.top + height), bounds.bottom),
	};
}

export interface HorizontalMotionState {
	bodyX: number;
	targetX: number;
	bounds?: Bounds;
	halfWidth: number;
	arrivalDistance?: number;
	edgeEpsilon?: number;
}

/** True when a horizontal move should yield instead of pushing into a wall forever. */
export function shouldStopHorizontalMotion({
	bodyX,
	targetX,
	bounds,
	halfWidth,
	arrivalDistance = 5,
	edgeEpsilon = 1,
}: HorizontalMotionState): boolean {
	const dx = targetX - bodyX;
	if (Math.abs(dx) < arrivalDistance) return true;
	if (!bounds) return false;
	const minX = bounds.left + halfWidth;
	const maxX = bounds.right - halfWidth;
	const direction = Math.sign(dx);
	const targetIsReachable = targetX >= minX - edgeEpsilon && targetX <= maxX + edgeEpsilon;
	const blockedAtEdge =
		direction !== 0 &&
		((direction < 0 && bodyX <= minX + edgeEpsilon) || (direction > 0 && bodyX >= maxX - edgeEpsilon));
	return !targetIsReachable || blockedAtEdge;
}

/** Platform nearest to `from` (by top-edge center distance) 鈥?used for hopping toward visibility. */
export function nearestPlatform(from: Vec2, platforms: Platform[], exclude?: Platform): Platform | undefined {
	let best: Platform | undefined;
	let bestDist = Infinity;
	for (const p of platforms) {
		if (p === exclude) continue;
		const cx = (p.left + p.right) / 2;
		const d = (cx - from.x) ** 2 + (p.top - from.y) ** 2;
		if (d < bestDist) {
			bestDist = d;
			best = p;
		}
	}
	return best;
}

/**
 * Initial velocity for a ballistic hop from `from` feet-position to land near the
 * top of `target`, given gravity. Picks an arc that clears the gap with a bit of
 * height. Returns undefined if the target is unreachable-ish (caller can walk).
 */
export function jumpVelocityTo(from: Vec2, target: Platform, gravity: number, jumpSpeed: number): Vec2 | undefined {
	const tx = clamp((target.left + target.right) / 2, target.left + 6, target.right - 6);
	const dx = tx - from.x;
	const dy = target.top - from.y; // negative when jumping up
	// Upward launch; if jumping down, still give a small upward pop for an arc.
	const vy = -Math.max(jumpSpeed, Math.sqrt(Math.max(0, -dy) * 2 * gravity) + 120);
	// Time to apex then down to target: solve dy = vy*t + 0.5*g*t^2 for the later root.
	const disc = vy * vy + 2 * gravity * dy;
	if (disc < 0) return undefined;
	const t = (-vy + Math.sqrt(disc)) / gravity;
	if (t <= 0) return undefined;
	const vx = dx / t;
	return { x: vx, y: vy };
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(Math.max(v, lo), hi);
}
