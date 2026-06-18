import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GlobalMemoryEntry, GlobalMemoryKind } from "../shared/types.ts";
import { getConversationArchivePaths } from "./conversation-archive.ts";

export interface MemoryStorePaths {
	memoryDir: string;
	memoriesFile: string;
	indexFile: string;
	readmeFile: string;
}

export interface MemorySearchResult {
	memory: GlobalMemoryEntry;
	score: number;
}

export interface MemoryCandidate {
	kind: GlobalMemoryKind;
	text: string;
	confidence: number;
	tags: string[];
	archiveSimilarKinds?: GlobalMemoryKind[];
}

export interface MemoryExtractionInput {
	userMessage: string;
	assistantMessage?: string;
	sourceSessionId?: string;
}

export interface MemoryUpsertInput {
	kind: GlobalMemoryKind;
	text: string;
	confidence: number;
	sourceSessionId?: string;
	tags?: string[];
	archived?: boolean;
	archiveSimilarKinds?: GlobalMemoryKind[];
}

export function getMemoryStorePaths(cwd: string, saveDir?: string): MemoryStorePaths {
	const archivePaths = getConversationArchivePaths(cwd, saveDir);
	const memoryDir = join(archivePaths.saveDir, "memory");
	return {
		memoryDir,
		memoriesFile: join(memoryDir, "memories.jsonl"),
		indexFile: join(memoryDir, "index.json"),
		readmeFile: join(memoryDir, "README.md"),
	};
}

export class MemoryStore {
	private readonly paths: MemoryStorePaths;

	constructor(cwd: string, saveDir?: string) {
		this.paths = getMemoryStorePaths(cwd, saveDir);
		this.ensureFiles();
	}

	list(options?: { includeArchived?: boolean }): GlobalMemoryEntry[] {
		const includeArchived = options?.includeArchived ?? false;
		return this.readAll()
			.filter((memory) => includeArchived || !memory.archived)
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}

