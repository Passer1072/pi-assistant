import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, type Stats, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { DesktopAutomationHost } from "../desktop/automation-host.ts";
import { isTimeout } from "../desktop/automation-host.ts";
import type { AttachmentDocumentSnapshot, PendingPromptAttachment, PromptAttachmentKind } from "../shared/types.ts";

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 30 * 1024 * 1024;
const MAX_TEXT_CHARS = 80_000;
const MAX_ATTACHMENT_BLOCK_CHARS = 220_000;
const WORD_EXTRACTION_TIMEOUT_MS = 45_000;
const EXCEL_EXTRACTION_TIMEOUT_MS = 45_000;

const TEXT_EXTENSIONS = new Set([
	".txt",
	".md",
	".markdown",
	".json",
	".jsonl",
	".csv",
	".tsv",
	".log",
	".xml",
	".html",
	".htm",
	".css",
	".js",
	".jsx",
	".ts",
	".tsx",
	".py",
	".ps1",
	".bat",
	".cmd",
	".yaml",
	".yml",
	".toml",
	".ini",
]);

export async function buildAttachmentPromptBlock(
	attachments: PendingPromptAttachment[] | undefined,
	host: DesktopAutomationHost,
): Promise<string> {
	const normalized = normalizeAttachments(attachments);
	if (normalized.length === 0) return "";

	let totalBytes = 0;
	const snapshots: AttachmentDocumentSnapshot[] = [];
	for (const attachment of normalized.slice(0, MAX_ATTACHMENTS)) {
		totalBytes += attachment.sizeBytes;
		if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
			snapshots.push(createErrorSnapshot(attachment, "Skipped: total attachment size limit exceeded."));
			continue;
		}
		snapshots.push(await extractAttachmentSnapshot(attachment, host));
	}

	return [
		`<attachments count="${snapshots.length}">`,
		...snapshots.map((snapshot, index) => formatAttachmentSnapshot(snapshot, index + 1)),
		"</attachments>",
	].join("\n");
}

export function createPromptAttachmentFromPath(path: string): PendingPromptAttachment {
	const details = statSync(path);
	return {
		id: randomUUID(),
		name: basename(path),
		path,
		sizeBytes: details.size,
		kind: inferAttachmentKind(path),
	};
}

