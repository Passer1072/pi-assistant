import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type {
	PersonalSkillEntry,
	PersonalSkillFileView,
	PersonalSkillListResponse,
	PersonalSkillSaveRequest,
} from "../shared/types.ts";

const PERSONAL_SKILL_ROOT = join("data", "personal-skills");
const SKILL_FILENAME = "SKILL.md";
const ARCHIVE_DIRNAME = ".archive";
const MAX_SKILL_BYTES = 512 * 1024;
const MAX_SEARCH_RESULTS = 20;

interface PersonalSkillFrontmatter {
	name?: string;
	description?: string;
	scope?: string;
	tags?: string[];
	createdAt?: string;
	updatedAt?: string;
	sourceSessionId?: string;
}

export class PersonalSkillRepositoryService {
	private readonly rootDir: string;
	private readonly archiveDir: string;

	constructor(cwd: string) {
		this.rootDir = resolve(cwd, PERSONAL_SKILL_ROOT);
		this.archiveDir = join(this.rootDir, ARCHIVE_DIRNAME);
	}

	getRootDir(): string {
		return this.rootDir;
	}

	list(): PersonalSkillListResponse {
		this.ensureRoot();
		return {
			rootDir: this.rootDir,
			skills: this.readEntries(false),
		};
	}

	refresh(): PersonalSkillListResponse {
		return this.list();
	}

