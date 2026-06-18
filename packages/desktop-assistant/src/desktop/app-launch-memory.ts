import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppLaunchCacheEntry, AppLaunchCacheTargetType, AppLaunchCacheView } from "../shared/types.ts";

export interface FoundAppLaunch {
	name: string;
	launch: string;
	kind: string;
}

const CACHE_VERSION = 1;
const EMPTY_CACHE: Omit<AppLaunchCacheView, "path"> = {
	version: CACHE_VERSION,
	updatedAt: 0,
	aliases: {},
};

export function getAppLaunchCachePath(agentDir: string): string {
	return join(agentDir, "app-launch-cache.json");
}

export function readAppLaunchCache(path: string): AppLaunchCacheView {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AppLaunchCacheView>;
		return normalizeCache(path, parsed);
	} catch {
		return emptyCache(path);
	}
}

export function clearAppLaunchCache(path: string): AppLaunchCacheView {
	if (existsSync(path)) {
		unlinkSync(path);
	}
	return emptyCache(path);
}

export function deleteAppLaunchCacheEntry(path: string, alias: string): AppLaunchCacheView {
	const cache = readAppLaunchCache(path);
	delete cache.aliases[normalizeAppAlias(alias)];
	return writeCache(path, cache);
}

export function parseFindAppResults(stdout: string): FoundAppLaunch[] {
	try {
		const parsed = JSON.parse(stdout.trim() || "{}") as { results?: unknown };
		if (!Array.isArray(parsed.results)) return [];
		return parsed.results.filter(isFoundAppLaunch);
	} catch {
		return [];
	}
}

export function rememberFindAppResults(path: string, query: string, stdout: string): AppLaunchCacheView {
	const first = parseFindAppResults(stdout)[0];
	if (!first) return readAppLaunchCache(path);
	return rememberSuccessfulLaunch(path, {
		query,
		displayName: first.name,
		launch: first.launch,
		kind: first.kind,
	});
}

export function resolveRememberedLaunch(
	path: string,
	app: string,
): { alias: string; entry: AppLaunchCacheEntry } | undefined {
	const cache = readAppLaunchCache(path);
	const alias = normalizeAppAlias(app);
	const entry = cache.aliases[alias];
	if (!entry) return undefined;
	if (!isLaunchStillValid(entry.launch)) {
		rememberLaunchFailure(path, app, entry.launch);
		return undefined;
	}
	return { alias, entry };
}

export function rememberSuccessfulLaunch(
	path: string,
	params: { query: string; displayName: string; launch: string; kind: string; targetType?: AppLaunchCacheTargetType },
): AppLaunchCacheView {
	const cache = readAppLaunchCache(path);
	const now = Date.now();
	const aliases = collectAliases(params.query, params.displayName, params.launch);
	const targetType = params.targetType ?? inferTargetType(params.launch, params.kind);
	for (const alias of aliases) {
		const previous = cache.aliases[alias];
		cache.aliases[alias] = {
			displayName: params.displayName,
			launch: params.launch,
			kind: params.kind,
			targetType,
			sourceQueries: mergeUnique([...(previous?.sourceQueries ?? []), params.query, params.displayName]),
			successCount: (previous?.successCount ?? 0) + 1,
			failCount: previous?.failCount ?? 0,
			lastSucceededAt: now,
			lastFailedAt: previous?.lastFailedAt,
		};
	}
	return writeCache(path, cache);
}

export function rememberLaunchFailure(path: string, query: string, launch: string): AppLaunchCacheView {
	const cache = readAppLaunchCache(path);
	const now = Date.now();
	for (const [alias, entry] of Object.entries(cache.aliases)) {
		if (alias === normalizeAppAlias(query) || entry.launch === launch) {
			cache.aliases[alias] = {
				...entry,
				failCount: entry.failCount + 1,
				lastFailedAt: now,
			};
		}
	}
	return writeCache(path, cache);
}

