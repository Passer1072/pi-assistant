// The pet's "brain": a small mood model plus a weighted-random state machine that
// loosely mimics how a real cat drifts between resting, grooming, wandering,
// playing and sleeping. Pure (RNG is injected) so the weighting can be tested.

import type { BehaviorId } from "../types.ts";

/** Slow-moving internal drives, each in [0, 1]. */
export interface Mood {
	/** Eagerness to move/play. Drains with activity, recovers while resting. */
	energy: number;
	/** Pull toward sleep. Rises over time, falls while sleeping. */
	sleepiness: number;
	/** Interest in new messages. Spikes on stimulus, decays. */
	curiosity: number;
}

export interface MoodSignals {
	/** The pet is currently exerting (walk/run/jump/play/pounce). */
	exerting: boolean;
	/** The pet is currently asleep or dozing. */
	resting: boolean;
	/** A new message bubble appeared since the last update. */
	newBubble: boolean;
}

export function createMood(): Mood {
	return { energy: 0.65, sleepiness: 0.2, curiosity: 0.3 };
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function updateMood(mood: Mood, dt: number, s: MoodSignals): Mood {
	let { energy, sleepiness, curiosity } = mood;

	energy += s.exerting ? -0.09 * dt : s.resting ? 0.05 * dt : 0.02 * dt;
	sleepiness += s.resting ? -0.12 * dt : 0.012 * dt;
	curiosity += -0.18 * dt;
	if (s.newBubble) curiosity += 0.45;

	return { energy: clamp01(energy), sleepiness: clamp01(sleepiness), curiosity: clamp01(curiosity) };
}

export interface BehaviorContext {
	/** There is at least one bubble to hop to (besides the current perch). */
	hasJumpTargets: boolean;
}

/**
 * Relative weights for the next idle behavior given mood + context. Higher = more
 * likely. The mix shifts with energy (active vs lazy) and sleepiness (awake vs sleepy).
 */
export function behaviorWeights(mood: Mood, ctx: BehaviorContext): Partial<Record<BehaviorId, number>> {
	const lazy = 1 - mood.energy; // 0 energetic, 1 lazy
	const sleepy = mood.sleepiness;
	const w: Partial<Record<BehaviorId, number>> = {
		loaf: 2 + lazy * 4,
		sit: 2 + lazy * 2,
		groom: 1.5 + mood.energy * 1.5,
		sleep: sleepy > 0.6 ? 3 + (sleepy - 0.6) * 14 : 0.2,
		doze: sleepy > 0.4 ? 1.5 + sleepy * 2 : 0.3,
		walk: 1 + mood.energy * 3,
		stretch: 1 + sleepy * 2,
		knead: 0.8 + lazy,
		watch: 0.6 + mood.curiosity * 3,
	};
	if (mood.energy > 0.5) {
		w.run = (mood.energy - 0.5) * 4;
		w.chaseTail = mood.energy * 1.5;
	}
	if (ctx.hasJumpTargets && mood.energy > 0.4) {
		w.jump = (mood.energy - 0.4) * 5 + mood.curiosity * 2;
	}
	return w;
}

/** Pick one behavior via weighted random using the injected RNG (0 <= rng() < 1). */
export function pickBehavior(mood: Mood, ctx: BehaviorContext, rng: () => number): BehaviorId {
	const weights = behaviorWeights(mood, ctx);
	const entries = Object.entries(weights).filter(([, v]) => (v ?? 0) > 0) as Array<[BehaviorId, number]>;
	if (entries.length === 0) return "loaf";
	const total = entries.reduce((sum, [, v]) => sum + v, 0);
	let roll = rng() * total;
	for (const [behavior, v] of entries) {
		roll -= v;
		if (roll <= 0) return behavior;
	}
	return entries[entries.length - 1][0];
}

/** How long (ms) to stay in a behavior before re-deciding. */
export function behaviorDuration(behavior: BehaviorId, rng: () => number): number {
	const ranges: Partial<Record<BehaviorId, [number, number]>> = {
		sleep: [9000, 22000],
		doze: [4000, 9000],
		loaf: [4000, 11000],
		sit: [2500, 7000],
		groom: [2500, 5500],
		stretch: [900, 1500],
		knead: [2500, 5000],
		walk: [1500, 4000],
		run: [900, 2200],
		watch: [1500, 5000],
		play: [1200, 3000],
		chaseTail: [1200, 2600],
	};
	const [lo, hi] = ranges[behavior] ?? [1500, 4000];
	return lo + rng() * (hi - lo);
}

/** Behaviors that should not be cut short by the idle re-decision timer. */
export function isTransient(behavior: BehaviorId): boolean {
	return behavior === "jump" || behavior === "pounce" || behavior === "falling" || behavior === "startled";
}
