import { Check, Copy } from "lucide-react";
import React, { memo, useMemo, useState } from "react";
import { type MarkdownNode, renderAssistantMarkdown } from "./markdown.ts";

async function copyToClipboard(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}

	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "true");
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	textarea.style.pointerEvents = "none";
	document.body.appendChild(textarea);
	textarea.focus();
	textarea.select();

	try {
		document.execCommand("copy");
	} finally {
		document.body.removeChild(textarea);
	}
}

function AssistantMessageMarkdownComponent({ text }: { text: string }) {
	const [copiedKey, setCopiedKey] = useState<string | null>(null);
	const nodes = useMemo<MarkdownNode[]>(() => renderAssistantMarkdown(text), [text]);

	async function copyAndMark(content: string, key: string) {
		await copyToClipboard(content);
		setCopiedKey(key);
		window.setTimeout(() => {
			setCopiedKey((current) => (current === key ? null : current));
		}, 1200);
	}

	return (
		<div className="assistant-markdown">
			{nodes.map((node, index) => {
				if (node.type === "html") {
					return <div key={`html-${index}`} dangerouslySetInnerHTML={{ __html: node.html }} />;
				}

				if (node.type === "table") {
					const mdKey = `table-${index}-md`;
					const tsvKey = `table-${index}-tsv`;
					return (
						<div className="table-block" key={`table-${index}`}>
							<div className="table-block-head">
								<span className="table-block-label">表格</span>
								<div className="table-copy-btns">
									<button
										type="button"
										className="assistant-copy-btn"
										title="复制为 Markdown 格式"
										onClick={() => copyAndMark(node.markdown, mdKey)}
									>
										{copiedKey === mdKey ? <Check size={13} /> : <Copy size={13} />}
										<span>{copiedKey === mdKey ? "已复制" : "Markdown"}</span>
									</button>
									<button
										type="button"
										className="assistant-copy-btn"
										title="复制为 TSV（可粘贴到 Excel / WPS）"
										onClick={() => copyAndMark(node.tsv, tsvKey)}
									>
										{copiedKey === tsvKey ? <Check size={13} /> : <Copy size={13} />}
										<span>{copiedKey === tsvKey ? "已复制" : "TSV"}</span>
									</button>
								</div>
							</div>
							<div className="md-table-wrapper" dangerouslySetInnerHTML={{ __html: node.html }} />
						</div>
					);
				}

				// codeblock
				const copyKey = `${index}:${node.language}:${node.code}`;
				const copied = copiedKey === copyKey;
				return (
					<div className="assistant-code-block" key={copyKey}>
						<div className="assistant-code-head">
							<span>{node.language || "text"}</span>
							<button
								type="button"
								className="assistant-copy-btn"
								onClick={() => copyAndMark(node.code, copyKey)}
							>
								{copied ? <Check size={13} /> : <Copy size={13} />}
								<span>{copied ? "已复制" : "复制代码"}</span>
							</button>
						</div>
						<pre>
							<code>{node.code}</code>
						</pre>
					</div>
				);
			})}
		</div>
	);
}

export const AssistantMessageMarkdown = memo(AssistantMessageMarkdownComponent);
