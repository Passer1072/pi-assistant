// React glue for the pet: a full-bleed overlay over the chat screen holding a
// canvas (shadow / ball / particles), the spritesheet sprite element,
// and a speech bubble. The overlay is pointer-events:none so the chat UI stays
// clickable; window-level pointer events drive grab/pet interactions.

import { useEffect, useRef } from "react";
import { PetEngine } from "./engine/PetEngine.ts";
import type { TerrainSelectors } from "./engine/terrain.ts";
import type { PetConfig, Vec2 } from "./types.ts";
import "./pets/cat.ts"; // registers the cat species
import "./pets/fox.ts"; // registers the fox species

export interface PetLayerHandle {
	current: PetEngine | null;
}

export function PetLayer({
	config,
	engineRef,
	messageCount,
	hostSelector = ".chat-screen",
	terrainSelectors,
}: {
	config: PetConfig;
	engineRef?: PetLayerHandle;
	messageCount: number;
	hostSelector?: string;
	terrainSelectors?: TerrainSelectors;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const spriteRef = useRef<HTMLDivElement>(null);
	const speechRef = useRef<HTMLDivElement>(null);
	const engineLocalRef = useRef<PetEngine | null>(null);
	const grabbingRef = useRef(false);

	useEffect(() => {
		const root = rootRef.current;
		const canvas = canvasRef.current;
		const sprite = spriteRef.current;
		const host = root?.closest<HTMLElement>(hostSelector);
		if (!root || !canvas || !sprite || !host) return undefined;

		let engine: PetEngine;
		try {
			engine = new PetEngine(canvas, sprite, host, config, speechRef.current ?? undefined, undefined, terrainSelectors);
		} catch (error) {
			console.warn("PetEngine failed to start:", error);
			return undefined;
		}
		engine.start();
		engineLocalRef.current = engine;
		if (engineRef) engineRef.current = engine;

		const toLocal = (e: PointerEvent): { local: Vec2; inside: boolean } => {
			const rect = host.getBoundingClientRect();
			const local = { x: e.clientX - rect.left, y: e.clientY - rect.top };
			const inside = local.x >= 0 && local.x <= rect.width && local.y >= 0 && local.y <= rect.height;
			return { local, inside };
		};

		const onMove = (e: PointerEvent) => {
			if (!grabbingRef.current) return;
			const { local } = toLocal(e);
			engine.setCursor(local);
		};
		const onDown = (e: PointerEvent) => {
			if (e.button !== 0) return;
			const { local, inside } = toLocal(e);
			if (!inside || !engine.hitTest(local)) return;
			grabbingRef.current = true;
			engine.beginGrab(local);
			e.preventDefault();
		};
		const onUp = () => {
			if (!grabbingRef.current) return;
			grabbingRef.current = false;
			engine.endGrab();
		};
		const onLeave = () => {
			if (!grabbingRef.current) engine.setCursor(null);
		};

		window.addEventListener("pointermove", onMove, { passive: true });
		window.addEventListener("pointerdown", onDown);
		window.addEventListener("pointerup", onUp, { passive: true });
		document.addEventListener("pointerleave", onLeave);

		const resizeObserver = new ResizeObserver(() => engine.resize());
		resizeObserver.observe(host);

		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerdown", onDown);
			window.removeEventListener("pointerup", onUp);
			document.removeEventListener("pointerleave", onLeave);
			resizeObserver.disconnect();
			engine.stop();
			engineLocalRef.current = null;
			if (engineRef && engineRef.current === engine) engineRef.current = null;
		};
		// Engine is created once; config/message changes are pushed via the effects
		// below so the rAF loop and listeners are never torn down mid-play.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		engineLocalRef.current?.setConfig(config);
	}, [config]);

	useEffect(() => {
		engineLocalRef.current?.notifyNewBubble();
	}, [messageCount]);

	return (
		<div ref={rootRef} className="pet-layer" aria-hidden="true">
			<canvas ref={canvasRef} className="pet-canvas" />
			<div ref={spriteRef} className="pet-sprite" />
			<div ref={speechRef} className="pet-speech" />
		</div>
	);
}
