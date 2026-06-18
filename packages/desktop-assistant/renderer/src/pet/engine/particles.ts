// Tiny particle system for emotes: Zzz while sleeping, hearts when petted, music
// notes while playing, dust puffs on landing. Drawn directly on the overlay canvas.

export type ParticleKind = "zzz" | "heart" | "note" | "dust";

interface Particle {
	kind: ParticleKind;
	x: number;
	y: number;
	vx: number;
	vy: number;
	life: number;
	maxLife: number;
	size: number;
	rot: number;
}

const COLORS: Record<ParticleKind, string> = {
	zzz: "#bcd2ff",
	heart: "#ff7eb0",
	note: "#c8a8ff",
	dust: "#cabfae",
};

export class Particles {
	private items: Particle[] = [];

	spawn(kind: ParticleKind, x: number, y: number, count = 1): void {
		for (let i = 0; i < count; i++) {
			const spread = kind === "dust" ? 60 : 18;
			this.items.push({
				kind,
				x: x + (Math.random() - 0.5) * (kind === "dust" ? 6 : 4),
				y,
				vx: (Math.random() - 0.5) * (spread / 30) * (kind === "dust" ? 30 : 14),
				vy: kind === "dust" ? -20 - Math.random() * 30 : -22 - Math.random() * 16,
				life: 0,
				maxLife: kind === "dust" ? 0.5 : 1.4 + Math.random() * 0.6,
				size: kind === "dust" ? 3 + Math.random() * 3 : 10 + Math.random() * 4,
				rot: (Math.random() - 0.5) * 0.6,
			});
		}
	}

	get count(): number {
		return this.items.length;
	}

	step(dt: number): void {
		for (const p of this.items) {
			p.life += dt;
			p.x += p.vx * dt;
			p.y += p.vy * dt;
			if (p.kind === "dust") p.vy += 40 * dt; // dust settles
		}
		this.items = this.items.filter((p) => p.life < p.maxLife);
	}

	draw(ctx: CanvasRenderingContext2D): void {
		for (const p of this.items) {
			const t = p.life / p.maxLife;
			const alpha = p.kind === "dust" ? 1 - t : Math.sin(Math.min(1, t * 1.2) * Math.PI);
			ctx.save();
			ctx.globalAlpha = Math.max(0, alpha);
			ctx.translate(p.x, p.y);
			if (p.kind === "dust") {
				ctx.fillStyle = COLORS.dust;
				ctx.beginPath();
				ctx.arc(0, 0, p.size * (1 - t * 0.4), 0, Math.PI * 2);
				ctx.fill();
			} else if (p.kind === "heart") {
				this.drawHeart(ctx, p.size, COLORS.heart);
			} else {
				ctx.fillStyle = COLORS[p.kind];
				ctx.font = `${Math.round(p.size)}px ui-sans-serif, system-ui, sans-serif`;
				ctx.textAlign = "center";
				ctx.rotate(p.rot);
				ctx.fillText(p.kind === "zzz" ? "Z" : "♪", 0, 0);
			}
			ctx.restore();
		}
	}

	private drawHeart(ctx: CanvasRenderingContext2D, size: number, color: string): void {
		const s = size / 12;
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.moveTo(0, 4 * s);
		ctx.bezierCurveTo(-6 * s, -2 * s, -5 * s, -7 * s, 0, -3 * s);
		ctx.bezierCurveTo(5 * s, -7 * s, 6 * s, -2 * s, 0, 4 * s);
		ctx.fill();
	}
}
