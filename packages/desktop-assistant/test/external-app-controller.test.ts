import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalAppController } from "../src/main/external-app-controller.ts";
import { ExternalAppRegistry } from "../src/main/external-app-registry.ts";

const electronMock = vi.hoisted(() => {
	class FakeBrowserWindow {
		static instances: FakeBrowserWindow[] = [];

		destroyed = false;
		minimized = false;
		loadedUrls: string[] = [];
		listeners: Record<string, Array<() => void>> = {};

		constructor() {
			FakeBrowserWindow.instances.push(this);
		}

		isDestroyed(): boolean {
			return this.destroyed;
		}

		isMinimized(): boolean {
			return this.minimized;
		}

		restore(): void {
			this.minimized = false;
		}

		show(): void {}

		focus(): void {}

		loadURL(url: string): Promise<void> {
			this.loadedUrls.push(url);
			return Promise.resolve();
		}

		on(event: string, listener: () => void): this {
			this.listeners[event] = [...(this.listeners[event] ?? []), listener];
			return this;
		}

		destroy(): void {
			if (this.destroyed) return;
			this.destroyed = true;
			for (const listener of this.listeners.closed ?? []) listener();
		}
	}

	return { FakeBrowserWindow };
});

const childProcessMock = vi.hoisted(() => {
	class FakeStream {
		on(_event: string, _listener: (value: unknown) => void): this {
			return this;
		}
	}

	class FakeChildProcess {
		stdout = new FakeStream();
		stderr = new FakeStream();
		pid = 12345;
		killed = false;

		on(_event: string, _listener: (...args: unknown[]) => void): this {
			return this;
		}

		kill(): boolean {
			this.killed = true;
			return true;
		}
	}

	return {
		spawn: vi.fn(() => new FakeChildProcess()),
	};
});

vi.mock("electron", () => ({ BrowserWindow: electronMock.FakeBrowserWindow }));
vi.mock("node:child_process", () => ({ spawn: childProcessMock.spawn }));

describe("ExternalAppController", () => {
	let dir: string;
	let originalFetch: typeof fetch;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "more-app-controller-"));
		originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch;
		electronMock.FakeBrowserWindow.instances = [];
		childProcessMock.spawn.mockClear();
		vi.useFakeTimers();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	it("does not auto-close while the app window is open, then counts idle time after it closes", async () => {
		const registry = new ExternalAppRegistry(dir);
		registry.updateConfig("email-manager", { idleTimeoutMinutes: 0.001 });
		const controller = new ExternalAppController({
			registry,
			addWindow: vi.fn(),
		});

		try {
			await controller.openApp("email-manager");

			expect(controller.listApps().find((app) => app.id === "email-manager")).toMatchObject({
				status: "running",
				windowOpen: true,
			});

			vi.advanceTimersByTime(120);
			expect(controller.listApps().find((app) => app.id === "email-manager")?.status).toBe("running");

			electronMock.FakeBrowserWindow.instances[0]?.destroy();
			expect(controller.listApps().find((app) => app.id === "email-manager")).toMatchObject({
				status: "running",
				windowOpen: false,
			});

			vi.advanceTimersByTime(59);
			expect(controller.listApps().find((app) => app.id === "email-manager")?.status).toBe("running");

			vi.advanceTimersByTime(2);
			expect(controller.listApps().find((app) => app.id === "email-manager")?.status).toBe("stopped");
		} finally {
			controller.dispose();
		}
	});
});
