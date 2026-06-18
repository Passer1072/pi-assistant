import type { DesktopAutomationHost } from "./automation-host.ts";

/**
 * Methods on DesktopAutomationHost that physically mutate the single shared
 * desktop (one mouse, one keyboard, one foreground window, one media session).
 * When several conversations run in parallel these must NOT overlap, or two
 * agents would fight over the cursor / focus. Everything else (PowerShell
 * scripts, window/active-window queries) is left to run concurrently so the
 * model can keep thinking and reading in parallel — "compute-parallel,
 * effect-serial".
 */
const WORLD_MUTATING_METHODS: ReadonlySet<keyof DesktopAutomationHost> = new Set([
	"startProcess",
	"runDesktopAction",
	"typeText",
	"keyTap",
	"sendKeyChord",
	"sendMediaCommand",
	"mouseClick",
	"focusWindow",
]);

/**
 * A FIFO async mutex. `run` queues work so that scheduled actions execute one
 * at a time, in submission order, regardless of which conversation submitted
 * them. A failed action never stalls the queue — the chain always advances.
 */
export class DesktopActionScheduler {
	private tail: Promise<unknown> = Promise.resolve();
	private activeCount = 0;

	/** Number of actions currently queued or running (0 means the desktop is free). */
	get pending(): number {
		return this.activeCount;
	}

	/** True while an action holds the desktop lease or is waiting for it. */
	get busy(): boolean {
		return this.activeCount > 0;
	}

	/** Run `fn` exclusively: world-mutating desktop actions never overlap. */
	run<T>(fn: () => Promise<T>): Promise<T> {
		this.activeCount += 1;
		// Chain after whatever is queued, ignoring its outcome so one failed
		// action cannot deadlock the queue for the next session.
		const result = this.tail.then(fn, fn) as Promise<T>;
		this.tail = result.then(
			() => {
				this.activeCount -= 1;
			},
			() => {
				this.activeCount -= 1;
			},
		);
		return result;
	}
}

/**
 * Wrap a DesktopAutomationHost so every world-mutating call goes through the
 * shared scheduler. Read/PowerShell methods pass straight through. The returned
 * host has the same interface, so callers (tools, confirmation approvals) need
 * no changes.
 */
export function createSerializedDesktopHost(
	host: DesktopAutomationHost,
	scheduler: DesktopActionScheduler,
): DesktopAutomationHost {
	return new Proxy(host, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function") {
				return value;
			}
			const bound = value.bind(target);
			if (WORLD_MUTATING_METHODS.has(property as keyof DesktopAutomationHost)) {
				return (...args: unknown[]) => scheduler.run(() => bound(...args));
			}
			return bound;
		},
	}) as DesktopAutomationHost;
}
