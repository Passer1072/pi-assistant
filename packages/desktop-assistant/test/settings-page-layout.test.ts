import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesPath = fileURLToPath(new URL("../renderer/src/styles.css", import.meta.url));

function selectorBlockIncludes(styles: string, selector: string, declaration: string): boolean {
	const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const blockPattern = new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`, "g");
	return [...styles.matchAll(blockPattern)].some((match) => match[0].includes(declaration));
}

describe("settings page layout styles", () => {
	it("keeps settings overlays opaque so underlying chat content cannot bleed through", () => {
		const styles = readFileSync(stylesPath, "utf-8");

		expect(selectorBlockIncludes(styles, ".overlay-page", "background: var(--bg-glass);")).toBe(true);
		expect(selectorBlockIncludes(styles, ".settings-screen", "background: var(--bg-glass);")).toBe(true);
		expect(selectorBlockIncludes(styles, ".overlay-page", "overflow: hidden;")).toBe(true);
	});

	it("keeps settings entry buttons wide enough for their labels", () => {
		const styles = readFileSync(stylesPath, "utf-8");

		expect(selectorBlockIncludes(styles, ".primary-btn", "white-space: nowrap;")).toBe(true);
		expect(
			selectorBlockIncludes(styles, ".mcp-entry-row", "grid-template-columns: minmax(0, 1fr) max-content;"),
		).toBe(true);
		expect(selectorBlockIncludes(styles, ".mcp-entry-row > .primary-btn", "min-width: max-content;")).toBe(true);
	});
});
