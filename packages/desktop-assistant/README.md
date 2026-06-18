# Pi Desktop Assistant

Windows-first desktop assistant client built on the Pi agent runtime.

The package provides:

- Electron main process for local automation, credentials, and voice bridge orchestration.
- React renderer for chat, execution timeline, model settings, and wake overlay state.
- DeepSeek V4 defaults (`deepseek-v4-pro`, fast mode `deepseek-v4-flash`) using the existing Pi model registry.
- MCP management for local stdio servers, including a global MCP switch and a built-in `Desktop Assistant MCP` example.

API keys are intentionally not stored in source files. Enter a fresh DeepSeek key in the desktop UI or set `DEEPSEEK_API_KEY`.

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

Docs:

- [MCP management](docs/mcp.md)
- [Writing MCP servers](docs/mcp-server-authoring.md)
- [Built-in Desktop Assistant MCP](docs/mcp-desktop-assistant-control.md)