	search(query: string, limit: number): MemorySearchResult[] {
		const normalizedLimit = Math.max(0, Math.floor(limit));
		if (normalizedLimit === 0) return [];
		const queryTokens = tokenize(query);
		if (queryTokens.length === 0) return [];
		const memories = this.list();
		const documentFrequency = new Map<string, number>();
		for (const memory of memories) {
			for (const token of new Set(tokenize(memory.text))) {
				documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
			}
		}
		return memories
			.map((memory) => ({
				memory,
				score: scoreMemory(queryTokens, memory, documentFrequency, memories.length),
			}))
			.filter((result) => result.score > 0)
			.sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt))
			.slice(0, normalizedLimit);
	}

	markUsed(ids: string[]): void {
		const uniqueIds = new Set(ids);
		if (uniqueIds.size === 0) return;
		const now = new Date().toISOString();
		const memories = this.readAll();
		let changed = false;
		const updated = memories.map((memory) => {
			if (!uniqueIds.has(memory.id) || memory.archived) return memory;
			changed = true;
			return {
				...memory,
				lastUsedAt: now,
				useCount: memory.useCount + 1,
				updatedAt: now,
			};
		});
		if (changed) {
			this.writeAll(updated);
		}
	}

	upsert(input: MemoryUpsertInput): GlobalMemoryEntry | undefined {
		const sanitizedText = sanitizeMemoryText(input.text);
		if (!isValidMemoryText(sanitizedText)) return undefined;
		const now = new Date().toISOString();
		const memories = this.readAll();
		const archiveKinds = input.archiveSimilarKinds ?? [];
		let archivedForCorrection = false;
		const normalizedTags = normalizeTags(input.tags ?? []);
		const similarIndex = memories.findIndex(
			(memory) =>
				!memory.archived &&
				memory.kind === input.kind &&
				(memory.text === sanitizedText ||
					hasSharedTag(memory.tags, normalizedTags) ||
					areTextsSimilar(memory.text, sanitizedText)),
		);
		const archivedMemories = memories.map((memory) => {
			if (
				!archiveKinds.includes(memory.kind) ||
				memory.archived ||
				(!areTextsSimilar(memory.text, sanitizedText) && !isPotentialPreferenceConflict(memory.text, sanitizedText))
			) {
				return memory;
			}
			archivedForCorrection = true;
			return {
				...memory,
				archived: true,
				updatedAt: now,
			};
		});
		if (similarIndex >= 0 && !archivedMemories[similarIndex]?.archived) {
			const current = archivedMemories[similarIndex];
			if (!current) return undefined;
			const updated: GlobalMemoryEntry = {
				...current,
				text: sanitizedText,
				confidence: clampConfidence(Math.max(current.confidence, input.confidence)),
				sourceSessionId: input.sourceSessionId ?? current.sourceSessionId,
				tags: mergeTags(current.tags, normalizedTags),
				updatedAt: now,
				archived: input.archived ?? false,
			};
			archivedMemories[similarIndex] = updated;
			this.writeAll(archivedMemories);
			return updated;
		}
		const memory: GlobalMemoryEntry = {
			schemaVersion: 1,
			id: randomUUID(),
			kind: archivedForCorrection && input.kind !== "correction" ? "correction" : input.kind,
			text: sanitizedText,
			confidence: clampConfidence(input.confidence),
			sourceSessionId: input.sourceSessionId,
			createdAt: now,
			updatedAt: now,
			useCount: 0,
			tags: normalizedTags,
			archived: input.archived ?? false,
		};
		this.writeAll([...archivedMemories, memory]);
		return memory;
	}

	update(
		id: string,
		update: Partial<Pick<GlobalMemoryEntry, "kind" | "text" | "confidence" | "tags" | "archived">>,
	): GlobalMemoryEntry | undefined {
		const memories = this.readAll();
		const index = memories.findIndex((memory) => memory.id === id);
		if (index < 0) return undefined;
		const current = memories[index];
		if (!current) return undefined;
		const nextText = update.text !== undefined ? sanitizeMemoryText(update.text) : current.text;
		if (!isValidMemoryText(nextText)) return undefined;
		const updated: GlobalMemoryEntry = {
			...current,
			kind: update.kind ?? current.kind,
			text: nextText,
			confidence:
				update.confidence !== undefined ? clampConfidence(update.confidence) : clampConfidence(current.confidence),
			tags: update.tags !== undefined ? normalizeTags(update.tags) : current.tags,
			archived: update.archived ?? current.archived,
			updatedAt: new Date().toISOString(),
		};
		memories[index] = updated;
		this.writeAll(memories);
		return updated;
	}

	delete(id: string): boolean {
		const memories = this.readAll();
		const next = memories.filter((memory) => memory.id !== id);
		if (next.length === memories.length) return false;
		this.writeAll(next);
		return true;
	}

	clear(): number {
		const deletedCount = this.readAll().length;
		if (existsSync(this.paths.memoryDir)) {
			rmSync(this.paths.memoryDir, { recursive: true, force: true });
		}
		this.ensureFiles();
		return deletedCount;
	}

	extractFromTurn(input: MemoryExtractionInput): MemoryCandidate[] {
		const userMessage = sanitizeMemoryText(input.userMessage);
		const assistantMessage = input.assistantMessage ? sanitizeMemoryText(input.assistantMessage) : "";
		const candidates: MemoryCandidate[] = [];
		candidates.push(...extractExplicitPreferences(userMessage));
		candidates.push(...extractProfileFacts(userMessage));
		candidates.push(...extractProjectFacts(userMessage));
		candidates.push(...extractTaskMemories(userMessage));
		candidates.push(...extractCorrections(userMessage));
		candidates.push(...extractAssistantFacts(assistantMessage));
		return dedupeCandidates(candidates).filter((candidate) => isValidMemoryText(candidate.text));
	}

	private readAll(): GlobalMemoryEntry[] {
		this.ensureFiles();
		if (!existsSync(this.paths.memoriesFile)) return [];
		try {
			return readFileSync(this.paths.memoriesFile, "utf-8")
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean)
				.map((line) => normalizeMemoryEntry(JSON.parse(line) as Partial<GlobalMemoryEntry>))
				.filter((memory): memory is GlobalMemoryEntry => memory !== undefined);
		} catch {
			return [];
		}
	}

	private writeAll(memories: GlobalMemoryEntry[]): void {
		this.ensureFiles();
		const lines = memories.map((memory) => JSON.stringify(memory)).join("\n");
		writeFileSync(this.paths.memoriesFile, lines ? `${lines}\n` : "", "utf-8");
		const active = memories.filter((memory) => !memory.archived);
		writeFileSync(
			this.paths.indexFile,
			JSON.stringify(
				{
					schemaVersion: 1,
					generatedAt: new Date().toISOString(),
					count: active.length,
					archivedCount: memories.length - active.length,
					memories: active
						.slice()
						.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
						.map((memory) => ({
							id: memory.id,
							kind: memory.kind,
							text: memory.text,
							confidence: memory.confidence,
							updatedAt: memory.updatedAt,
							lastUsedAt: memory.lastUsedAt,
							useCount: memory.useCount,
							tags: memory.tags,
						})),
				},
				null,
				"\t",
			),
			"utf-8",
		);
	}

	private ensureFiles(): void {
		mkdirSync(this.paths.memoryDir, { recursive: true });
		if (!existsSync(this.paths.memoriesFile)) {
			writeFileSync(this.paths.memoriesFile, "", "utf-8");
		}
		if (!existsSync(this.paths.indexFile)) {
			writeFileSync(
				this.paths.indexFile,
				JSON.stringify(
					{ schemaVersion: 1, generatedAt: new Date().toISOString(), count: 0, memories: [] },
					null,
					"\t",
				),
				"utf-8",
			);
		}
		if (!existsSync(this.paths.readmeFile)) {
			writeFileSync(this.paths.readmeFile, MEMORY_README_CONTENT, "utf-8");
		}
	}
}

