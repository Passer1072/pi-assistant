// The pet's runtime: a requestAnimationFrame loop that scans terrain, ticks the
// mood + behavior state machine, integrates physics, runs grab/ball
// interactions, and renders. The cat itself is a DOM element whose background is a
// spritesheet stepped via background-position (faithful to KINGS-MZ/PixelCat, and
// it lets CSS-filter skins — incl. the animated rainbow — work for free). The
// canvas behind it draws the shadow, ball and particles.

import { defaultPet, getPet } from "../registry.ts";
import { animFor, skinFor } from "../sprite.ts";
import type { BehaviorId, NudgeAction, PetConfig, PetDefinition, SpriteSkin, Vec2 } from "../types.ts";
import type { PetDebugSnapshot, PetDebugStateEvent } from "../../../../src/shared/types.ts";
import {
	type BehaviorContext,
	behaviorDuration,
	createMood,
	isTransient,
	type Mood,
	type MoodSignals,
	pickBehavior,
	updateMood,
} from "./behavior.ts";
import { Particles } from "./particles.ts";
import {
	type Body,
	clampToBounds,
	groundUnder,
	jumpVelocityTo,
	nearestPlatform,
	resolveLanding,
	shouldStopHorizontalMotion,
	standingSurface,
} from "./physics.ts";
import { scanTerrain, type Terrain, type TerrainSelectors } from "./terrain.ts";
import ballSrc from "../assets/tennis.png";

const TERRAIN_REFRESH_MS = 140;
const RESTING: ReadonlySet<BehaviorId> = new Set(["loaf", "sit", "sleep", "doze", "groom", "knead", "stretch", "watch"]);
const BALL_RADIUS = 9;
const HORIZONTAL_STUCK_MS = 900;
const HORIZONTAL_PROGRESS_EPSILON = 1.5;

interface Ball {
	x: number;
	y: number;
	vx: number;
	vy: number;
	bornAt: number;
}

const CAT_PHRASES = ["喵~", "喵呜", "呼噜呼噜~", "🐟?", "摸摸我", "zzz...", "(=^･ω･^=)", "想玩!", "🐾"];
const FOX_PHRASES = ["唔?", "🦊", "哼哼~", "zzz...", "一起玩!", "🐾"];

const BEHAVIOR_ACTION_LABELS: Record<BehaviorId, string> = {
	loaf: "趴卧",
	sit: "坐下",
	sleep: "睡觉",
	doze: "打盹",
	groom: "梳毛",
	stretch: "伸展",
	walk: "行走",
	run: "奔跑",
	jump: "跳跃",
	knead: "踩踏",
	watch: "观察",
	play: "玩耍",
	pounce: "扑击",
	startled: "受惊",
	chaseTail: "追尾巴",
	falling: "下落",
	grabbed: "被抓起",
};

const BEHAVIOR_ACTIVE_LABELS: Record<BehaviorId, string> = {
	loaf: "趴卧中",
	sit: "坐着",
	sleep: "睡觉中",
	doze: "打盹中",
	groom: "梳毛中",
	stretch: "伸展中",
	walk: "行走中",
	run: "奔跑中",
	jump: "跳跃中",
	knead: "踩踏中",
	watch: "观察中",
	play: "玩耍中",
	pounce: "扑击中",
	startled: "受惊",
	chaseTail: "追尾巴中",
	falling: "下落中",
	grabbed: "被抓起",
};

interface EnterBehaviorOptions {
	now?: number;
	startReason: string;
	endReason?: string;
	target?: string;
	durationMs?: number;
	keepWanderTarget?: boolean;
}

export class PetEngine {
	private def!: PetDefinition;
	private skin!: SpriteSkin;

	private readonly ctx: CanvasRenderingContext2D;
	private readonly canvas: HTMLCanvasElement;
	private readonly spriteEl: HTMLElement;
	private readonly host: HTMLElement;
	private readonly terrainSelectors?: TerrainSelectors;
	private readonly speechEl?: HTMLElement;
	private readonly rng: () => number;
	private mood: Mood = createMood();
	private readonly particles = new Particles();

	private body: Body = { x: 0, y: 0, vx: 0, vy: 0 };
	private dir: 1 | -1 = -1;
	private behavior: BehaviorId = "loaf";
	private behaviorStartedAt = 0;
	private behaviorEndsAt = 0;
	private behaviorStartReason = "engine initialized";
	private behaviorEndReason?: string;
	private behaviorTarget?: string;
	private animStart = 0;
	private grounded = true;
	private wanderTarget?: number;
	private chaseTailBaseDir: 1 | -1 = -1;
	private placed = false;

	// Smoothing channels.
	private targetVx = 0;
	private facingScale = -1;
	private squash = 0;
	private squashVel = 0;

