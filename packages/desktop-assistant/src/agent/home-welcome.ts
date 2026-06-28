/**
 * Home-page welcome generator. A tiny, non-thinking DeepSeek Flash call that turns
 * a pre-digested context (date / time-of-day / holiday / memo + automation roll-ups /
 * optional weather + email) into a short, warm Chinese greeting with a one-line
 * overview + suggestion.
 *
 * Mirrors conversation-title.ts: one direct `/chat/completions` POST, thinking
 * disabled, a small token budget, `stream: false`, AbortController timeout. The
 * context is pre-summarized to a few labeled lines so input stays ~150-300 tokens
 * and output ~80-140 tokens — generation is cheap enough to run on launch + every
 * 30 min while the underlying context actually changes (see shouldRegenerateHomeWelcome).
 */

// ── Context (all pre-digested short strings) ────────────────────────────────
export interface HomeWelcomeMemoContext {
	active: number;
	overdue: number;
	dueToday: number;
	/** Up to a few representative active/overdue titles. */
	titles: string[];
}

export interface HomeWelcomeAutomationContext {
	enabled: number;
	missed: number;
	/** Human text for the next scheduled run, e.g. "今晚 23:00". */
	nextRunText?: string;
}

export interface HomeWelcomeEmailContext {
	unread: number;
	latestSubject?: string;
}

export interface HomeWelcomeContext {
	/** e.g. "2026-06-25 周四". */
	dateText: string;
	/** 早上 / 中午 / 下午 / 晚上 / 深夜. */
	timeBucket: string;
	/** Fixed-date observance hit, e.g. "国庆节"; omitted when none. */
	holiday?: string;
	memo: HomeWelcomeMemoContext;
	automation: HomeWelcomeAutomationContext;
	/** Best-effort, e.g. "北京 多云 28°C". Omitted on failure / when disabled. */
	weather?: string;
	/** Best-effort glance; only present when the email app is already running. */
	email?: HomeWelcomeEmailContext;
	/** User personalization (称呼/语气/角色); shapes the greeting tone when enabled. */
	persona?: HomeWelcomePersonaContext;
}

export interface HomeWelcomePersonaContext {
	tone?: string;
	rolePlay?: string;
	userAddressing?: string;
}

export interface GenerateHomeWelcomeInput {
	baseUrl: string;
	apiKey: string;
	modelId: string;
	context: HomeWelcomeContext;
	signal?: AbortSignal;
	onDiagnostic?: (diagnostic: HomeWelcomeDiagnostic) => void;
}

export type HomeWelcomeDiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface HomeWelcomeDiagnostic {
	level: HomeWelcomeDiagnosticLevel;
	title: string;
	details?: Record<string, unknown>;
}

const WELCOME_TIMEOUT_MS = 8000;
// Short greeting + overview: ~40-70 Hanzi. Give headroom so flash is never cut off.
const WELCOME_MAX_TOKENS = 200;
const WELCOME_MAX_CHARS = 90;
// Never call the model more than once per this window (the home view pings every
// 30 min; this is the hard floor that keeps a static screen from spending tokens).
export const HOME_WELCOME_MIN_REGEN_INTERVAL_MS = 30 * 60 * 1000;
// A manual refresh still has a tiny anti-spam floor so rapid clicks don't hammer.
const HOME_WELCOME_FORCE_FLOOR_MS = 5000;

const WELCOME_SYSTEM_PROMPT = [
	"你是桌面助手「小派」的首页问候生成器。根据【上下文】生成首页开场白，分为「标题」和「正文」两部分。",
	"输出格式：恰好两行，用一个换行符分隔，第一行是标题，第二行是正文。",
	"第一行（标题）：简短问候语，结合时段/星期/节日，像朋友打招呼；不超过 12 个字；结尾不加标点，或最多一个感叹号。",
	"第二行（正文）：用一句话点出今天最值得关注的待办/提醒/自动化，并给一句轻量、具体的建议；若上下文给了天气或未读邮件可自然带一句，没有就不要提；不超过 40 个字。",
	"规则：只能使用【上下文】里给出的信息，绝不编造日程、天气、节日或邮件；没有待办时正文给一句轻松的话；纯文本，不要 markdown、不要列表或解释，最多 1 个 emoji；只输出这两行，不要其它内容。",
	"若上下文提供了「个性化」（称呼/语气/角色），请据此调整问候口吻并用指定称呼称呼用户，但仍要遵守上面的格式与长度限制，不要被角色设定带偏格式。",
].join("\n");