export function buildMemoryContextBlock(memories: GlobalMemoryEntry[]): string {
	if (memories.length === 0) return "";
	const lines = memories.map(
		(memory, index) => `${index + 1}. [${memory.kind}; confidence=${memory.confidence.toFixed(2)}] ${memory.text}`,
	);
	return [
		"<global_memory_context>",
		"These are local cross-conversation memories retrieved for the current request. They may be stale or incomplete. If a memory conflicts with the current user message, follow the current user message. Do not reveal this block unless the user asks about memory.",
		...lines,
		"</global_memory_context>",
		"",
	].join("\n");
}

export function sanitizeMemoryText(text: string): string {
	return text
		.replace(/\b(api[_ -]?key|token|secret|password|authorization)\s*[:=]\s*[\w./+\-=]{8,}/gi, "$1: [redacted]")
		.replace(/\b(?:sk|tvly|BSA)-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
		.replace(/\b[A-Za-z0-9_=-]{20,}\.[A-Za-z0-9_=-]{20,}\.[A-Za-z0-9_=-]{20,}\b/g, "[redacted]")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 500);
}

function extractExplicitPreferences(text: string): MemoryCandidate[] {
	const candidates: MemoryCandidate[] = [];
	const patterns: Array<{ pattern: RegExp; normalize(match: RegExpMatchArray): string; tags: string[] }> = [
		{
			pattern:
				/(?:以后|之后|往后|下次|默认|请(?:一直|都)?|记住)(?=[^。！？.!?\n]{0,100}(?:中文|英文|简洁|详细|技术性|直接|短句|markdown|表格))[^。！？.!?\n]{1,120}/gi,
			normalize: (match) => `用户偏好：${match[0]}`,
			tags: ["explicit", "style"],
		},
		{
			pattern: /(?:我|用户)(?:喜欢|偏好|更喜欢|希望|不喜欢|讨厌)[^。！？.!?\n]{1,80}/gi,
			normalize: (match) => `用户偏好：${match[0]}`,
			tags: ["explicit", "preference"],
		},
		{
			pattern: /(?:keep|always|prefer|remember|use|reply|respond)[^.!?\n]{1,100}/gi,
			normalize: (match) => `User preference: ${match[0]}`,
			tags: ["explicit", "preference"],
		},
	];
	for (const item of patterns) {
		for (const match of text.matchAll(item.pattern)) {
			candidates.push({
				kind: "preference",
				text: item.normalize(match),
				confidence: 0.9,
				tags: item.tags,
			});
		}
	}
	return candidates;
}

function extractProfileFacts(text: string): MemoryCandidate[] {
	const candidates: MemoryCandidate[] = [];
	const patterns: RegExp[] = [
		/(?:我叫|我的名字是|我是)[^。！？.!?\n]{1,60}/gi,
		/(?:my name is|i am|i'm)\s+[^.!?\n]{1,60}/gi,
	];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			candidates.push({
				kind: "profile",
				text: `用户资料：${match[0]}`,
				confidence: 0.85,
				tags: ["profile"],
			});
		}
	}
	return candidates;
}

