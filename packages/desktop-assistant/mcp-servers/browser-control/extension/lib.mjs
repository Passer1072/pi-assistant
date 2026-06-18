/**
 * Shared, side-effect-free helpers for the browser-control MCP.
 *
 * This module is imported by BOTH runtimes:
 *   - the Node MCP server (browser-control-mcp-server.mjs) for the debug/CDP backend, and
 *   - the Chrome/Edge MV3 extension service worker (extension/background.js) for the
 *     normal-browser backend.
 *
 * Therefore it must stay pure ESM: no Node APIs, no `chrome.*`, no DOM access at module
 * scope. The DOM-touching functions (setupCursorOverlay / setupTabMarker / overlayCall)
 * are written to be self-contained so they can be (a) handed to `chrome.scripting
 * .executeScript({ func })` in the extension and (b) stringified via `.toString()` and
 * run through CDP `Runtime.evaluate` in the debug backend.
 */

// ---------------------------------------------------------------------------
// Humanized cursor motion math
// ---------------------------------------------------------------------------

export function easeInOutCubic(t) {
	return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Stronger ease-in/ease-out — pronounced acceleration then deceleration, reads more human. */
export function easeInOutQuart(t) {
	return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
}

/** Total glide duration (ms) for a move of `dist` px — distance-scaled and clamped. */
export function cursorDuration(dist) {
	return Math.max(240, Math.min(900, 180 + dist * 0.8));
}

/** Per-step move delay (ms) — small so motion looks smooth, not robotic. */
export function humanStepDelay(rng = Math.random) {
	return 6 + rng() * 10;
}

/** Per-character typing delay (ms) with the occasional longer "thinking" pause. */
export function humanTypeDelay(rng = Math.random) {
	const base = 45 + rng() * 70;
	return rng() < 0.08 ? base + 120 + rng() * 160 : base;
}

/** Delay between mousePressed and mouseReleased (ms). */
export function humanPressDelay(rng = Math.random) {
	return 40 + rng() * 50;
}

/** Gap between the two clicks of a double-click (ms). */
export function doubleClickGap(rng = Math.random) {
	return 80 + rng() * 60;
}

/**
 * Build an eased, slightly-bowed path of viewport points from `from` to `to`.
 * The first point is exactly `from` and the last is exactly `to`, so callers can
 * dispatch trusted press/release at the precise target. A small perpendicular bow
 * and sub-pixel jitter make the motion read as human rather than a straight ramp.
 *
 * @param {{x:number,y:number}|undefined} from
 * @param {{x:number,y:number}} to
 * @param {{ rng?: () => number }} [opts] deterministic rng injection for tests
 * @returns {{x:number,y:number}[]}
 */
export function cursorPath(from, to, { rng = Math.random, steps } = {}) {
	const fx = from?.x ?? to.x;
	const fy = from?.y ?? to.y;
	const dx = to.x - fx;
	const dy = to.y - fy;
	const dist = Math.hypot(dx, dy);
	// Finer sampling (≈one waypoint per 16px) makes the trusted move stream feel fluid.
	const count = steps ?? Math.max(12, Math.min(60, Math.round(dist / 16)));
	// Perpendicular unit vector for the arc control point (a gentle, human bow).
	const nx = dist ? -dy / dist : 0;
	const ny = dist ? dx / dist : 0;
	const bow = Math.min(36, dist * 0.12) * (rng() < 0.5 ? -1 : 1);
	const cx = fx + dx / 2 + nx * bow;
	const cy = fy + dy / 2 + ny * bow;
	const points = [];
	for (let i = 0; i <= count; i += 1) {
		const t = easeInOutQuart(i / count);
		const mt = 1 - t;
		let x = mt * mt * fx + 2 * mt * t * cx + t * t * to.x;
		let y = mt * mt * fy + 2 * mt * t * cy + t * t * to.y;
		if (i > 0 && i < count) {
			x += (rng() - 0.5) * 0.6;
			y += (rng() - 0.5) * 0.6;
		}
		points.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
	}
	// Pin the exact endpoints so the click lands where the caller asked.
	points[0] = { x: fx, y: fy };
	points[points.length - 1] = { x: to.x, y: to.y };
	return points;
}

// ---------------------------------------------------------------------------
// Per-tab FIFO mutex so parallel MCP sessions never interleave input on one tab
// ---------------------------------------------------------------------------

/**
 * Returns a scheduler whose `run(key, fn)` chains work behind whatever is already
 * queued for `key`, advancing even when a prior task rejects (one bad action never
 * deadlocks the tab). Different keys run in parallel. Modelled on the desktop
 * DesktopActionScheduler but keyed by tab id.
 */
export function createTabScheduler() {
	const queues = new Map();
	return {
		run(key, fn) {
			const k = String(key);
			const prev = queues.get(k) ?? Promise.resolve();
			const next = prev.then(fn, fn);
			queues.set(
				k,
				next.then(
					() => {},
					() => {},
				),
			);
			return next;
		},
		delete(key) {
			queues.delete(String(key));
		},
		get size() {
			return queues.size;
		},
	};
}

// ---------------------------------------------------------------------------
// In-page virtual cursor overlay (self-contained — DOM only, no eval)
// ---------------------------------------------------------------------------

/**
 * Inject (idempotently) a `window.__aiCursor` API that renders a fake mouse pointer
 * inside the page. Pure DOM, `pointer-events:none`, top z-index — it can never
 * intercept the user's real pointer, and the real OS cursor is never touched.
 * Designed to be passed to `chrome.scripting.executeScript({ func })` or stringified.
 */
export function setupCursorOverlay(opts) {
	opts = opts || {};
	const theme = opts.theme || "#6aa9ff";
	const ID = "__ai_cursor_overlay__";
	const existing = document.getElementById(ID);
	const root = existing || document.createElement("div");
	if (!existing) {
		root.id = ID;
		root.setAttribute("aria-hidden", "true");
		const s = root.style;
		s.position = "fixed";
		s.left = "0";
		s.top = "0";
		s.width = "0";
		s.height = "0";
		s.margin = "0";
		s.padding = "0";
		s.zIndex = "2147483647";
		s.pointerEvents = "none";
		s.transform = "translate(-200px,-200px)";
		s.willChange = "transform";
		// Theme-color halo (glow) behind the pointer + the arrow + a click ripple ring + label.
		root.innerHTML =
			'<div class="__ai_glow" style="position:absolute;left:-23px;top:-23px;width:46px;height:46px;border-radius:50%;background:radial-gradient(circle,COLOR 0%,COLOR 28%,transparent 72%);opacity:.5;filter:blur(2px);transition:opacity .2s ease-out,transform .2s ease-out"></div>'.replace(
				/COLOR/g,
				theme,
			) +
			'<svg width="26" height="26" viewBox="0 0 24 24" style="position:absolute;left:-2px;top:-2px;overflow:visible;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">' +
			'<path d="M3 2 L3 20.5 L8 15.5 L11.2 22.5 L14.2 21.2 L11 14.3 L18 14.3 Z" fill="#ffffff" stroke="#1b1b1b" stroke-width="1.4" stroke-linejoin="round"/>' +
			"</svg>" +
			'<div class="__ai_ring" style="position:absolute;left:0;top:0;width:16px;height:16px;margin:-8px 0 0 -8px;border:2px solid COLOR;border-radius:50%;opacity:0;transform:scale(0.2);box-shadow:0 0 8px COLOR;transition:transform .2s ease-out,opacity .2s ease-out"></div>'.replace(
				/COLOR/g,
				theme,
			) +
			'<div class="__ai_label" style="position:absolute;left:18px;top:14px;font:600 11px/1.4 system-ui,sans-serif;color:#fff;background:rgba(20,20,28,.82);padding:1px 6px;border-radius:6px;white-space:nowrap;opacity:0"></div>';
		(document.documentElement || document.body).appendChild(root);
	}
	const glow = root.querySelector(".__ai_glow");
	const ring = root.querySelector(".__ai_ring");
	const label = root.querySelector(".__ai_label");
	const api = {
		theme,
		_raf: 0,
		_render() {
			root.style.transform = "translate(" + api.x + "px," + api.y + "px)";
		},
		moveTo(x, y) {
			if (api._raf) {
				cancelAnimationFrame(api._raf);
				api._raf = 0;
			}
			api.x = x;
			api.y = y;
			api._render();
		},
		/** Smoothly animate to (x,y) over `duration` ms via rAF (60fps when the tab is visible). */
		glideTo(x, y, duration) {
			if (api._raf) cancelAnimationFrame(api._raf);
			const sx = api.x;
			const sy = api.y;
			const dx = x - sx;
			const dy = y - sy;
			const dur = Math.max(1, Number(duration) || 1);
			const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
			const ease = (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2);
			const tick = () => {
				const now = typeof performance !== "undefined" ? performance.now() : Date.now();
				const t = Math.min(1, (now - t0) / dur);
				const e = ease(t);
				api.x = sx + dx * e;
				api.y = sy + dy * e;
				api._render();
				api._raf = t < 1 ? requestAnimationFrame(tick) : 0;
			};
			api._raf = requestAnimationFrame(tick);
		},
		show() {
			root.style.display = "";
		},
		hide() {
			root.style.display = "none";
		},
		press() {
			if (ring) {
				ring.style.opacity = "1";
				ring.style.transform = "scale(1.6)";
			}
			if (glow) {
				glow.style.opacity = ".85";
				glow.style.transform = "scale(1.3)";
			}
		},
		release() {
			if (ring) {
				ring.style.opacity = "0";
				ring.style.transform = "scale(0.2)";
			}
			if (glow) {
				glow.style.opacity = ".5";
				glow.style.transform = "scale(1)";
			}
		},
		setTheme(color) {
			if (!color) return;
			api.theme = color;
			if (glow) glow.style.background = "radial-gradient(circle," + color + " 0%," + color + " 28%,transparent 72%)";
			if (ring) {
				ring.style.borderColor = color;
				ring.style.boxShadow = "0 0 8px " + color;
			}
		},
		setStyle(style) {
			style = style || {};
			if (style.theme) api.setTheme(style.theme);
			if (label && style.label !== undefined) {
				label.textContent = String(style.label);
				label.style.opacity = style.label ? "1" : "0";
			}
		},
		getPos() {
			return { x: api.x, y: api.y };
		},
	};
	if (existing && window.__aiCursor) {
		// Preserve last position across re-injection (e.g. after navigation).
		api.x = window.__aiCursor.x;
		api.y = window.__aiCursor.y;
	} else {
		api.x = opts.x != null ? opts.x : Math.round((window.innerWidth || 800) / 2);
		api.y = opts.y != null ? opts.y : Math.round((window.innerHeight || 600) / 2);
	}
	window.__aiCursor = api;
	api.setTheme(theme);
	api._render();
	if (opts.label !== undefined) api.setStyle({ label: opts.label });
	return { x: api.x, y: api.y };
}

/** Call a method on the in-page cursor; used per motion step via executeScript/evaluate. */
export function cursorOverlayCall(call, args) {
	const cursor = window.__aiCursor;
	if (!cursor || typeof cursor[call] !== "function") return null;
	const result = cursor[call].apply(cursor, args || []);
	return result === undefined ? null : result;
}

// ---------------------------------------------------------------------------
// "AI 操作中" tab-title marker (self-contained)
// ---------------------------------------------------------------------------

/**
 * Prefix `document.title` with an "AI 操作中" marker so the controlled tab is obvious
 * in the Chrome tab strip. Re-applies on SPA title changes via a MutationObserver and
 * a low-frequency interval. Idempotent.
 */
export function setupTabMarker(opts) {
	opts = opts || {};
	const PREFIX = opts.prefix || "🟢 AI 操作中 · ";
	if (window.__aiTabMarker && window.__aiTabMarker.active) {
		window.__aiTabMarker.prefix = PREFIX;
		window.__aiTabMarker.apply();
		return { ok: true, title: document.title };
	}
	const state = {
		active: true,
		prefix: PREFIX,
		original: (document.title || "").replace(/^🟢 AI 操作中 · /, ""),
		apply() {
			const base = (document.title || "").replace(/^🟢 AI 操作中 · /, "");
			if (base) state.original = base;
			const want = state.prefix + state.original;
			if (document.title !== want) document.title = want;
		},
		restore() {
			state.active = false;
			if (state.observer) state.observer.disconnect();
			if (state.timer) clearInterval(state.timer);
			document.title = state.original;
		},
	};
	const titleEl = document.querySelector("title");
	if (titleEl && typeof MutationObserver !== "undefined") {
		state.observer = new MutationObserver(() => {
			if (state.active) state.apply();
		});
		state.observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
	}
	state.timer = setInterval(() => {
		if (state.active) state.apply();
	}, 1500);
	window.__aiTabMarker = state;
	state.apply();
	return { ok: true, title: document.title };
}

/** Remove the tab marker (restore the original title). */
export function restoreTabMarker() {
	if (window.__aiTabMarker && window.__aiTabMarker.active) {
		window.__aiTabMarker.restore();
		return { ok: true, restored: true };
	}
	return { ok: true, restored: false };
}

// ---------------------------------------------------------------------------
// CDP result shaping (shared by both backends; pure transforms over CDP JSON)
// ---------------------------------------------------------------------------

/** Compress a CDP Accessibility.getFullAXTree node list into a token-frugal outline. */
export function compactAxNodes(nodes, max = 400) {
	const byId = new Map();
	for (const node of nodes) byId.set(node.nodeId, node);
	const depthOf = (node) => {
		let depth = 0;
		let current = node;
		while (current && current.parentId && byId.has(current.parentId) && depth < 64) {
			current = byId.get(current.parentId);
			depth += 1;
		}
		return depth;
	};
	const out = [];
	for (const node of nodes) {
		if (out.length >= max) break;
		if (node.ignored) continue;
		const role = node.role?.value;
		if (!role || role === "none" || role === "InlineTextBox") continue;
		const name = node.name?.value || "";
		const value = node.value?.value;
		if (!name && role === "generic") continue;
		out.push({
			role,
			name: typeof name === "string" ? name.slice(0, 200) : name,
			...(value !== undefined && value !== "" ? { value: String(value).slice(0, 120) } : {}),
			level: depthOf(node),
			childCount: Array.isArray(node.childIds) ? node.childIds.length : 0,
		});
	}
	return out;
}

/** Flatten a CDP Page.getFrameTree into a simple list. */
export function flattenFrameTree(frameTree, depth = 0, out = []) {
	if (!frameTree) return out;
	const frame = frameTree.frame || {};
	out.push({
		frameId: frame.id,
		parentId: frame.parentId,
		url: frame.url,
		name: frame.name,
		depth,
		crossOrigin: Boolean(frame.crossOriginIsolatedContextType && frame.crossOriginIsolatedContextType !== "NotIsolated"),
	});
	for (const child of frameTree.childFrames || []) flattenFrameTree(child, depth + 1, out);
	return out;
}

/** Normalize a CDP console / log event into a small record. */
export function normalizeConsoleEvent(msg) {
	const p = msg.params || {};
	if (msg.method === "Log.entryAdded") {
		const entry = p.entry || {};
		return { level: entry.level || "info", text: String(entry.text || "").slice(0, 1000), ts: entry.timestamp || Date.now() };
	}
	const args = (p.args || []).map((a) => (a.value !== undefined ? a.value : a.description)).filter((v) => v !== undefined);
	return {
		level: p.type || "log",
		text: args.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ").slice(0, 1000),
		ts: p.timestamp || Date.now(),
	};
}

/** Normalize a CDP Network.responseReceived event into a small record. */
export function normalizeNetworkEvent(msg) {
	const p = msg.params || {};
	const r = p.response || {};
	return {
		method: r.requestMethod || (r.requestHeaders && r.requestHeaders[":method"]) || "GET",
		url: String(r.url || "").slice(0, 500),
		status: r.status,
		type: p.type,
		mime: r.mimeType,
		ts: (p.timestamp || 0) * 1000 || Date.now(),
	};
}

/** Append to a capped ring buffer stored in `map` under `key`. */
export function pushRing(map, key, entry, cap = 300) {
	const k = String(key);
	const list = map.get(k) || [];
	list.push(entry);
	if (list.length > cap) list.splice(0, list.length - cap);
	map.set(k, list);
	return list;
}
