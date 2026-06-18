import { describe, expect, it, vi } from "vitest";
import type { CommandResult, DesktopAutomationHost } from "../src/desktop/automation-host.ts";
import { createSerializedDesktopHost, DesktopActionScheduler } from "../src/desktop/desktop-action-scheduler.ts";
import type { WindowInfo } from "../src/shared/types.ts";

describe("DesktopActionScheduler", () => {
	it("serializes overlapping actions so they never run concurrently", async () => {
		const scheduler = new DesktopActionScheduler();
		let active = 0;
		let maxConcurrent = 0;
		const makeAction = (delay: number) => () =>
			new Promise<number>((resolve) => {
				active += 1;
				maxConcurrent = Math.max(maxConcurrent, active);
				setTimeout(() => {
					active -= 1;
					resolve(delay);
				}, delay);
			});

		// Submit "slow then fast" — without serialization the fast one would finish first.
		const results = await Promise.all([
			scheduler.run(makeAction(30)),
			scheduler.run(makeAction(1)),
			scheduler.run(makeAction(1)),
		]);

		expect(maxConcurrent).toBe(1);
		expect(results).toEqual([30, 1, 1]);
		expect(scheduler.pending).toBe(0);
	});

	it("preserves FIFO order of submitted actions", async () => {
		const scheduler = new DesktopActionScheduler();
		const order: number[] = [];
		await Promise.all(
			[0, 1, 2, 3].map((index) =>
				scheduler.run(async () => {
					await new Promise((resolve) => setTimeout(resolve, (4 - index) * 5));
					order.push(index);
				}),
			),
		);
		expect(order).toEqual([0, 1, 2, 3]);
	});

	it("keeps draining the queue after an action rejects", async () => {
		const scheduler = new DesktopActionScheduler();
		const failing = scheduler.run(() => Promise.reject(new Error("boom")));
		const next = scheduler.run(() => Promise.resolve("ok"));
		await expect(failing).rejects.toThrow("boom");
		await expect(next).resolves.toBe("ok");
		expect(scheduler.pending).toBe(0);
	});
});

describe("createSerializedDesktopHost", () => {
	it("routes world-mutating calls through the scheduler but passes reads straight through", async () => {
		const calls: string[] = [];
		let active = 0;
		let maxConcurrent = 0;
		const mutate = (name: string) => async (): Promise<CommandResult> => {
			calls.push(name);
			active += 1;
			maxConcurrent = Math.max(maxConcurrent, active);
			await new Promise((resolve) => setTimeout(resolve, 10));
			active -= 1;
			return { stdout: name, stderr: "", code: 0 } as unknown as CommandResult;
		};
		const host = {
			runDesktopAction: mutate("runDesktopAction"),
			typeText: mutate("typeText"),
			mouseClick: mutate("mouseClick"),
			listWindows: vi.fn(async (): Promise<WindowInfo[]> => []),
			getActiveWindow: vi.fn(async (): Promise<WindowInfo | undefined> => undefined),
		} as unknown as DesktopAutomationHost;

		const scheduler = new DesktopActionScheduler();
		const serialized = createSerializedDesktopHost(host, scheduler);

		await Promise.all([
			serialized.runDesktopAction("open", "app"),
			serialized.typeText("hello"),
			serialized.mouseClick("left"),
			// Reads are not gated by the lease.
			serialized.listWindows(),
			serialized.getActiveWindow(),
		]);

		expect(maxConcurrent).toBe(1);
		expect(calls).toEqual(["runDesktopAction", "typeText", "mouseClick"]);
	});
});
