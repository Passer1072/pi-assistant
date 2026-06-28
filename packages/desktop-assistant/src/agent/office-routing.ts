import type { AiOfficePreference } from "../shared/types.ts";

export function buildOfficeRoutingAppendPrompt(preference: AiOfficePreference = "auto"): string {
	const live =
		"Live Office add-in MCP tools mcp_word_* / mcp_xlive_* / mcp_pptlive_* edit the user's currently open, visible Word/Excel/PowerPoint document directly, without file locks.";
	const ppt =
		"PowerPoint live add-ins are for lightweight edits only; use file-based mcp_pptx_* on a closed .pptx for complex layout, charts, themes, or animations.";
	const lines = ["<office_routing_policy>"];
	if (preference === "live") {
		lines.push(
			`The user prefers live Office collaboration: ${live}`,
			ppt,
			"Do not use hidden COM doc_*/excel_*/ppt_* tools or file-based mcp_xlsx_/mcp_pptx_ tools for the active open document.",
		);
	} else if (preference === "file") {
		lines.push(
			"The user prefers file-level Office work: use mcp_xlsx_*/mcp_pptx_* or COM tools for closed files. Live Office add-in tools are disabled in this session.",
		);
	} else {
		lines.push(
			`Two Office control surfaces may be available: ${live}`,
			"File-based mcp_xlsx_*/mcp_pptx_* tools edit closed files.",
			"Use live tools when the user has the document open and wants visible real-time editing; otherwise use file-based tools. Pick one surface and do not switch needlessly.",
			ppt,
		);
	}
	lines.push("</office_routing_policy>");
	return lines.join("\n");
}
