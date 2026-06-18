# Desktop Assistant

Windows-first AI desktop assistant built on the Pi agent runtime.

This repository contains the Electron desktop client, React renderer, local automation tools, voice/wake-word assets, MCP server integrations, and test coverage needed to run the assistant from source.

## What Is Included

- Desktop app package: `packages/desktop-assistant`
- Launch helper: `start_desktop_assistant.py`
- Runtime model assets required by the current voice/wake-word flow:
  - `packages/desktop-assistant/resources/kws/*.onnx`
  - `packages/desktop-assistant/resources/kws/*.txt`
  - `packages/desktop-assistant/resources/public/models/**`
- Built-in MCP examples for browser control, Forge, NetEase Music, and Steam.
- Project-level checks inherited from the Pi monorepo runtime.

## Requirements

Use Windows 10/11.

Install:

- Git
- Node.js `>=22.19.0`
- npm, bundled with Node.js
- Python 3.10+ for `start_desktop_assistant.py`

Check the tools:

```powershell
git --version
node --version
npm --version
python --version
```

## Clone

```powershell
cd C:\pythonProject
git clone https://github.com/Passer1072/Desktop_Assistant.git
cd Desktop_Assistant
```

## Install And Prepare

The recommended first-time command is:

```powershell
python .\start_desktop_assistant.py --prepare-only
```

This command:

1. Installs npm dependencies with `--ignore-scripts --legacy-peer-deps`.
2. Ensures Electron's runtime binary is downloaded.
3. Builds the packages needed by the desktop assistant.

The direct manual equivalent is:

```powershell
npm install --ignore-scripts --legacy-peer-deps
npm exec --package electron@42.3.0 -- install-electron
python .\start_desktop_assistant.py --skip-install --rebuild --prepare-only
```

## Run

After preparation:

```powershell
python .\start_desktop_assistant.py --skip-install --skip-build
```

For normal day-to-day use, this is also fine:

```powershell
python .\start_desktop_assistant.py
```

It installs missing dependencies, rebuilds when source files are newer than the build output, then starts Electron.

## Development Mode

To run Electron with a Vite renderer dev server:

```powershell
python .\start_desktop_assistant.py --dev-renderer
```

The helper sets `DESKTOP_ASSISTANT_DEV_SERVER_URL=http://127.0.0.1:5178` and starts the renderer dev server before launching Electron.

## Configuration

API keys are not committed to this repository.

Set a DeepSeek key in the app settings UI, or set it for the current PowerShell session:

```powershell
$env:DEEPSEEK_API_KEY = "your-key"
python .\start_desktop_assistant.py --skip-install --skip-build
```

Local runtime data is stored outside version control, including:

- `packages/desktop-assistant/auth.json`
- `packages/desktop-assistant/save/`
- `packages/desktop-assistant/data/`
- `packages/desktop-assistant/bc_*.db`
- `packages/desktop-assistant/dist/`
- `packages/desktop-assistant/renderer-dist/`
- `node_modules/`

## Useful Commands

```powershell
npm run check
```

Runs formatting, linting, pinned-dependency checks, TypeScript checks, shrinkwrap verification, and browser smoke checks.

```powershell
npm --workspace @earendil-works/pi-desktop-assistant run test
```

Runs the Desktop Assistant package tests.

```powershell
npm --workspace @earendil-works/pi-desktop-assistant run build
```

Builds only the Desktop Assistant package after shared packages have already been built.

```powershell
npm run build
```

Builds all workspace packages.

## MCP

Open Settings, then MCP Manager.

When MCP is enabled, Desktop Assistant starts enabled MCP servers and exposes their tools before normal desktop automation tools. When MCP is disabled, no MCP tools are exposed and started stdio servers are closed.

Minimal external stdio config:

```json
{
  "name": "Chrome Controller",
  "enabled": true,
  "transport": "stdio",
  "command": "node",
  "args": ["C:/tools/chrome-mcp/server.js"],
  "toolNamePrefix": "chrome",
  "timeoutMs": 10000
}
```

More docs:

- [Desktop Assistant package README](packages/desktop-assistant/README.md)
- [MCP management](packages/desktop-assistant/docs/mcp.md)
- [Writing MCP servers](packages/desktop-assistant/docs/mcp-server-authoring.md)
- [Built-in Desktop Assistant MCP](packages/desktop-assistant/docs/mcp-desktop-assistant-control.md)
- [Wake word assets and settings](packages/desktop-assistant/docs/wake-word.md)

## Troubleshooting

If `electron` fails because its binary is missing, run:

```powershell
npm exec --package electron@42.3.0 -- install-electron
```

If `python` is not found, try:

```powershell
py .\start_desktop_assistant.py --prepare-only
```

If native desktop automation dependencies fail on install, confirm the Node version first:

```powershell
node --version
```

Use Node `>=22.19.0`.

If a clean clone does not build, run:

```powershell
npm run check
python .\start_desktop_assistant.py --rebuild --prepare-only
```

## Repository Hygiene

Do not commit generated or local runtime files. The `.gitignore` keeps local state and credentials out while preserving the model resources required for a fresh clone to run.