	search(query: string, limit = MAX_SEARCH_RESULTS): PersonalSkillListResponse {
		const normalizedQuery = query.trim().toLowerCase();
		const max = clampLimit(limit);
		const entries = this.readEntries(false);
		if (!normalizedQuery) {
			return { rootDir: this.rootDir, skills: entries.slice(0, max) };
		}
		const terms = normalizedQuery.split(/\s+/g).filter(Boolean);
		const scored = entries
			.map((entry) => ({
				entry,
				score: scoreEntry(entry, terms),
			}))
			.filter((item) => item.score > 0)
			.sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt))
			.map((item) => item.entry)
			.slice(0, max);
		return { rootDir: this.rootDir, skills: scored };
	}

	read(id: string): PersonalSkillFileView {
		const skillDir = this.resolveSkillDir(id);
		const filePath = join(skillDir, SKILL_FILENAME);
		const raw = readFileUtf8(filePath);
		const parsed = parsePersonalSkill(raw);
		return this.buildFileView(normalizeSkillId(id), filePath, raw, parsed, false);
	}

	save(request: PersonalSkillSaveRequest): PersonalSkillFileView {
		const id = request.id ? normalizeSkillId(request.id) : createSkillId(request.title);
		const skillDir = this.resolveSkillDir(id);
		const filePath = join(skillDir, SKILL_FILENAME);
		if (existsSync(filePath) && request.overwrite !== true) {
			throw new Error(`Personal skill already exists: ${id}`);
		}
		const now = new Date().toISOString();
		const existing = existsSync(filePath) ? parsePersonalSkill(readFileUtf8(filePath)).frontmatter : undefined;
		const frontmatter: PersonalSkillFrontmatter = {
			name: id,
			description: cleanRequired(request.description, "description"),
			scope: "personal",
			tags: normalizeTags(request.tags),
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			sourceSessionId: cleanOptional(request.sourceSessionId),
		};
		const content = normalizeSkillContent(request.content);
		const fileContent = [formatFrontmatter(frontmatter), content].join("\n\n");
		assertContentSize(fileContent);
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(filePath, fileContent, "utf-8");
		return this.read(id);
	}

	archive(id: string): PersonalSkillListResponse {
		const normalizedId = normalizeSkillId(id);
		const skillDir = this.resolveSkillDir(normalizedId);
		if (!existsSync(skillDir)) {
			throw new Error(`Personal skill not found: ${normalizedId}`);
		}
		mkdirSync(this.archiveDir, { recursive: true });
		const archivedName = `${normalizedId}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
		const archiveTarget = this.resolveArchiveDir(archivedName);
		renameSync(skillDir, archiveTarget);
		return this.list();
	}

	private readEntries(includeArchived: boolean): PersonalSkillEntry[] {
		this.ensureRoot();
		const entries: PersonalSkillEntry[] = [];
		for (const dirent of readdirSync(this.rootDir, { withFileTypes: true })) {
			if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
			const filePath = join(this.rootDir, dirent.name, SKILL_FILENAME);
			if (!existsSync(filePath)) continue;
			try {
				const raw = readFileUtf8(filePath);
				const parsed = parsePersonalSkill(raw);
				entries.push(this.buildEntry(dirent.name, filePath, raw, parsed, false));
			} catch {}
		}
		if (includeArchived && existsSync(this.archiveDir)) {
			for (const dirent of readdirSync(this.archiveDir, { withFileTypes: true })) {
				if (!dirent.isDirectory()) continue;
				const filePath = join(this.archiveDir, dirent.name, SKILL_FILENAME);
				if (!existsSync(filePath)) continue;
				try {
					const raw = readFileUtf8(filePath);
					const parsed = parsePersonalSkill(raw);
					entries.push(this.buildEntry(dirent.name, filePath, raw, parsed, true));
				} catch {}
			}
		}
		return entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}

	private buildFileView(
		id: string,
		filePath: string,
		raw: string,
		parsed: { frontmatter: PersonalSkillFrontmatter; body: string },
		archived: boolean,
	): PersonalSkillFileView {
		return {
			...this.buildEntry(id, filePath, raw, parsed, archived),
			content: raw,
		};
	}

	private buildEntry(
		id: string,
		filePath: string,
		raw: string,
		parsed: { frontmatter: PersonalSkillFrontmatter; body: string },
		archived: boolean,
	): PersonalSkillEntry {
		const stats = statSync(filePath);
		const title = parsed.frontmatter.name?.trim() || id;
		const description = parsed.frontmatter.description?.trim() || "(no description)";
		const updatedAt = parsed.frontmatter.updatedAt ?? stats.mtime.toISOString();
		return {
			id,
			title,
			description,
			tags: normalizeTags(parsed.frontmatter.tags),
			path: filePath,
			createdAt: parsed.frontmatter.createdAt ?? stats.birthtime.toISOString(),
			updatedAt,
			sourceSessionId: parsed.frontmatter.sourceSessionId,
			archived,
			preview: previewText(parsed.body || raw),
		};
	}

	private ensureRoot(): void {
		mkdirSync(this.rootDir, { recursive: true });
	}

	private resolveSkillDir(id: string): string {
		const normalizedId = normalizeSkillId(id);
		const target = resolve(this.rootDir, normalizedId);
		assertInside(target, this.rootDir);
		if (basename(target) === ARCHIVE_DIRNAME) {
			throw new Error("Reserved personal skill id.");
		}
		return target;
	}

	private resolveArchiveDir(id: string): string {
		const target = resolve(this.archiveDir, id);
		assertInside(target, this.archiveDir);
		return target;
	}
}

export function normalizeSkillId(value: string): string {
	const raw = value.trim();
	if (raw.startsWith(".")) throw new Error("Reserved personal skill id.");
	const id = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-");
	if (!id) throw new Error("Personal skill id is required.");
	if (id.length > 64) throw new Error("Personal skill id must be 64 characters or fewer.");
	return id;
}

function createSkillId(title: string): string {
	const id = title
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-")
		.slice(0, 48);
	return id || `personal-skill-${randomUUID().slice(0, 8)}`;
}

export function buildPersonalSkillRoutedPrompt(message: string, skill: PersonalSkillFileView | undefined): string {
	if (!skill) return message;
	return [
		`<selected_personal_skill id="${escapeXml(skill.id)}" title="${escapeXml(skill.title)}" location="${escapeXml(skill.path)}">`,
		skill.content,
		"</selected_personal_skill>",
		"<personal_skill_instruction>",
		"This is a personal, user-customized workflow note. It is not a built-in system skill. Apply it only to the current user request, and do not generalize it into system behavior.",
		"AI may maintain personal skills only through personal_skill_* tools under data/personal-skills. Do not create, edit, archive, or delete built-in Desktop Assistant system skills.",
		"</personal_skill_instruction>",
		"",
		message,
	].join("\n");
}

export function selectExplicitPersonalSkillId(message: string): string | undefined {
	const normalized = message.trim();
	if (
		!/(personal\s+skill|个人\s*skill|定制\s*skill|私人\s*skill|学习.+skill|读取.+skill|使用.+skill|用.+skill)/i.test(
			normalized,
		)
	) {
		return undefined;
	}
	const patterns = [
		/(?:personal\s+skill|个人\s*skill|定制\s*skill|私人\s*skill)[:：\s]+([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/i,
		/(?:读取|学习|使用|用)\s*([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\s*(?:这个)?\s*skill/i,
		/skill\s+([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/i,
	];
	for (const pattern of patterns) {
		const match = normalized.match(pattern);
		if (match?.[1]) return normalizeSkillId(match[1]);
	}
	return undefined;
}

function parsePersonalSkill(content: string): { frontmatter: PersonalSkillFrontmatter; body: string } {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return { frontmatter: {}, body: normalized };
	}
	const endIndex = normalized.indexOf("\n---", 4);
	if (endIndex < 0) {
		return { frontmatter: {}, body: normalized };
	}
	const frontmatterText = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();
	return { frontmatter: parseSimpleFrontmatter(frontmatterText), body };
}

function parseSimpleFrontmatter(text: string): PersonalSkillFrontmatter {
	const frontmatter: PersonalSkillFrontmatter = {};
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const keyValue = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!keyValue) continue;
		const key = keyValue[1];
		const value = unquoteYamlValue(keyValue[2] ?? "");
		if (key === "tags" && value === "") {
			const tags: string[] = [];
			for (let nested = index + 1; nested < lines.length; nested += 1) {
				const tagMatch = lines[nested]?.match(/^\s*-\s*(.*)$/);
				if (!tagMatch) break;
				tags.push(unquoteYamlValue(tagMatch[1] ?? ""));
				index = nested;
			}
			frontmatter.tags = normalizeTags(tags);
			continue;
		}
		if (key === "name") frontmatter.name = value;
		if (key === "description") frontmatter.description = value;
		if (key === "scope") frontmatter.scope = value;
		if (key === "createdAt") frontmatter.createdAt = value;
		if (key === "updatedAt") frontmatter.updatedAt = value;
		if (key === "sourceSessionId") frontmatter.sourceSessionId = value;
	}
	return frontmatter;
}

function formatFrontmatter(frontmatter: PersonalSkillFrontmatter): string {
	const lines = [
		"---",
		`name: ${formatYamlString(frontmatter.name ?? "")}`,
		`description: ${formatYamlString(frontmatter.description ?? "")}`,
		"scope: personal",
		"tags:",
		...normalizeTags(frontmatter.tags).map((tag) => `  - ${formatYamlString(tag)}`),
		`createdAt: ${formatYamlString(frontmatter.createdAt ?? "")}`,
		`updatedAt: ${formatYamlString(frontmatter.updatedAt ?? "")}`,
	];
	if (frontmatter.sourceSessionId) {
		lines.push(`sourceSessionId: ${formatYamlString(frontmatter.sourceSessionId)}`);
	}
	lines.push("---");
	return lines.join("\n");
}

function formatYamlString(value: string): string {
	return JSON.stringify(value);
}

function unquoteYamlValue(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

function normalizeTags(value: string[] | undefined): string[] {
	if (!value) return [];
	return [...new Set(value.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
}

function normalizeSkillContent(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
	if (!normalized) throw new Error("Personal skill content is required.");
	if (normalized.startsWith("---\n")) {
		const parsed = parsePersonalSkill(normalized);
		return parsed.body || normalized;
	}
	return normalized;
}

function cleanRequired(value: string, field: string): string {
	const cleaned = value.trim();
	if (!cleaned) throw new Error(`Personal skill ${field} is required.`);
	return cleaned;
}

function cleanOptional(value: string | undefined): string | undefined {
	const cleaned = value?.trim();
	return cleaned ? cleaned : undefined;
}

function assertContentSize(content: string): void {
	if (Buffer.byteLength(content, "utf-8") > MAX_SKILL_BYTES) {
		throw new Error(`Personal skill content exceeds ${MAX_SKILL_BYTES} bytes.`);
	}
}

function readFileUtf8(filePath: string): string {
	if (!existsSync(filePath)) throw new Error(`Personal skill not found: ${filePath}`);
	const content = readFileSync(filePath, "utf-8");
	assertContentSize(content);
	return content;
}

function previewText(content: string): string {
	return content
		.replace(/^---[\s\S]*?\n---/, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 220);
}

function scoreEntry(entry: PersonalSkillEntry, terms: string[]): number {
	const haystack = [entry.id, entry.title, entry.description, entry.tags.join(" "), entry.preview]
		.join(" ")
		.toLowerCase();
	return terms.reduce((score, term) => {
		if (entry.id.toLowerCase() === term) return score + 100;
		if (entry.title.toLowerCase().includes(term)) return score + 30;
		if (entry.tags.some((tag) => tag.toLowerCase().includes(term))) return score + 20;
		return haystack.includes(term) ? score + 5 : score;
	}, 0);
}

function clampLimit(value: number): number {
	if (!Number.isFinite(value)) return MAX_SEARCH_RESULTS;
	return Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.floor(value)));
}

function assertInside(target: string, root: string): void {
	const normalizedRoot = resolve(root);
	const normalizedTarget = resolve(target);
	if (normalizedTarget === normalizedRoot) return;
	const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
	if (!normalizedTarget.startsWith(prefix)) {
		throw new Error("Personal skill path must stay inside data/personal-skills.");
	}
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
