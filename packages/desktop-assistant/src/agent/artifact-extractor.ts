import * as fs from "node:fs";
import * as path from "node:path";
import { expandEnv } from "../desktop/sandbox/sandbox-workspace.ts";
import type { FileArtifact } from "../shared/types.ts";

/**
 * Resolve a candidate path to a native absolute path for disk checks. Unlike the sandbox's
 * canonicalize (which is Windows-semantic and forces backslashes for containment matching), this
 * uses the platform's own path module, so it works on the Linux CI as well as on Windows.
 */
function resolveCandidatePath(input: string, baseDir: string): string {
	const expanded = expandEnv(input.trim());
	if (!expanded) return "";
	const abs = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
	return path.normalize(abs);
}

/**
 * Output-file detection for the conversation timeline.
 *
 * The assistant "produces a file" through a tool step (ppt_create, excel_write,
 * doc_create_from_html, office_*_run, sandbox_export, shell commands, Office MCP
 * tools, …). We surface those files as interactive shortcut cards. Rather than
 * storing a parallel artifact list, cards are *derived* from tool results with
 * the pure helpers here, applied both live (on tool_execution_end) and on history
 * reload (over the archived tool records). Every candidate is validated against
 * disk before it becomes a card.
 *
 * Two signals are combined:
 *  - producer tools (those that write files) → any path they name in args/result
 *    is a candidate, kept whenever it exists on disk;
 *  - non-producer tools → a path is only a candidate when it was freshly written
 *    during this turn (mtime ≥ turn start). This keeps files a tool merely *read*
 *    (e.g. excel_read's input) from showing up, while still catching files a
 *    shell command created. Freshness is unavailable on history reload, so only
 *    producer-tool outputs are reconstructed there.
 */

/** A path mentioned by a tool, tagged with whether the tool is a file producer. */
export interface ArtifactCandidate {
	path: string;
	producer: boolean;
}

export interface ResolveArtifactsOptions {
	/** Base dir for resolving relative paths (sandbox root, else cwd). */
	baseDir?: string;
	/**
	 * Epoch-ms turn start. When set, non-producer candidates must have been
	 * modified at/after this time; producer candidates likewise must be fresh
	 * (so a producer tool that merely *opened* an old file doesn't surface it).
	 * Omit on history reload, where freshness can't be trusted — producer
	 * candidates are then kept on existence alone.
	 */
	since?: number;
	/** Clock skew tolerance for the freshness check (default 5 min). */
	skewMs?: number;
	/** Max cards per tool step (default 8). */
	limit?: number;
}

/** Tools that write files but don't expose a clean output path arg (path is in the script/result). */
const EXPLICIT_PRODUCER_TOOLS = new Set(["office_word_run", "office_excel_run", "office_ppt_run", "sandbox_export"]);

/** Tool names that never produce a deliverable, even if their name hits a producer keyword. */
const NON_PRODUCER_RE = /(read|inspect|verify|list|status|observe|query|search|plan|get_|_get|snapshot|preview)/i;

/** Verb fragments that mark a tool as a file producer. */
const PRODUCER_KEYWORD_RE = /(create|write|export|save|convert|generate|render|build)/i;

/** Object keys whose string value is treated as a (clean, possibly spaced) path. */
const PATH_KEY_RE =
	/^(?:.*[_-])?(?:paths?|outputs?|output_?path|out_?file|dest|destination|file|file_?path|file_?name|save_?path|saved_?path|output_?file|target)$/i;

/** Absolute Windows path (drive or UNC) ending in an extension; whitespace-delimited. */
const WIN_PATH_RE =
	/(?:[A-Za-z]:[\\/]|\\\\[^\\/\r\n]+[\\/])[^\r\n"'<>|?*\t]*?\.[A-Za-z0-9]{1,12}(?=$|[\s"'<>|)\]}，。、）]|\\)/g;

/** File extensions that are never user-facing deliverables. */
const IGNORED_EXTS = new Set(["lnk", "tmp", "crdownload", "part"]);

/** Path fragments that are internal plumbing, not deliverables. */
const IGNORED_PATH_RE = /[\\/](?:node_modules|\.git|\.tmp)[\\/]/i;

/** Whether a tool is expected to produce files (see module docs). */
export function isProducerTool(toolName: string): boolean {
	if (EXPLICIT_PRODUCER_TOOLS.has(toolName)) return true;
	if (NON_PRODUCER_RE.test(toolName)) return false;
	return PRODUCER_KEYWORD_RE.test(toolName);
}

/** Trim trailing sentence punctuation a regex match may have swallowed. */
function trimTrailingPunctuation(value: string): string {
	return value.replace(/[\s)\].,;:，。、）】]+$/u, "");
}

