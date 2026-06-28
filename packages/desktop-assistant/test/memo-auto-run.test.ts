import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DesktopAgentService } from "../src/agent/desktop-agent-service.ts";
import { DryRunDesktopAutomationHost } from "../src/desktop/automation-host.ts";
import type { MemoItem } from "../src/shared/types.ts";

interface StubMemoAutoRunConversation {
	sessionId: string;
	prompt(message: string, source?: unknown): Promise<void>;
	dispose(options?: unknown): Promise<void>;
}

interface MemoAutoRunServiceAccess {
	onMemoReminder(memoId: string, missed: boolean): void;
	runMemoAutoTask(memo: MemoItem): Promise<void>;
	createMemoAutoRunConversation(memo: MemoItem): Promise<StubMemoAutoRunConversation>;
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "memo-auto-run-"));
}

function createService(dir: string): DesktopAgentService {
	return new DesktopAgentService({
		cwd: dir,
		agentDir: dir,
		memoDir: join(dir, "memos"),
		host: new DryRunDesktopAutomationHost(),
	});
}

describe("memo auto-run", () => {
	it("requires a reminder before enabling auto-run through service updates", () => {
		const dir = tempDir();
		try {
			const service = createService(dir);
			const plain = service.createMemo({ title: "Plain" });
			expect(() => service.updateMemo({ id: plain.id, autoRunAtReminder: true })).toThrow("needs a reminder time");

			const reminder = service.createMemo({ title: "Reminder", reminderAt: "2026-06-21T09:00:00.000Z" });
			const enabled = service.updateMemo({ id: reminder.id, autoRunAtReminder: true, autoRunPrompt: "Open report" });
			expect(enabled.autoRunAtReminder).toBe(true);
			expect(enabled.autoRunPrompt).toBe("Open report");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("dispatches auto-run only for on-time reminder fires", async () => {
		const dir = tempDir();
		try {
			const service = createService(dir);
			const access = service as unknown as MemoAutoRunServiceAccess;
			const runMemoAutoTask = vi.fn(async () => {});
			access.runMemoAutoTask = runMemoAutoTask;
			const onTime = service.createMemo({
				title: "Run report",
				reminderAt: "2026-06-21T09:00:00.000Z",
				autoRunAtReminder: true,
			});
			const missed = service.createMemo({
				title: "Missed report",
				reminderAt: "2026-06-21T09:00:00.000Z",
				autoRunAtReminder: true,
			});
			const reminderOnly = service.createMemo({
				title: "Reminder only",
				reminderAt: "2026-06-21T09:00:00.000Z",
			});

			access.onMemoReminder(onTime.id, false);
			access.onMemoReminder(missed.id, true);
			access.onMemoReminder(reminderOnly.id, false);
			await Promise.resolve();

			expect(runMemoAutoTask).toHaveBeenCalledTimes(1);
			expect(runMemoAutoTask).toHaveBeenCalledWith(expect.objectContaining({ id: onTime.id }));
			expect(service.listMemos({}).memos.find((memo) => memo.id === missed.id)?.reminderMissed).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs the scheduled memo prompt in a background conversation and records the session", async () => {
		const dir = tempDir();
		try {
			const service = createService(dir);
			const access = service as unknown as MemoAutoRunServiceAccess;
			const prompts: string[] = [];
			let disposeCount = 0;
			access.createMemoAutoRunConversation = async () => ({
				sessionId: "auto-session-1",
				prompt: async (message: string) => {
					prompts.push(message);
				},
				dispose: async () => {
					disposeCount += 1;
				},
			});
			const memo = service.createMemo({
				title: "Daily report",
				notes: "Use yesterday's numbers.",
				reminderAt: "2026-06-21T09:00:00.000Z",
				autoRunAtReminder: true,
				autoRunPrompt: "Open the report and summarize it.",
			});

			await access.runMemoAutoTask(memo);

			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toContain("Daily report");
			expect(prompts[0]).toContain("Open the report and summarize it.");
			expect(disposeCount).toBe(1);
			expect(service.listMemos({}).memos.find((item) => item.id === memo.id)).toEqual(
				expect.objectContaining({
					lastAutoRunSessionId: "auto-session-1",
					lastAutoRunError: undefined,
					lastAutoRunStatus: "succeeded",
				}),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records failed auto-runs and lets manual rerun use the same path", async () => {
		const dir = tempDir();
		try {
			const service = createService(dir);
			const access = service as unknown as MemoAutoRunServiceAccess;
			let shouldFail = true;
			let promptCount = 0;
			access.createMemoAutoRunConversation = async () => ({
				sessionId: `auto-session-${promptCount + 1}`,
				prompt: async () => {
					promptCount += 1;
					if (shouldFail) throw new Error("background failed");
				},
				dispose: async () => {},
			});
			const memo = service.createMemo({
				title: "Daily report",
				reminderAt: "2026-06-21T09:00:00.000Z",
				autoRunAtReminder: true,
			});

			await expect(access.runMemoAutoTask(memo)).rejects.toThrow("background failed");
			expect(service.listMemos({}).memos.find((item) => item.id === memo.id)).toEqual(
				expect.objectContaining({
					lastAutoRunStatus: "failed",
					lastAutoRunError: "background failed",
				}),
			);

			shouldFail = false;
			const rerun = await service.runMemoAutoTaskNow({ id: memo.id });
			expect(promptCount).toBe(2);
			expect(rerun).toEqual(
				expect.objectContaining({
					lastAutoRunSessionId: "auto-session-2",
					lastAutoRunStatus: "succeeded",
					lastAutoRunError: undefined,
				}),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
