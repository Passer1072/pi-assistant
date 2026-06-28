import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildHomeWelcomePrompt,
	computeHomeWelcomeSignature,
	generateHomeWelcome,
	HOME_WELCOME_MIN_REGEN_INTERVAL_MS,
	type HomeWelcomeContext,
	lookupFixedHoliday,
	sanitizeHomeWelcome,
	shouldRegenerateHomeWelcome,
} from "../src/agent/home-welcome.ts";
import { formatWeatherGlance, parseWeatherSnapshot } from "../src/agent/home-welcome-weather.ts";

function makeContext(overrides: Partial<HomeWelcomeContext> = {}): HomeWelcomeContext {
	return {
		dateText: "2026-06-25 周四",
		timeBucket: "晚上",
		memo: { active: 2, overdue: 1, dueToday: 1, titles: ["买菜", "给妈妈打电话"] },
		automation: { enabled: 3, missed: 0, nextRunText: "今天 23:00" },
		...overrides,
	};
}

describe("home welcome generation", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("normalizes into a title\\n body shape and caps length", () => {
		expect(sanitizeHomeWelcome("## 下午好\n记得喝水")).toBe("下午好\n记得喝水");
		// A single line has no subtitle.
		expect(sanitizeHomeWelcome(`  "早上好呀"  `)).toBe("早上好呀");
		// Extra body lines fold into one overview line; blank lines are dropped.
		expect(sanitizeHomeWelcome("晚上好\n\n今天有两件待办\n记得早点休息")).toBe("晚上好\n今天有两件待办 记得早点休息");
		expect(sanitizeHomeWelcome("「早上好呀」")).toBe("早上好呀");
		expect(sanitizeHomeWelcome("")).toBe("");
		expect(Array.from(sanitizeHomeWelcome("阿".repeat(200))).length).toBe(90);
	});

	it("returns a sanitized greeting from chat completions", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ choices: [{ message: { content: "「晚上好，先把逾期的待办处理掉吧。」" } }] }),
					{
						status: 200,
					},
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const text = await generateHomeWelcome({
			baseUrl: "https://api.example.com/v1",
			apiKey: "test-key",
			modelId: "deepseek-v4-flash",
			context: makeContext(),
		});

		expect(text).toBe("晚上好，先把逾期的待办处理掉吧。");
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

	it("always disables deep thinking and keeps a small token budget", async () => {
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ choices: [{ message: { content: "晚上好" } }] }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		await generateHomeWelcome({
			baseUrl: "https://api.example.com/v1",
			apiKey: "test-key",
			modelId: "deepseek-v4-flash",
			context: makeContext(),
		});

		const body = JSON.parse(((fetchMock.mock.calls[0] as unknown[])?.[1] as RequestInit).body as string);
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body.stream).toBe(false);
		expect(body.max_tokens).toBeLessThanOrEqual(256);
	});

	it("resolves to undefined on an http failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 500 })),
		);
		await expect(
			generateHomeWelcome({
				baseUrl: "https://api.example.com/v1",
				apiKey: "test-key",
				modelId: "deepseek-v4-flash",
				context: makeContext(),
			}),
		).resolves.toBeUndefined();
	});

	it("emits diagnostics around a successful request", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ choices: [{ message: { content: "晚上好" } }] }), { status: 200 }),
			),
		);
		const diagnostics: string[] = [];
		await generateHomeWelcome({
			baseUrl: "https://api.example.com/v1",
			apiKey: "test-key",
			modelId: "deepseek-v4-flash",
			context: makeContext(),
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.title),
		});
		expect(diagnostics).toEqual(["request started", "request succeeded"]);
	});
});

