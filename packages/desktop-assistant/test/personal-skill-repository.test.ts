import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildPersonalSkillRoutedPrompt,
	PersonalSkillRepositoryService,
	selectExplicitPersonalSkillId,
} from "../src/agent/personal-skill-repository.ts";

describe("PersonalSkillRepositoryService", () => {
	it("creates, reads, searches, updates, and archives personal skills", () => {
		const workspace = createTempWorkspace();
		try {
			const repository = new PersonalSkillRepositoryService(workspace);

			const created = repository.save({
				id: "music-handoff",
				title: "Music handoff",
				description: "NetEase playlist workflow",
				tags: ["music", "automation"],
				content: "# Workflow\n\n1. Search playlist\n2. Verify playback",
				sourceSessionId: "session-a",
			});

			expect(created.id).toBe("music-handoff");
			expect(created.archived).toBe(false);
			expect(created.content).toContain("scope: personal");
			expect(created.content).toContain('sourceSessionId: "session-a"');
			expect(readFileSync(join(workspace, "data", "personal-skills", "music-handoff", "SKILL.md"), "utf-8")).toBe(
				created.content,
			);

			expect(() =>
				repository.save({
					id: "music-handoff",
					title: "Music handoff",
					description: "Duplicate",
					content: "# Duplicate",
				}),
			).toThrow(/already exists/i);

			const updated = repository.save({
				id: "music-handoff",
				title: "Music handoff",
				description: "Updated NetEase workflow",
				tags: ["music"],
				content: "# Updated\n\nUse MCP playback tools.",
				overwrite: true,
			});
			expect(updated.description).toBe("Updated NetEase workflow");
			expect(repository.read("music-handoff").content).toContain("Use MCP playback tools.");
			expect(repository.search("netease").skills.map((entry) => entry.id)).toEqual(["music-handoff"]);

			const afterArchive = repository.archive("music-handoff");
			expect(afterArchive.skills).toEqual([]);
			expect(existsSync(join(workspace, "data", "personal-skills", "music-handoff"))).toBe(false);
			expect(existsSync(join(workspace, "data", "personal-skills", ".archive"))).toBe(true);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("keeps every id inside data/personal-skills", () => {
		const workspace = createTempWorkspace();
		try {
			const repository = new PersonalSkillRepositoryService(workspace);

			expect(() => repository.read("../outside")).toThrow(/inside data\/personal-skills|reserved/i);
			expect(() =>
				repository.save({
					id: ".archive",
					title: "Archive",
					description: "Reserved",
					content: "# Reserved",
				}),
			).toThrow(/personal skill id is required|reserved/i);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("wraps explicitly selected personal skills without treating them as system skills", () => {
		const workspace = createTempWorkspace();
		try {
			const repository = new PersonalSkillRepositoryService(workspace);
			const skill = repository.save({
				id: "playlist-flow",
				title: "Playlist flow",
				description: "Playlist automation",
				content: "# Steps\n\nUse the playlist workflow.",
			});

			const prompt = buildPersonalSkillRoutedPrompt("Use it now", skill);

			expect(selectExplicitPersonalSkillId("读取 playlist-flow 这个 skill 完成任务")).toBe("playlist-flow");
			expect(prompt).toContain('<selected_personal_skill id="playlist-flow"');
			expect(prompt).toContain("It is not a built-in system skill");
			expect(prompt).toContain("AI may maintain personal skills only");
			expect(prompt).toContain("Use it now");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("does not appear in the built-in desktop skill directory", () => {
		const workspace = createTempWorkspace();
		try {
			const repository = new PersonalSkillRepositoryService(workspace);
			const skill = repository.save({
				id: "handoff",
				title: "Handoff",
				description: "Personal handoff",
				content: "# Handoff",
			});

			expect(skill.path.replace(/\\/g, "/")).toContain("/data/personal-skills/handoff/SKILL.md");
			expect(dirname(skill.path).replace(/\\/g, "/")).not.toContain("/packages/desktop-assistant/skills");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});

function createTempWorkspace(): string {
	return mkdtempSync(join(tmpdir(), "desktop-assistant-personal-skills-"));
}
