import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AutomationRepositoryService } from "../src/agent/automation-repository.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "automation-repo-"));
}

describe("AutomationRepositoryService", () => {
	it("creates, lists and persists automation flows", () => {
		const dir = tempDir();
		try {
			const repo = new AutomationRepositoryService(dir);
			const flow = repo.create({
				name: "Morning run",
				description: "Open daily tools",
				enabled: true,
				trigger: { kind: "daily", time: "09:00" },
			});
			expect(flow.name).toBe("Morning run");
			expect(flow.trigger).toEqual({ kind: "daily", time: "09:00" });
			expect(flow.nodes.map((node) => node.id)).toEqual(["start", "end"]);
			expect(repo.list().flows).toHaveLength(1);

			const reloaded = new AutomationRepositoryService(dir);
			expect(reloaded.get(flow.id)?.description).toBe("Open daily tools");
			expect(existsSync(join(dir, "automations.json"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("updates enabled state and records bounded run history", () => {
		const dir = tempDir();
		try {
			const repo = new AutomationRepositoryService(dir);
			const flow = repo.create({ name: "Manual flow" });
			expect(repo.setEnabled(flow.id, true).enabled).toBe(true);
			const run = repo.recordRunStart(flow.id, "manual", "session-1");
			expect(run.status).toBe("running");
			const finished = repo.recordRunFinish(flow.id, run.id, "succeeded", { summary: "Done" });
			expect(finished?.status).toBe("succeeded");
			expect(repo.get(flow.id)?.lastRun?.summary).toBe("Done");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not overwrite an already finished run", () => {
		const dir = tempDir();
		try {
			const repo = new AutomationRepositoryService(dir);
			const flow = repo.create({ name: "Finish guard" });
			const run = repo.recordRunStart(flow.id, "test");
			expect(repo.recordRunFinish(flow.id, run.id, "failed", { error: "Stopped" })?.status).toBe("failed");
			expect(repo.recordRunFinish(flow.id, run.id, "succeeded", { summary: "Late success" })?.status).toBe("failed");
			expect(repo.get(flow.id)?.lastRun?.error).toBe("Stopped");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to an empty store when the file is corrupt", () => {
		const dir = tempDir();
		try {
			writeFileSync(join(dir, "automations.json"), "{ nope", "utf-8");
			const repo = new AutomationRepositoryService(dir);
			expect(repo.all()).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("deletes flows", () => {
		const dir = tempDir();
		try {
			const repo = new AutomationRepositoryService(dir);
			const flow = repo.create({ name: "Temporary" });
			expect(repo.delete(flow.id)).toBe(true);
			expect(repo.get(flow.id)).toBeUndefined();
			expect(JSON.parse(readFileSync(join(dir, "automations.json"), "utf-8")).automations).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