describe("home welcome prompt + context", () => {
	it("renders a compact labeled context", () => {
		const prompt = buildHomeWelcomePrompt(makeContext({ weather: "北京 多云 28°C", holiday: "端午节" }));
		expect(prompt).toContain("时间：2026-06-25 周四 晚上");
		expect(prompt).toContain("节日：端午节");
		expect(prompt).toContain("逾期 1");
		expect(prompt).toContain("买菜、给妈妈打电话");
		expect(prompt).toContain("自动化：启用 3 个");
		expect(prompt).toContain("天气：北京 多云 28°C");
	});

	it("says there are no todos when memo is empty and omits absent enrichments", () => {
		const prompt = buildHomeWelcomePrompt(
			makeContext({
				memo: { active: 0, overdue: 0, dueToday: 0, titles: [] },
				automation: { enabled: 0, missed: 0 },
			}),
		);
		expect(prompt).toContain("待办：今天没有待办");
		expect(prompt).not.toContain("天气");
		expect(prompt).not.toContain("邮箱");
		expect(prompt).not.toContain("自动化");
	});

	it("excludes weather / email from the signature so they don't trigger regeneration", () => {
		const base = computeHomeWelcomeSignature(makeContext());
		const withWeather = computeHomeWelcomeSignature(makeContext({ weather: "上海 晴 30°C" }));
		const withEmail = computeHomeWelcomeSignature(makeContext({ email: { unread: 5, latestSubject: "发票" } }));
		expect(withWeather).toBe(base);
		expect(withEmail).toBe(base);
		const moved = computeHomeWelcomeSignature(makeContext({ timeBucket: "深夜" }));
		expect(moved).not.toBe(base);
	});

	it("maps fixed solar holidays", () => {
		expect(lookupFixedHoliday(new Date(2026, 9, 1))).toBe("国庆节");
		expect(lookupFixedHoliday(new Date(2026, 11, 25))).toBe("圣诞节");
		expect(lookupFixedHoliday(new Date(2026, 6, 18))).toBeUndefined();
	});
});

describe("shouldRegenerateHomeWelcome (cost gate)", () => {
	const now = Date.parse("2026-06-25T20:00:00.000Z");
	const fresh = { signature: "sig-a", generatedAt: new Date(now - 60_000).toISOString() };
	const stale = {
		signature: "sig-a",
		generatedAt: new Date(now - HOME_WELCOME_MIN_REGEN_INTERVAL_MS - 60_000).toISOString(),
	};

	it("regenerates on a cold start (no previous welcome)", () => {
		expect(shouldRegenerateHomeWelcome(undefined, "sig-a", now)).toBe(true);
	});

	it("never regenerates inside the min interval", () => {
		expect(shouldRegenerateHomeWelcome(fresh, "sig-a", now)).toBe(false);
		expect(shouldRegenerateHomeWelcome(fresh, "sig-DIFFERENT", now)).toBe(false);
	});

	it("regenerates past the interval only when the signature changed", () => {
		expect(shouldRegenerateHomeWelcome(stale, "sig-a", now)).toBe(false);
		expect(shouldRegenerateHomeWelcome(stale, "sig-b", now)).toBe(true);
	});

	it("forces regeneration past the small anti-spam floor", () => {
		expect(shouldRegenerateHomeWelcome(fresh, "sig-a", now, { force: true })).toBe(true);
	});
});

describe("weather snapshot parsing", () => {
	it("parses a WeatherAPI.com current.json payload into a structured view", () => {
		const payload = {
			location: { name: "北京", region: "Beijing", country: "China" },
			current: {
				temp_c: 28.4,
				feelslike_c: 30.1,
				is_day: 1,
				humidity: 48,
				wind_kph: 12.6,
				condition: { text: "多云", icon: "//cdn.weatherapi.com/weather/64x64/day/116.png", code: 1003 },
			},
		};
		const snapshot = parseWeatherSnapshot(payload);
		expect(snapshot).toMatchObject({
			city: "北京",
			tempC: 28.4,
			feelsLikeC: 30.1,
			conditionText: "多云",
			conditionCode: 1003,
			isDay: true,
			humidity: 48,
			windKph: 12.6,
		});
		expect(typeof snapshot?.fetchedAt).toBe("string");
	});

	it("requires a temperature and tolerates missing fields", () => {
		expect(parseWeatherSnapshot({ current: { temp_c: 4.6, condition: { text: "Sunny" } } })).toMatchObject({
			tempC: 4.6,
			conditionText: "Sunny",
			isDay: true,
		});
		expect(parseWeatherSnapshot({ current: {} })).toBeUndefined();
		expect(parseWeatherSnapshot({})).toBeUndefined();
		expect(parseWeatherSnapshot(null)).toBeUndefined();
	});

	it("treats is_day=0 as night", () => {
		expect(parseWeatherSnapshot({ current: { temp_c: 10, is_day: 0 } })?.isDay).toBe(false);
	});
});

describe("weather glance formatting", () => {
	it("builds a compact city/condition/temp string and rounds temperature", () => {
		const payload = {
			location: { name: "北京" },
			current: { temp_c: 28.4, condition: { text: "多云", code: 1003 } },
		};
		expect(formatWeatherGlance(parseWeatherSnapshot(payload))).toBe("北京 多云 28°C");
		expect(
			formatWeatherGlance(parseWeatherSnapshot({ current: { temp_c: 4.6, condition: { text: "Sunny" } } })),
		).toBe("Sunny 5°C");
		expect(formatWeatherGlance(undefined)).toBeUndefined();
	});
});
