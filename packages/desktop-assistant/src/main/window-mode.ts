import { type BrowserWindow, type Rectangle, screen } from "electron";
import type { WindowMode } from "../shared/types.ts";

const COMPACT = { width: 440, height: 820, minW: 360, minH: 560, maxW: 640 };
const EXPANDED = { defaultW: 1080, defaultH: 760, minW: 760, minH: 560, margin: 80 };
const TWEEN_MS = 360;

type Bounds = { x: number; y: number; width: number; height: number };

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

export function applyWindowMode(win: BrowserWindow, mode: WindowMode, opts: { animate?: boolean } = {}): void {
	if (win.isDestroyed()) return;
	const area = screen.getDisplayMatching(win.getBounds()).workArea;
	const current = win.getBounds();
	const animate = opts.animate !== false;

	if (mode === "expanded") {
		win.setMaximumSize(area.width, area.height);
		win.setMinimumSize(EXPANDED.minW, EXPANDED.minH);
		const width = Math.min(EXPANDED.defaultW, area.width - EXPANDED.margin);
		const height = Math.min(EXPANDED.defaultH, area.height - EXPANDED.margin);
		const target = clamp(
			{
				x: centerX(current, width),
				y: centerY(current, height),
				width,
				height,
			},
			area,
		);
		tween(win, target, animate);
		return;
	}

	win.setMinimumSize(COMPACT.minW, COMPACT.minH);
	const target = clamp(
		{
			x: centerX(current, COMPACT.width),
			y: current.y,
			width: COMPACT.width,
			height: COMPACT.height,
		},
		area,
	);
	tween(win, target, animate, () => {
		if (!win.isDestroyed()) win.setMaximumSize(COMPACT.maxW, 0);
	});
}

const centerX = (bounds: Bounds, width: number): number => Math.round(bounds.x + bounds.width / 2 - width / 2);
const centerY = (bounds: Bounds, height: number): number => Math.round(bounds.y + bounds.height / 2 - height / 2);

function clamp(bounds: Bounds, area: Rectangle): Bounds {
	return {
		width: bounds.width,
		height: bounds.height,
		x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width)),
		y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height)),
	};
}

function tween(win: BrowserWindow, target: Bounds, animate: boolean, done?: () => void): void {
	if (!animate) {
		win.setBounds(target);
		done?.();
		return;
	}

	const start = win.getBounds();
	const startedAt = Date.now();
	const timer = setInterval(() => {
		if (win.isDestroyed()) {
			clearInterval(timer);
			return;
		}
		const t = Math.min(1, (Date.now() - startedAt) / TWEEN_MS);
		const k = easeOutCubic(t);
		win.setBounds({
			x: Math.round(start.x + (target.x - start.x) * k),
			y: Math.round(start.y + (target.y - start.y) * k),
			width: Math.round(start.width + (target.width - start.width) * k),
			height: Math.round(start.height + (target.height - start.height) * k),
		});
		if (t >= 1) {
			clearInterval(timer);
			done?.();
		}
	}, 16);
}
