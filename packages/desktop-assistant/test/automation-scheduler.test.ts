import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationScheduler, computeNextRun } from "../src/agent/automation-scheduler.ts";
import type { AutomationFlow } from "../src/shared/types.ts";

function makeFlow(overrides: Partial<AutomationFlow> = {}): AutomationFlow {
	const now = new Date().toISOString();
	return {
		id: overrides.id ?? "flow-1",
		name: "Flow",
		description: "",
		enabled: true,
		nodes: [],
		edges: [],
		trigger: { kind: "manual" },
		runPolicy: { permissionMode: "automatic" },
		runs: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("computeNextRun", () => {
	it("computes interval, daily and weekly schedules", () => {
		const now = new Date("2026-06-20T10:00:00.000Z");
		expect(computeNextRun({ kind: "interval", everyMs: 60_000 }, now)?.toISOString()).toBe(
			"2026-06-20T10:01:00.000Z",
		);
		const daily = new Date(now);
		daily.setDate(daily.getDate() + 1);
		daily.setHours(9, 0, 0, 0);
		const weekly = new Date(now);
		weekly.setHours(11, 0, 0, 0);
		if (weekly.getTime() <= now.getTime()) weekly.setDate(weekly.getDate() + 7);
		expect(computeNextRun({ kind: "daily", time: "09:00" }, now)?.toISOString()).toBe(daily.toISOString());
		expect(computeNextRun({ kind: "weekly", weekdays: [6], time: "11:00" }, now)?.toISOString()).toBe(
			weekly.toISOString(),
		);
	});

	it("returns undefined for manual and expired once triggers", () => {
		const now = new Date("2026-06-20T10:00:00.000Z");
		expect(computeNextRun({ kind: "manual" }, now)).toBeUndefined();
		expect(computeNextRun({ kind: "once", at: "2026-06-20T09:00:00.000Z" }, now)).toBeUndefined();
	});
});

describe("AutomationScheduler", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-20T10:00:00.000Z"));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("fires a scheduled flow after the delay elapses", () => {
		const fired: Array<{ id: string; missed: boolean }> = [];
		const scheduler = new AutomationScheduler((id, missed) => fired.push({ id, missed }));
		scheduler.set(makeFlow({ trigger: { kind: "once", at: new Date(Date.now() + 30_000).toISOString() } }));
		expect(scheduler.scheduledIds()).toEqual(["flow-1"]);
		vi.advanceTimersByTime(31_000);
		expect(fired).toEqual([{ id: "flow-1", missed: false }]);
	});

	it("does not compensate missed persisted runs on rescheduleAll", () => {
		const fired: string[] = [];
		const scheduler = new AutomationScheduler((id) => fired.push(id));
		const missed = scheduler.rescheduleAll([
			makeFlow({
				id: "past",
				trigger: { kind: "interval", everyMs: 60_000 },
				nextRunAt: new Date(Date.now() - 10_000).toISOString(),
			}),
		]);
		expect(fired).toEqual([]);
		expect(missed).toHaveLength(1);
	});
});
