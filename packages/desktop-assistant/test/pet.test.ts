import { describe, expect, it, vi } from "vitest";
import {
	behaviorDuration,
	behaviorWeights,
	createMood,
	type Mood,
	pickBehavior,
	updateMood,
} from "../renderer/src/pet/engine/behavior.ts";
import { PetEngine } from "../renderer/src/pet/engine/PetEngine.ts";
import {
	type Body,
	clampToBounds,
	groundUnder,
	jumpVelocityTo,
	resolveLanding,
	shouldStopHorizontalMotion,
	standingSurface,
} from "../renderer/src/pet/engine/physics.ts";
import type { Terrain } from "../renderer/src/pet/engine/terrain.ts";
import { isCatCommand, runCatCommand } from "../renderer/src/pet/pet-commands.ts";
import { loadPetConfig, PET_STORAGE_KEY, persistPetConfig } from "../renderer/src/pet/pet-storage.ts";
import { CAT } from "../renderer/src/pet/pets/cat.ts";
import { FOX } from "../renderer/src/pet/pets/fox.ts";
import { animFor, skinFor, validateDefinition } from "../renderer/src/pet/sprite.ts";
import { type BehaviorId, DEFAULT_PET_CONFIG, type Platform } from "../renderer/src/pet/types.ts";

function bubble(left: number, right: number, top: number, id = "b"): Platform {
	return { id, kind: "bubble", left, right, top };
}

interface PetEngineTestAccess {
	body: Body;
	behavior: BehaviorId;
	grounded: boolean;
	terrain?: Terrain;
	physics(dt: number, terrain: Terrain): void;
}

function createEngineForPhysics(): PetEngine {
	const ctx = {
		imageSmoothingEnabled: true,
		setTransform: () => {},
	} as unknown as CanvasRenderingContext2D;
	const canvas = {
		width: 0,
		height: 0,
		style: {},
		getContext: () => ctx,
	} as unknown as HTMLCanvasElement;
	const sprite = { style: {} } as unknown as HTMLElement;
	const chatScreen = {
		getBoundingClientRect: () => ({ width: 320, height: 260 }),
	} as unknown as HTMLElement;
	return new PetEngine(canvas, sprite, chatScreen, DEFAULT_PET_CONFIG, undefined, () => 0.5);
}

class FakeImage {
	onload: (() => void) | null = null;
	private currentSrc = "";

	set src(value: string) {
		this.currentSrc = value;
	}

	get src(): string {
		return this.currentSrc;
	}
}

describe("pet definitions", () => {
	it("cat and fox spritesheet layouts are internally consistent", () => {
		expect(validateDefinition(CAT)).toEqual([]);
		expect(validateDefinition(FOX)).toEqual([]);
	});

	it("maps behaviors to animations and skins by id", () => {
		expect(animFor(CAT, "walk").row).toBe(CAT.anims.walk.row);
		expect(animFor(CAT, "sleep")).toBe(CAT.anims.sleep);
		expect(skinFor(CAT, "orange").label).toBe("橘猫");
		expect(skinFor(CAT, "nope").id).toBe(CAT.defaultSkinId); // falls back
	});
});

