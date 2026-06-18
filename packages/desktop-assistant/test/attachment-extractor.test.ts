import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAttachmentPromptBlock } from "../src/agent/attachment-extractor.ts";
import type { DesktopAutomationHost, PowerShellResult } from "../src/desktop/automation-host.ts";
import { DryRunDesktopAutomationHost } from "../src/desktop/automation-host.ts";
import type { PendingPromptAttachment } from "../src/shared/types.ts";

describe("attachment extractor", () => {
	it("injects readable text files as attachment snapshots", async () => {
		const workspace = createTempWorkspace();
		try {
			const filePath = join(workspace, "notes.md");
			writeFileSync(filePath, "# Plan\n\nKeep formatting signals.", "utf-8");

			const block = await buildAttachmentPromptBlock(
				[
					{
						id: "a1",
						name: "notes.md",
						path: filePath,
						sizeBytes: 31,
						kind: "text",
					},
				],
				new DryRunDesktopAutomationHost(),
			);

			expect(block).toContain('<attachments count="1">');
			expect(block).toContain('type="text"');
			expect(block).toContain("# Plan");
			expect(block).toContain("Plain text attachment");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("formats Word COM snapshots with markdown and structured JSON", async () => {
		const workspace = createTempWorkspace();
		try {
			const filePath = join(workspace, "brief.docx");
			writeFileSync(filePath, "fake docx");
			const host = hostReturning({
				markdown: "# Title [page=1 style=Heading 1 align=center]",
				outline: ["Title"],
				content: {
					pageCount: 1,
					paragraphs: [
						{
							text: "Title",
							styleName: "Heading 1",
							characterFormat: { fontName: "Aptos", fontSize: 16, bold: true },
						},
					],
				},
				formatNotes: ["pages=1 sections=1"],
				truncated: false,
			});

			const block = await buildAttachmentPromptBlock([attachment(filePath, "word")], host);

			expect(block).toContain('type="word"');
			expect(block).toContain("# Title [page=1 style=Heading 1 align=center]");
			expect(block).toContain('"styleName": "Heading 1"');
			expect(block).toContain('"bold": true');
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("formats Excel COM snapshots with formulas and merge notes", async () => {
		const workspace = createTempWorkspace();
		try {
			const filePath = join(workspace, "budget.xlsx");
			writeFileSync(filePath, "fake xlsx");
			const host = hostReturning({
				markdown: "## Sheet: Budget [usedRange=A1:C3 visible=-1]\n| Item | Total |\n| --- | --- |\n| Cloud | 42 |",
				outline: ["Sheet 'Budget': UsedRange=A1:C3 rows=3 cols=2 visible=-1"],
				content: {
					sheetCount: 1,
					sheets: [
						{
							name: "Budget",
							formulas: ["B2=SUM(B3:B9)"],
							mergedAreas: ["A1:C1"],
							highlightedCells: ["A1 text='Budget' bold=True fill=65535"],
						},
					],
				},
				formatNotes: ["Sheet 'Budget' formulas: B2=SUM(B3:B9)", "Sheet 'Budget' merged areas: A1:C1"],
				truncated: false,
			});

			const block = await buildAttachmentPromptBlock([attachment(filePath, "excel")], host);

			expect(block).toContain('type="excel"');
			expect(block).toContain("## Sheet: Budget");
			expect(block).toContain("B2=SUM(B3:B9)");
			expect(block).toContain("A1:C1");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("keeps failed attachment extraction in the prompt instead of blocking the message", async () => {
		const workspace = createTempWorkspace();
		try {
			const filePath = join(workspace, "broken.docx");
			writeFileSync(filePath, "fake docx");
			const host = hostReturning({ stderr: "Word is not installed." });

			const block = await buildAttachmentPromptBlock([attachment(filePath, "word")], host);

			expect(block).toContain("Attachment extraction failed");
			expect(block).toContain("Word is not installed.");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});

function createTempWorkspace(): string {
	return mkdtempSync(join(tmpdir(), "desktop-attachments-"));
}

function attachment(path: string, kind: PendingPromptAttachment["kind"]): PendingPromptAttachment {
	return {
		id: "attachment-1",
		name: path.split(/[\\/]/).pop() ?? path,
		path,
		sizeBytes: 9,
		kind,
	};
}

function hostReturning(payloadOrResult: Record<string, unknown> | { stderr: string }): DesktopAutomationHost {
	const host = new DryRunDesktopAutomationHost();
	return Object.assign(host, {
		runPowerShellManaged: async (): Promise<PowerShellResult> => {
			if ("stderr" in payloadOrResult && typeof payloadOrResult.stderr === "string") {
				return { stdout: "", stderr: payloadOrResult.stderr };
			}
			return { stdout: JSON.stringify(payloadOrResult), stderr: "" };
		},
	});
}
