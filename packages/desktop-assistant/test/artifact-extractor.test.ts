import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectArtifacts, extractArtifactCandidates, isProducerTool } from "../src/agent/artifact-extractor.ts";

function tempWorkspace(): string {
	return mkdtempSync(join(tmpdir(), "artifact-test-"));
}

/** A DesktopToolResult-shaped result as it arrives on tool_execution_end. */
function toolResult(target: string, stdout = ""): unknown {
	return {
		content: [{ type: "text", text: "ok" }],
		details: { intent: "Create file", action: "create", target, status: "succeeded", stdout },
	};
}

describe("isProducerTool", () => {
	it("flags writers and clears readers", () => {
		expect(isProducerTool("ppt_create")).toBe(true);
		expect(isProducerTool("excel_write")).toBe(true);
		expect(isProducerTool("doc_create_from_html")).toBe(true);
		expect(isProducerTool("office_word_run")).toBe(true);
		expect(isProducerTool("sandbox_export")).toBe(true);
		expect(isProducerTool("excel_read")).toBe(false);
		expect(isProducerTool("doc_inspect")).toBe(false);
		expect(isProducerTool("get_screen_context")).toBe(false);
	});
});

describe("extractArtifactCandidates", () => {
	it("pulls the output path from a producer tool's args and result", () => {
		const candidates = extractArtifactCandidates(
			"ppt_create",
			{ path: "C:\\out\\deck.pptx", slides: [] },
			toolResult("C:\\out\\deck.pptx"),
		);
		expect(candidates.some((c) => c.path === "C:\\out\\deck.pptx" && c.producer)).toBe(true);
	});

	it("marks non-producer tool paths so they need freshness", () => {
		const candidates = extractArtifactCandidates(
			"excel_read",
			{ path: "C:\\in\\data.xlsx" },
			toolResult("C:\\in\\data.xlsx"),
		);
		expect(candidates.length).toBeGreaterThan(0);
		expect(candidates.every((c) => !c.producer)).toBe(true);
	});
});

describe("collectArtifacts", () => {
	it("surfaces a producer tool's freshly written file", () => {
		const dir = tempWorkspace();
		try {
			const file = join(dir, "图片转excel输出表.xlsx");
			writeFileSync(file, "x");
			const turnStart = Date.now() - 1000;
			const artifacts = collectArtifacts("excel_write", { path: file }, toolResult(file), { since: turnStart });
			expect(artifacts).toHaveLength(1);
			expect(artifacts[0].name).toBe("图片转excel输出表.xlsx");
			expect(artifacts[0].ext).toBe("xlsx");
			expect(artifacts[0].isDirectory).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips a file a read tool merely opened (old mtime, non-producer)", () => {
		const dir = tempWorkspace();
		try {
			const file = join(dir, "input.xlsx");
			writeFileSync(file, "x");
			const old = new Date(Date.now() - 60 * 60 * 1000);
			utimesSync(file, old, old);
			const artifacts = collectArtifacts("excel_read", { path: file }, toolResult(file), { since: Date.now() });
			expect(artifacts).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("drops candidates that do not exist on disk", () => {
		const artifacts = collectArtifacts(
			"ppt_create",
			{ path: "C:\\nope\\missing.pptx" },
			toolResult("C:\\nope\\missing.pptx"),
			{
				since: Date.now() - 1000,
			},
		);
		expect(artifacts).toHaveLength(0);
	});

	it("keeps producer outputs on history reload (no `since`)", () => {
		const dir = tempWorkspace();
		try {
			const file = join(dir, "report.docx");
			writeFileSync(file, "x");
			const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
			utimesSync(file, old, old);
			// No `since` → freshness can't be checked; producer outputs survive, readers don't.
			expect(collectArtifacts("doc_create_from_html", { path: file }, toolResult(file))).toHaveLength(1);
			expect(collectArtifacts("doc_read", { path: file }, toolResult(file))).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
