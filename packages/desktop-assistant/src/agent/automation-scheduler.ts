import type { AutomationFlow, AutomationTrigger } from "../shared/types.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;

interface ScheduledAutomation {
	flowId: string;
	fireAt: number;
	handle: ReturnType<typeof setTimeout>;
}

export class AutomationScheduler {
	private readonly scheduled = new Map<string, ScheduledAutomation>();
	private readonly onFire: (flowId: string, missed: boolean) => void;
	private readonly now: () => number;

	constructor(onFire: (flowId: string, missed: boolean) => void, now: () => number = () => Date.now()) {
		this.onFire = onFire;
		this.now = now;
	}

	set(flow: AutomationFlow): string | undefined {
		this.cancel(flow.id);
		if (!flow.enabled) return undefined;
		const next = computeNextRun(flow.trigger, new Date(this.now()));
		if (!next) return undefined;
		this.arm(flow.id, next.getTime(), false);
		return next.toISOString();
	}

	cancel(flowId: string): void {
		const existing = this.scheduled.get(flowId);
		if (!existing) return;
		clearTimeout(existing.handle);
		this.scheduled.delete(flowId);
	}

	rescheduleAll(flows: AutomationFlow[]): Array<{ flowId: string; missedAt: string }> {
		for (const id of [...this.scheduled.keys()]) this.cancel(id);
		const missed: Array<{ flowId: string; missedAt: string }> = [];
		const current = this.now();
		for (const flow of flows) {
			if (!flow.enabled) continue;
			const next = computeNextRun(flow.trigger, new Date(current));
			if (!next) continue;
			const persisted = flow.nextRunAt ? Date.parse(flow.nextRunAt) : Number.NaN;
			if (!Number.isNaN(persisted) && persisted <= current) {
				// Unlike memo reminders, automations may move the user's desktop. Never
				// compensate missed schedules on startup; only surface them to the user.
				missed.push({ flowId: flow.id, missedAt: new Date(persisted).toISOString() });
			}
			if (next.getTime() > current) this.arm(flow.id, next.getTime(), false);
		}
		return missed;
	}

	scheduledIds(): string[] {
		return [...this.scheduled.keys()];
	}

	dispose(): void {
		for (const item of this.scheduled.values()) clearTimeout(item.handle);
		this.scheduled.clear();
	}

	private arm(flowId: string, fireAt: number, missed: boolean): void {
		const delay = Math.max(0, fireAt - this.now());
		const chunk = Math.min(delay, MAX_TIMEOUT_MS);
		const handle = setTimeout(() => {
			this.scheduled.delete(flowId);
			if (this.now() >= fireAt - 50) {
				this.onFire(flowId, missed);
			} else {
				this.arm(flowId, fireAt, missed);
			}
		}, chunk);
		(handle as { unref?: () => void }).unref?.();
		this.scheduled.set(flowId, { flowId, fireAt, handle });
	}
}

export function computeNextRun(trigger: AutomationTrigger, now: Date = new Date()): Date | undefined {
	const current = now.getTime();
	switch (trigger.kind) {
		case "manual":
			return undefined;
		case "once": {
			const at = Date.parse(trigger.at);
			return Number.isNaN(at) || at <= current ? undefined : new Date(at);
		}
		case "interval": {
			if (!Number.isFinite(trigger.everyMs) || trigger.everyMs <= 0) return undefined;
			return new Date(current + trigger.everyMs);
		}
		case "daily":
			return nextDaily(trigger.time, now);
		case "weekly":
			return nextWeekly(trigger.weekdays, trigger.time, now);
	}
}

function nextDaily(time: string, now: Date): Date | undefined {
	const parts = parseTime(time);
	if (!parts) return undefined;
	const candidate = new Date(now);
	candidate.setHours(parts.hour, parts.minute, 0, 0);
	if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
	return candidate;
}

function nextWeekly(weekdays: number[], time: string, now: Date): Date | undefined {
	const parts = parseTime(time);
	if (!parts) return undefined;
	const days = weekdays.length > 0 ? [...new Set(weekdays)].filter((day) => day >= 0 && day <= 6) : [now.getDay()];
	let best: Date | undefined;
	for (const day of days) {
		const candidate = new Date(now);
		const delta = (day - now.getDay() + 7) % 7;
		candidate.setDate(candidate.getDate() + delta);
		candidate.setHours(parts.hour, parts.minute, 0, 0);
		if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 7);
		if (!best || candidate.getTime() < best.getTime()) best = candidate;
	}
	return best;
}

function parseTime(value: string): { hour: number; minute: number } | undefined {
	const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
	if (!match) return undefined;
	return { hour: Number(match[1]), minute: Number(match[2]) };
}