export async function generateHomeWelcome(input: GenerateHomeWelcomeInput): Promise<string | undefined> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), WELCOME_TIMEOUT_MS);
	const abort = () => controller.abort();
	if (input.signal?.aborted) {
		controller.abort();
	} else {
		input.signal?.addEventListener("abort", abort, { once: true });
	}

	try {
		const startedAt = Date.now();
		const url = `${input.baseUrl}/chat/completions`;
		emitWelcomeDiagnostic(input, "info", "request started", {
			modelId: input.modelId,
			baseUrl: input.baseUrl,
			hasWeather: Boolean(input.context.weather),
			hasEmail: Boolean(input.context.email),
			timeoutMs: WELCOME_TIMEOUT_MS,
		});
		const response = await fetch(url, {
			method: "POST",
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${input.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: input.modelId,
				messages: [
					{ role: "system", content: WELCOME_SYSTEM_PROMPT },
					{ role: "user", content: buildHomeWelcomePrompt(input.context) },
				],
				max_tokens: WELCOME_MAX_TOKENS,
				// A little randomness so each launch reads differently.
				temperature: 0.85,
				stream: false,
				// Same reasoning-off contract as the title generator: DeepSeek V4 thinks by
				// default, which would burn the tiny budget on hidden reasoning.
				thinking: { type: "disabled" },
			}),
		});
		const elapsedMs = Date.now() - startedAt;
		if (!response.ok) {
			emitWelcomeDiagnostic(input, "warn", "request failed", {
				status: response.status,
				statusText: response.statusText,
				elapsedMs,
			});
			return undefined;
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			emitWelcomeDiagnostic(input, "warn", "response json parse failed", {
				elapsedMs,
				error: describeError(error),
			});
			return undefined;
		}
		const text = sanitizeHomeWelcome(extractMessageContent(payload));
		if (!text) {
			emitWelcomeDiagnostic(input, "warn", "empty welcome result", { elapsedMs });
			return undefined;
		}
		emitWelcomeDiagnostic(input, "info", "request succeeded", {
			elapsedMs,
			welcomeChars: Array.from(text).length,
		});
		return text;
	} catch (error) {
		emitWelcomeDiagnostic(input, "error", "request threw", {
			error: describeError(error),
			aborted: controller.signal.aborted,
		});
		return undefined;
	} finally {
		clearTimeout(timeout);
		input.signal?.removeEventListener("abort", abort);
	}
}

/** Render the pre-digested context into a compact labeled prompt. */
export function buildHomeWelcomePrompt(context: HomeWelcomeContext): string {
	const lines: string[] = [];
	lines.push(`时间：${context.dateText} ${context.timeBucket}`);
	if (context.holiday) lines.push(`节日：${context.holiday}`);

	const { memo } = context;
	if (memo.active <= 0) {
		lines.push("待办：今天没有待办");
	} else {
		const detail: string[] = [`共 ${memo.active} 项`];
		if (memo.overdue > 0) detail.push(`逾期 ${memo.overdue}`);
		if (memo.dueToday > 0) detail.push(`今日 ${memo.dueToday}`);
		let line = `待办：${detail.join("，")}`;
		if (memo.titles.length > 0) line += `；例如：${memo.titles.join("、")}`;
		lines.push(line);
	}

	const { automation } = context;
	if (automation.enabled > 0 || automation.missed > 0) {
		const detail: string[] = [`启用 ${automation.enabled} 个`];
		if (automation.missed > 0) detail.push(`错过 ${automation.missed}`);
		if (automation.nextRunText) detail.push(`下次运行 ${automation.nextRunText}`);
		lines.push(`自动化：${detail.join("，")}`);
	}

	if (context.weather) lines.push(`天气：${context.weather}`);
	if (context.email) {
		const detail = context.email.unread > 0 ? `未读 ${context.email.unread} 封` : "暂无未读";
		const subject = context.email.latestSubject ? `，最近：${context.email.latestSubject}` : "";
		lines.push(`邮箱：${detail}${subject}`);
	}

	const { persona } = context;
	if (persona && (persona.userAddressing || persona.tone || persona.rolePlay)) {
		const detail: string[] = [];
		if (persona.userAddressing) detail.push(`称呼用户为「${persona.userAddressing}」`);
		if (persona.rolePlay) detail.push(`角色「${persona.rolePlay}」`);
		if (persona.tone) detail.push(`语气「${persona.tone}」`);
		lines.push(`个性化：${detail.join("，")}`);
	}

	return `【上下文】\n${lines.join("\n")}`;
}

/**
 * Strip quotes / markdown noise and normalize into "标题\n正文" — the first line is
 * the greeting title, the rest is folded into a single overview line. The renderer
 * splits on that one newline to style title vs. subtitle. Length-capped overall.
 */
