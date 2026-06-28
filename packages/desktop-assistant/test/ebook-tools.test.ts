import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalAppToolHost } from "../src/agent/app-bridge-tools.ts";
import { createEbookToolDefinitions } from "../src/agent/ebook-tools.ts";
import type { DesktopToolResult, ExternalAppManifest } from "../src/shared/types.ts";

const ebookManifest: ExternalAppManifest = {
	id: "ebook-library",
	name: "电子书库",
	icon: "📚",
	cwd: "x",
	command: "py",
	args: ["main.py"],
	urlPattern: "http://127.0.0.1:{port}/",
	healthPath: "/health",
	autoStart: false,
	builtIn: true,
	ai: { basePath: "", allowPrefixes: ["/api/books", "/extract"] },
};

type ToolReturn = { content: Array<{ type: "text"; text: string }>; details: DesktopToolResult };
type FetchResponseMock = { ok: boolean; status: number; text: () => Promise<string> };
type FetchMock = ReturnType<typeof vi.fn> & {
	mock: { calls: Array<[URL, RequestInit?]> };
};

function makeHost(): ExternalAppToolHost {
	return {
		listManifests: () => [ebookManifest],
		ensureRunning: vi.fn(async () => ({ manifest: ebookManifest, baseUrl: "http://127.0.0.1:9000" })),
		openAtPath: vi.fn(async () => undefined),
	};
}

function tool(name: string) {
	const defs = createEbookToolDefinitions(makeHost());
	const found = defs.find((d) => d.name === name);
	if (!found) throw new Error(`tool not found: ${name}`);
	return found;
}

function run(t: { execute: unknown }, params: Record<string, unknown>): Promise<ToolReturn> {
	const execute = t.execute as (id: string, params: Record<string, unknown>) => Promise<ToolReturn>;
	return execute("call-1", params);
}

