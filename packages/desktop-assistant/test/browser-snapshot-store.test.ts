import { describe, expect, it } from "vitest";
import { BrowserSnapshotStore } from "../src/agent/browser-snapshot-store.ts";

describe("BrowserSnapshotStore", () => {
	it("creates snapshot references and reads summary by default without html", () => {
		const store = new BrowserSnapshotStore();
		const snapshot = store.create({
			toolName: "mcp_browser_read_page",
			action: "read_page",
			url: "https://example.test",
			title: "Example",
			stdout: JSON.stringify({
				title: "Example",
				url: "https://example.test",
				text: "Visible page text",
				html: "<main>Visible page text</main>",
				links: [{ text: "Home", href: "/" }],
			}),
			raw: {},
		});

		const reference = store.toReference(snapshot);
		const read = store.read({ snapshotId: snapshot.id });

		expect(reference.snapshotId).toBe(snapshot.id);
		expect(reference.summary).toContain("Visible page text");
		expect(read.ok).toBe(true);
		expect(read.summary).toContain("Visible page text");
		expect(JSON.stringify(read)).not.toContain("<main>");
	});

	it("detects unchanged snapshots for the same page", () => {
		const store = new BrowserSnapshotStore();
		const first = store.create({
			toolName: "mcp_browser_read_page",
			action: "read_page",
			url: "https://example.test",
			stdout: JSON.stringify({ text: "same page" }),
			raw: {},
		});
		const second = store.create({
			toolName: "mcp_browser_read_page",
			action: "read_page",
			url: "https://example.test",
			stdout: JSON.stringify({ text: "same page" }),
			raw: {},
		});

		expect(second.previousSnapshotId).toBe(first.id);
		expect(second.unchanged).toBe(true);
		expect(second.changeSummary).toContain("unchanged");
	});

	it("returns selected fields and structured unknown id errors", () => {
		const store = new BrowserSnapshotStore();
		const snapshot = store.create({
			toolName: "mcp_browser_read_page",
			action: "read_page",
			url: "https://example.test",
			stdout: JSON.stringify({
				text: "a".repeat(2000),
				html: "<main>full</main>",
				forms: [{ id: "login" }],
			}),
			raw: {},
		});

		const read = store.read({ snapshotId: snapshot.id, fields: ["text", "forms"], maxTextLength: 500 });
		const missing = store.read({ snapshotId: "missing" });

		expect(read.fields?.text).toContain("[truncated");
		expect(read.fields?.forms).toEqual([{ id: "login" }]);
		expect(missing.ok).toBe(false);
		expect(missing.error).toContain("Unknown");
	});

	it("extracts actionable elements from nested MCP text payloads", () => {
		const store = new BrowserSnapshotStore();
		const snapshot = store.create({
			toolName: "mcp_browser_read_page",
			action: "read_page",
			url: "https://example.test/task",
			stdout: JSON.stringify({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							text: "Question area",
							elements: [
								{ role: "button", text: "提交", selector: "button.submit" },
								{ role: "button", text: "关闭", selector: "button.close" },
							],
						}),
					},
				],
			}),
			raw: {},
		});

		const reference = store.toReference(snapshot);
		const read = store.read({ snapshotId: snapshot.id, fields: ["interactive"] });

		expect(reference.summary).toContain("Actionable elements");
		expect(reference.summary).toContain("提交");
		expect(read.fields?.interactive).toEqual([
			{ role: "button", text: "提交", selector: "button.submit" },
			{ role: "button", text: "关闭", selector: "button.close" },
		]);
	});
});
