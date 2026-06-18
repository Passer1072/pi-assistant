import { describe, expect, it } from "vitest";
import { renderAssistantMarkdown } from "../renderer/src/markdown.ts";

describe("assistant markdown rendering", () => {
	it("splits fenced code blocks into dedicated nodes", () => {
		const nodes = renderAssistantMarkdown("前言\n```ts\nconst x = 1;\n```\n结尾");

		expect(nodes.some((node) => node.type === "codeblock")).toBe(true);
		expect(nodes.find((node) => node.type === "codeblock")).toMatchObject({
			type: "codeblock",
			language: "ts",
			code: "const x = 1;",
		});
	});

	it("keeps unsafe links from rendering as clickable anchors", () => {
		const nodes = renderAssistantMarkdown("[bad](javascript:alert(1))");
		const htmlNode = nodes.find((node) => node.type === "html");

		expect(htmlNode?.type).toBe("html");
		expect(htmlNode?.html.includes('href="javascript:alert(1)"')).toBe(false);
	});

	it("escapes raw html instead of rendering it directly", () => {
		const nodes = renderAssistantMarkdown('<script>alert("xss")</script><div>safe?</div>');
		const htmlNode = nodes.find((node) => node.type === "html");

		expect(htmlNode?.type).toBe("html");
		expect(htmlNode?.html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
		expect(htmlNode?.html).toContain("&lt;div&gt;safe?&lt;/div&gt;");
		expect(htmlNode?.html).not.toContain("<script>");
		expect(htmlNode?.html).not.toContain("<div>safe?</div>");
	});

	it("renders gfm tables as dedicated table nodes with html, markdown, and tsv", () => {
		const nodes = renderAssistantMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |");
		const tableNode = nodes.find((node) => node.type === "table");

		expect(tableNode?.type).toBe("table");
		expect(tableNode?.html).toContain("<table");
		expect(tableNode?.html).toContain("<thead>");
		expect(tableNode?.html).toContain("<tbody>");
		expect(tableNode?.markdown).toContain("| A | B |");
		expect(tableNode?.tsv).toBe("A\tB\n1\t2");
	});
});
