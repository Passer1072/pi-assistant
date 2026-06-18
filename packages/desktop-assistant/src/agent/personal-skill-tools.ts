import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DesktopToolResult, PersonalSkillSaveRequest } from "../shared/types.ts";
import type { PersonalSkillRepositoryService } from "./personal-skill-repository.ts";

export const PERSONAL_SKILL_TOOL_NAMES = [
	"personal_skill_search",
	"personal_skill_read",
	"personal_skill_save",
	"personal_skill_archive",
	"personal_skill_refresh",
] as const;

export function createPersonalSkillToolDefinitions(options: {
	repository: PersonalSkillRepositoryService;
	getSourceSessionId: () => string | undefined;
}): ToolDefinition[] {
	return [
		defineTool({
			name: "personal_skill_search",
			label: "Search personal skills",
			description:
				"Search only the user's project-local personal skill repository under data/personal-skills. This never searches or changes built-in system skills.",
			promptSnippet:
				"Search personal, user-customized workflow notes. Use when the user explicitly asks to find, read, learn, or use a personal/custom skill.",
			promptGuidelines: PERSONAL_SKILL_GUIDELINES,
			parameters: Type.Object({
				query: Type.String({ description: "Search query, skill id, title, or tags." }),
				limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
			}),
			execute: async (_toolCallId, params) =>
				personalSkillResult("Search personal skills", "personal_skill_search", params.query, () =>
					options.repository.search(params.query, params.limit),
				),
		}),
		defineTool({
			name: "personal_skill_read",
			label: "Read personal skill",
			description:
				"Read one personal custom skill by id from data/personal-skills. It cannot read built-in system skills.",
			promptSnippet: "Read a personal skill only after the user explicitly asks to learn or use that skill.",
			promptGuidelines: PERSONAL_SKILL_GUIDELINES,
			parameters: Type.Object({
				id: Type.String({ description: "Personal skill id, e.g. netease-playlist-workflow." }),
			}),
			execute: async (_toolCallId, params) =>
				personalSkillResult("Read personal skill", "personal_skill_read", params.id, () =>
					options.repository.read(params.id),
				),
		}),
		defineTool({
			name: "personal_skill_save",
			label: "Save personal skill",
			description:
				"Save a user-customized personal skill or handoff document under data/personal-skills. This is the only AI-writeable skill surface and it never modifies built-in system skills.",
			promptSnippet:
				"Save a personal custom skill from the current conversation when the user asks to preserve a workflow or handoff. Do not use this for built-in system skill maintenance.",
			promptGuidelines: PERSONAL_SKILL_GUIDELINES,
			parameters: Type.Object({
				id: Type.Optional(Type.String({ description: "Optional stable id. Omit to derive one from title." })),
				title: Type.String({ description: "Human-readable personal skill title." }),
				description: Type.String({ description: "Short description used for search and discovery." }),
				tags: Type.Optional(Type.Array(Type.String())),
				content: Type.String({ description: "Markdown body of the personal skill. Do not include frontmatter." }),
				overwrite: Type.Optional(
					Type.Boolean({ description: "Must be true to replace an existing personal skill." }),
				),
			}),
			execute: async (_toolCallId, params) => {
				const request: PersonalSkillSaveRequest = {
					id: params.id,
					title: params.title,
					description: params.description,
					tags: params.tags,
					content: params.content,
					overwrite: params.overwrite,
					sourceSessionId: options.getSourceSessionId(),
				};
				return personalSkillResult("Save personal skill", "personal_skill_save", params.title, () =>
					options.repository.save(request),
				);
			},
		}),
		defineTool({
			name: "personal_skill_archive",
			label: "Archive personal skill",
			description:
				"Archive one personal custom skill by moving it under data/personal-skills/.archive. It cannot delete or alter built-in system skills.",
			promptSnippet:
				"Archive obsolete personal skills only when the user asks. This is not a system skill delete tool.",
			promptGuidelines: PERSONAL_SKILL_GUIDELINES,
			parameters: Type.Object({
				id: Type.String({ description: "Personal skill id to archive." }),
			}),
			execute: async (_toolCallId, params) =>
				personalSkillResult("Archive personal skill", "personal_skill_archive", params.id, () =>
					options.repository.archive(params.id),
				),
		}),
		defineTool({
			name: "personal_skill_refresh",
			label: "Refresh personal skills",
			description:
				"Refresh the project-local personal skill repository listing. It does not reload or mutate built-in system skills.",
			promptSnippet: "Refresh personal skill repository metadata after manual file edits.",
			promptGuidelines: PERSONAL_SKILL_GUIDELINES,
			parameters: Type.Object({}),
			execute: async () =>
				personalSkillResult("Refresh personal skills", "personal_skill_refresh", "data/personal-skills", () =>
					options.repository.refresh(),
				),
		}),
	];
}

const PERSONAL_SKILL_GUIDELINES = [
	"Personal skills are user-customized workflow notes stored under data/personal-skills. They are not built-in system skills.",
	"Only use personal_skill_* tools when the user explicitly asks to save, search, read, learn, use, refresh, or archive a personal/custom skill.",
	"Never use these tools to maintain built-in system skills, Desktop Assistant capability skills, or files under packages/desktop-assistant/skills.",
	"When saving, write concise reusable Markdown with scope, prerequisites, workflow steps, verification, and known pitfalls.",
];

function personalSkillResult(
	intent: string,
	action: string,
	target: string,
	run: () => unknown,
): { content: [{ type: "text"; text: string }]; details: DesktopToolResult } {
	try {
		const payload = run();
		const details = buildDetails(intent, action, target, "succeeded", JSON.stringify(payload, null, 2));
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	} catch (error) {
		const details = buildDetails(
			intent,
			action,
			target,
			"failed",
			undefined,
			error instanceof Error ? error.message : String(error),
		);
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	}
}

function buildDetails(
	intent: string,
	action: string,
	target: string,
	status: DesktopToolResult["status"],
	stdout?: string,
	stderr?: string,
): DesktopToolResult {
	return {
		stepId: randomUUID(),
		intent,
		action,
		target,
		status,
		stdout,
		stderr,
		riskLevel: "low",
		requiresConfirmation: false,
	};
}
