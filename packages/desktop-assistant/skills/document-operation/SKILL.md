---
name: document-operation
description: Document operation capability for creating, inspecting, editing, verifying, formatting, exporting, and managing Word documents using Microsoft Word COM automation.
---

# Document Operation Capability

Use this skill when the user asks to create, inspect, edit, format, summarize, verify, or export Word documents (`.docx`, `.doc`).

Requirement: Microsoft Word must be installed. If Word is unavailable, tell the user and do not pretend the operation succeeded.

## Available Tools

| Tool | When to use |
|------|-------------|
| `doc_inspect` | First step for editing an existing document; returns structured blocks, tables, headers, footers, and warnings |
| `doc_plan_edits` | Convert a natural-language document request into a structured edit plan before changing the file |
| `doc_apply_edits` | Apply structured operations to an existing document |
| `doc_verify` | Verify the final document state from explicit checks |
| `doc_create_from_html` | Create a brand-new document — you write document-style HTML and the tool converts it to an editable .docx (see rules below) |
| `doc_read` | **Read / compare / summarize / extract text** — the FAST primary tool for read-only tasks (single full-text pass). Use this, not `doc_inspect`, when you are not editing |
| (detailed formatting) | To read exact font/size/color/indent/spacing/shading, call `doc_inspect` with `formatForBlockIds=[…]` (returns `formats` for those blocks), or use `office_word_run` to read the specific COM properties you need. Don't read full formatting for the whole document unless you truly need it |
| `office_word_run` | Fast path for simple global edits and advanced fallback for operations the structured tools cannot express yet |

## Execution Policy

1. Always use a tool. Never claim a document was created or edited without a successful tool call.
2. READ vs EDIT: if the task only needs to READ the document (compare / summarize / extract / answer a question about it) and you are NOT editing it, use `doc_read` (one fast full-text pass). Do NOT use `doc_inspect` for read-only tasks — it walks every paragraph and table cell and is far slower (often times out) on large or form documents. Reserve `doc_inspect` for the first step of an actual EDIT.
3. For simple global edits across one or more existing documents, prefer `office_word_run`: Find/Replace, append/prepend plain text, update all font family/size/style, update fields, or export PDF.
3. For targeted edits that depend on document structure, visible block selection, table/form cell filling, or high-confidence verification, use `doc_inspect -> doc_apply_edits -> doc_verify`.
4. Prefer `doc_plan_edits` before `doc_apply_edits` when the request is non-trivial or ambiguous.
5. Prefer selectors built from `blockId` values returned by `doc_inspect`.
6. Use `doc_verify` after important structured edits so the result is confirmed by tool output.
7. To create a brand-new document, use `doc_create_from_html` and write document-style HTML (see "Creating New Documents" below). There is no markdown create tool; even a short note is created as minimal HTML. Do not use it to edit an existing file.
8. Use `office_word_run` as the fast path for simple global edits and as an advanced escape hatch for PDF export, complex headers/footers, field updates, or unsupported formatting.

## Creating New Documents (write document-style HTML)

To create a new Word document, call `doc_create_from_html` with a COMPLETE HTML page. Word imports the HTML, so the result is a real, **editable** .docx — headings become Word heading styles, tables become real tables. You decide the visual design (palette, type scale, spacing, table shading) to fit the document type (report / letter / résumé / manual / notice). Think "a cleanly typeset single-column document", not a web landing page.

**Structure (this is what makes it editable / semantically faithful):**
- Real headings use `<h1>`–`<h4>` (imported as built-in Word heading styles → navigable, language-independent). NEVER fake a heading with a big-font `<p>`.
- Body `<p>`; lists `<ul>/<ol>/<li>`; quotes `<blockquote>`; emphasis `<strong>/<em>/<u>`.
- All tabular data uses `<table><thead><tbody><tr><th><td>`. Do not simulate tables with multi-column layouts.
- Images: `<img>` with explicit `width`, source as a `data:` base64 URI (self-contained, preferred) or `file:///` absolute path.

