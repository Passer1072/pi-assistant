---
name: ppt-operation
description: Presentation operation capability for creating, editing, formatting, and exporting PowerPoint presentations using Microsoft PowerPoint COM automation.
---

# PPT Operation Capability

Use this skill when the user asks to create, edit, format, or export PowerPoint presentations (.pptx).

**Requirement**: Microsoft PowerPoint must be installed. If unavailable, tell the user and do not pretend the operation succeeded.

## Available Tools

There are two backends for PowerPoint. Pick by the rules in **Tool Selection** below.

**COM backend (drives Microsoft PowerPoint directly — works on the live, on-screen app):**

| Tool | When to use |
|------|-------------|
| `ppt_create` | Create a new .pptx from an array of slide definitions |
| `ppt_read` | Extract slide titles and text content from an existing .pptx |
| `office_ppt_run` | COM escape hatch: operate a deck **currently open** in PowerPoint, make changes **visible live**, or animations / master layout / notes / PDF export through PowerPoint |

**File backend (`mcp_pptx_*`, python-pptx — edits the .pptx file on disk, no PowerPoint needed):**

| Tool | When to use |
|------|-------------|
| `mcp_pptx_create_presentation` | Create a new deck on disk |
| `mcp_pptx_apply_slide_template` / `mcp_pptx_create_slide_from_template` | Professional templates and themed layouts |
| `mcp_pptx_add_chart` / `mcp_pptx_add_table` / `mcp_pptx_add_shape` | Rich content elements |
| `mcp_pptx_manage_slide_transitions` / `mcp_pptx_apply_picture_effects` | Transitions and visual effects |
| other `mcp_pptx_*` | Images, hyperlinks, connectors, text management, extract text |

> `mcp_pptx_*` come from the optional **PPT 高级设计 (GongRzhe)** MCP server. If these tools are not in your tool list the server is disabled — use `office_ppt_run` for complex work instead.

## Tool Selection (COM vs file backend)

- **A deck is already OPEN in PowerPoint, or the user wants the change to appear live on screen** → use the COM tools (`ppt_read` / `ppt_create` / `office_ppt_run`). `mcp_pptx_*` **cannot** touch a file that PowerPoint has open (file lock; changes would not show in the open window).
- **Simple new deck from a few title/content slides** → `ppt_create`.
- **Rich design on a file on disk** (templates, themes, charts, tables, shapes, transitions, master layout) → prefer `mcp_pptx_*` so you don't have to hand-write COM PowerShell. If the same file happens to be open, close it first or fall back to `office_ppt_run`.

## Execution Policy

1. **Always use a tool** — never claim a presentation was created or modified without a successful tool call.
2. Ask for the file path if not provided. Default to `$env:USERPROFILE\Documents\` if unspecified. `mcp_pptx_*` expects an absolute path.
3. Use `ppt_read` (or `mcp_pptx_*` extract) first to understand the existing structure before editing.
4. Use `ppt_create` for simple new decks; use `mcp_pptx_*` for template/design/chart work on a closed file, and `office_ppt_run` only when the deck is open in PowerPoint or must stay live.

## ppt_create — Slide Definitions

```
ppt_create(
  path="C:\Users\user\Documents\deck.pptx",
  slides=[
    { "title": "Company Overview", "content": "Founded 2020\nHeadquarters: Beijing\n500+ employees", "layout": 1 },
    { "title": "Key Metrics", "content": "Revenue: ¥50M\nGrowth: 35%\nNPS: 72", "layout": 1 },
    { "title": "Thank You", "layout": 7 }
  ]
)
```

**Layout values:** 1=Title+Content (default), 2=Title+Body, 7=TitleOnly, 12=Blank

**In content:** Use `\n` to separate bullet points.

## office_ppt_run — Common Examples

**Add speaker notes to all slides:**
```powershell
$pres = $Ppt.Presentations.Open('C:\Users\user\Documents\deck.pptx')
for ($i = 1; $i -le $pres.Slides.Count; $i++) {
    $pres.Slides.Item($i).NotesPage.Shapes.Item(2).TextFrame.TextRange.Text = "Speaker notes for slide $i"
}
$pres.Save()
$pres.Close()
Write-Output "Notes added to $($pres.Slides.Count) slides"
```

**Export presentation to PDF:**
```powershell
$pres = $Ppt.Presentations.Open('C:\Users\user\Documents\deck.pptx')
$pres.ExportAsFixedFormat('C:\Users\user\Documents\deck.pdf', 2)  # 2 = ppFixedFormatTypePDF
$pres.Close()
Write-Output "Exported to PDF"
```

**Change slide background color (RGB):**
```powershell
$pres = $Ppt.Presentations.Open('C:\Users\user\Documents\deck.pptx')
for ($i = 1; $i -le $pres.Slides.Count; $i++) {
    $bg = $pres.Slides.Item($i).Background
    $bg.Fill.ForeColor.RGB = 0x1E3A5F  # Dark blue
    $bg.Fill.Solid()
}
$pres.Save()
$pres.Close()
Write-Output "Background color set"
```

**Apply a theme from a .thmx file:**
```powershell
$pres = $Ppt.Presentations.Open('C:\Users\user\Documents\deck.pptx')
$pres.ApplyTheme('C:\path\to\theme.thmx')
$pres.Save()
$pres.Close()
Write-Output "Theme applied"
```

**Add a new slide at the end:**
```powershell
$pres = $Ppt.Presentations.Open('C:\Users\user\Documents\deck.pptx')
$newSlide = $pres.Slides.Add($pres.Slides.Count + 1, 1)
$newSlide.Shapes.Title.TextFrame.TextRange.Text = "New Slide Title"
$newSlide.Shapes.Item(2).TextFrame.TextRange.Text = "Content here"
$pres.Save()
$pres.Close()
Write-Output "Slide added"
```

## Output Conventions

- Report the output file path and slide count after creation.
- For edits, confirm what was changed.
- If PowerPoint is not installed, clearly say so rather than failing silently.