/** Depth-first collect of (key, string-value) pairs from an args/result object. */
function collectKeyedStrings(value: unknown, key: string, out: Array<{ key: string; value: string }>, depth = 0): void {
	if (depth > 6 || value == null) return;
	if (typeof value === "string") {
		out.push({ key, value });
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) collectKeyedStrings(entry, key, out, depth + 1);
		return;
	}
	if (typeof value === "object") {
		for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
			collectKeyedStrings(childValue, childKey, out, depth + 1);
		}
	}
}

/**
 * Pull candidate paths from one tool call's args and result. Pure — no disk access.
 * Combines clean path-keyed values with a whitespace-delimited regex sweep of the
 * full payload (catches paths echoed in stdout).
 */
export function extractArtifactCandidates(toolName: string, args: unknown, result: unknown): ArtifactCandidate[] {
	const producer = isProducerTool(toolName);
	const seen = new Set<string>();
	const candidates: ArtifactCandidate[] = [];
	const add = (raw: string): void => {
		const value = trimTrailingPunctuation(raw.trim());
		if (!value || seen.has(value)) return;
		seen.add(value);
		candidates.push({ path: value, producer });
	};

	const keyed: Array<{ key: string; value: string }> = [];
	collectKeyedStrings(args, "", keyed);
	collectKeyedStrings(result, "", keyed);
	for (const { key, value } of keyed) {
		if (PATH_KEY_RE.test(key)) add(value);
	}

	// Supplementary: absolute paths embedded in free text (no spaces).
	const haystack = `${safeStringify(args)}\n${safeStringify(result)}`;
	for (const match of haystack.matchAll(WIN_PATH_RE)) add(match[0]);

	return candidates;
}

function safeStringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

/** Validate candidate paths against disk and turn freshness; returns ready-to-render artifacts. */
export function resolveArtifacts(
	candidates: ArtifactCandidate[],
	options: ResolveArtifactsOptions = {},
): FileArtifact[] {
	const baseDir = options.baseDir || process.cwd();
	const skewMs = options.skewMs ?? 5 * 60 * 1000;
	const limit = options.limit ?? 8;
	const out: FileArtifact[] = [];
	const seen = new Set<string>();

	for (const candidate of candidates) {
		if (out.length >= limit) break;
		let abs: string;
		try {
			abs = resolveCandidatePath(candidate.path, baseDir);
		} catch {
			continue;
		}
		if (!abs || IGNORED_PATH_RE.test(abs)) continue;
		const dedupeKey = abs.toLowerCase();
		if (seen.has(dedupeKey)) continue;

		let stat: fs.Stats;
		try {
			stat = fs.statSync(abs);
		} catch {
			continue; // must exist on disk
		}
		const isDirectory = stat.isDirectory();
		const ext = isDirectory ? "" : path.extname(abs).replace(/^\./, "").toLowerCase();
		if (!isDirectory && IGNORED_EXTS.has(ext)) continue;

		const modifiedAt = stat.mtimeMs;
		if (options.since !== undefined) {
			// Live: require the file to have been (re)written during this turn.
			if (modifiedAt < options.since - skewMs) continue;
		} else if (!candidate.producer) {
			// History reload: can't trust freshness, so only keep producer outputs.
			continue;
		}

		seen.add(dedupeKey);
		out.push({
			path: abs,
			name: path.basename(abs),
			ext,
			sizeBytes: isDirectory ? 0 : stat.size,
			modifiedAt,
			isDirectory,
		});
	}

	return out;
}

/** Convenience: extract + resolve in one call. */
export function collectArtifacts(
	toolName: string,
	args: unknown,
	result: unknown,
	options: ResolveArtifactsOptions = {},
): FileArtifact[] {
	return resolveArtifacts(extractArtifactCandidates(toolName, args, result), options);
}