**Layout (single-column thinking — layout CSS is discarded by Word's import):**
- Single column. Do NOT use flexbox, grid, `position:absolute/fixed`, complex `float`, CSS columns, `transform`, or `vw/vh`.
- For side-by-side / columns, use a **borderless `<table>`**.
- Page break: `<div style="page-break-before:always"></div>` (Word honors this).

**Styling (design freely, within the importable subset):**
- Survives import: `color`, `background-color` (paragraph / cell shading), `font-family`, `font-size` (pt/px), `font-weight`, `font-style`, `text-align`, `line-height`, `margin`, `padding`, table `border`/`width`, cell alignment.
- Dropped on import: `box-shadow`, `border-radius`, `opacity`, `::before/::after`, background images, `@font-face`/web fonts, animation.
- Use installed fonts: 中文 `微软雅黑`/`黑体`/`宋体`; western `Calibri`/`Arial`/`Times New Roman`/`Georgia`. Colors as hex.

**Encoding / page:** include `<meta charset="utf-8">`. Set margins/orientation/paper via the tool's `pageSetup` parameter, not CSS `@page`.

**Self-check:** after creating, you may run `doc_inspect` to confirm heading blocks report `kind=heading` and tables were detected; if not, fix the HTML and regenerate.

### Worked example

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:'微软雅黑',Calibri,Arial; color:#1a1a1a; line-height:1.6;">
  <h1 style="color:#0b5394; text-align:center;">DeepSeek 用量报告</h1>
  <p style="text-align:center; color:#666;">报告日期：2026年6月16日</p>

  <h2 style="color:#0b5394; border-bottom:2px solid #0b5394; padding-bottom:4px;">一、账户概览</h2>
  <table style="border-collapse:collapse; width:100%;">
    <thead>
      <tr style="background-color:#0b5394; color:#ffffff;">
        <th style="border:1px solid #999; padding:6px; text-align:left;">项目</th>
        <th style="border:1px solid #999; padding:6px; text-align:left;">数值</th>
      </tr>
    </thead>
    <tbody>
      <tr><td style="border:1px solid #999; padding:6px;">充值余额</td><td style="border:1px solid #999; padding:6px;">¥6.30</td></tr>
      <tr style="background-color:#f3f7fc;"><td style="border:1px solid #999; padding:6px;">本月消费</td><td style="border:1px solid #999; padding:6px;">¥20.32</td></tr>
    </tbody>
  </table>

  <div style="page-break-before:always"></div>
  <h2 style="color:#0b5394;">二、备注</h2>
  <p>本月主要使用 <strong>deepseek-v4-flash</strong>，建议关注余额并及时充值。</p>
</body></html>
```

## Structured Edit Operations

`doc_apply_edits` accepts declarative operations instead of arbitrary PowerShell:

- `replace_text`
- `insert_after_block`
- `insert_before_block`
- `set_block_text`
- `append_to_block`
- `update_table_cell`
- `delete_block`

Selectors should prefer `blockId`. If `blockId` is unavailable, fall back to `kind + text match + occurrence`.

## Verification Policy

Use `doc_verify` checks such as:

- text exists
- text does not exist
- block text equals expected text
- table cell equals expected text

## Advanced Fallback

Use `office_word_run` for simple global edits or advanced fallback work:

- Prefer it for whole-document or batch-wide operations that do not require locating a specific user-visible block or merged table cell.
- Do not use it for routine form/table filling with `$table.Cell($row,$col)` loops. Use `doc_inspect -> doc_apply_edits -> doc_verify` first; only fall back when the structured tools cannot express the change.
- When writing a document, open it editable (`Documents.Open(..., $false, $false)` or `ReadOnly:=$false`). Never open read-only and then save or mutate content.
- Close only the document objects you opened.
- Do not call `$Word.Quit()` inside the script.
- Good fits: Find/Replace, uniform font/size/style updates, append/prepend simple text, export, field update, or complex layout work.

## Output Conventions

- Report the edited or generated file path from tool output.
- If the tool reports a timeout, explain that the task is still running and can be continued or aborted.
- If verification fails, say that explicitly.
- If Word is not installed or the file cannot be accessed, say so clearly instead of pretending the edit succeeded.