export function normalizeAppAlias(input: string): string {
	const normalized = input
		.trim()
		.toLowerCase()
		.replace(/\.lnk$/i, "")
		.replace(/\.exe$/i, "")
		.replace(/^.*[/\\]/, "")
		.replace(/[_.-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const compact = normalized.replace(/\s+/g, "");
	const aliasMap: Record<string, string> = {
		wechat: "wechat",
		weixin: "wechat",
		wx: "wechat",
		微信: "wechat",
		qq: "qq",
		tim: "qq",
		腾讯qq: "qq",
		tencentqq: "qq",
	};
	return aliasMap[compact] ?? compact;
}

export function isLikelyDirectLaunch(input: string): boolean {
	const trimmed = input.trim();
	return (
		/^(?:[a-z]:\\|\\\\|shell:|ms-settings:|https?:)/i.test(trimmed) || /\.(?:exe|lnk|bat|cmd|ps1)$/i.test(trimmed)
	);
}

export function resolveKnownWebsiteLaunch(
	query: string,
): { displayName: string; launch: string; kind: string } | undefined {
	const alias = normalizeAppAlias(query);
	const websites: Record<string, { displayName: string; launch: string; kind: string }> = {
		googletranslate: { displayName: "Google Translate", launch: "https://translate.google.com/", kind: "url" },
		google翻译: { displayName: "Google Translate", launch: "https://translate.google.com/", kind: "url" },
		谷歌翻译: { displayName: "Google Translate", launch: "https://translate.google.com/", kind: "url" },
		谷歌translate: { displayName: "Google Translate", launch: "https://translate.google.com/", kind: "url" },
	};
	return websites[alias];
}

function normalizeCache(path: string, value: Partial<AppLaunchCacheView>): AppLaunchCacheView {
	const aliases: Record<string, AppLaunchCacheEntry> = {};
	const rawAliases = typeof value.aliases === "object" && value.aliases !== null ? value.aliases : {};
	for (const [alias, rawEntry] of Object.entries(rawAliases)) {
		if (!isCacheEntry(rawEntry)) continue;
		aliases[normalizeAppAlias(alias)] = {
			...rawEntry,
			targetType: rawEntry.targetType ?? inferTargetType(rawEntry.launch, rawEntry.kind),
			sourceQueries: mergeUnique(rawEntry.sourceQueries),
		};
	}
	return {
		path,
		version: CACHE_VERSION,
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
		aliases,
	};
}

function emptyCache(path: string): AppLaunchCacheView {
	return {
		path,
		version: EMPTY_CACHE.version,
		updatedAt: EMPTY_CACHE.updatedAt,
		aliases: {},
	};
}

function writeCache(path: string, cache: AppLaunchCacheView): AppLaunchCacheView {
	const next: AppLaunchCacheView = { ...cache, path, version: CACHE_VERSION, updatedAt: Date.now() };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
	return next;
}

function isLaunchStillValid(launch: string): boolean {
	if (!/^(?:[a-z]:\\|\\\\)/i.test(launch)) return true;
	return existsSync(launch);
}

function collectAliases(query: string, displayName: string, launch: string): string[] {
	const launchBase = launch.replace(/^.*[/\\]/, "");
	return mergeUnique([query, displayName, launchBase].map(normalizeAppAlias).filter(Boolean));
}

function inferTargetType(launch: string, kind: string): AppLaunchCacheTargetType {
	return kind === "url" || /^https?:/i.test(launch.trim()) ? "url" : "app";
}

function mergeUnique(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isFoundAppLaunch(value: unknown): value is FoundAppLaunch {
	if (typeof value !== "object" || value === null) return false;
	const item = value as Partial<FoundAppLaunch>;
	return typeof item.name === "string" && typeof item.launch === "string" && typeof item.kind === "string";
}

function isCacheEntry(value: unknown): value is AppLaunchCacheEntry {
	if (typeof value !== "object" || value === null) return false;
	const item = value as Partial<AppLaunchCacheEntry>;
	return (
		typeof item.displayName === "string" &&
		typeof item.launch === "string" &&
		typeof item.kind === "string" &&
		(item.targetType === undefined || item.targetType === "app" || item.targetType === "url") &&
		Array.isArray(item.sourceQueries) &&
		typeof item.successCount === "number" &&
		typeof item.failCount === "number"
	);
}