describe("pet physics", () => {
	const platforms = [bubble(0, 100, 50, "low"), bubble(0, 100, 80, "lower")];

	it("lands on the highest surface crossed while falling", () => {
		expect(resolveLanding(40, 90, 50, platforms)?.id).toBe("low");
	});
	it("does not land while rising", () => {
		expect(resolveLanding(90, 40, 50, platforms)).toBeUndefined();
	});
	it("ignores platforms outside the x-span", () => {
		expect(resolveLanding(40, 90, 200, platforms)).toBeUndefined();
	});
	it("finds the ground directly under the feet", () => {
		expect(groundUnder(50, 49, platforms)?.id).toBe("low");
		expect(groundUnder(50, 30, platforms)).toBeUndefined();
	});
	it("detects a surface when released directly onto the ground", () => {
		expect(standingSurface(50, 50, platforms)?.id).toBe("low");
		expect(standingSurface(50, 53.5, platforms)?.id).toBe("low");
		expect(standingSurface(50, 58, platforms)).toBeUndefined();
	});
	it("clamps x so the sprite stays inside the bounds", () => {
		const bounds = { left: 10, right: 200, top: 0, bottom: 300 };
		expect(clampToBounds({ x: 0, y: 100 }, bounds, 20, 0).x).toBe(30);
		expect(clampToBounds({ x: 500, y: 100 }, bounds, 20, 0).x).toBe(180);
	});
	it("stops horizontal motion at arrivals, unreachable targets, and edges", () => {
		const bounds = { left: 0, right: 100, top: 0, bottom: 100 };
		expect(shouldStopHorizontalMotion({ bodyX: 50, targetX: 53, bounds, halfWidth: 10 })).toBe(true);
		expect(shouldStopHorizontalMotion({ bodyX: 50, targetX: 200, bounds, halfWidth: 10 })).toBe(true);
		expect(shouldStopHorizontalMotion({ bodyX: 90, targetX: 95, bounds, halfWidth: 10 })).toBe(true);
		expect(shouldStopHorizontalMotion({ bodyX: 50, targetX: 70, bounds, halfWidth: 10 })).toBe(false);
	});
	it("produces an upward arc toward a jump target", () => {
		const v = jumpVelocityTo({ x: 0, y: 100 }, bubble(80, 120, 50), 1500, 460);
		expect(v).toBeDefined();
		expect(v!.y).toBeLessThan(0);
		expect(Number.isFinite(v!.x)).toBe(true);
	});
});

