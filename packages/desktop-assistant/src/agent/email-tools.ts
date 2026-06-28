import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appToolResult, type ExternalAppToolHost } from "./app-bridge-tools.ts";

/**
 * High-frequency convenience tools for the Email-manager app (邮箱管家). They wrap
 * its FastAPI `/api/v1` endpoints so the model doesn't have to hand-craft app_call
 * requests for the common flows (验证码 / 最新邮件 / 账号列表). Anything not covered
 * here is still reachable via the generic app_call tool. See app-bridge-tools.ts.
 */

const EMAIL_APP_ID = "email-manager";
const MAX_RESPONSE_CHARS = 8_000;

export const EMAIL_TOOL_NAMES = [
	"email_list_accounts",
	"email_latest_mail",
	"email_message_detail",
	"email_verification_code",
] as const;

const EMAIL_GUIDELINES = [
	"邮箱账号用数字 id 标识；不确定 id 时先用 email_list_accounts 列出账号。",
	"接收验证码时优先用 email_verification_code（默认刷新拉取最新）；需要更早邮件再用 email_latest_mail。",
	"总结邮件：先用 email_latest_mail 取列表、必要时用 email_message_detail 取正文，再自行归纳，不要编造内容。",
];

async function emailGet(
	host: ExternalAppToolHost,
	path: string,
	query?: Record<string, string>,
): Promise<{ ok: boolean; status: number; text: string }> {
	const { baseUrl, manifest } = await host.ensureRunning(EMAIL_APP_ID);
	const base = manifest.ai?.basePath ?? "/api/v1";
	const url = new URL(`${baseUrl}${base}${path}`);
	for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
	const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
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
	path: string,
	query?: Record<string, string>,
) {
	return emailGet(host, path, query)
		.then((result) =>
			appToolResult(intent, toolTarget, result.ok, result.text, result.ok ? undefined : `HTTP ${result.status}`),
		)
		.catch((error: unknown) =>
			appToolResult(intent, toolTarget, false, undefined, error instanceof Error ? error.message : String(error)),
		);
}

export function createEmailToolDefinitions(host: ExternalAppToolHost): ToolDefinition[] {
	return [
		defineTool({
			name: "email_list_accounts",
			label: "List email accounts",
			description: "List the configured email accounts (mailboxes), with id, address, group and token status.",
			promptSnippet: "List the user's managed email accounts so you can pick the right mailbox id.",
			promptGuidelines: EMAIL_GUIDELINES,
			parameters: Type.Object({
				search: Type.Optional(Type.String({ description: "Filter by email / notes substring." })),
			}),
			execute: async (_id, params) =>
				run(
					host,
					"List email accounts",
					"mailboxes",
					"/mailboxes",
					params.search ? { search: params.search } : undefined,
				),
		}),
		defineTool({
			name: "email_latest_mail",
			label: "Latest mail",
			description:
				"Fetch the latest messages of a mailbox (inbox by default), returning folders + recent message list with subject, sender, preview and time.",
			promptSnippet: "Read a mailbox's most recent emails (to summarize or to find something).",
			promptGuidelines: EMAIL_GUIDELINES,
			parameters: Type.Object({
				mailboxId: Type.Number({ description: "Mailbox numeric id (from email_list_accounts)." }),
				limit: Type.Optional(Type.Number({ description: "How many recent messages, 1–50. Default 20." })),
			}),
			execute: async (_id, params) =>
				run(
					host,
					"Latest mail",
					`mailbox ${params.mailboxId}`,
					`/mailboxes/${params.mailboxId}/mail-viewer-bootstrap`,
					{
						limit: String(Math.max(1, Math.min(50, params.limit ?? 20))),
					},
				),
		}),
		defineTool({
			name: "email_message_detail",
			label: "Email detail",
			description: "Fetch the full detail (including body text) of a single message in a mailbox.",
			promptSnippet: "Read the full body of a specific email.",
			promptGuidelines: EMAIL_GUIDELINES,
			parameters: Type.Object({
				mailboxId: Type.Number({ description: "Mailbox numeric id." }),
				messageId: Type.String({ description: "Message id from email_latest_mail." }),
			}),
			execute: async (_id, params) =>
				run(host, "Email detail", `mailbox ${params.mailboxId}`, `/mailboxes/${params.mailboxId}/message-detail`, {
					message_id: params.messageId,
				}),
		}),
		defineTool({
			name: "email_verification_code",
			label: "Verification code",
			description:
				"Get the latest ChatGPT verification code (password-reset or login) for an email address. Refreshes from the server by default.",
			promptSnippet: "Fetch a one-time verification code that just arrived in an inbox.",
			promptGuidelines: EMAIL_GUIDELINES,
			parameters: Type.Object({
				email: Type.String({ description: "The email address to look up." }),
				codeType: Type.Optional(
					Type.Union([Type.Literal("reset"), Type.Literal("login")], {
						description: "Which code to fetch. Default 'reset'.",
					}),
				),
			}),
			execute: async (_id, params) => {
				const kind = params.codeType === "login" ? "chatgpt-login-code" : "chatgpt-reset-code";
				return run(
					host,
					"Verification code",
					params.email,
					`/mailboxes/by-email/${encodeURIComponent(params.email)}/${kind}`,
					{ refresh: "true" },
				);
			},
		}),
	];
}
