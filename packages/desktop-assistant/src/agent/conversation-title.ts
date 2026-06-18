export interface GenerateTitleInput {
	baseUrl: string;
	apiKey: string;
	modelId: string;
	userMessage: string;
	assistantMessage?: string;
	signal?: AbortSignal;
	onDiagnostic?: (diagnostic: ConversationTitleDiagnostic) => void;
}

export type ConversationTitleDiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface ConversationTitleDiagnostic {
	level: ConversationTitleDiagnosticLevel;
	title: string;
	details?: Record<string, unknown>;
}

const TITLE_TIMEOUT_MS = 8000;
const USER_MESSAGE_LIMIT = 500;
const ASSISTANT_MESSAGE_LIMIT = 200;
const TITLE_MAX_CHARS = 20;
const TITLE_SYSTEM_PROMPT =
	"\u4f60\u662f\u4f1a\u8bdd\u6807\u9898\u751f\u6210\u5668\u3002\u6839\u636e\u7528\u6237\u7684\u9996\u6761\u6d88\u606f\uff08\u53ca\u53ef\u9009\u7684\u52a9\u624b\u56de\u590d\uff09\u603b\u7ed3\u4e00\u4e2a\u7b80\u77ed\u6807\u9898\u3002\u8981\u6c42\uff1a\u76f4\u63a5\u8f93\u51fa\u6807\u9898\u672c\u8eab\uff1b\u4e0d\u8d85\u8fc712\u4e2a\u6c49\u5b57\u621620\u4e2a\u82f1\u6587\u5b57\u7b26\uff1b\u4e0d\u8981\u6807\u70b9\u3001\u5f15\u53f7\u3001\u4e66\u540d\u53f7\u3001\u53e5\u53f7\uff1b\u4e0d\u8981\u89e3\u91ca\uff1b\u7528\u4e0e\u7528\u6237\u76f8\u540c\u7684\u8bed\u8a00\u3002";

export async function generateConversationTitle(input: GenerateTitleInput): Promise<string | undefined> {
	const userMessage = input.userMessage.trim();
	if (!userMessage) return undefined;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
	const abort = () => controller.abort();
	if (input.signal?.aborted) {
		controller.abort();
	} else {
		input.signal?.addEventListener("abort", abort, { once: true });
	}

	try {
		const startedAt = Date.now();
		const url = `${input.baseUrl}/chat/completions`;
		emitTitleDiagnostic(input, "info", "request started", {
			modelId: input.modelId,
			baseUrl: input.baseUrl,
			userMessageChars: Array.from(userMessage).length,
			assistantMessageChars: input.assistantMessage ? Array.from(input.assistantMessage.trim()).length : 0,
			timeoutMs: TITLE_TIMEOUT_MS,
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
					{
						role: "system",
						content: TITLE_SYSTEM_PROMPT,
					},
					{
						role: "user",
						content: buildTitlePrompt(userMessage, input.assistantMessage),
					},
				],
				max_tokens: 24,
				temperature: 0,
				stream: false,
			}),
		});
		const elapsedMs = Date.now() - startedAt;
		if (!response.ok) {
			emitTitleDiagnostic(input, "warn", "request failed", {
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
			emitTitleDiagnostic(input, "warn", "response json parse failed", {
				elapsedMs,
				error: describeError(error),
			});
			return undefined;
		}
		const title = sanitizeConversationTitle(extractTitleContent(payload));
		if (!title) {
			emitTitleDiagnostic(input, "warn", "empty title result", {
				elapsedMs,
				hasChoices: responsePayloadHasChoices(payload),
			});
			return undefined;
		}
		emitTitleDiagnostic(input, "info", "request succeeded", {
			elapsedMs,
			title,
			titleChars: Array.from(title).length,
		});
		return title || undefined;
	} catch (error) {
		emitTitleDiagnostic(input, "error", "request threw", {
			error: describeError(error),
			aborted: controller.signal.aborted,
		});
		return undefined;
	} finally {
		clearTimeout(timeout);
		input.signal?.removeEventListener("abort", abort);
	}
}

function emitTitleDiagnostic(
	input: GenerateTitleInput,
	level: ConversationTitleDiagnosticLevel,
	title: string,
	details?: Record<string, unknown>,
): void {
	input.onDiagnostic?.({ level, title, details });
}

function describeError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
		};
	}
	return {
		message: String(error),
	};
}

function responsePayloadHasChoices(payload: unknown): boolean {
	if (typeof payload !== "object" || payload === null) return false;
	return Array.isArray((payload as { choices?: unknown }).choices);
}

export function sanitizeConversationTitle(raw: string): string {
	let title = raw.replace(/\s+/g, " ").trim();
	title = stripWrappingPairs(title);
	title = title.replace(TRAILING_PUNCTUATION_PATTERN, "").trim();
	title = stripWrappingPairs(title);
	if (!title) return "";
	return Array.from(title).slice(0, TITLE_MAX_CHARS).join("").trim();
}

function buildTitlePrompt(userMessage: string, assistantMessage: string | undefined): string {
	const parts = [`\u7528\u6237\u9996\u6761\u6d88\u606f\uff1a\n${truncate(userMessage, USER_MESSAGE_LIMIT)}`];
	const trimmedAssistant = assistantMessage?.trim();
	if (trimmedAssistant) {
		parts.push(`\u52a9\u624b\u56de\u590d\uff1a\n${truncate(trimmedAssistant, ASSISTANT_MESSAGE_LIMIT)}`);
	}
	return parts.join("\n\n");
}

function truncate(text: string, maxChars: number): string {
	return Array.from(text).slice(0, maxChars).join("");
}

function extractTitleContent(payload: unknown): string {
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
	let title = text.trim();
	let changed = true;
	while (changed && title.length >= 2) {
		changed = false;
		for (const [left, right] of WRAPPING_PAIRS) {
			if (title.startsWith(left) && title.endsWith(right)) {
				title = title.slice(left.length, title.length - right.length).trim();
				changed = true;
				break;
			}
		}
	}
	return title;
}

const TRAILING_PUNCTUATION_PATTERN =
	/[\u3002\uff0e.!?\uff01\uff1f,\uff0c\u3001;\uff1b:\uff1a|\uff5c/\\\-_~\uff5e"'`\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\u300a\u300b\u3010\u3011()\uff08\uff09[\]{}]+$/u;

const WRAPPING_PAIRS: ReadonlyArray<readonly [string, string]> = [
	['"', '"'],
	["'", "'"],
	["`", "`"],
	["\u201c", "\u201d"],
	["\u2018", "\u2019"],
	["\u300c", "\u300d"],
	["\u300e", "\u300f"],
	["\u300a", "\u300b"],
	["\u3010", "\u3011"],
	["(", ")"],
	["\uff08", "\uff09"],
];