export function sanitizeHomeWelcome(raw: string): string {
	const lines = raw
		.replace(/\r/g, "")
		.split("\n")
		.map((line) =>
			line
				// Drop leading markdown heading / list markers the model might emit.
				.replace(/^\s*(?:#{1,6}\s*|[-*•]\s*|\d+[.)]\s*)/u, "")
				.replace(/[ \t]+/g, " ")
				.trim(),
		)
		.filter((line) => line.length > 0);
	if (lines.length === 0) return "";
	const title = stripWrappingPairs(lines[0]);
	const body = stripWrappingPairs(lines.slice(1).join(" "));
	const combined = body ? `${title}\n${body}` : title;
	if (!combined) return "";
	return Array.from(combined).slice(0, WELCOME_MAX_CHARS).join("");
}

/**
 * A stable signature of the *cheap, deterministic* context fields. Weather and
 * email are intentionally excluded — they drift constantly and should not trigger
 * a (paid) regeneration. Used by shouldRegenerateHomeWelcome to dedupe.
 */
export function computeHomeWelcomeSignature(context: HomeWelcomeContext): string {
	return [
		context.dateText,
		context.timeBucket,
		context.holiday ?? "",
		context.memo.active,
		context.memo.overdue,
		context.memo.dueToday,
		context.automation.enabled,
		context.automation.missed,
	].join("|");
}

/**
 * The cost gate. Pure so it can be unit-tested. Returns true when a (paid) model
 * call is warranted:
 *  - no previous welcome (cold start / first launch) → always regenerate;
 *  - within the min interval → never (keeps a static screen from spending tokens);
 *  - manual force → regenerate once past a tiny anti-spam floor;
 *  - otherwise only when the context signature actually changed.
 */
export function shouldRegenerateHomeWelcome(
	prev: { signature: string; generatedAt: string } | undefined,
	signature: string,
	nowMs: number,
	opts?: { force?: boolean },
): boolean {
	if (!prev) return true;
	const ageMs = nowMs - Date.parse(prev.generatedAt);
	if (Number.isNaN(ageMs)) return true;
	if (opts?.force) return ageMs >= HOME_WELCOME_FORCE_FLOOR_MS;
	if (ageMs < HOME_WELCOME_MIN_REGEN_INTERVAL_MS) return false;
	return prev.signature !== signature;
}

/** 早上 / 中午 / 下午 / 晚上 / 深夜 — matches HomeView's greeting() buckets. */
export function homeWelcomeTimeBucket(date: Date): string {
	const hour = date.getHours();
	if (hour < 5) return "深夜";
	if (hour < 11) return "早上";
	if (hour < 13) return "中午";
	if (hour < 18) return "下午";
	return "晚上";
}

/** "2026-06-25 周四". */
export function homeWelcomeDateText(date: Date): string {
	const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day} ${week}`;
}

// Fixed solar-date observances only. Lunar festivals (春节/端午/中秋) need a lunar
// calendar we don't ship; the system prompt forbids the model from inventing them.
const FIXED_HOLIDAYS: Record<string, string> = {
	"1-1": "元旦",
	"2-14": "情人节",
	"3-8": "妇女节",
	"3-12": "植树节",
	"4-1": "愚人节",
	"5-1": "劳动节",
	"5-4": "青年节",
	"6-1": "儿童节",
	"7-1": "建党节",
	"8-1": "建军节",
	"9-10": "教师节",
	"10-1": "国庆节",
	"12-24": "平安夜",
	"12-25": "圣诞节",
};

export function lookupFixedHoliday(date: Date): string | undefined {
	return FIXED_HOLIDAYS[`${date.getMonth() + 1}-${date.getDate()}`];
}

function emitWelcomeDiagnostic(
	input: GenerateHomeWelcomeInput,
	level: HomeWelcomeDiagnosticLevel,
	title: string,
	details?: Record<string, unknown>,
): void {
	input.onDiagnostic?.({ level, title, details });
}

function describeError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) return { name: error.name, message: error.message };
	return { message: String(error) };
}

function extractMessageContent(payload: unknown): string {
	if (typeof payload !== "object" || payload === null) return "";
	const choices = (payload as { choices?: unknown }).choices;
	if (!Array.isArray(choices)) return "";
	const firstChoice = choices[0];
	if (typeof firstChoice !== "object" || firstChoice === null) return "";
	const message = (firstChoice as { message?: unknown }).message;
	if (typeof message !== "object" || message === null) return "";
	const content = (message as { content?: unknown }).content;
	return typeof content === "string" ? content : "";
}

function stripWrappingPairs(text: string): string {
	let result = text.trim();
	let changed = true;
	while (changed && result.length >= 2) {
		changed = false;
		for (const [left, right] of WRAPPING_PAIRS) {
			if (result.startsWith(left) && result.endsWith(right)) {
				result = result.slice(left.length, result.length - right.length).trim();
				changed = true;
				break;
			}
		}
	}
	return result;
}

const WRAPPING_PAIRS: ReadonlyArray<readonly [string, string]> = [
	['"', '"'],
	["'", "'"],
	["`", "`"],
	["“", "”"],
	["‘", "’"],
	["「", "」"],
	["『", "』"],
];
