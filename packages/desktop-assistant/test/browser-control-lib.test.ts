import { describe, expect, it } from "vitest";
import {
	compactAxNodes,
	createTabScheduler,
	cursorPath,
	flattenFrameTree,
} from "../mcp-servers/browser-control/extension/lib.mjs";

describe("createTabScheduler", () => {
	const task = (state: { active: number; max: number }, delay: number) => () =>
		new Promise<void>((resolve) => {
			state.active += 1;
			state.max = Math.max(state.max, state.active);
			setTimeout(() => {
				state.active -= 1;
				resolve();
			}, delay);
		});

	it("serializes input on the same tab so two sessions never interleave", async () => {
		const scheduler = createTabScheduler();
		const state = { active: 0, max: 0 };
		await Promise.all([
			scheduler.run("tab-7", task(state, 20)),
			scheduler.run("tab-7", task(state, 1)),
			scheduler.run("tab-7", task(state, 1)),
		]);
		expect(state.max).toBe(1);
	});

	it("runs different tabs in parallel", async () => {
		const scheduler = createTabScheduler();
		const state = { active: 0, max: 0 };
		await Promise.all([scheduler.run("tab-1", task(state, 20)), scheduler.run("tab-2", task(state, 20))]);
		expect(state.max).toBe(2);
	});

	it("keeps draining a tab queue after a step rejects", async () => {
		const scheduler = createTabScheduler();
		const failing = scheduler.run("tab-9", () => Promise.reject(new Error("boom")));
		const next = scheduler.run("tab-9", () => Promise.resolve("ok"));
		await expect(failing).rejects.toThrow("boom");
		await expect(next).resolves.toBe("ok");
	});
});

describe("cursorPath", () => {
	it("starts exactly at the source and ends exactly at the target", () => {
		const path = cursorPath({ x: 10, y: 20 }, { x: 210, y: 120 }, { rng: () => 0.5 });
		expect(path[0]).toEqual({ x: 10, y: 20 });
		expect(path[path.length - 1]).toEqual({ x: 210, y: 120 });
		expect(path.length).toBeGreaterThanOrEqual(8);
	});

	it("falls back to the target as origin when from is undefined", () => {
		const path = cursorPath(undefined, { x: 5, y: 5 });
		expect(path[0]).toEqual({ x: 5, y: 5 });
		expect(path[path.length - 1]).toEqual({ x: 5, y: 5 });
	});
});

describe("compactAxNodes", () => {
	it("drops ignored / role=none nodes and keeps named roles", () => {
		const nodes = [
			{ nodeId: "1", role: { value: "WebArea" }, name: { value: "Doc" }, childIds: ["2"] },
			{ nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "OK" } },
			{ nodeId: "3", parentId: "1", ignored: true, role: { value: "generic" } },
			{ nodeId: "4", parentId: "1", role: { value: "none" } },
		];
		const out = compactAxNodes(nodes, 10);
		expect(out.map((node) => node.role)).toEqual(["WebArea", "button"]);
		expect(out.find((node) => node.name === "OK")?.level).toBe(1);
	});

	it("caps the number of returned nodes", () => {
		const nodes = Array.from({ length: 50 }, (_, i) => ({
			nodeId: String(i),
			role: { value: "listitem" },
			name: { value: `n${i}` },
		}));
		expect(compactAxNodes(nodes, 10).length).toBe(10);
	});
});

describe("flattenFrameTree", () => {
	it("flattens nested frames with depth", () => {
		const tree = {
			frame: { id: "a", url: "http://x" },
			childFrames: [{ frame: { id: "b", parentId: "a", url: "http://y" } }],
		};
		const flat = flattenFrameTree(tree);
		expect(flat.length).toBe(2);
		expect(flat[0].frameId).toBe("a");
		expect(flat[1].depth).toBe(1);
	});
});
