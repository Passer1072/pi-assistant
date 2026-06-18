import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DesktopToolResult, SandboxNetworkSettings, WebSearchMode, WebSearchProvider } from "../shared/types.ts";
import { evaluateNetworkUrl } from "./sandbox/policy-engine.ts";

export interface WebToolOptions {
	mode: WebSearchMode;
	provider: WebSearchProvider;
	/** API key for Bing / Google / Serper. */
	apiKey?: string;
	/** Google Custom Search Engine ID (cx). */
	googleCx?: string;
	/** SearXNG self-hosted instance URL, e.g. https://searx.example.com */
	searxngUrl?: string;
	/** Sandbox network policy (SSRF guard, domain allow/deny) applied to web_fetch. */
	network?: SandboxNetworkSettings;
}

// ─── Result shape ──────────────────────────────────────────────────────────

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

// ─── Provider implementations ──────────────────────────────────────────────

/**
 * DuckDuckGo Instant Answer API — free, no key required.
 * Returns instant answers + related topics. Not a full-text web search.
 */
async function ddgSearch(query: string, count: number): Promise<SearchResult[]> {
	const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&t=pi-desktop`;
	const res = await fetch(url, {
		headers: { "User-Agent": "Pi-Desktop-Assistant/1.0" },
		signal: AbortSignal.timeout(12_000),
	});
	if (!res.ok) throw new Error(`DuckDuckGo API ${res.status}`);

	const data = (await res.json()) as {
		AbstractText?: string;
		AbstractURL?: string;
		Heading?: string;
		RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: unknown[] }>;
		Results?: Array<{ Text?: string; FirstURL?: string }>;
	};

	const results: SearchResult[] = [];

	if (data.AbstractText) {
		results.push({ title: data.Heading ?? query, url: data.AbstractURL ?? "", snippet: data.AbstractText });
	}
	for (const r of data.Results ?? []) {
		if (r.Text && r.FirstURL) results.push({ title: r.Text.slice(0, 80), url: r.FirstURL, snippet: r.Text });
	}
	for (const topic of data.RelatedTopics ?? []) {
		if (results.length >= count) break;
		if ((topic as { Topics?: unknown[] }).Topics) continue;
		const t = topic as { Text?: string; FirstURL?: string };
		if (t.Text && t.FirstURL) results.push({ title: t.Text.slice(0, 80), url: t.FirstURL, snippet: t.Text });
	}
	return results.slice(0, count);
}

/**
 * Bing Web Search v7 (Azure Cognitive Services).
 * Free tier: 1 000 queries/month.
 * Key type: Ocp-Apim-Subscription-Key
 */
async function bingSearch(query: string, count: number, apiKey: string): Promise<SearchResult[]> {
	const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${count}&responseFilter=Webpages`;
	const res = await fetch(url, {
		headers: { "Ocp-Apim-Subscription-Key": apiKey },
		signal: AbortSignal.timeout(12_000),
	});
	if (!res.ok) throw new Error(`Bing API ${res.status}: ${await res.text().catch(() => "")}`);
	const data = (await res.json()) as {
		webPages?: { value?: Array<{ name: string; url: string; snippet: string }> };
	};
	return (data.webPages?.value ?? []).map((p) => ({ title: p.name, url: p.url, snippet: p.snippet }));
}

/**
 * Google Programmable Search Engine (Custom Search JSON API).
 * Free tier: 100 queries/day.
 * Requires: API key (Cloud Console) + Search Engine ID (cx).
 */
async function googleSearch(query: string, count: number, apiKey: string, cx: string): Promise<SearchResult[]> {
	const url =
		`https://www.googleapis.com/customsearch/v1` +
		`?key=${encodeURIComponent(apiKey)}` +
		`&cx=${encodeURIComponent(cx)}` +
		`&q=${encodeURIComponent(query)}` +
		`&num=${Math.min(count, 10)}`;
	const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
	if (!res.ok) throw new Error(`Google API ${res.status}: ${await res.text().catch(() => "")}`);
	const data = (await res.json()) as {
		items?: Array<{ title: string; link: string; snippet: string }>;
	};
	return (data.items ?? []).map((item) => ({ title: item.title, url: item.link, snippet: item.snippet }));
}

/**
 * Tavily — AI-native search API, designed for LLM agents.
 * Free tier: 1 000 queries/month. Sign up at app.tavily.com.
 */
async function tavilySearch(query: string, count: number, apiKey: string): Promise<SearchResult[]> {
	const res = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ api_key: apiKey, query, max_results: count, search_depth: "basic" }),
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`Tavily API ${res.status}: ${await res.text().catch(() => "")}`);
	const data = (await res.json()) as {
		results?: Array<{ title: string; url: string; content?: string; snippet?: string }>;
	};
	return (data.results ?? []).slice(0, count).map((r) => ({
		title: r.title,
		url: r.url,
		snippet: r.content ?? r.snippet ?? "",
	}));
}

