import { afterEach, describe, expect, it, vi } from "vitest";
import { generateConversationTitle, sanitizeConversationTitle } from "../src/agent/conversation-title.ts";

describe("conversation title generation", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sanitizes model output into a compact title", () => {
		expect(sanitizeConversationTitle(`  "\u81ea\u52a8\u4f1a\u8bdd\u6807\u9898\u3002"  `)).toBe(
			"\u81ea\u52a8\u4f1a\u8bdd\u6807\u9898",
		);
		expect(sanitizeConversationTitle("\u300a\u6574\u7406\u684c\u9762\u6587\u4ef6\u300b\n")).toBe(
			"\u6574\u7406\u684c\u9762\u6587\u4ef6",
		);
		expect(sanitizeConversationTitle("Plan a weekly budget!!!")).toBe("Plan a weekly budget");
		expect(sanitizeConversationTitle("")).toBe("");
		expect(sanitizeConversationTitle("abcdefghijklmnopqrstuvwxyz")).toBe("abcdefghijklmnopqrst");
	});

	it("returns a sanitized title from chat completions", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "\u300c\u9879\u76ee\u8ba1\u5212\u300d" } }],
				}),
				{ status: 200 },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const title = await generateConversationTitle({
			baseUrl: "https://api.example.com/v1",
			apiKey: "test-key",
			modelId: "deepseek-v4-flash",
			userMessage: "\u5e2e\u6211\u89c4\u5212\u9879\u76ee",
			assistantMessage: "\u53ef\u4ee5\uff0c\u6211\u4f1a\u62c6\u6210\u9636\u6bb5\u3002",
		});

		expect(title).toBe("\u9879\u76ee\u8ba1\u5212");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.example.com/v1/chat/completions",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer test-key",
					"Content-Type": "application/json",
				}),
			}),
		);
	});

	it("always disables deep thinking so the short title budget is not spent reasoning", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(JSON.stringify({ choices: [{ message: { content: "项目计划" } }] }), {
				status: 200,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		await generateConversationTitle({
			baseUrl: "https://api.example.com/v1",
			apiKey: "test-key",
			modelId: "deepseek-v4-flash",
			userMessage: "帮我规划项目",
		});

		const body = JSON.parse(((fetchMock.mock.calls[0] as unknown[])?.[1] as RequestInit).body as string);
		expect(body.thinking).toEqual({ type: "disabled" });
	});

	it("emits diagnostics around a successful title request", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(
					JSON.stringify({
						choices: [{ message: { content: "\u9879\u76ee\u8ba1\u5212" } }],
					}),
					{ status: 200 },
				);
			}),
		);
		const diagnostics: string[] = [];

		const title = await generateConversationTitle({
			baseUrl: "https://api.example.com/v1",
			apiKey: "test-key",
			modelId: "deepseek-v4-flash",
			userMessage: "\u5e2e\u6211\u89c4\u5212\u9879\u76ee",
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.title),
		});

		expect(title).toBe("\u9879\u76ee\u8ba1\u5212");
		expect(diagnostics).toEqual(["request started", "request succeeded"]);
	});

	it("falls back and emits diagnostics when the request fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 500 })),
		);
		const diagnostics: Array<{ level: string; title: string }> = [];

		await expect(
			generateConversationTitle({
				baseUrl: "https://api.example.com/v1",
				apiKey: "test-key",
				modelId: "deepseek-v4-flash",
				userMessage: "hello",
				onDiagnostic: (diagnostic) => diagnostics.push({ level: diagnostic.level, title: diagnostic.title }),
			}),
		).resolves.toBeUndefined();
		expect(diagnostics).toEqual([
			{ level: "info", title: "request started" },
			{ level: "warn", title: "request failed" },
		]);
	});
});