	// Ball toy.
	private readonly ballImg = new Image();
	private ballReady = false;
	private ball: Ball | null = null;
	private chasingBall = false;

	// Speech.
	private speechUntil = 0;

	private terrain?: Terrain;
	private lastTerrainScan = 0;
	private cursor: Vec2 | null = null;
	private grabbed = false;
	private newBubblePending = false;

	// Sprite DOM bookkeeping (skip redundant writes).
	private lastBgPos = "";
	private skinAnimation: Animation | null = null;

	private rafId = 0;
	private lastTime = 0;
	private running = false;
	private cssWidth = 0;
	private cssHeight = 0;
	private horizontalProgressX = 0;
	private horizontalProgressAt = 0;
	private pendingDebugEvents: PetDebugStateEvent[] = [];

	constructor(
		canvas: HTMLCanvasElement,
		spriteEl: HTMLElement,
		host: HTMLElement,
		config: PetConfig,
		speechEl?: HTMLElement,
		rng: () => number = Math.random,
		terrainSelectors?: TerrainSelectors,
	) {
		this.canvas = canvas;
		this.spriteEl = spriteEl;
		this.host = host;
		this.terrainSelectors = terrainSelectors;
		this.speechEl = speechEl;
		this.rng = rng;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("PetEngine: 2d canvas context unavailable");
		this.ctx = ctx;
		this.ballImg.onload = () => { this.ballReady = true; };
		this.ballImg.src = ballSrc;
		this.applyConfig(config);
		this.resize();
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────

	start(): void {
		if (this.running) return;
		this.running = true;
		this.lastTime = performance.now();
		this.loop(this.lastTime);
	}

	stop(): void {
		this.running = false;
		if (this.rafId) cancelAnimationFrame(this.rafId);
		this.rafId = 0;
		this.skinAnimation?.cancel();
		this.skinAnimation = null;
	}

	resize(): void {
		const rect = this.host.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		this.cssWidth = rect.width;
		this.cssHeight = rect.height;
		this.canvas.width = Math.round(rect.width * dpr);
		this.canvas.height = Math.round(rect.height * dpr);
		this.canvas.style.width = `${rect.width}px`;
		this.canvas.style.height = `${rect.height}px`;
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.ctx.imageSmoothingEnabled = false;
	}

	getDebugSnapshot(enabled = true, now = performance.now()): PetDebugSnapshot {
		const terrain = this.terrain;
		const ball = this.ball;
		return {
			enabled,
			updatedAt: Date.now(),
			speciesId: this.def.id,
			speciesLabel: this.def.label,
			colorId: this.skin.id,
			colorLabel: this.skin.label,
			behavior: this.behavior,
			behaviorLabel: BEHAVIOR_ACTIVE_LABELS[this.behavior],
			behaviorStartedAt: this.behaviorStartedAt,
			behaviorEndsAt: this.behaviorEndsAt,
			behaviorRemainingMs: Math.max(0, this.behaviorEndsAt - now),
			behaviorStartReason: this.behaviorStartReason,
			behaviorTarget: this.behaviorTarget,
			position: { x: round1(this.body.x), y: round1(this.body.y) },
			velocity: { x: round1(this.body.vx), y: round1(this.body.vy) },
			targetVx: round1(this.targetVx),
			direction: this.dir < 0 ? "left" : "right",
			grounded: this.grounded,
			grabbed: this.grabbed,
			placed: this.placed,
			chasingBall: this.chasingBall,
			wanderTarget: this.wanderTarget === undefined ? undefined : round1(this.wanderTarget),
			mood: {
				energy: round3(this.mood.energy),
				sleepiness: round3(this.mood.sleepiness),
				curiosity: round3(this.mood.curiosity),
			},
			terrain: terrain
				? {
					platformCount: terrain.platforms.length,
					bubblePlatformCount: terrain.platforms.filter((platform) => platform.kind === "bubble").length,
					bounds: {
						left: round1(terrain.bounds.left),
						right: round1(terrain.bounds.right),
						top: round1(terrain.bounds.top),
						bottom: round1(terrain.bounds.bottom),
					},
				}
				: undefined,
			ball: ball
				? {
					x: round1(ball.x),
					y: round1(ball.y),
					vx: round1(ball.vx),
					vy: round1(ball.vy),
					ageMs: Math.max(0, Math.round(now - ball.bornAt)),
				}
				: undefined,
			canvas: { width: round1(this.cssWidth), height: round1(this.cssHeight) },
			sprite: { width: round1(this.spriteW), height: round1(this.spriteVisualH) },
		};
	}

	flushDebugEvents(): PetDebugStateEvent[] {
		const events = this.pendingDebugEvents;
		this.pendingDebugEvents = [];
		return events;
	}

	// ── Config / commands ──────────────────────────────────────────────────────

	setConfig(config: PetConfig): void {
		const speciesChanged = config.speciesId !== this.def?.id;
		this.applyConfig(config);
		if (speciesChanged) this.placed = false; // re-spawn on the perch
	}

	private applyConfig(config: PetConfig): void {
		const def = getPet(config.speciesId) ?? defaultPet();
		if (!def) throw new Error("PetEngine: no pet species registered");
		this.def = def;
		this.skin = skinFor(def, config.colorId);
		this.setupSprite();
		this.applySkin();
	}

	private setupSprite(): void {
		const el = this.spriteEl;
		const px = this.def.cell * this.def.scale;
		el.style.backgroundImage = `url("${this.def.sheet}")`;
		el.style.backgroundSize = `${this.def.cols * px}px ${this.def.rows * px}px`;
		el.style.width = `${px}px`;
		el.style.height = `${px}px`;
		el.style.transformOrigin = `50% ${((this.def.anchorY / this.def.cell) * 100).toFixed(2)}%`;
		this.lastBgPos = "";
	}

	private applySkin(): void {
		this.skinAnimation?.cancel();
		this.skinAnimation = null;
		const el = this.spriteEl;
		if (this.skin.animatedHue && typeof el.animate === "function") {
			el.style.filter = this.skin.filter;
			this.skinAnimation = el.animate(
				[0, 72, 144, 216, 288, 360].map((deg) => ({
					filter: `sepia(1) saturate(7) hue-rotate(${deg}deg) brightness(1.08) contrast(1.08)`,
				})),
				{ duration: 3600, iterations: Infinity, easing: "linear" },
			);
		} else {
			el.style.filter = this.skin.filter;
		}
	}

	/** Imperative pokes from the `/cat` command (or other UI). */
	nudge(action: NudgeAction): void {
		switch (action) {
			case "sleep":
				this.mood.sleepiness = 1;
				this.mood.energy = 0.2;
				this.enter("sleep", { startReason: "/cat sleep command" });
				this.speak();
				break;
			case "play":
				this.mood.curiosity = 1;
				this.mood.energy = Math.max(this.mood.energy, 0.75);
				if (!this.ball) this.spawnBall(true);
				this.enter("chaseTail", { startReason: "/cat play command" });
				break;
			case "come":
				if (this.terrain) {
					this.wanderTarget = this.terrain.homeX;
					this.enter("run", {
						startReason: "/cat come command",
						target: `home x=${round1(this.terrain.homeX)}`,
						keepWanderTarget: true,
					});
				}
				break;
			case "wake":
				this.wake();
				this.speak();
				break;
		}
	}

	/** Show a short speech bubble (random line, or the given text). */
	speak(text?: string): void {
		if (!this.speechEl) return;
		const lines = this.def.id === "fox" ? FOX_PHRASES : CAT_PHRASES;
		this.speechEl.textContent = text ?? lines[Math.floor(this.rng() * lines.length)];
		this.speechUntil = performance.now() + 2600;
	}

	// ── Pointer interaction (called by PetLayer) ───────────────────────────────

	setCursor(local: Vec2 | null): void {
		this.cursor = local;
		if (this.grabbed && local) {
			this.body.x = local.x;
			this.body.y = local.y + 6;
		}
	}

	hitTest(local: Vec2): boolean {
		const w = this.spriteW * 0.7;
		const h = this.spriteVisualH * 0.95;
		return local.x >= this.body.x - w / 2 && local.x <= this.body.x + w / 2 && local.y >= this.body.y - h && local.y <= this.body.y + 6;
	}

	beginGrab(local: Vec2): void {
		this.grabbed = true;
		this.body.vx = 0;
		this.body.vy = 0;
		this.body.x = local.x;
		this.body.y = local.y + 6;
		this.wake();
		this.particles.spawn("heart", this.body.x, this.body.y - this.spriteVisualH, 2);
		this.speak();
		this.enter("grabbed", {
			startReason: "pointer grab started",
			target: `cursor x=${round1(local.x)}, y=${round1(local.y)}`,
		});
	}

	endGrab(): void {
		if (!this.grabbed) return;
		this.grabbed = false;
		this.grounded = false;
		this.body.vy = 60;
		this.enter("falling", { startReason: "pointer grab released", endReason: "released by pointer" });
	}

	notifyNewBubble(): void {
		this.newBubblePending = true;
	}

	private wake(): void {
		this.mood.sleepiness = Math.min(this.mood.sleepiness, 0.3);
		if (this.behavior === "sleep" || this.behavior === "doze") {
			this.enter("startled", { startReason: "wake request while sleeping", endReason: "woken up" });
		}
	}

	// ── Main loop ───────────────────────────────────────────────────────────────

	private loop = (now: number): void => {
		if (!this.running) return;
		const dt = Math.min(0.05, (now - this.lastTime) / 1000);
		this.lastTime = now;
		this.update(dt, now);
		this.draw();
		this.rafId = requestAnimationFrame(this.loop);
	};

	private update(dt: number, now: number): void {
		if (now - this.lastTerrainScan > TERRAIN_REFRESH_MS) {
			this.terrain = scanTerrain(this.host, this.terrainSelectors);
			this.lastTerrainScan = now;
		}
		const terrain = this.terrain;
		if (!terrain) return;

		if (!this.placed) {
			this.body = { x: terrain.homeX, y: terrain.homeTop, vx: 0, vy: 0 };
			this.placed = true;
			this.grounded = true;
			this.enter("loaf", {
				now,
				startReason: "initial placement on home platform",
				target: `home x=${round1(terrain.homeX)}, top=${round1(terrain.homeTop)}`,
			});
		}

		const signals: MoodSignals = {
			exerting: this.behavior === "walk" || this.behavior === "run" || this.behavior === "jump" || this.behavior === "play" || this.behavior === "pounce" || this.behavior === "chaseTail",
			resting: this.behavior === "sleep" || this.behavior === "doze",
			newBubble: this.newBubblePending,
		};
		this.mood = updateMood(this.mood, dt, signals);
		if (this.newBubblePending) this.maybeChaseBubble();
		this.newBubblePending = false;

		if (!this.grabbed) {
			this.act(dt, now);
			this.physics(dt, terrain);
		}

		this.stepBall(dt, terrain, now);
		this.maybeSpawnBall(now);
		this.updateVisual(dt);
		this.particles.step(dt);
		if (!this.grabbed && this.rng() < 0.0006) this.speak();
	}

	private act(dt: number, now: number): void {
		const phys = this.def.physics;
		switch (this.behavior) {
			case "walk":
			case "run": {
				const speed = this.behavior === "run" ? phys.runSpeed : phys.walkSpeed;
				if (this.chasingBall && !this.ball) {
					this.stopHorizontalBehavior(now, "ball target disappeared");
					break;
				}
				const target = this.chasingBall && this.ball ? this.ball.x : (this.wanderTarget ??= this.pickWanderTarget());
				if (!Number.isFinite(target)) {
					this.stopHorizontalBehavior(now, "target is invalid");
					break;
				}
				const dx = target - this.body.x;
				const direction = Math.sign(dx);
				const terrain = this.terrain;
				const half = this.spriteW * 0.3;
				if (direction === 0) {
					this.stopHorizontalBehavior(now, "already at target");
					break;
				}
				this.dir = direction < 0 ? -1 : 1;
				if (this.chasingBall && this.ball && Math.abs(this.ball.x - this.body.x) < 38 && this.grounded) {
					this.kickBall();
					break;
				}
				if (shouldStopHorizontalMotion({ bodyX: this.body.x, targetX: target, bounds: terrain?.bounds, halfWidth: half })) {
					this.stopHorizontalBehavior(now, "target reached or blocked by terrain bounds");
				} else if (this.isHorizontalMotionStuck(now)) {
					this.stopHorizontalBehavior(now, "no horizontal progress toward target");
				} else {
					this.targetVx = Math.sign(dx) * speed;
					this.behaviorTarget = `${this.chasingBall ? "ball" : "wander"} x=${round1(target)}`;
				}
				break;
			}
			case "chaseTail":
				this.targetVx = 0;
				this.body.vx *= Math.max(0, 1 - dt * 12);
				this.dir = Math.floor((now - this.animStart) / 180) % 2 === 0 ? this.chaseTailBaseDir : this.chaseTailBaseDir === 1 ? -1 : 1;
				break;
			case "play":
			case "watch":
				this.targetVx = 0;
				break;
			case "falling":
				this.body.vx *= 0.99;
				break;
			case "jump":
			case "pounce":
			case "startled":
				break;
			default:
				this.targetVx = 0;
				break;
		}

		if (now >= this.behaviorEndsAt && this.grounded && !isTransient(this.behavior)) {
			const endReason = this.behaviorEndReason ?? "duration elapsed";
			if (this.behavior === "sleep" || this.behavior === "doze") {
				this.enter("stretch", {
					now,
					startReason: `${BEHAVIOR_ACTION_LABELS[this.behavior]}自然结束，需要伸展`,
					endReason,
				});
			} else {
				this.decide(now, endReason);
			}
		}
	}

	private physics(dt: number, terrain: Terrain): void {
		const phys = this.def.physics;
		if (this.grounded) this.body.vx += (this.targetVx - this.body.vx) * Math.min(1, dt * 11);
		const prevY = this.body.y;
		this.body.vy += phys.gravity * dt;
		this.body.x += this.body.vx * dt;
		this.body.y += this.body.vy * dt;

		const land = resolveLanding(prevY, this.body.y, this.body.x, terrain.platforms);
		const wasAirborne = !this.grounded;
		if (land) {
			this.body.y = land.top;
			this.body.vy = 0;
			if (wasAirborne || this.behavior === "falling") this.onLanded(`landed on ${land.kind} platform ${land.id}`);
			this.grounded = true;
		} else {
			const standing = standingSurface(this.body.x, this.body.y, terrain.platforms);
			if (standing && this.body.vy >= 0) {
				this.body.y = standing.top;
				this.body.vy = 0;
				if (wasAirborne || this.behavior === "falling") {
					this.onLanded(`settled on ${standing.kind} platform ${standing.id}`);
				}
				this.grounded = true;
				return;
			}
			this.grounded = !!groundUnder(this.body.x, this.body.y, terrain.platforms);
			if (!this.grounded && RESTING.has(this.behavior) && this.behavior !== "falling") {
				this.enter("falling", { startReason: "support platform disappeared", endReason: "lost ground support" });
			}
		}

		const half = this.spriteW * 0.3;
		this.body.x = clampToBounds({ x: this.body.x, y: this.body.y }, terrain.bounds, half, 0).x;
		if (this.body.y > terrain.bounds.bottom) {
			this.body.y = terrain.bounds.bottom;
			this.body.vy = 0;
			if (wasAirborne) this.onLanded("landed on bottom world bound");
			this.grounded = true;
		}
	}

	private onLanded(reason: string): void {
		this.particles.spawn("dust", this.body.x, this.body.y, 4);
		this.squash = -0.4;
		this.squashVel = 0;
		this.body.vx = 0;
		this.targetVx = 0;
		this.enter("sit", {
			startReason: reason,
			endReason: "landed",
			durationMs: 350 + this.rng() * 500,
		});
	}

	// ── Behavior selection ───────────────────────────────────────────────────────

	private decide(now: number, endReason: string): void {
		// A ball on the floor is irresistible to an energetic, grounded cat.
		if (this.ball && this.grounded && this.mood.energy > 0.4 && this.rng() < 0.6) {
			this.chasingBall = true;
			this.wanderTarget = this.ball.x;
			this.enter("walk", {
				now,
				startReason: "ball available and energy is high",
				endReason,
				target: `ball x=${round1(this.ball.x)}`,
				keepWanderTarget: true,
			});
			return;
		}
		this.chasingBall = false;
		const ctx: BehaviorContext = {
			hasJumpTargets: !!this.terrain && this.terrain.platforms.some((p) => p.kind === "bubble"),
		};
		const next = pickBehavior(this.mood, ctx, this.rng);
		if (next === "jump") {
			this.startJumpToRandomPlatform("weighted behavior pick: jump", endReason);
			return;
		}
		if (next === "walk" || next === "run") {
			const target = this.pickWanderTarget();
			this.wanderTarget = target;
			this.enter(next, {
				now,
				startReason: `weighted behavior pick; energy=${round3(this.mood.energy)}, sleepiness=${round3(this.mood.sleepiness)}, curiosity=${round3(this.mood.curiosity)}`,
				endReason,
				target: `wander x=${round1(target)}`,
				keepWanderTarget: true,
			});
			return;
		}
		this.enter(next, {
			now,
			startReason: `weighted behavior pick; energy=${round3(this.mood.energy)}, sleepiness=${round3(this.mood.sleepiness)}, curiosity=${round3(this.mood.curiosity)}`,
			endReason,
		});
	}

	private enter(behavior: BehaviorId, options: EnterBehaviorOptions): void {
		const now = options.now ?? performance.now();
		const previous = this.behavior;
		if (previous === behavior) {
			if (this.behaviorStartedAt > 0) {
				this.pushBehaviorEndEvent(previous, now, options.endReason ?? `restarting ${BEHAVIOR_ACTION_LABELS[behavior]}`);
			}
			this.behaviorStartedAt = now;
			this.animStart = now;
			this.behaviorStartReason = options.startReason;
			this.behaviorEndReason = undefined;
			this.behaviorTarget = options.target;
			this.resetHorizontalProgress(now);
			this.behaviorEndsAt = now + (options.durationMs ?? behaviorDuration(behavior, this.rng));
			if (!options.keepWanderTarget) this.wanderTarget = undefined;
			if (behavior === "chaseTail") this.chaseTailBaseDir = this.dir;
			if (behavior === "startled") this.applyStartledPhysics(now);
			this.pushBehaviorStartEvent(behavior, now, options.startReason, options.target);
			return;
		}
		this.pushBehaviorEndEvent(previous, now, options.endReason ?? `switching to ${BEHAVIOR_ACTION_LABELS[behavior]}`);
		this.behavior = behavior;
		this.behaviorStartedAt = now;
		this.animStart = now;
		this.resetHorizontalProgress(now);
		if (!options.keepWanderTarget) this.wanderTarget = undefined;
		this.behaviorEndsAt = now + (options.durationMs ?? behaviorDuration(behavior, this.rng));
		this.behaviorStartReason = options.startReason;
		this.behaviorEndReason = undefined;
		this.behaviorTarget = options.target;
		if (behavior === "chaseTail") this.chaseTailBaseDir = this.dir;
		if (behavior === "startled") {
			this.applyStartledPhysics(now);
		}
		this.pushBehaviorStartEvent(behavior, now, options.startReason, options.target);
	}

	private applyStartledPhysics(now: number): void {
		this.body.vy = -220;
		this.grounded = false;
		this.squash = 0.22;
		this.behaviorEndsAt = now + 600;
	}

	private resetHorizontalProgress(now: number): void {
		this.horizontalProgressAt = now;
		this.horizontalProgressX = this.body.x;
	}

	private stopHorizontalBehavior(now: number, reason: string): void {
		const target = this.behaviorTarget;
		this.targetVx = 0;
		this.body.vx = 0;
		this.wanderTarget = undefined;
		this.chasingBall = false;
		this.enter("sit", {
			now,
			startReason: `${BEHAVIOR_ACTION_LABELS[this.behavior]}结束后稳定身体`,
			endReason: reason,
			target,
			durationMs: 350 + this.rng() * 450,
		});
	}

	private isHorizontalMotionStuck(now: number): boolean {
		if (this.horizontalProgressAt === 0 || this.behaviorStartedAt >= this.horizontalProgressAt) {
			this.horizontalProgressAt = now;
			this.horizontalProgressX = this.body.x;
			return false;
		}
		if (Math.abs(this.body.x - this.horizontalProgressX) > HORIZONTAL_PROGRESS_EPSILON) {
			this.horizontalProgressAt = now;
			this.horizontalProgressX = this.body.x;
			return false;
		}
		return now - this.horizontalProgressAt >= HORIZONTAL_STUCK_MS && Math.abs(this.targetVx) > 1;
	}

	private pushBehaviorStartEvent(behavior: BehaviorId, now: number, reason: string, target?: string): void {
		this.pendingDebugEvents.push({
			id: crypto.randomUUID(),
			ts: Date.now(),
			phase: "start",
			behavior,
			title: target ? `猫：${BEHAVIOR_ACTIVE_LABELS[behavior]}（目标：${target}）` : `猫：${BEHAVIOR_ACTIVE_LABELS[behavior]}`,
			reason,
			target,
			detail: this.describeDebugState(now, `开始原因：${reason}`),
		});
	}

	private pushBehaviorEndEvent(behavior: BehaviorId, now: number, reason: string): void {
		this.pendingDebugEvents.push({
			id: crypto.randomUUID(),
			ts: Date.now(),
			phase: "end",
			behavior,
			title: `猫：结束${BEHAVIOR_ACTION_LABELS[behavior]}`,
			reason,
			target: this.behaviorTarget,
			detail: this.describeDebugState(now, `结束原因：${reason}`),
		});
	}

	private describeDebugState(now: number, reasonLine: string): string {
		const terrain = this.terrain;
		const lines = [
			reasonLine,
			`状态：${BEHAVIOR_ACTIVE_LABELS[this.behavior]} (${this.behavior})`,
			`开始原因：${this.behaviorStartReason}`,
			this.behaviorTarget ? `目标：${this.behaviorTarget}` : "目标：无",
			`持续：${Math.max(0, Math.round(now - this.behaviorStartedAt))}ms / 剩余：${Math.max(0, Math.round(this.behaviorEndsAt - now))}ms`,
			`位置：x=${round1(this.body.x)}, y=${round1(this.body.y)}；速度：vx=${round1(this.body.vx)}, vy=${round1(this.body.vy)}；目标速度：${round1(this.targetVx)}`,
			`朝向：${this.dir < 0 ? "left" : "right"}；着地：${this.grounded ? "yes" : "no"}；抓取：${this.grabbed ? "yes" : "no"}；追球：${this.chasingBall ? "yes" : "no"}`,
			`情绪：energy=${round3(this.mood.energy)}, sleepiness=${round3(this.mood.sleepiness)}, curiosity=${round3(this.mood.curiosity)}`,
		];
		if (terrain) {
			lines.push(
				`地形：platforms=${terrain.platforms.length}, bubbles=${terrain.platforms.filter((platform) => platform.kind === "bubble").length}, bounds=${round1(terrain.bounds.left)}..${round1(terrain.bounds.right)} x ${round1(terrain.bounds.top)}..${round1(terrain.bounds.bottom)}`,
			);
		}
		if (this.ball) {
			lines.push(`球：x=${round1(this.ball.x)}, y=${round1(this.ball.y)}, vx=${round1(this.ball.vx)}, vy=${round1(this.ball.vy)}, age=${Math.max(0, Math.round(now - this.ball.bornAt))}ms`);
		}
		if (this.behaviorEndReason) lines.push(`上次结束原因：${this.behaviorEndReason}`);
		return lines.join("\n");
	}

	private pickWanderTarget(): number {
		const t = this.terrain;
		if (!t) return this.body.x;
		const p = groundUnder(this.body.x, this.body.y, t.platforms) ?? t.platforms[0];
		const lo = p.left + this.spriteW * 0.35;
		const hi = p.right - this.spriteW * 0.35;
		if (hi <= lo) return this.body.x;
		return lo + this.rng() * (hi - lo);
	}

	private startJumpToRandomPlatform(startReason: string, endReason = "switching to 跳跃"): void {
		const t = this.terrain;
		if (!t) return;
		const current = groundUnder(this.body.x, this.body.y, t.platforms);
		const candidates = t.platforms.filter((p) => p !== current);
		const target = candidates.length > 0 ? candidates[Math.floor(this.rng() * candidates.length)] : nearestPlatform({ x: this.body.x, y: this.body.y }, t.platforms, current);
		if (!target) {
			this.enter("walk", {
				startReason: "jump requested but no platform target was available",
				endReason: "no jump target",
			});
			return;
		}
		const v = jumpVelocityTo({ x: this.body.x, y: this.body.y }, target, this.def.physics.gravity, this.def.physics.jumpSpeed);
		if (!v) {
			this.enter("walk", {
				startReason: `jump target ${target.id} was unreachable`,
				endReason: "jump trajectory unavailable",
				target: `${target.kind} ${target.id}`,
			});
			return;
		}
		this.dir = v.x < 0 ? -1 : 1;
		this.body.vx = v.x;
		this.targetVx = v.x;
		this.body.vy = v.y;
		this.grounded = false;
		this.squash = 0.28;
		this.enter("jump", {
			startReason,
			endReason,
			target: `${target.kind} ${target.id} x=${round1((target.left + target.right) / 2)}, top=${round1(target.top)}`,
			durationMs: 3000,
		});
	}

	private maybeChaseBubble(): void {
		if (!this.grounded || this.mood.energy < 0.45 || this.grabbed) return;
		if (this.rng() > 0.5) this.startJumpToRandomPlatform("new message bubble stimulus");
	}

	// ── Ball toy ──────────────────────────────────────────────────────────────

	private maybeSpawnBall(now: number): void {
		if (this.ball || !this.placed || this.grabbed || !this.terrain) return;
		if (this.mood.energy < 0.45 || this.rng() > 0.0009) return;
		this.spawnBall(false, now);
	}

	private spawnBall(fromPet = false, now = performance.now()): void {
		const terrain = this.terrain;
		if (!terrain || this.ball) return;
		if (fromPet) {
			const half = this.spriteW * 0.3;
			const dir = this.dir || 1;
			const x = clampToBounds({ x: this.body.x + dir * 34, y: this.body.y }, terrain.bounds, half, 0).x;
			this.ball = { x, y: this.body.y - this.spriteVisualH * 0.5, vx: dir * 120, vy: -120, bornAt: now };
			this.chasingBall = true;
			this.wanderTarget = x;
			return;
		}
		const p = terrain.platforms[Math.floor(this.rng() * terrain.platforms.length)];
		const x = p.left + this.rng() * Math.max(1, p.right - p.left);
		this.ball = { x, y: p.top - 60, vx: (this.rng() - 0.5) * 40, vy: 0, bornAt: now };
	}

	private kickBall(): void {
		if (!this.ball) return;
		this.ball.vx = this.dir * 240 + (this.rng() - 0.5) * 60;
		this.ball.vy = -190;
		this.chasingBall = false;
		this.enter("play", {
			startReason: "reached the ball and kicked it",
			endReason: "ball reached",
			target: `ball x=${round1(this.ball.x)}, y=${round1(this.ball.y)}`,
		});
		this.particles.spawn("note", this.body.x, this.body.y - this.spriteVisualH, 1);
		if (this.rng() < 0.4) this.speak();
	}

	private stepBall(dt: number, terrain: Terrain, now: number): void {
		const ball = this.ball;
		if (!ball) return;
		ball.vy += this.def.physics.gravity * 0.7 * dt;
		const prevY = ball.y;
		ball.x += ball.vx * dt;
		ball.y += ball.vy * dt;
		ball.vx *= 0.99;
		const land = resolveLanding(prevY, ball.y, ball.x, terrain.platforms);
		if (land) {
			ball.y = land.top;
			ball.vy = ball.vy > 120 ? -ball.vy * 0.45 : 0; // bounce, then settle
			ball.vx *= 0.8;
		}
		if (ball.x < terrain.bounds.left) { ball.x = terrain.bounds.left; ball.vx = Math.abs(ball.vx) * 0.6; }
		if (ball.x > terrain.bounds.right) { ball.x = terrain.bounds.right; ball.vx = -Math.abs(ball.vx) * 0.6; }
		if (ball.y > terrain.bounds.bottom) { ball.y = terrain.bounds.bottom; ball.vy = ball.vy > 120 ? -ball.vy * 0.45 : 0; }
		// Despawn when it's been around a while and is resting.
		const resting = Math.abs(ball.vx) < 6 && Math.abs(ball.vy) < 6;
		if (now - ball.bornAt > 22000 && resting) {
			this.ball = null;
			this.chasingBall = false;
			this.behaviorStartReason = `${this.behaviorStartReason}; ball despawned after resting`;
		}
	}

	// ── Smoothing ───────────────────────────────────────────────────────────────

	private updateVisual(dt: number): void {
		this.facingScale += (this.dir - this.facingScale) * Math.min(1, dt * 13);
		this.squashVel += (-130 * this.squash - 15 * this.squashVel) * dt;
		this.squash += this.squashVel * dt;
	}

	// ── Rendering ─────────────────────────────────────────────────────────────

	private get spriteW(): number {
		return this.def.cell * this.def.scale;
	}
	private get spriteVisualH(): number {
		return this.def.anchorY * this.def.scale;
	}

	private draw(): void {
		const ctx = this.ctx;
		ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
		if (!this.placed) {
			this.spriteEl.style.visibility = "hidden";
			return;
		}

		this.drawBall();

		if (this.grounded && !this.grabbed) {
			ctx.save();
			ctx.globalAlpha = 0.16;
			ctx.fillStyle = "#000";
			ctx.beginPath();
			ctx.ellipse(this.body.x, this.body.y - 1, this.spriteW * 0.26, 3.5, 0, 0, Math.PI * 2);
			ctx.fill();
			ctx.restore();
		}

		this.particles.draw(ctx);
		this.updateSprite();
		this.updateSpeech();
	}

	private updateSprite(): void {
		const el = this.spriteEl;
		el.style.visibility = "visible";
		const anim = animFor(this.def, this.behavior);
		const px = this.def.cell * this.def.scale;
		const frame = Math.floor(((performance.now() - this.animStart) / 1000) * anim.fps) % anim.frames;
		const bgPos = `${-frame * px}px ${-anim.row * px}px`;
		if (bgPos !== this.lastBgPos) {
			el.style.backgroundPosition = bgPos;
			this.lastBgPos = bgPos;
		}
		const bob = this.breathOffset() + this.walkBob();
		const left = Math.round(this.body.x - px / 2);
		const top = Math.round(this.body.y - this.def.anchorY * this.def.scale + bob);
		const sx = this.facingScale * (1 - this.squash * 0.45);
		const sy = 1 + this.squash;
		el.style.transform = `translate(${left}px, ${top}px) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
	}

	private breathOffset(): number {
		if (!RESTING.has(this.behavior)) return 0;
		const amp = this.behavior === "sleep" ? 1.4 : 0.7;
		return Math.sin(performance.now() / 700) * amp;
	}

	private walkBob(): number {
		if (this.behavior === "run" || this.behavior === "chaseTail") return -Math.abs(Math.sin(performance.now() / 90)) * 4;
		if (this.behavior === "walk") return -Math.abs(Math.sin(performance.now() / 140)) * 2.5;
		return 0;
	}

	private drawBall(): void {
		const ball = this.ball;
		if (!ball) return;
		const ctx = this.ctx;
		ctx.save();
		ctx.globalAlpha = 0.14;
		ctx.fillStyle = "#000";
		ctx.beginPath();
		ctx.ellipse(ball.x, ball.y + BALL_RADIUS, BALL_RADIUS, 2.5, 0, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();
		const d = BALL_RADIUS * 2;
		if (this.ballReady) {
			ctx.imageSmoothingEnabled = false;
			ctx.drawImage(this.ballImg, ball.x - BALL_RADIUS, ball.y - BALL_RADIUS, d, d);
		} else {
			ctx.fillStyle = "#c6e34a";
			ctx.beginPath();
			ctx.arc(ball.x, ball.y, BALL_RADIUS, 0, Math.PI * 2);
			ctx.fill();
		}
	}

	private updateSpeech(): void {
		const el = this.speechEl;
		if (!el) return;
		if (performance.now() > this.speechUntil) {
			el.style.opacity = "0";
			return;
		}
		el.style.opacity = "1";
		const x = Math.round(this.body.x);
		const y = Math.round(this.body.y - this.spriteVisualH - 10);
		el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
	}

}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}