/**
 * Brave Search API — independent index, not reliant on Google/Bing.
 * Free tier: 2 000 queries/month. Sign up at brave.com/search/api.
 */
async function braveSearch(query: string, count: number, apiKey: string): Promise<SearchResult[]> {
	const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}`;
	const res = await fetch(url, {
		headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
		signal: AbortSignal.timeout(12_000),
	});
	if (!res.ok) throw new Error(`Brave API ${res.status}: ${await res.text().catch(() => "")}`);
	const data = (await res.json()) as {
		web?: { results?: Array<{ title: string; url: string; description?: string }> };
	};
	return (data.web?.results ?? []).slice(0, count).map((r) => ({
		title: r.title,
		url: r.url,
		snippet: r.description ?? "",
	}));
}

/**
 * Serper.dev — Google search via API.
 * Free tier: 2 500 queries (one-time credit).
 * Key: X-API-KEY header.
 */
async function serperSearch(query: string, count: number, apiKey: string): Promise<SearchResult[]> {
	const res = await fetch("https://google.serper.dev/search", {
		method: "POST",
		headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({ q: query, num: Math.min(count, 10) }),
		signal: AbortSignal.timeout(12_000),
	});
	if (!res.ok) throw new Error(`Serper API ${res.status}: ${await res.text().catch(() => "")}`);
	const data = (await res.json()) as {
		organic?: Array<{ title: string; link: string; snippet?: string }>;
	};
	return (data.organic ?? []).slice(0, count).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet ?? "" }));
}

/**
 * SearXNG — self-hosted meta-search engine (JSON API).
 * No key required; just the instance URL.
 */
async function searxngSearch(query: string, count: number, baseUrl: string): Promise<SearchResult[]> {
	const u = new URL("/search", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
	u.searchParams.set("q", query);
	u.searchParams.set("format", "json");
	u.searchParams.set("categories", "general");
	const res = await fetch(u.toString(), {
		headers: { "User-Agent": "Pi-Desktop-Assistant/1.0" },
		signal: AbortSignal.timeout(12_000),
	});
	if (!res.ok) throw new Error(`SearXNG ${res.status}: ${await res.text().catch(() => "")}`);
	const data = (await res.json()) as {
		results?: Array<{ title: string; url: string; content?: string }>;
	};
	return (data.results ?? []).slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
}

/** Dispatch to the correct provider. Throws with a descriptive error on misconfiguration. */
async function runSearch(
	query: string,
	count: number,
	opts: WebToolOptions,
): Promise<{ provider: string; results: SearchResult[] }> {
	switch (opts.provider) {
		case "bing": {
			if (!opts.apiKey) throw new Error("Bing 搜索需要配置 API Key（Ocp-Apim-Subscription-Key）");
			return { provider: "Bing", results: await bingSearch(query, count, opts.apiKey) };
		}
		case "google": {
			if (!opts.apiKey) throw new Error("Google 搜索需要配置 API Key");
			if (!opts.googleCx) throw new Error("Google 搜索需要配置搜索引擎 ID（cx）");
			return { provider: "Google", results: await googleSearch(query, count, opts.apiKey, opts.googleCx) };
		}
		case "tavily": {
			if (!opts.apiKey) throw new Error("Tavily 搜索需要配置 API Key（从 app.tavily.com 获取）");
			return { provider: "Tavily", results: await tavilySearch(query, count, opts.apiKey) };
		}
		case "brave": {
			if (!opts.apiKey) throw new Error("Brave 搜索需要配置 API Key（从 brave.com/search/api 获取）");
			return { provider: "Brave", results: await braveSearch(query, count, opts.apiKey) };
		}
		case "serper": {
			if (!opts.apiKey) throw new Error("Serper 搜索需要配置 API Key");
			return { provider: "Serper", results: await serperSearch(query, count, opts.apiKey) };
		}
		case "searxng": {
			const url = opts.searxngUrl?.trim();
			if (!url) throw new Error("SearXNG 搜索需要配置实例 URL");
			return { provider: `SearXNG(${url})`, results: await searxngSearch(query, count, url) };
		}
		default: // duckduckgo
			return { provider: "DuckDuckGo", results: await ddgSearch(query, count) };
	}
}

// ─── HTML → plain text ─────────────────────────────────────────────────────

function htmlToText(html: string): string {
	return html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
}

// ─── Tool helpers ──────────────────────────────────────────────────────────

function makeResult(
	intent: string,
	target: string,
	ok: boolean,
	stdout?: string,
	stderr?: string,
): { content: [{ type: "text"; text: string }]; details: DesktopToolResult } {
	const details: DesktopToolResult = {
		stepId: randomUUID(),
		intent,
		action: "http",
		target,
		status: ok ? "succeeded" : "failed",
		stdout,
		stderr,
		riskLevel: "low",
		requiresConfirmation: false,
	};
	return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

function modeGuidelines(mode: WebSearchMode, provider: WebSearchProvider): string[] {
	const providerNote =
		provider === "duckduckgo" ? "（使用 DuckDuckGo 即时答案，适合事实性查询）" : `（使用 ${provider} 全文搜索）`;
	if (mode === "on") {
		return [
			`Web search is ON ${providerNote}. Proactively search the web for factual questions, current events, prices, software documentation, or any information that may change over time. Do not rely solely on training data.`,
			"Always cite the source URL when using web search results.",
		];
	}
	return [
		`Web search is in AUTO mode ${providerNote}. Use web_search when the query requires current information (news, prices, software versions, real-time data, specific URLs, or events after your training cutoff). Skip searching for stable well-known facts.`,
		"Always cite the source URL when using web search results.",
	];
}

// ─── Schemas ───────────────────────────────────────────────────────────────

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query string." }),
	maxResults: Type.Optional(Type.Number({ description: "Number of results, 1–10. Default: 5." })),
});

const webFetchSchema = Type.Object({
	url: Type.String({ description: "URL to fetch." }),
	maxChars: Type.Optional(Type.Number({ description: "Max characters to return. Default: 6000." })),
});

// ─── Tool factory ──────────────────────────────────────────────────────────

/**
 * Create web_search and web_fetch tool definitions based on current settings.
 * Returns an empty array when mode is "off".
 */
export function createWebTools(options: WebToolOptions): ToolDefinition[] {
	if (options.mode === "off") return [];

	const guidelines = modeGuidelines(options.mode, options.provider);

	const webSearchTool = defineTool({
		name: "web_search",
		label: "Web search",
		description:
			"Search the web for up-to-date information. Returns titles, URLs, and snippets. Use web_fetch to read full page content.",
		promptSnippet:
			"Search the internet for current information, news, prices, documentation, or recent events. Follow up with web_fetch to read specific pages in full.",
		promptGuidelines: guidelines,
		parameters: webSearchSchema,
		execute: async (_id, params) => {
			const count = Math.max(1, Math.min(10, params.maxResults ?? 5));
			try {
				const { provider, results } = await runSearch(params.query, count, options);
				return makeResult(
					"Web search",
					params.query,
					true,
					JSON.stringify({ provider, query: params.query, count: results.length, results }),
				);
			} catch (err) {
				return makeResult(
					"Web search",
					params.query,
					false,
					undefined,
					err instanceof Error ? err.message : String(err),
				);
			}
		},
	});

	const webFetchTool = defineTool({
		name: "web_fetch",
		label: "Web fetch",
		description:
			"Fetch the text content of a web page. Strips HTML and returns readable plain text. Use after web_search to read full articles.",
		promptSnippet:
			"Download and read a web page by URL. Useful for reading full articles, documentation, or search result pages.",
		promptGuidelines: guidelines,
		parameters: webFetchSchema,
		execute: async (_id, params) => {
			const maxChars = Math.max(500, Math.min(20_000, params.maxChars ?? 6_000));

			const trim = (text: string) =>
				text.length > maxChars ? `${text.slice(0, maxChars)}\n…[截断，共 ${text.length} 字符]` : text;

			// Sandbox network policy: SSRF guard + domain allow/deny.
			if (options.network) {
				const verdict = evaluateNetworkUrl(params.url, options.network);
				if (!verdict.allowed) {
					return makeResult(
						"Fetch web page",
						params.url,
						false,
						undefined,
						verdict.reason ?? "网络访问被沙箱策略拒绝",
					);
				}
			}

			// Primary: direct fetch
			try {
				const res = await fetch(params.url, {
					headers: {
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
						Accept: "text/html,application/xhtml+xml,text/plain,*/*",
						"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
					},
					signal: AbortSignal.timeout(15_000),
					redirect: "follow",
				});
				if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
				const ct = res.headers.get("content-type") ?? "";
				const raw = await res.text();
				const text = ct.includes("html") ? htmlToText(raw) : raw;
				return makeResult("Fetch web page", params.url, true, trim(text));
			} catch (_directErr) {
				// Fallback: Jina AI Reader — strips JS, returns clean markdown, free & no key needed
				try {
					const jinaRes = await fetch(`https://r.jina.ai/${params.url}`, {
						headers: { Accept: "text/plain", "X-No-Cache": "true" },
						signal: AbortSignal.timeout(20_000),
					});
					if (!jinaRes.ok) throw new Error(`Jina ${jinaRes.status}`);
					const text = await jinaRes.text();
					return makeResult("Fetch web page (via Jina)", params.url, true, trim(text));
				} catch (jinaErr) {
					return makeResult(
						"Fetch web page",
						params.url,
						false,
						undefined,
						jinaErr instanceof Error ? jinaErr.message : String(jinaErr),
					);
				}
			}
		},
	});

	return [webSearchTool, webFetchTool];
}

/** Names of web tools for the active-tool allowlist. */
export const WEB_TOOL_NAMES = ["web_search", "web_fetch"] as const;