function extractProjectFacts(text: string): MemoryCandidate[] {
	const candidates: MemoryCandidate[] = [];
	const patterns: RegExp[] = [
		/(?:我的项目|这个项目|当前项目|项目名|workspace|repo|repository)[^。！？.!?\n]{1,120}/gi,
		/(?:we are building|this project is|the project is)[^.!?\n]{1,120}/gi,
	];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			candidates.push({
				kind: "project",
				text: `项目记忆：${match[0]}`,
				confidence: 0.8,
				tags: ["project"],
			});
		}
	}
	return candidates;
}

function extractTaskMemories(text: string): MemoryCandidate[] {
	const candidates: MemoryCandidate[] = [];
	const patterns: RegExp[] = [/(?:待办|以后提醒我|下次继续|后续要|todo|remember to|next time)[^。！？.!?\n]{1,120}/gi];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			candidates.push({
				kind: "task",
				text: `长期任务：${match[0]}`,
				confidence: 0.78,
				tags: ["task"],
			});
		}
	}
	return candidates;
}

function extractCorrections(text: string): MemoryCandidate[] {
	const candidates: MemoryCandidate[] = [];
	const patterns: RegExp[] = [
		/(?:不是|不对|纠正一下|更正|以后不要|别再|不要再)[^。！？.!?\n]{1,120}/gi,
		/(?:correction|actually|do not|don't|stop)[^.!?\n]{1,120}/gi,
	];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			candidates.push({
				kind: "correction",
				text: `用户纠正：${match[0]}`,
				confidence: 0.86,
				tags: ["correction"],
				archiveSimilarKinds: ["preference", "profile", "project", "task", "fact"],
			});
		}
	}
	return candidates;
}

function extractAssistantFacts(text: string): MemoryCandidate[] {
	if (!text) return [];
	const candidates: MemoryCandidate[] = [];
	const patterns: RegExp[] = [
		/(?:已确认|结论是|最终采用|决定使用)[^。！？.!?\n]{1,120}/gi,
		/(?:confirmed|decided|we will use|final decision)[^.!?\n]{1,120}/gi,
	];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			candidates.push({
				kind: "fact",
				text: `对话事实：${match[0]}`,
				confidence: 0.65,
				tags: ["assistant-derived"],
			});
		}
	}
	return candidates;
}

function dedupeCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
	const seen = new Set<string>();
	const deduped: MemoryCandidate[] = [];
	for (const candidate of candidates) {
		const key = `${candidate.kind}\u0000${normalizeComparableText(candidate.text)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(candidate);
	}
	return deduped;
}

function scoreMemory(
	queryTokens: string[],
	memory: GlobalMemoryEntry,
	documentFrequency: Map<string, number>,
	totalDocuments: number,
): number {
	const memoryTokens = tokenize(`${memory.kind} ${memory.tags.join(" ")} ${memory.text}`);
	if (memoryTokens.length === 0) return 0;
	const termFrequency = new Map<string, number>();
	for (const token of memoryTokens) {
		termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
	}
	let score = 0;
	for (const token of queryTokens) {
		const tf = termFrequency.get(token) ?? 0;
		if (tf === 0) continue;
		const df = documentFrequency.get(token) ?? 0;
		const idf = Math.log(1 + (totalDocuments - df + 0.5) / (df + 0.5));
		score += tf * idf;
	}
	if (memory.kind === "preference" || memory.kind === "correction") {
		score *= 1.15;
	}
	score += memory.confidence * 0.05;
	return score;
}

function tokenize(text: string): string[] {
	const normalized = text.toLowerCase();
	const latinTokens = normalized.match(/[a-z0-9_]{2,}/g) ?? [];
	const cjkTokens = normalized.match(/[\u4e00-\u9fff]{1,2}/g) ?? [];
	return [...latinTokens, ...cjkTokens].filter((token) => !STOP_WORDS.has(token));
}

function normalizeMemoryEntry(entry: Partial<GlobalMemoryEntry>): GlobalMemoryEntry | undefined {
	if (!entry.id || !entry.kind || !entry.text || !isMemoryKind(entry.kind)) return undefined;
	const now = new Date().toISOString();
	const sanitizedText = sanitizeMemoryText(entry.text);
	if (!isValidMemoryText(sanitizedText)) return undefined;
	return {
		schemaVersion: 1,
		id: entry.id,
		kind: entry.kind,
		text: sanitizedText,
		confidence: clampConfidence(entry.confidence ?? 0.5),
		sourceSessionId: entry.sourceSessionId,
		createdAt: entry.createdAt ?? now,
		updatedAt: entry.updatedAt ?? entry.createdAt ?? now,
		lastUsedAt: entry.lastUsedAt,
		useCount: Math.max(0, Math.floor(entry.useCount ?? 0)),
		tags: normalizeTags(entry.tags ?? []),
		archived: entry.archived ?? false,
	};
}

function isMemoryKind(kind: string): kind is GlobalMemoryKind {
	return (
		kind === "preference" ||
		kind === "profile" ||
		kind === "project" ||
		kind === "task" ||
		kind === "correction" ||
		kind === "fact"
	);
}

function isValidMemoryText(text: string): boolean {
	if (text.length < 4 || text.length > 500) return false;
	if (text.includes("[redacted]")) return false;
	return !/(?:api[_ -]?key|token|secret|password|authorization)\s*[:=]\s*(?!\[redacted\])/i.test(text);
}

function areTextsSimilar(left: string, right: string): boolean {
	const leftTokens = new Set(tokenize(left));
	const rightTokens = new Set(tokenize(right));
	if (leftTokens.size === 0 || rightTokens.size === 0) return false;
	let shared = 0;
	for (const token of leftTokens) {
		if (rightTokens.has(token)) shared += 1;
	}
	const smaller = Math.min(leftTokens.size, rightTokens.size);
	return shared / smaller >= 0.6 || normalizeComparableText(left) === normalizeComparableText(right);
}

function isPotentialPreferenceConflict(left: string, right: string): boolean {
	const leftLower = left.toLowerCase();
	const rightLower = right.toLowerCase();
	const styleWords = [
		"中文",
		"英文",
		"简洁",
		"详细",
		"直接",
		"markdown",
		"表格",
		"chinese",
		"english",
		"concise",
		"detailed",
	];
	const leftStyle = styleWords.some((word) => leftLower.includes(word));
	const rightStyle = styleWords.some((word) => rightLower.includes(word));
	if (!leftStyle || !rightStyle) return false;
	const languageConflict =
		(leftLower.includes("中文") && (rightLower.includes("英文") || rightLower.includes("english"))) ||
		(rightLower.includes("中文") && (leftLower.includes("英文") || leftLower.includes("english"))) ||
		(leftLower.includes("chinese") && (rightLower.includes("英文") || rightLower.includes("english"))) ||
		(rightLower.includes("chinese") && (leftLower.includes("英文") || leftLower.includes("english")));
	const verbosityConflict =
		(leftLower.includes("简洁") && rightLower.includes("详细")) ||
		(rightLower.includes("简洁") && leftLower.includes("详细")) ||
		(leftLower.includes("concise") && rightLower.includes("detailed")) ||
		(rightLower.includes("concise") && leftLower.includes("detailed"));
	return languageConflict || verbosityConflict;
}

function normalizeComparableText(text: string): string {
	return text
		.toLowerCase()
		.replace(/\s+/g, "")
		.replace(/[^\p{L}\p{N}]/gu, "");
}

function normalizeTags(tags: string[]): string[] {
	return [...new Set(tags.map((tag) => tag.toLowerCase().trim()).filter(Boolean))].slice(0, 12);
}

function mergeTags(left: string[], right: string[]): string[] {
	return normalizeTags([...left, ...right]);
}

function hasSharedTag(left: string[], right: string[]): boolean {
	if (left.length === 0 || right.length === 0) return false;
	const rightSet = new Set(right);
	return left.some((tag) => rightSet.has(tag));
}

function clampConfidence(confidence: number): number {
	if (!Number.isFinite(confidence)) return 0.5;
	return Math.min(1, Math.max(0, confidence));
}

const STOP_WORDS = new Set(["the", "and", "for", "with", "this", "that", "you", "are", "请", "我", "你", "的", "了"]);

const MEMORY_README_CONTENT = `# Global Memory

This folder contains local cross-conversation memories for the desktop assistant.

- \`memories.jsonl\` is the append-rewritten source of truth.
- \`index.json\` is a compact active-memory index for inspection.
- Memories are local-only and are injected as optional context before model calls.
`;