function mockFetchOnce(body: unknown, init: { ok?: boolean; status?: number } = {}) {
	const fetchMock = vi.fn(
		async (): Promise<FetchResponseMock> => ({
			ok: init.ok ?? true,
			status: init.status ?? 200,
			text: async () => JSON.stringify(body),
		}),
	) as FetchMock;
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function mockFetchSequence(bodies: unknown[]) {
	const fetchMock = vi.fn(async (): Promise<FetchResponseMock> => {
		const body = bodies.shift() ?? bodies.at(-1) ?? {};
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify(body),
		};
	}) as FetchMock;
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("ebook_list_books", () => {
	it("hits /api/books without query when q is absent", async () => {
		const fetchMock = mockFetchOnce({ ok: true, count: 2, books: [] });
		await run(tool("ebook_list_books"), {});
		expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:9000/api/books");
	});

	it("appends ?q= when searching", async () => {
		const fetchMock = mockFetchOnce({ ok: true, count: 1, books: [] });
		await run(tool("ebook_list_books"), { q: "三体" });
		const url = String(fetchMock.mock.calls[0][0]);
		expect(url).toContain("/api/books");
		expect(url).toContain("q=%E4%B8%89%E4%BD%93");
	});
});

describe("ebook_start_extract", () => {
	it("posts to /extract/start with source_url in body", async () => {
		const fetchMock = mockFetchOnce({ ok: true, job_id: "abc123" });
		const result = await run(tool("ebook_start_extract"), { sourceUrl: "https://example.com/book" });
		const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(String(url)).toBe("http://127.0.0.1:9000/extract/start");
		expect(init.method).toBe("POST");
		const body = JSON.parse(String(init.body));
		expect(body.source_url).toBe("https://example.com/book");
		expect(body.target_site).toBe("auto");
		expect(result.details.status).toBe("succeeded");
	});

	it("includes max_pages when provided", async () => {
		const fetchMock = mockFetchOnce({ ok: true, job_id: "def456" });
		await run(tool("ebook_start_extract"), { sourceUrl: "https://example.com/book2", maxPages: 50 });
		const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		const body = JSON.parse(String(init.body));
		expect(body.max_pages).toBe("50");
	});
});

describe("ebook_job_status", () => {
	it("hits /extract/status/<job_id>", async () => {
		const fetchMock = mockFetchOnce({ ok: true, job: { status: "running", progress: 42 } });
		await run(tool("ebook_job_status"), { jobId: "abc123" });
		expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:9000/extract/status/abc123");
	});

	it("waitForChange returns only after terminal status", async () => {
		vi.useFakeTimers();
		try {
			const fetchMock = mockFetchSequence([
				{ ok: true, job: { status: "running", progress: 10 } },
				{ ok: true, job: { status: "running", progress: 12 } },
				{ ok: true, job: { status: "done", progress: 100 } },
			]);
			const promise = run(tool("ebook_job_status"), { jobId: "abc123", waitForChange: true });
			await vi.advanceTimersByTimeAsync(6_000);
			const result = await promise;
			expect(fetchMock).toHaveBeenCalledTimes(3);
			expect(result.details.stdout).toContain('"done"');
		} finally {
			vi.useRealTimers();
		}
	});

	it("waitForChange stops on meaningful progress", async () => {
		vi.useFakeTimers();
		try {
			const fetchMock = mockFetchSequence([
				{ ok: true, job: { status: "running", progress: 10 } },
				{ ok: true, job: { status: "running", progress: 16 } },
			]);
			const promise = run(tool("ebook_job_status"), { jobId: "abc123", waitForChange: true });
			await vi.advanceTimersByTimeAsync(3_000);
			const result = await promise;
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(result.details.stdout).toContain('"progress":16');
		} finally {
			vi.useRealTimers();
		}
	});

	it("waitForChange aborts promptly", async () => {
		vi.useFakeTimers();
		try {
			mockFetchSequence([{ ok: true, job: { status: "running", progress: 10 } }]);
			const controller = new AbortController();
			const execute = tool("ebook_job_status").execute as (
				id: string,
				params: { jobId: string; waitForChange: boolean },
				signal?: AbortSignal,
			) => Promise<ToolReturn>;
			const promise = execute("call-1", { jobId: "abc123", waitForChange: true }, controller.signal);
			await vi.advanceTimersByTimeAsync(1_000);
			controller.abort();
			await expect(promise).rejects.toThrow("Aborted");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("ebook_list_jobs", () => {
	it("hits /extract/jobs", async () => {
		const fetchMock = mockFetchOnce({ ok: true, jobs: [] });
		await run(tool("ebook_list_jobs"), {});
		expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:9000/extract/jobs");
	});
});

describe("ebook_extract_progress", () => {
	it("hits /api/extract/progress/<job_id>", async () => {
		const fetchMock = mockFetchOnce({
			ok: true,
			job_id: "abc123",
			status: "running",
			progress: 45,
			pages_total: 100,
			pages_done: 45,
			pages_success: 43,
			pages_failed: 2,
			pages_remaining: 55,
			started_at: "2026-06-24T10:00:00+00:00",
			eta_seconds: 120.5,
		});
		const result = await run(tool("ebook_extract_progress"), { jobId: "abc123" });
		expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:9000/api/extract/progress/abc123");
		expect(result.details.status).toBe("succeeded");
	});
});

describe("ebook_retry_extract", () => {
	it("posts to /extract/<job_id>/retry-failed", async () => {
		const fetchMock = mockFetchOnce({ ok: true, retrying: 3 });
		await run(tool("ebook_retry_extract"), { jobId: "abc123" });
		const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(String(url)).toBe("http://127.0.0.1:9000/extract/abc123/retry-failed");
		expect((init as RequestInit).method).toBe("POST");
	});
});

describe("ebook_export_book", () => {
	it("hits /api/books/<book_id>/epub-path", async () => {
		const fetchMock = mockFetchOnce({ ok: true, epub_path: "C:\\data\\book.epub" });
		await run(tool("ebook_export_book"), { bookId: "book-001" });
		expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:9000/api/books/book-001/epub-path");
	});
});

describe("ebook_export_to", () => {
	it("posts destination_path in body to /api/books/<id>/export-to", async () => {
		const fetchMock = mockFetchOnce({ ok: true, book_id: "book-001", destination: "C:\\Downloads\\book.epub" });
		await run(tool("ebook_export_to"), { bookId: "book-001", destinationPath: "C:\\Downloads\\book.epub" });
		const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(String(url)).toBe("http://127.0.0.1:9000/api/books/book-001/export-to");
		expect((init as RequestInit).method).toBe("POST");
		const body = JSON.parse(String((init as RequestInit).body));
		expect(body.destination_path).toBe("C:\\Downloads\\book.epub");
	});

	it("returns failed when destination_path causes server error", async () => {
		mockFetchOnce({ ok: false, error: "复制文件失败: 权限不足" }, { ok: false, status: 400 });
		const result = await run(tool("ebook_export_to"), {
			bookId: "book-001",
			destinationPath: "Z:\\readonly\\book.epub",
		});
		expect(result.details.status).toBe("failed");
		expect(result.details.stderr).toContain("400");
	});
});

describe("ebook_import_book", () => {
	it("posts file_path in body to /api/books/import-path", async () => {
		const fetchMock = mockFetchOnce({ ok: true, book_id: "new-001", title: "测试书" });
		await run(tool("ebook_import_book"), { filePath: "C:\\Downloads\\test.epub" });
		const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(String(url)).toBe("http://127.0.0.1:9000/api/books/import-path");
		expect((init as RequestInit).method).toBe("POST");
		const body = JSON.parse(String((init as RequestInit).body));
		expect(body.file_path).toBe("C:\\Downloads\\test.epub");
	});
});

describe("ebook_delete_book", () => {
	it("sends DELETE to /api/books/<book_id>", async () => {
		const fetchMock = mockFetchOnce({ ok: true, deleted: "book-001" });
		await run(tool("ebook_delete_book"), { bookId: "book-001" });
		const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(String(url)).toBe("http://127.0.0.1:9000/api/books/book-001");
		expect((init as RequestInit).method).toBe("DELETE");
	});
});

describe("ebook_convert_simplified", () => {
	it("posts to /api/books/<book_id>/convert", async () => {
		const fetchMock = mockFetchOnce({ ok: true, book_id: "book-001", title: "简体版" });
		await run(tool("ebook_convert_simplified"), { bookId: "book-001" });
		const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(String(url)).toBe("http://127.0.0.1:9000/api/books/book-001/convert");
		expect((init as RequestInit).method).toBe("POST");
	});
});

describe("ebook_update_metadata", () => {
	it("sends PUT with title and author", async () => {
		const fetchMock = mockFetchOnce({ ok: true, book_id: "book-001", title: "新书名", author: "新作者" });
		await run(tool("ebook_update_metadata"), { bookId: "book-001", title: "新书名", author: "新作者" });
		const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(String(url)).toBe("http://127.0.0.1:9000/api/books/book-001");
		expect((init as RequestInit).method).toBe("PUT");
		const body = JSON.parse(String((init as RequestInit).body));
		expect(body.title).toBe("新书名");
		expect(body.author).toBe("新作者");
	});

	it("omits undefined fields from PUT body", async () => {
		const fetchMock = mockFetchOnce({ ok: true, book_id: "book-001", title: "只改标题" });
		await run(tool("ebook_update_metadata"), { bookId: "book-001", title: "只改标题" });
		const body = JSON.parse(String((fetchMock.mock.calls[0] as [URL, RequestInit])[1].body));
		expect(body.title).toBe("只改标题");
		expect(body.author).toBeUndefined();
	});
});

describe("ebook_update_cover", () => {
	it("posts cover_url to /api/books/<id>/cover", async () => {
		const fetchMock = mockFetchOnce({ ok: true, cover_filename: "cover.jpg" });
		await run(tool("ebook_update_cover"), { bookId: "book-001", coverUrl: "https://example.com/cover.jpg" });
		const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(String(url)).toBe("http://127.0.0.1:9000/api/books/book-001/cover");
		expect((init as RequestInit).method).toBe("POST");
		const body = JSON.parse(String((init as RequestInit).body));
		expect(body.cover_url).toBe("https://example.com/cover.jpg");
	});

	it("posts cover_path to /api/books/<id>/cover", async () => {
		const fetchMock = mockFetchOnce({ ok: true, cover_filename: "cover.png" });
		await run(tool("ebook_update_cover"), { bookId: "book-001", coverPath: "C:\\images\\cover.png" });
		const body = JSON.parse(String((fetchMock.mock.calls[0] as [URL, RequestInit])[1].body));
		expect(body.cover_path).toBe("C:\\images\\cover.png");
	});
});

describe("ebook_read_book", () => {
	it("calls openAtPath with /books/<id>/read", async () => {
		const host = makeHost();
		const defs = createEbookToolDefinitions(host);
		const t = defs.find((d) => d.name === "ebook_read_book");
		if (!t) throw new Error("tool not found");
		await run(t as { execute: unknown }, { bookId: "book-001" });
		expect(host.openAtPath).toHaveBeenCalledWith("ebook-library", "/books/book-001/read");
	});

	it("appends ?chapter= when chapterIndex is given", async () => {
		const host = makeHost();
		const defs = createEbookToolDefinitions(host);
		const t = defs.find((d) => d.name === "ebook_read_book");
		if (!t) throw new Error("tool not found");
		await run(t as { execute: unknown }, { bookId: "book-001", chapterIndex: 3 });
		expect(host.openAtPath).toHaveBeenCalledWith("ebook-library", "/books/book-001/read?chapter=3");
	});

	it("returns failed when openAtPath throws", async () => {
		const host = makeHost();
		(host.openAtPath as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("应用未启动"));
		const defs = createEbookToolDefinitions(host);
		const t = defs.find((d) => d.name === "ebook_read_book");
		if (!t) throw new Error("tool not found");
		const result = await run(t as { execute: unknown }, { bookId: "book-001" });
		expect(result.details.status).toBe("failed");
		expect(result.details.stderr).toContain("应用未启动");
	});
});

describe("error handling", () => {
	it("returns failed status on non-ok HTTP response", async () => {
		mockFetchOnce({ ok: false, error: "任务不存在" }, { ok: false, status: 404 });
		const result = await run(tool("ebook_job_status"), { jobId: "ghost" });
		expect(result.details.status).toBe("failed");
		expect(result.details.stderr).toContain("404");
	});
});