describe("pet engine landing regressions", () => {
	it("ends falling when a stale grounded flag survives until platform contact", () => {
		vi.stubGlobal("Image", FakeImage);
		vi.stubGlobal("window", { devicePixelRatio: 1 });
		try {
			const engine = createEngineForPhysics();
			const access = engine as unknown as PetEngineTestAccess;
			const terrain: Terrain = {
				platforms: [bubble(0, 200, 100, "floor")],
				bounds: { left: 0, right: 200, top: 0, bottom: 100 },
				homeTop: 100,
				homeX: 100,
			};
			access.terrain = terrain;
			access.body = { x: 50, y: 90, vx: 0, vy: 200 };
			access.behavior = "falling";
			access.grounded = true;

			access.physics(0.1, terrain);

			const snapshot = engine.getDebugSnapshot(true, 1000);
			expect(snapshot.behavior).toBe("sit");
			expect(snapshot.grounded).toBe(true);
			expect(snapshot.behaviorStartReason).toBe("landed on bubble platform floor");
			expect(engine.flushDebugEvents()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ phase: "end", behavior: "falling", reason: "landed" }),
					expect.objectContaining({ phase: "start", behavior: "sit", reason: "landed on bubble platform floor" }),
				]),
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("pet behavior brain", () => {
	const sleepy: Mood = { energy: 0.2, sleepiness: 0.9, curiosity: 0.1 };
	const energetic: Mood = { energy: 0.9, sleepiness: 0.1, curiosity: 0.5 };
	const idleCtx = { hasJumpTargets: true };

	it("prioritises sleep when very sleepy", () => {
		expect(behaviorWeights(sleepy, idleCtx).sleep ?? 0).toBeGreaterThan(behaviorWeights(sleepy, idleCtx).walk ?? 0);
	});
	it("offers running when energetic", () => {
		expect(behaviorWeights(energetic, idleCtx).run ?? 0).toBeGreaterThan(0);
	});
	it("pickBehavior is a deterministic weighted draw given an RNG", () => {
		expect(pickBehavior(energetic, { hasJumpTargets: false }, () => 0)).toBe("loaf");
	});
	it("behaviorDuration stays within the sleep range", () => {
		expect(behaviorDuration("sleep", () => 0)).toBeGreaterThanOrEqual(9000);
		expect(behaviorDuration("sleep", () => 0.999)).toBeLessThanOrEqual(22000);
	});
	it("mood drifts toward sleepiness over time and recovers energy at rest", () => {
		const m = updateMood(createMood(), 2, {
			exerting: false,
			resting: true,
			newBubble: false,
		});
		expect(m.sleepiness).toBeLessThan(createMood().sleepiness);
		expect(m.energy).toBeGreaterThan(createMood().energy);
	});
});

describe("/cat commands", () => {
	it("recognises cat commands and ignores look-alikes", () => {
		expect(isCatCommand("/cat")).toBe(true);
		expect(isCatCommand("/cat off")).toBe(true);
		expect(isCatCommand("/CAT color orange")).toBe(true);
		expect(isCatCommand("/category list")).toBe(false);
		expect(isCatCommand("hello")).toBe(false);
	});
	it("toggles the pet on and off", () => {
		expect(runCatCommand("/cat off", DEFAULT_PET_CONFIG).nextConfig?.enabled).toBe(false);
		expect(runCatCommand("/cat on", { ...DEFAULT_PET_CONFIG, enabled: false }).nextConfig?.enabled).toBe(true);
	});
	it("changes skin by id, label and synonym", () => {
		expect(runCatCommand("/cat color white", DEFAULT_PET_CONFIG).nextConfig?.colorId).toBe("white");
		expect(runCatCommand("/cat color 橘", DEFAULT_PET_CONFIG).nextConfig?.colorId).toBe("orange");
		expect(runCatCommand("/cat color 彩虹", DEFAULT_PET_CONFIG).nextConfig?.colorId).toBe("rainbow");
	});
	it("rejects an unknown skin without changing config", () => {
		const r = runCatCommand("/cat color chartreuse", DEFAULT_PET_CONFIG);
		expect(r.tone).toBe("error");
		expect(r.nextConfig).toBeUndefined();
	});
	it("switches species (cat/fox) and rejects unknown ones", () => {
		expect(runCatCommand("/cat switch fox", DEFAULT_PET_CONFIG).nextConfig?.speciesId).toBe("fox");
		expect(runCatCommand("/cat switch 狐狸", DEFAULT_PET_CONFIG).nextConfig?.speciesId).toBe("fox");
		expect(runCatCommand("/cat switch dragon", DEFAULT_PET_CONFIG).tone).toBe("error");
	});
	it("maps interaction verbs to nudges", () => {
		expect(runCatCommand("/cat sleep", DEFAULT_PET_CONFIG).nudge).toBe("sleep");
		expect(runCatCommand("/cat play", DEFAULT_PET_CONFIG).nudge).toBe("play");
		expect(runCatCommand("/cat come", DEFAULT_PET_CONFIG).nudge).toBe("come");
		expect(runCatCommand("/cat speak", DEFAULT_PET_CONFIG).nudge).toBe("wake");
	});
	it("shows help for bare or unknown input", () => {
		expect(runCatCommand("/cat", DEFAULT_PET_CONFIG).tone).toBe("completed");
		expect(runCatCommand("/cat wibble", DEFAULT_PET_CONFIG).tone).toBe("error");
	});
});

describe("pet storage", () => {
	function withStubbedStorage(run: (store: Map<string, string>) => void): void {
		const store = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => store.set(k, v),
		});
		try {
			run(store);
		} finally {
			vi.unstubAllGlobals();
		}
	}

	it("round-trips the config", () => {
		withStubbedStorage(() => {
			persistPetConfig({ enabled: false, speciesId: "fox", colorId: "rainbow" });
			expect(loadPetConfig()).toEqual({ enabled: false, speciesId: "fox", colorId: "rainbow" });
		});
	});
	it("falls back to defaults when nothing is stored", () => {
		withStubbedStorage(() => {
			expect(loadPetConfig()).toEqual(DEFAULT_PET_CONFIG);
		});
	});
	it("falls back to defaults on corrupt data", () => {
		withStubbedStorage((store) => {
			store.set(PET_STORAGE_KEY, "{not valid json");
			expect(loadPetConfig()).toEqual(DEFAULT_PET_CONFIG);
		});
	});
});
