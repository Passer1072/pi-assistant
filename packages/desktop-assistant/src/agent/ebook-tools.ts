import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appToolResult, type ExternalAppToolHost } from "./app-bridge-tools.ts";

/**
 * Convenience AI tools for the E-Book library app (电子书库). They wrap the
 * Flask API endpoints added to E-Book's main.py so the model can list books,
 * search the shelf, and kick off extraction jobs without hand-crafting app_call
 * requests. Anything not covered here is still reachable via app_call.
 */

const EBOOK_APP_ID = "ebook-library";
const MAX_RESPONSE_CHARS = 8_000;
const LONG_POLL_INTERVAL_MS = 3_000;
const LONG_POLL_TIMEOUT_MS = 60_000;
const PROGRESS_PERCENT_MILESTONE = 5;
const PROGRESS_PAGE_MILESTONE = 10;

export const EBOOK_TOOL_NAMES = [
	"ebook_list_books",
	"ebook_start_extract",
	"ebook_job_status",
	"ebook_extract_progress",
	"ebook_list_jobs",
	"ebook_retry_extract",
	"ebook_export_book",
	"ebook_export_to",
	"ebook_import_book",
	"ebook_delete_book",
	"ebook_convert_simplified",
	"ebook_update_metadata",
	"ebook_update_cover",
	"ebook_read_book",
] as const;

const EBOOK_GUIDELINES = [
	"After ebook_start_extract, prefer ebook_job_status or ebook_extract_progress with waitForChange=true. If you must check manually, call wait first and do not poll more frequently than about 10-15 seconds.",
	"During long ebook extraction waits, do not send repetitive user updates for every check. Report only meaningful progress, completion, or errors.",
	"打开/阅读书籍一律用 ebook 工具（优先 ebook_read_book）或 app_call 走 /api/books；严禁用 shell（如 Get-ChildItem/dir/find）在磁盘上搜索 .epub 或书籍目录。",
	"先用 ebook_list_books 在书库内查找；库里没有就直接告诉用户「书库里没有这本书」，不要去磁盘翻找。",
	"确需做磁盘搜索时，必须先征求用户明确同意，得到允许后才运行 shell 搜索；未经同意不得自行扫描磁盘。",
	"抓取书籍之前可先用 ebook_list_jobs 确认是否已有进行中的任务，避免重复提交。",
	"ebook_start_extract 提交后立即返回 job_id；用 ebook_job_status 轮询进度（status: pending/running/done/partial/error）。",
	"需要详细进度和剩余时间预测时用 ebook_extract_progress，它会返回 pages_done/pages_total 和 eta_seconds。",
	"ebook_list_books 支持 q 参数按书名或作者模糊搜索；不传 q 则返回全部。",
	"导出 EPUB 到指定位置：用 ebook_export_to 并指定 destinationPath（绝对路径含文件名）。",
	"只需查看本地 EPUB 路径时用 ebook_export_book；要复制到用户指定位置时用 ebook_export_to。",
	"导入 EPUB：ebook_import_book 需要本地磁盘上已存在的 .epub 文件绝对路径。",
	"删除书籍前务必向用户确认，操作不可撤销。",
];

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

async function ebookFetch(
	host: ExternalAppToolHost,
	method: HttpMethod,
	path: string,
	query?: Record<string, string>,
	body?: unknown,
	signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; text: string }> {
	const { baseUrl, manifest } = await host.ensureRunning(EBOOK_APP_ID);
	const base = manifest.ai?.basePath ?? "";
	const url = new URL(`${baseUrl}${base}${path}`);
	for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
	const hasBody = method !== "GET" && body !== undefined;
	const res = await fetch(url, {
		method,
		headers: hasBody ? { "Content-Type": "application/json" } : undefined,
		body: hasBody ? JSON.stringify(body) : undefined,
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
	});
	const text = await res.text();
	return {
		ok: res.ok,
		status: res.status,
		text: text.length > MAX_RESPONSE_CHARS ? text.slice(0, MAX_RESPONSE_CHARS) : text,
	};
}

