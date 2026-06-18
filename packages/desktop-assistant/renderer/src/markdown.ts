import { marked, Renderer, type Tokens } from "marked";

export type MarkdownNode =
	| { type: "html"; html: string }
	| { type: "codeblock"; code: string; language: string }
	| { type: "table"; html: string; markdown: string; tsv: string };

interface MarkedHtmlToken {
	text: string;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
	return escapeHtml(value).replaceAll("`", "&#96;");
}

function normalizeFenceLanguage(raw: string): string {
	return raw.trim().toLowerCase().replace(/[^a-z0-9_+-]/g, "").slice(0, 32);
}

function isSafeHref(href: string): boolean {
	const normalized = href.trim().toLowerCase();
	return (
		normalized.startsWith("http://") ||
		normalized.startsWith("https://") ||
		normalized.startsWith("mailto:") ||
		normalized.startsWith("tel:")
	);
}

function generateTsv(token: Tokens.Table): string {
	const headerRow = token.header
		.map((cell) => cell.text.replace(/[\t\n\r]/g, " "))
		.join("\t");
	const dataRows = token.rows.map((row) =>
		row.map((cell) => cell.text.replace(/[\t\n\r]/g, " ")).join("\t"),
	);
	return [headerRow, ...dataRows].join("\n");
}

function renderTableHtml(markdown: string): string {
	const renderer = new Renderer();
	renderer.html = (token: MarkedHtmlToken) => escapeHtml(token.text);
	renderer.image = (token: { text?: string }) =>
		`<span>${escapeHtml(token.text || "")}</span>`;
	const html = marked.parse(markdown, {
		async: false,
		gfm: true,
		breaks: true,
		renderer,
	}) as string;
	return sanitizeRenderedHtml(
		html.replace(/<table>/g, '<table class="md-table">'),
	);
}

function renderMarkdownSegment(text: string): string {
	const renderer = new Renderer();
	renderer.html = (token: MarkedHtmlToken) => escapeHtml(token.text);
	renderer.image = (token: { text?: string }) =>
		`<span>${escapeHtml(token.text || "")}</span>`;

	const html = marked.parse(text, {
		async: false,
		gfm: true,
		breaks: true,
		renderer,
	}) as string;

	// Safety net: if any table slips through, wrap it. Should not trigger
	// now that tables are extracted before this function is called.
	return html
		.replace(/<table>/g, '<div class="md-table-wrapper"><table class="md-table">')
		.replace(/<\/table>/g, "</table></div>");
}

function sanitizeRenderedHtml(html: string): string {
	return html
		.replace(/<a\s+([^>]*?)href="([^"]*)"([^>]*)>/gi, (_full, before, href, after) => {
			if (!isSafeHref(href)) {
				return `<span ${before}${after}>`;
			}
			return `<a ${before}href="${escapeAttribute(href)}"${after} target="_blank" rel="noreferrer noopener">`;
		})
		.replace(/<\/a>/gi, "</a>");
}

type RawToken =
	| { type: "markdown"; content: string }
	| { type: "code"; code: string; language: string }
	| { type: "table"; raw: string; tsv: string };

function extractFromSegment(text: string, out: RawToken[]): void {
	const lexed = marked.lexer(text, { gfm: true });
	let mdBuffer = "";
	for (const token of lexed) {
		if (token.type === "table") {
			if (mdBuffer.trim()) {
				out.push({ type: "markdown", content: mdBuffer });
				mdBuffer = "";
			}
			out.push({
				type: "table",
				raw: token.raw,
				tsv: generateTsv(token as Tokens.Table),
			});
		} else {
			mdBuffer += ((token as unknown) as { raw?: string }).raw ?? "";
		}
	}
	if (mdBuffer.trim()) {
		out.push({ type: "markdown", content: mdBuffer });
	}
}

function tokenizeMarkdown(text: string): RawToken[] {
	const tokens: RawToken[] = [];
	const fenceRegex = /```([^\n`]*)\n([\s\S]*?)```/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null = fenceRegex.exec(text);
	while (match) {
		if (match.index > lastIndex) {
			extractFromSegment(text.slice(lastIndex, match.index), tokens);
		}
		tokens.push({
			type: "code",
			language: normalizeFenceLanguage(match[1] ?? ""),
			code: match[2] ?? "",
		});
		lastIndex = match.index + match[0].length;
		match = fenceRegex.exec(text);
	}
	if (lastIndex < text.length) {
		extractFromSegment(text.slice(lastIndex), tokens);
	}
	return tokens;
}

export function renderAssistantMarkdown(text: string): MarkdownNode[] {
	const tokens = tokenizeMarkdown(text);
	const nodes: MarkdownNode[] = [];
	for (const token of tokens) {
		if (token.type === "code") {
			nodes.push({
				type: "codeblock",
				code: token.code.replace(/\n$/, ""),
				language: token.language,
			});
		} else if (token.type === "table") {
			nodes.push({
				type: "table",
				html: renderTableHtml(token.raw),
				markdown: token.raw,
				tsv: token.tsv,
			});
		} else {
			const content = token.content.trim();
			if (!content) continue;
			nodes.push({
				type: "html",
				html: sanitizeRenderedHtml(renderMarkdownSegment(content)),
			});
		}
	}
	return nodes;
}
