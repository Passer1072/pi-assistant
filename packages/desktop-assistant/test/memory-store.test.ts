import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getMemoryStorePaths, MemoryStore } from "../src/agent/memory-store.ts";

describe("MemoryStore", () => {
	it("writes, lists, updates, deletes, and clears global memories", () => {
		const workspace = createTempWorkspace();
		try {
			const store = new MemoryStore(workspace.cwd);
			const created = store.upsert({
				kind: "preference",
				text: "用户偏好：以后都用中文简洁回答",
				confidence: 0.9,
				sourceSessionId: "session-a",
				tags: ["style"],
			});

			expect(created).toBeDefined();
			expect(created?.schemaVersion).toBe(2);
			expect(created?.scope).toBe("workspace");
			expect(created?.source).toBe("auto");
			expect(store.list()).toHaveLength(1);
			const updated = store.update(created!.id, {
				text: "用户偏好：以后都用中文直接回答",
				tags: ["style", "direct"],
			});
			expect(updated?.text).toBe("用户偏好：以后都用中文直接回答");
			expect(updated?.tags).toEqual(["style", "direct"]);
			expect(store.delete(created!.id)).toBe(true);
			expect(store.list()).toEqual([]);

			store.upsert({ kind: "fact", text: "对话事实：已确认使用本地 JSONL 记忆", confidence: 0.7 });
			expect(store.clear()).toBe(1);
			expect(store.list()).toEqual([]);
			expect(existsSync(getMemoryStorePaths(workspace.cwd).memoriesFile)).toBe(true);
		} finally {
			workspace.cleanup();
		}
	});

	it("dedupes similar memories and updates usage when searched", () => {
		const workspace = createTempWorkspace();
		try {
			const store = new MemoryStore(workspace.cwd);
			const first = store.upsert({
				kind: "preference",
				text: "用户偏好：以后都用中文简洁回答",
				confidence: 0.8,
				tags: ["style"],
			});
			const second = store.upsert({
				kind: "preference",
				text: "用户偏好：请以后都用中文简洁回答",
				confidence: 0.9,
				tags: ["style"],
			});

			expect(first?.id).toBe(second?.id);
			const results = store.search("请用中文回答", 5);
			expect(results[0]?.memory.id).toBe(first?.id);
			store.markUsed(results.map((result) => result.memory.id));
			expect(store.list()[0]?.useCount).toBe(1);
		} finally {
			workspace.cleanup();
		}
	});

	it("archives conflicting preferences and redacts secrets", () => {
		const workspace = createTempWorkspace();
		try {
			const store = new MemoryStore(workspace.cwd);
			store.upsert({
				kind: "preference",
				text: "用户偏好：以后都用英文回答",
				confidence: 0.9,
				tags: ["style"],
			});
			const correction = store.upsert({
				kind: "correction",
				text: "用户纠正：以后不要用英文回答，改成中文",
				confidence: 0.9,
				tags: ["correction"],
				archiveSimilarKinds: ["preference"],
			});
			const secret = store.upsert({
				kind: "fact",
				text: "api key: sk-1234567890abcdefghijklmnopqrstuvwxyz",
				confidence: 0.9,
			});

			expect(correction?.kind).toBe("correction");
			expect(store.list()).toHaveLength(1);
			expect(store.list({ includeArchived: true }).some((memory) => memory.archived)).toBe(true);
			expect(secret).toBeUndefined();
			expect(readFileSync(getMemoryStorePaths(workspace.cwd).memoriesFile, "utf-8")).not.toContain("sk-123456");
		} finally {
			workspace.cleanup();
		}
	});

	it("migrates v1 records to schema v2 defaults", () => {
		const workspace = createTempWorkspace();
		try {
			const paths = getMemoryStorePaths(workspace.cwd);
			mkdirSync(paths.memoryDir, { recursive: true });
			const legacy = {
				schemaVersion: 1,
				id: "legacy-1",
				kind: "preference",
				text: "User preference: keep answers concise",
				confidence: 0.7,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				useCount: 0,
				tags: ["style"],
				archived: false,
			};
			writeFileSync(paths.memoriesFile, `${JSON.stringify(legacy)}\n`, "utf-8");
			const store = new MemoryStore(workspace.cwd);

			expect(store.list()[0]).toMatchObject({
				schemaVersion: 2,
				id: "legacy-1",
				scope: "workspace",
				source: "auto",
			});
		} finally {
			workspace.cleanup();
		}
	});
});

function createTempWorkspace(): { cwd: string; cleanup(): void } {
	const root = mkdtempSync(join(tmpdir(), "desktop-assistant-memory-"));
	return {
		cwd: root,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}