export async function extractAttachmentSnapshot(
	attachment: PendingPromptAttachment,
	host: DesktopAutomationHost,
): Promise<AttachmentDocumentSnapshot> {
	const kind = attachment.kind ?? inferAttachmentKind(attachment.path);
	if (!existsSync(attachment.path)) {
		return createErrorSnapshot({ ...attachment, kind }, "File not found.");
	}

	let details: Stats;
	try {
		details = statSync(attachment.path);
	} catch (error) {
		return createErrorSnapshot({ ...attachment, kind }, errorMessage(error));
	}

	if (!details.isFile()) {
		return createErrorSnapshot({ ...attachment, kind }, "Attachment path is not a file.");
	}
	if (details.size > MAX_ATTACHMENT_BYTES) {
		return createErrorSnapshot(
			{ ...attachment, kind, sizeBytes: details.size },
			`Skipped: file is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
		);
	}

	const normalized = {
		...attachment,
		kind,
		name: attachment.name || basename(attachment.path),
		sizeBytes: details.size,
	};

	try {
		if (kind === "word") return await extractWordSnapshot(normalized, host);
		if (kind === "excel") return await extractExcelSnapshot(normalized, host);
		if (kind === "text") return extractTextSnapshot(normalized);
		return createUnsupportedSnapshot(normalized);
	} catch (error) {
		return createErrorSnapshot(normalized, errorMessage(error));
	}
}

export function formatAttachmentSnapshot(snapshot: AttachmentDocumentSnapshot, index: number): string {
	const metadata = snapshot.metadata;
	const json = truncateForPrompt(
		JSON.stringify(
			{
				metadata,
				outline: snapshot.outline,
				content: snapshot.content,
				formatNotes: snapshot.formatNotes,
			},
			null,
			2,
		),
		MAX_ATTACHMENT_BLOCK_CHARS,
	).text;

	return [
		`<attachment index="${index}" name="${escapeXmlAttribute(metadata.name)}" type="${metadata.kind}">`,
		"## Metadata",
		`- path: ${metadata.path}`,
		`- size: ${formatBytes(metadata.sizeBytes)}`,
		`- extractedAt: ${metadata.extractedAt}`,
		`- truncated: ${metadata.truncated}`,
		metadata.error ? `- error: ${metadata.error}` : undefined,
		"",
		"## Outline",
		snapshot.outline.length > 0 ? snapshot.outline.map((item) => `- ${item}`).join("\n") : "- (none)",
		"",
		"## Markdown View",
		snapshot.markdown || "(no readable markdown content)",
		"",
		"## Structured Snapshot JSON",
		"```json",
		json,
		"```",
		"</attachment>",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function normalizeAttachments(attachments: PendingPromptAttachment[] | undefined): PendingPromptAttachment[] {
	if (!attachments) return [];
	const seen = new Set<string>();
	const normalized: PendingPromptAttachment[] = [];
	for (const attachment of attachments) {
		const path = attachment.path.trim();
		if (!path || seen.has(path)) continue;
		seen.add(path);
		normalized.push({
			...attachment,
			id: attachment.id || randomUUID(),
			name: attachment.name || basename(path),
			path,
			kind: attachment.kind ?? inferAttachmentKind(path),
		});
	}
	return normalized;
}

function inferAttachmentKind(path: string): PromptAttachmentKind {
	const extension = extname(path).toLowerCase();
	if (TEXT_EXTENSIONS.has(extension)) return "text";
	if (extension === ".docx" || extension === ".doc") return "word";
	if (extension === ".xlsx" || extension === ".xls" || extension === ".xlsm") return "excel";
	if (extension === ".pptx" || extension === ".ppt") return "powerpoint";
	if (extension === ".pdf") return "pdf";
	if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(extension)) return "image";
	return "unknown";
}

function extractTextSnapshot(attachment: PendingPromptAttachment): AttachmentDocumentSnapshot {
	let content = readFileSync(attachment.path, "utf-8");
	const truncated = content.length > MAX_TEXT_CHARS;
	if (truncated) content = `${content.slice(0, MAX_TEXT_CHARS)}\n[truncated: text attachment exceeds limit]`;
	return {
		metadata: createMetadata(attachment, truncated),
		outline: [`Text file with ${content.split(/\r?\n/).length} readable lines.`],
		content: {
			format: "plain_text",
			text: content,
		},
		formatNotes: ["Plain text attachment; no document layout metadata is available."],
		markdown: ["```text", content, "```"].join("\n"),
	};
}

async function extractWordSnapshot(
	attachment: PendingPromptAttachment,
	host: DesktopAutomationHost,
): Promise<AttachmentDocumentSnapshot> {
	const result = await host.runPowerShellManaged(buildWordSnapshotScript(attachment.path), WORD_EXTRACTION_TIMEOUT_MS);
	if (isTimeout(result)) {
		return createErrorSnapshot(
			attachment,
			`Timed out while extracting Word structure after ${result.elapsedSeconds}s.`,
		);
	}
	if (result.stderr.trim()) {
		return createErrorSnapshot(attachment, result.stderr.trim());
	}
	const payload = parseJsonObject(result.stdout);
	return {
		metadata: createMetadata(attachment, Boolean(payload.truncated)),
		outline: asStringArray(payload.outline),
		content: payload.content ?? payload,
		formatNotes: asStringArray(payload.formatNotes),
		markdown: String(payload.markdown ?? ""),
	};
}

async function extractExcelSnapshot(
	attachment: PendingPromptAttachment,
	host: DesktopAutomationHost,
): Promise<AttachmentDocumentSnapshot> {
	const result = await host.runPowerShellManaged(
		buildExcelSnapshotScript(attachment.path),
		EXCEL_EXTRACTION_TIMEOUT_MS,
	);
	if (isTimeout(result)) {
		return createErrorSnapshot(
			attachment,
			`Timed out while extracting Excel structure after ${result.elapsedSeconds}s.`,
		);
	}
	if (result.stderr.trim()) {
		return createErrorSnapshot(attachment, result.stderr.trim());
	}
	const payload = parseJsonObject(result.stdout);
	return {
		metadata: createMetadata(attachment, Boolean(payload.truncated)),
		outline: asStringArray(payload.outline),
		content: payload.content ?? payload,
		formatNotes: asStringArray(payload.formatNotes),
		markdown: String(payload.markdown ?? ""),
	};
}

function createUnsupportedSnapshot(attachment: PendingPromptAttachment): AttachmentDocumentSnapshot {
	const kind = attachment.kind ?? inferAttachmentKind(attachment.path);
	const notes =
		kind === "image"
			? ["Image attachment detected. DeepSeek text chat does not receive image pixels in this app path."]
			: ["This attachment type is not structurally extracted in v1."];
	return {
		metadata: createMetadata({ ...attachment, kind }, false),
		outline: [`${kind} attachment included by path and metadata only.`],
		content: {
			path: attachment.path,
			kind,
			note: notes[0],
		},
		formatNotes: notes,
		markdown: `[${kind} attachment: ${attachment.name}]\nPath: ${attachment.path}\n${notes[0]}`,
	};
}

function createErrorSnapshot(attachment: PendingPromptAttachment, error: string): AttachmentDocumentSnapshot {
	const normalized = { ...attachment, kind: attachment.kind ?? inferAttachmentKind(attachment.path) };
	return {
		metadata: createMetadata(normalized, false, error),
		outline: [`Attachment could not be extracted: ${error}`],
		content: {
			path: normalized.path,
			error,
		},
		formatNotes: ["The model should treat this attachment as unavailable except for its path and metadata."],
		markdown: `[Attachment extraction failed: ${normalized.name}]\n${error}`,
	};
}

function createMetadata(attachment: PendingPromptAttachment, truncated: boolean, error?: string) {
	return {
		name: attachment.name || basename(attachment.path),
		path: attachment.path,
		sizeBytes: attachment.sizeBytes,
		kind: attachment.kind ?? inferAttachmentKind(attachment.path),
		extractedAt: new Date().toISOString(),
		truncated,
		error,
	};
}

function buildWordSnapshotScript(path: string): string {
	const pathEsc = escapePsString(path);
	return wrapComScript(
		"$Word = New-Object -ComObject Word.Application",
		"$Word.Visible = $false",
		"$Word.DisplayAlerts = 0",
		"$Word.Quit()",
		[
			`$path = '${pathEsc}'`,
			`if (-not (Test-Path -LiteralPath $path)) { throw "Document path not found: $path" }`,
			`$doc = $Word.Documents.Open($path, $false, $true)`,
			`try {`,
			`  $maxParagraphs = 350`,
			`  $maxTables = 30`,
			`  $outline = New-Object System.Collections.ArrayList`,
			`  $formatNotes = New-Object System.Collections.ArrayList`,
			`  $paragraphs = New-Object System.Collections.ArrayList`,
			`  $tables = New-Object System.Collections.ArrayList`,
			`  $markdownLines = New-Object System.Collections.ArrayList`,
			`  $truncated = $false`,
			`  $pageCount = 0`,
			`  try { $pageCount = [int]$doc.ComputeStatistics(2) } catch {}`,
			`  $sectionCount = [int]$doc.Sections.Count`,
			`  [void]$formatNotes.Add("pages=$pageCount sections=$sectionCount")`,
			`  $index = 0`,
			`  foreach ($para in $doc.Paragraphs) {`,
			`    if ($index -ge $maxParagraphs) { $truncated = $true; break }`,
			`    $text = ($para.Range.Text -replace '[\\r\\a]+$', '').TrimEnd()`,
			`    if (-not $text) { continue }`,
			`    $styleName = ''`,
			`    try { $styleName = [string]$para.Range.Style.NameLocal } catch { try { $styleName = [string]$para.Range.Style } catch {} }`,
			`    $outlineLevel = 0`,
			`    try { $outlineLevel = [int]$para.OutlineLevel } catch {}`,
			`    $kind = if ($styleName -match 'Heading|标题' -or ($outlineLevel -gt 0 -and $outlineLevel -lt 10)) { 'heading' } elseif ($styleName -match 'List|列表') { 'list' } else { 'paragraph' }`,
			// Snapshot is for reading; keep it to ~3 COM calls/paragraph (text + style + outline).
			// Per-paragraph font/indent/spacing/page reads were ~15 COM round-trips each and made
			// large documents time out, so they are dropped here.
			`    [void]$paragraphs.Add([pscustomobject]@{ index=$index; kind=$kind; text=$text; styleName=$styleName; outlineLevel=$outlineLevel })`,
			`    if ($kind -eq 'heading') {`,
			`      $level = if ($outlineLevel -gt 0 -and $outlineLevel -lt 10) { [Math]::Min($outlineLevel, 6) } else { 2 }`,
			`      [void]$markdownLines.Add(("#" * $level) + " " + $text)`,
			`      [void]$outline.Add($text)`,
			`    } elseif ($kind -eq 'list') {`,
			`      [void]$markdownLines.Add("- " + $text)`,
			`    } else {`,
			`      [void]$markdownLines.Add($text)`,
			`    }`,
			`    $index++`,
			`  }`,
			`  $tableIndex = 0`,
			`  foreach ($table in $doc.Tables) {`,
			`    if ($tableIndex -ge $maxTables) { $truncated = $true; break }`,
			`    $rows = 0; try { $rows = [int]$table.Rows.Count } catch {}`,
			`    $cols = 0; try { $cols = [int]$table.Columns.Count } catch {}`,
			// One COM call reads the whole table; Word separates cell text with BEL (chr 7)
			// in row-major order (merged cells appear once). Replaces the per-cell
			// $table.Cell($r,$c) loop (~5 COM calls each) and the O(n^2) Where-Object rebuild.
			`    $cellTexts = @(); try { $cellTexts = @($table.Range.Text -split ([char]7)) | ForEach-Object { ($_ -replace '[\\r\\a]+',' ').Trim() } } catch {}`,
			`    if ($cellTexts.Count -gt 0 -and $cellTexts[$cellTexts.Count-1] -eq '') { $cellTexts = @($cellTexts[0..($cellTexts.Count-2)]) }`,
			`    if ($cellTexts.Count -gt 1200) { $cellTexts = @($cellTexts[0..1199]); $truncated = $true }`,
			`    $uniform = ($rows -gt 0 -and $cols -gt 0 -and $cellTexts.Count -eq ($rows * $cols))`,
			`    $cells = New-Object System.Collections.ArrayList`,
			`    if ($uniform) {`,
			`      for ($r = 1; $r -le $rows; $r++) { for ($c = 1; $c -le $cols; $c++) { [void]$cells.Add([pscustomobject]@{ row=$r; col=$c; text=$cellTexts[(($r-1)*$cols)+($c-1)] }) } }`,
			`    } else {`,
			`      foreach ($t in $cellTexts) { [void]$cells.Add([pscustomobject]@{ row=0; col=0; text=$t }) }`,
			`    }`,
			`    [void]$tables.Add([pscustomobject]@{ index=$tableIndex; rows=$rows; cols=$cols; merged=(-not $uniform); cells=$cells })`,
			`    [void]$markdownLines.Add("")`,
			`    [void]$markdownLines.Add("### Table " + ($tableIndex + 1) + $(if (-not $uniform) { " (含合并单元格，按文档顺序列出)" } else { "" }))`,
			`    if ($uniform) {`,
			`      $hdr = @(); for ($c = 0; $c -lt $cols; $c++) { $hdr += ($cellTexts[$c] -replace '\\|','\\|') }`,
			`      [void]$markdownLines.Add("| " + ($hdr -join " | ") + " |")`,
			`      [void]$markdownLines.Add("| " + (($hdr | ForEach-Object { "---" }) -join " | ") + " |")`,
			`      for ($r = 2; $r -le $rows; $r++) { $rv = @(); for ($c = 0; $c -lt $cols; $c++) { $rv += ($cellTexts[(($r-1)*$cols)+$c] -replace '\\|','\\|') }; [void]$markdownLines.Add("| " + ($rv -join " | ") + " |") }`,
			`    } else {`,
			`      foreach ($t in $cellTexts) { if ($t) { [void]$markdownLines.Add("- " + ($t -replace '\\|','\\|')) } }`,
			`    }`,
			`    $tableIndex++`,
			`  }`,
			`  $headersFooters = New-Object System.Collections.ArrayList`,
			`  for ($sectionIndex = 1; $sectionIndex -le $doc.Sections.Count; $sectionIndex++) {`,
			`    $section = $doc.Sections.Item($sectionIndex)`,
			`    foreach ($pair in @(@{key='header'; collection=$section.Headers}, @{key='footer'; collection=$section.Footers})) {`,
			`      foreach ($variant in @(1,2,3)) {`,
			`        try { $item = $pair.collection.Item($variant); $text = ($item.Range.Text -replace '[\\r\\a]+$', '').TrimEnd(); if ($text) { [void]$headersFooters.Add([pscustomobject]@{ kind=$pair.key; sectionIndex=$sectionIndex; variant="$variant"; text=$text }) } } catch {}`,
			`      }`,
			`    }`,
			`  }`,
			`  $shapeCount = 0; try { $shapeCount = [int]$doc.Shapes.Count + [int]$doc.InlineShapes.Count } catch {}`,
			`  if ($shapeCount -gt 0) { [void]$formatNotes.Add("nonTextObjects=$shapeCount (images/shapes are represented as count only; no OCR)") }`,
			`  $content = [pscustomobject]@{ pageCount=$pageCount; sectionCount=$sectionCount; paragraphs=$paragraphs; tables=$tables; headersFooters=$headersFooters; nonTextObjectCount=$shapeCount }`,
			`  [pscustomobject]@{ markdown=($markdownLines -join [Environment]::NewLine); outline=$outline; content=$content; formatNotes=$formatNotes; truncated=$truncated } | ConvertTo-Json -Compress -Depth 10`,
			`} finally {`,
			`  $doc.Close($false)`,
			`}`,
		].join("\n"),
	);
}

function buildExcelSnapshotScript(path: string): string {
	const pathEsc = escapePsString(path);
	return wrapComScript(
		"$Excel = New-Object -ComObject Excel.Application",
		"$Excel.Visible = $false",
		"$Excel.DisplayAlerts = $false",
		"$Excel.Quit()",
		[
			`$path = '${pathEsc}'`,
			`if (-not (Test-Path -LiteralPath $path)) { throw "Workbook path not found: $path" }`,
			`$wb = $Excel.Workbooks.Open($path, 0, $true)`,
			`try {`,
			`  $maxRows = 200`,
			`  $maxCols = 50`,
			`  $outline = New-Object System.Collections.ArrayList`,
			`  $formatNotes = New-Object System.Collections.ArrayList`,
			`  $sheets = New-Object System.Collections.ArrayList`,
			`  $markdownLines = New-Object System.Collections.ArrayList`,
			`  $truncated = $false`,
			`  foreach ($ws in $wb.Worksheets) {`,
			`    $used = $ws.UsedRange`,
			`    $rowCount = [int]$used.Rows.Count`,
			`    $colCount = [int]$used.Columns.Count`,
			`    $rowLimit = [Math]::Min($rowCount, $maxRows)`,
			`    $colLimit = [Math]::Min($colCount, $maxCols)`,
			`    if ($rowCount -gt $maxRows -or $colCount -gt $maxCols) { $truncated = $true }`,
			`    $sheetName = [string]$ws.Name`,
			`    $visible = [string]$ws.Visible`,
			`    $usedAddress = ''; try { $usedAddress = [string]$used.Address($false, $false) } catch {}`,
			`    [void]$outline.Add("Sheet '$sheetName': UsedRange=$usedAddress rows=$rowCount cols=$colCount visible=$visible")`,
			`    [void]$markdownLines.Add("## Sheet: " + $sheetName + " [usedRange=" + $usedAddress + " visible=" + $visible + "]")`,
			`    $cells = New-Object System.Collections.ArrayList`,
			`    $formulaCells = New-Object System.Collections.ArrayList`,
			`    $highlightedCells = New-Object System.Collections.ArrayList`,
			`    $mergedAreas = New-Object System.Collections.ArrayList`,
			`    for ($r = 1; $r -le $rowLimit; $r++) {`,
			`      for ($c = 1; $c -le $colLimit; $c++) {`,
			`        $cell = $ws.Cells.Item($r, $c)`,
			`        $address = [string]$cell.Address($false, $false)`,
			`        $text = [string]$cell.Text`,
			`        $value = if ($null -eq $cell.Value2) { $null } else { [string]$cell.Value2 }`,
			`        $formula = ""; try { if ($cell.HasFormula) { $formula = [string]$cell.Formula } } catch {}`,
			`        $numberFormat = ""; try { $numberFormat = [string]$cell.NumberFormat } catch {}`,
			`        $fontName = ""; try { $fontName = [string]$cell.Font.Name } catch {}`,
			`        $fontSize = 0; try { $fontSize = [double]$cell.Font.Size } catch {}`,
			`        $bold = $false; try { $bold = ([bool]$cell.Font.Bold) } catch {}`,
			`        $italic = $false; try { $italic = ([bool]$cell.Font.Italic) } catch {}`,
			`        $fontColor = ""; try { $fontColor = [string]$cell.Font.Color } catch {}`,
			`        $fillColor = ""; try { $fillColor = [string]$cell.Interior.Color } catch {}`,
			`        $horizontalAlignment = ""; try { $horizontalAlignment = [string]$cell.HorizontalAlignment } catch {}`,
			`        $verticalAlignment = ""; try { $verticalAlignment = [string]$cell.VerticalAlignment } catch {}`,
			`        $mergeAddress = ""; try { if ($cell.MergeCells) { $mergeAddress = [string]$cell.MergeArea.Address($false,$false); if (-not $mergedAreas.Contains($mergeAddress)) { [void]$mergedAreas.Add($mergeAddress) } } } catch {}`,
			`        if ($formula) { [void]$formulaCells.Add("$address=$formula") }`,
			`        if ($bold -or ($fillColor -and $fillColor -ne "16777215")) { [void]$highlightedCells.Add("$address text='$text' bold=$bold fill=$fillColor") }`,
			`        [void]$cells.Add([pscustomobject]@{ address=$address; row=$r; col=$c; text=$text; value=$value; formula=$formula; numberFormat=$numberFormat; fontName=$fontName; fontSize=$fontSize; bold=$bold; italic=$italic; fontColor=$fontColor; fillColor=$fillColor; horizontalAlignment=$horizontalAlignment; verticalAlignment=$verticalAlignment; mergeAddress=$mergeAddress })`,
			`      }`,
			`    }`,
			`    $headers = @(); for ($c = 1; $c -le $colLimit; $c++) { $headers += (([string]$ws.Cells.Item(1, $c).Text -replace '\\|','\\|') -replace '\\r?\\n',' ') }`,
			`    if ($headers.Count -gt 0) {`,
			`      [void]$markdownLines.Add("| " + ($headers -join " | ") + " |")`,
			`      [void]$markdownLines.Add("| " + (($headers | ForEach-Object { "---" }) -join " | ") + " |")`,
			`      for ($r = 2; $r -le $rowLimit; $r++) {`,
			`        $rowVals = @(); for ($c = 1; $c -le $colLimit; $c++) { $rowVals += ((([string]$ws.Cells.Item($r, $c).Text) -replace '\\|','\\|') -replace '\\r?\\n',' ') }`,
			`        [void]$markdownLines.Add("| " + ($rowVals -join " | ") + " |")`,
			`      }`,
			`    }`,
			`    $sheet = [pscustomobject]@{ name=$sheetName; visible=$visible; usedRange=$usedAddress; rowCount=$rowCount; columnCount=$colCount; extractedRows=$rowLimit; extractedColumns=$colLimit; freezePanes=$Excel.ActiveWindow.FreezePanes; autoFilterMode=$ws.AutoFilterMode; cells=$cells; formulas=$formulaCells; mergedAreas=$mergedAreas; highlightedCells=$highlightedCells }`,
			`    [void]$sheets.Add($sheet)`,
			`    if ($formulaCells.Count -gt 0) { [void]$formatNotes.Add("Sheet '$sheetName' formulas: " + ($formulaCells -join "; ")) }`,
			`    if ($mergedAreas.Count -gt 0) { [void]$formatNotes.Add("Sheet '$sheetName' merged areas: " + ($mergedAreas -join ", ")) }`,
			`    [void]$markdownLines.Add("")`,
			`  }`,
			`  $content = [pscustomobject]@{ sheetCount=$wb.Worksheets.Count; sheets=$sheets }`,
			`  [pscustomobject]@{ markdown=($markdownLines -join [Environment]::NewLine); outline=$outline; content=$content; formatNotes=$formatNotes; truncated=$truncated } | ConvertTo-Json -Compress -Depth 10`,
			`} finally {`,
			`  $wb.Close($false)`,
			`}`,
		].join("\n"),
	);
}

function wrapComScript(
	createLine: string,
	visibleLine: string,
	alertsLine: string,
	quitLine: string,
	innerScript: string,
): string {
	return [
		"$ErrorActionPreference = 'Stop'",
		createLine,
		visibleLine,
		alertsLine,
		"try {",
		innerScript,
		"} finally {",
		`  try { ${quitLine} } catch {}`,
		"}",
	].join("\n");
}

function parseJsonObject(text: string): Record<string, unknown> {
	const trimmed = text.trim();
	if (!trimmed) return {};
	try {
		return JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start >= 0 && end > start) {
			return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
		}
		throw new Error("Attachment extractor did not return valid JSON.");
	}
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => String(item));
}

function escapePsString(value: string): string {
	return value.replace(/'/g, "''");
}

function escapeXmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncateForPrompt(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return {
		text: `${text.slice(0, maxChars)}\n[truncated: structured attachment JSON exceeds prompt block limit]`,
		truncated: true,
	};
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