function run(
	host: ExternalAppToolHost,
	intent: string,
	toolTarget: string,
	method: HttpMethod,
	path: string,
	query?: Record<string, string>,
	body?: unknown,
) {
	return ebookFetch(host, method, path, query, body)
		.then((r) => appToolResult(intent, toolTarget, r.ok, r.text, r.ok ? undefined : `HTTP ${r.status}`))
		.catch((e: unknown) =>
			appToolResult(intent, toolTarget, false, undefined, e instanceof Error ? e.message : String(e)),
		);
}

function delayAbortable(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new Error("Aborted"));
	return new Promise((resolve, reject) => {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => {
			finish();
			reject(new Error("Aborted"));
		};
		const finish = () => {
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		};
		timeout = setTimeout(() => {
			finish();
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function getStringField(value: Record<string, unknown> | undefined, field: string): string | undefined {
	const raw = value?.[field];
	return typeof raw === "string" ? raw : undefined;
}

function getNumberField(value: Record<string, unknown> | undefined, field: string): number | undefined {
	const raw = value?.[field];
	return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function getNestedObject(
	value: Record<string, unknown> | undefined,
	field: string,
): Record<string, unknown> | undefined {
	const raw = value?.[field];
	return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function statusFromPayload(payload: Record<string, unknown> | undefined): string | undefined {
	return getStringField(payload, "status") ?? getStringField(getNestedObject(payload, "job"), "status");
}

function progressPercentFromPayload(payload: Record<string, unknown> | undefined): number | undefined {
	const direct = getNumberField(payload, "progress");
	if (direct !== undefined) return direct;
	return getNumberField(getNestedObject(payload, "job"), "progress");
}

function pagesDoneFromPayload(payload: Record<string, unknown> | undefined): number | undefined {
	return getNumberField(payload, "pages_done") ?? getNumberField(getNestedObject(payload, "job"), "pages_done");
}

function isTerminalStatus(status: string | undefined): boolean {
	return status === "done" || status === "partial" || status === "error";
}

function hasMeaningfulProgress(
	previous: Record<string, unknown> | undefined,
	current: Record<string, unknown> | undefined,
): boolean {
	const previousPercent = progressPercentFromPayload(previous);
	const currentPercent = progressPercentFromPayload(current);
	if (previousPercent !== undefined && currentPercent !== undefined) {
		if (currentPercent - previousPercent >= PROGRESS_PERCENT_MILESTONE) return true;
	}
	const previousPages = pagesDoneFromPayload(previous);
	const currentPages = pagesDoneFromPayload(current);
	if (previousPages !== undefined && currentPages !== undefined) {
		return currentPages - previousPages >= PROGRESS_PAGE_MILESTONE;
	}
	return false;
}

async function runWithOptionalLongPoll(
	host: ExternalAppToolHost,
	intent: string,
	toolTarget: string,
	path: string,
	waitForChange: boolean | undefined,
	signal: AbortSignal | undefined,
) {
	if (!waitForChange) return run(host, intent, toolTarget, "GET", path);
	const startedAt = Date.now();
	let initialPayload: Record<string, unknown> | undefined;
	let last = await ebookFetch(host, "GET", path, undefined, undefined, signal);
	while (true) {
		const payload = parseJsonObject(last.text);
		initialPayload ??= payload;
		if (!last.ok || isTerminalStatus(statusFromPayload(payload))) {
			return appToolResult(intent, toolTarget, last.ok, last.text, last.ok ? undefined : `HTTP ${last.status}`);
		}
		if (payload !== initialPayload && hasMeaningfulProgress(initialPayload, payload)) {
			return appToolResult(intent, toolTarget, true, last.text);
		}
		if (Date.now() - startedAt >= LONG_POLL_TIMEOUT_MS) {
			return appToolResult(intent, toolTarget, last.ok, last.text, last.ok ? undefined : `HTTP ${last.status}`);
		}
		await delayAbortable(LONG_POLL_INTERVAL_MS, signal);
		last = await ebookFetch(host, "GET", path, undefined, undefined, signal);
	}
}

export function createEbookToolDefinitions(host: ExternalAppToolHost): ToolDefinition[] {
	return [
		defineTool({
			name: "ebook_list_books",
			label: "List / search books",
			description:
				"List books on the E-Book library shelf, optionally filtered by a search string that matches title or author. Returns id, title, author, chapter count, and page count for each book.",
			promptSnippet: "Browse or search the local e-book collection.",
			promptGuidelines: EBOOK_GUIDELINES,
			parameters: Type.Object({
				q: Type.Optional(Type.String({ description: "Search substring for title or author. Omit to list all." })),
			}),
			execute: async (_id, params) =>
				run(host, "List books", "ebook shelf", "GET", "/api/books", params.q ? { q: params.q } : undefined),
		}),

		defineTool({
			name: "ebook_start_extract",
			label: "Extract book from URL",
			description:
				"Start an async job that crawls a novel/book from an online source URL and saves it to the local shelf as EPUB. Returns a job_id to track progress with ebook_job_status.",
			promptSnippet: "Kick off crawling a book from an online source.",
			promptGuidelines: EBOOK_GUIDELINES,
			parameters: Type.Object({
				sourceUrl: Type.String({ description: "Homepage URL of the book (e.g. the chapter list page)." }),
				targetSite: Type.Optional(
					Type.String({
						description:
							"Site preset to use (auto/banxia/xfshuyuan/qixinyuan/23wenxue/innaerc). Default 'auto' (auto-detect).",
					}),
				),
				chapterPattern: Type.Optional(
					Type.String({
						description: "Regex for splitting raw text into chapters. Leave blank for the default pattern.",
					}),
				),
				maxPages: Type.Optional(Type.Number({ description: "Max pages to crawl. Omit for no limit." })),
			}),
			execute: async (_id, params) =>
				run(host, "Extract book", params.sourceUrl, "POST", "/extract/start", undefined, {
					source_url: params.sourceUrl,
					target_site: params.targetSite ?? "auto",
					...(params.chapterPattern ? { chapter_pattern: params.chapterPattern } : {}),
					...(params.maxPages !== undefined ? { max_pages: String(params.maxPages) } : {}),
				}),
		}),

		defineTool({
			name: "ebook_job_status",
			label: "Extraction job status",
			description:
				"Get the current status and progress of an extraction job by its job_id (from ebook_start_extract).",
			promptSnippet: "Poll the progress of an ongoing book extraction.",
			promptGuidelines: EBOOK_GUIDELINES,
			parameters: Type.Object({
				jobId: Type.String({ description: "Job id returned by ebook_start_extract." }),
				waitForChange: Type.Optional(
					Type.Boolean({
						description:
							"Block server-side until terminal status, meaningful progress, or about 60 seconds. Prefer true for running jobs.",
					}),
				),
			}),
			execute: async (_id, params, signal) =>
				runWithOptionalLongPoll(
					host,
					"Job status",
					params.jobId,
					`/extract/status/${params.jobId}`,
					params.waitForChange,
					signal,
				),
		}),

		defineTool({
			name: "ebook_extract_progress",
			label: "Detailed extraction progress",
			description:
				"Get detailed page-level progress and ETA for an extraction job. Returns pages_total, pages_done, pages_success, pages_failed, pages_remaining, and eta_seconds (estimated seconds to completion, null if not yet calculable).",
			promptSnippet: "Check how many pages are done and how long until extraction finishes.",
			promptGuidelines: EBOOK_GUIDELINES,
			parameters: Type.Object({
				jobId: Type.String({ description: "Job id returned by ebook_start_extract." }),
				waitForChange: Type.Optional(
					Type.Boolean({
						description:
							"Block server-side until terminal status, meaningful pages_done/progress change, or about 60 seconds. Prefer true for running jobs.",
					}),
				),
			}),
			execute: async (_id, params, signal) =>
				runWithOptionalLongPoll(
					host,
					"Extract progress",
					params.jobId,
					`/api/extract/progress/${params.jobId}`,
					params.waitForChange,
					signal,
				),
		}),

		defineTool({
			name: "ebook_list_jobs",
			label: "List extraction jobs",
			description:
				"List the most recent book extraction jobs (up to 40), with their id, status, progress, title and source URL. Useful to check ongoing or past extractions.",
			promptSnippet: "See recent and ongoing book extraction jobs.",
			promptGuidelines: EBOOK_GUIDELINES,
			parameters: Type.Object({}),
			execute: async () => run(host, "List jobs", "extract jobs", "GET", "/extract/jobs"),
		}),

		defineTool({
			name: "ebook_retry_extract",
			label: "Retry failed extraction pages",
			description:
				"Retry the failed pages in a partial or errored extraction job. Useful when some pages failed due to network errors.",
			promptSnippet: "Retry pages that failed during book extraction.",
			promptGuidelines: EBOOK_GUIDELINES,
			parameters: Type.Object({
				jobId: Type.String({ description: "Job id of the failed/partial extraction." }),
			}),
			execute: async (_id, params) =>
				run(host, "Retry extract", params.jobId, "POST", `/extract/${params.jobId}/retry-failed`),
		}),

		defineTool({
			name: "ebook_export_book",
			label: "Export book to EPUB",
			description:
				"Ensure the EPUB for a book is generated and return its local filesystem path. The user can then open, copy, or share the file.",
			promptSnippet: "Get the local EPUB file path of a book on the shelf.",
			promptGuidelines: EBOOK_GUIDELINES,
			parameters: Type.Object({
				bookId: Type.String({ description: "Book id (from ebook_list_books)." }),
			}),
			execute: async (_id, params) =>
				run(host, "Export EPUB", params.bookId, "GET", `/api/books/${params.bookId}/epub-path`),
		}),

		defineTool({
			name: "ebook_export_to",
			label: "Export book to destination",
			description:
				"Copy a book's EPUB to a user-specified filesystem path. Ensures the EPUB is generated first, then copies it to the destination. Use this when the user wants the file saved somewhere specific.",
			promptSnippet: "Export a book's EPUB to a user-specified folder or file path.",
			promptGuidelines: EBOOK_GUIDELINES,
			parameters: Type.Object({
				bookId: Type.String({ description: "Book id (from ebook_list_books)." }),
				destinationPath: Type.String({
					description:
						"Absolute destination path — can be a full file path (e.g. C:\\Downloads\\book.epub) or a directory (the EPUB filename is appended automatically by the server).",
				}),
			}),
			execute: async (_id, params) =>
				run(
					host,
					"Export to path",
					params.destinationPath,
					"POST",
					`/api/books/${params.bookId}/export-to`,
					undefined,
					{
						destination_path: params.destinationPath,
					},
				),
		}),

		defineTool({
			name: "ebook_import_book",
			label: "Import EPUB from path",
			description:
				"Import a local .epub file into the E-Book library by its absolute filesystem path. The book appears on the shelf after import.",
			promptSnippet: "Add a local EPUB file to the library shelf.",
			promptGuidelines: EBOOK_GUIDELINES,
			parameters: Type.Object({
				filePath: Type.String({ description: "Absolute path to the .epub file on this machine." }),
			}),
			execute: async (_id, params) =>
				run(host, "Import EPUB", params.filePath, "POST", "/api/books/import-path", undefined, {
					file_path: params.filePath,
				}),
		}),

		defineTool({
			name: "ebook_delete_book",
			label: "Delete book",
			description:
				"Permanently delete a book from the local shelf. This removes all files including the EPUB — irreversible. Always confirm with the user first.",
			promptSnippet: "Remove a book from the shelf permanently.",
			promptGuidelines: EBOOK_GUIDELINES,
			parameters: Type.Object({
				bookId: Type.String({ description: "Book id to delete (from ebook_list_books)." }),
			}),
			execute: async (_id, params) =>
				run(host, "Delete book", params.bookId, "DELETE", `/api/books/${params.bookId}`),
		}),

		defineTool({
			name: "ebook_convert_simplified",
			label: "Convert to simplified Chinese",
			description:
				"Convert a book's text from traditional Chinese to simplified Chinese and regenerate its EPUB. Works in-place — the original traditional text is replaced.",
			promptSnippet: "Convert a traditional-Chinese book to simplified Chinese.",
			promptGuidelines: EBOOK_GUIDELINES,
			parameters: Type.Object({
				bookId: Type.String({ description: "Book id to convert (from ebook_list_books)." }),
			}),
			execute: async (_id, params) =>
				run(host, "Convert simplified", params.bookId, "POST", `/api/books/${params.bookId}/convert`),
		}),

		defineTool({
			name: "ebook_update_metadata",
			label: "Update book metadata",
			description:
				"Update the title, author, and/or chapter-split pattern of a book and regenerate its EPUB. Pass only the fields you want to change.",
			promptSnippet: "Rename a book or fix its author name.",
			promptGuidelines: EBOOK_GUIDELINES,
			parameters: Type.Object({
				bookId: Type.String({ description: "Book id (from ebook_list_books)." }),
				title: Type.Optional(Type.String({ description: "New title." })),
				author: Type.Optional(Type.String({ description: "New author name." })),
				chapterPattern: Type.Optional(Type.String({ description: "New regex for chapter splitting." })),
			}),
			execute: async (_id, params) => {
				const body: Record<string, string> = {};
				if (params.title) body.title = params.title;
				if (params.author) body.author = params.author;
				if (params.chapterPattern) body.chapter_pattern = params.chapterPattern;
				return run(host, "Update metadata", params.bookId, "PUT", `/api/books/${params.bookId}`, undefined, body);
			},
		}),

		defineTool({
			name: "ebook_update_cover",
			label: "Update book cover",
			description:
				"Replace the cover image of a book and regenerate its EPUB. Provide either a URL to download the cover from, or a local file path to an image on this machine.",
			promptSnippet: "Change a book's cover image.",
			promptGuidelines: EBOOK_GUIDELINES,
			parameters: Type.Object({
				bookId: Type.String({ description: "Book id (from ebook_list_books)." }),
				coverUrl: Type.Optional(Type.String({ description: "URL of the new cover image to download." })),
				coverPath: Type.Optional(
					Type.String({ description: "Local absolute path to an image file (jpg/png/etc.)." }),
				),
			}),
			execute: async (_id, params) => {
				const body: Record<string, string> = {};
				if (params.coverUrl) body.cover_url = params.coverUrl;
				if (params.coverPath) body.cover_path = params.coverPath;
				return run(
					host,
					"Update cover",
					params.bookId,
					"POST",
					`/api/books/${params.bookId}/cover`,
					undefined,
					body,
				);
			},
		}),

		defineTool({
			name: "ebook_read_book",
			label: "Open book reader",
			description:
				"Open the E-Book library window and navigate directly to the reader for a specific book. Starts the app if not running.",
			promptSnippet: "Let the user read a specific book — open the app and jump to the reader page.",
			promptGuidelines: [
				...EBOOK_GUIDELINES,
				"用户说「我想读 X」「帮我打开 X」时优先用 ebook_read_book，不要只返回书架链接。",
			],
			parameters: Type.Object({
				bookId: Type.String({ description: "Book id (from ebook_list_books)." }),
				chapterIndex: Type.Optional(Type.Number({ description: "Chapter index to open (0-based). Default 0." })),
			}),
			execute: async (_id, params) => {
				const chapterSuffix = params.chapterIndex !== undefined ? `?chapter=${params.chapterIndex}` : "";
				const path = `/books/${params.bookId}/read${chapterSuffix}`;
				try {
					await host.openAtPath(EBOOK_APP_ID, path);
					return appToolResult("Open book reader", params.bookId, true, `已开启阅读：${path}`);
				} catch (error) {
					return appToolResult(
						"Open book reader",
						params.bookId,
						false,
						undefined,
						error instanceof Error ? error.message : String(error),
					);
				}
			},
		}),
	];
}
