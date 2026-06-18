---
name: excel-operation
description: Spreadsheet operation capability for reading, writing, formatting, and automating Excel workbooks using Microsoft Excel COM automation.
---

# Excel Operation Capability

Use this skill when the user asks to create, read, edit, format, analyze, or export Excel files (.xlsx, .xls, .csv).

**Requirement**: Microsoft Excel must be installed. If Excel is unavailable, tell the user and do not pretend the operation succeeded.

## Available Tools

There are two backends for Excel. Pick by the rules in **Tool Selection** below.

**COM backend (drives Microsoft Excel directly — works on the live, on-screen app):**

| Tool | When to use |
|------|-------------|
| `excel_read` | Read data from an existing .xlsx as a JSON array of rows |
| `excel_write` | Bulk write rows to an .xlsx (new file, overwrite, or append) |
| `office_excel_run` | COM escape hatch: operate a workbook **currently open** in Excel, make changes **visible live**, or do PDF export / CSV import through Excel |

**File backend (`mcp_xlsx_*`, openpyxl — edits the .xlsx file on disk, no Excel needed):**

| Tool | When to use |
|------|-------------|
| `mcp_xlsx_apply_formula` | Add/set formulas in cells |
| `mcp_xlsx_create_chart` | Create charts (line, column, pie, scatter, …) |
| `mcp_xlsx_create_pivot_table` | Build pivot tables |
| `mcp_xlsx_format_range` | Fonts, colors, borders, conditional formatting |
| other `mcp_xlsx_*` | Tables, data validation, sheet copy/rename, range read/write |

> `mcp_xlsx_*` come from the optional **Excel 高级操作 (haris-musa)** MCP server. If these tools are not in your tool list the server is disabled — use `office_excel_run` for complex work instead.

## Tool Selection (COM vs file backend)

- **A workbook is already OPEN in Excel, or the user wants the change to appear live on screen** → use the COM tools (`excel_read` / `excel_write` / `office_excel_run`). `mcp_xlsx_*` **cannot** touch a file that Excel has open (file lock; changes would not show in the open window).
- **Simple bulk read/write of a closed file** → `excel_read` / `excel_write`.
- **Complex work on a file on disk** (formulas, charts, pivot tables, conditional formatting, validation) → prefer `mcp_xlsx_*` so you don't have to hand-write COM PowerShell. If the same file happens to be open in Excel, close it first or fall back to `office_excel_run`.

## Execution Policy

1. **Always use a tool** — never claim a file was created or edited without a successful tool call.
2. Ask for the file path if not provided. Default to `$env:USERPROFILE\Documents\` if unspecified. `mcp_xlsx_*` expects an absolute path.
3. Use `excel_read` (or `mcp_xlsx_*` read) first to understand the existing structure before writing.
4. Use `excel_write` for bulk data writes; use `mcp_xlsx_*` for formulas/charts/pivots/formatting on a closed file, and `office_excel_run` only when the file is open in Excel or must stay live.

## excel_read — Usage

```
excel_read(path="C:\...\data.xlsx", sheet=1, maxRows=200)
```

Returns JSON: `[["Header1", "Header2"], ["row1val1", "row1val2"], ...]`

## excel_write — Usage

```
excel_write(
  path="C:\...\report.xlsx",
  data=[["Name","Score"],["Alice",95],["Bob",87]],
  sheet=1,
  startRow=1,
  clearSheet=true
)
```

## office_excel_run — Common Examples

**Add a SUM formula:**
```powershell
$wb = $Excel.Workbooks.Open('C:\Users\user\Documents\sales.xlsx')
$ws = $wb.Sheets.Item(1)
$ws.Cells.Item(11, 2).Formula = '=SUM(B2:B10)'
$ws.Cells.Item(11, 1).Value2 = 'Total'
$wb.Save()
$wb.Close($false)
Write-Output "Formula added"
```

**Auto-fit columns and bold the header row:**
```powershell
$wb = $Excel.Workbooks.Open('C:\Users\user\Documents\data.xlsx')
$ws = $wb.Sheets.Item(1)
$ws.UsedRange.Columns.AutoFit() | Out-Null
$ws.Rows.Item(1).Font.Bold = $true
$wb.Save()
$wb.Close($false)
Write-Output "Formatted"
```

**Export to PDF:**
```powershell
$wb = $Excel.Workbooks.Open('C:\Users\user\Documents\report.xlsx')
$wb.ExportAsFixedFormat(0, 'C:\Users\user\Documents\report.pdf')  # 0 = xlTypePDF
$wb.Close($false)
Write-Output "Exported to PDF"
```

**Import CSV and save as XLSX:**
```powershell
$csvPath = 'C:\Users\user\Downloads\data.csv'
$xlsxPath = 'C:\Users\user\Documents\data.xlsx'
$wb = $Excel.Workbooks.Open($csvPath)
$wb.SaveAs($xlsxPath, 51)  # 51 = xlOpenXMLWorkbook
$wb.Close($false)
Write-Output "Converted CSV to XLSX: $xlsxPath"
```

**Create a chart:**
```powershell
$wb = $Excel.Workbooks.Open('C:\Users\user\Documents\data.xlsx')
$ws = $wb.Sheets.Item(1)
$chart = $ws.Shapes.AddChart2(-1, 57).Chart  # 57 = xlColumnClustered
$chart.SetSourceData($ws.Range("A1:B10"))
$wb.Save()
$wb.Close($false)
Write-Output "Chart created"
```

## Output Conventions

- Report the file path after write/create operations.
- Report row/column counts after read operations.
- If Excel is not installed, clearly say so rather than failing silently.
