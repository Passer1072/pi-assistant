# MCP management

Desktop Assistant supports local stdio MCP servers behind one global switch.

## Global switch

Open Settings, then MCP Manager.

- Enabled: Desktop Assistant starts enabled MCP servers, discovers tools/resources/prompts, and exposes MCP tools before normal desktop tools.
- Disabled: Desktop Assistant disconnects every MCP client, closes stdio server processes started by the assistant, clears MCP tools, and does not allow test or refresh.

When disabled, server configuration can still be edited offline.

## Built-in server

`Desktop Assistant MCP` is always present as a built-in example. It can be disabled but cannot be deleted. It controls safe settings in this app, such as web search mode, voice toggles, memory settings, and desktop capabilities. It never changes API keys.

## Add an external stdio MCP

Use MCP Manager, click Add, then fill:

```json
{
  "name": "Chrome Controller",
  "enabled": true,
  "transport": "stdio",
  "command": "node",
  "args": ["C:/tools/chrome-mcp/server.js"],
  "cwd": "C:/tools/chrome-mcp",
  "env": {
    "CHROME_PROFILE": "Default"
  },
  "timeoutMs": 10000,
  "toolNamePrefix": "chrome"
}
```

Arguments are entered one per line. Environment variables are entered as `KEY=value`, one per line.

## Tool names

All MCP tools are exposed to the AI as:

```text
mcp_<serverPrefix>_<toolName>
```

For example, `search_tabs` from a server with prefix `chrome` becomes:

```text
mcp_chrome_search_tabs
```

If two tools collide, Desktop Assistant appends a stable server-id suffix.

## Secrets

Environment values whose keys look like `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `AUTH`, or `CREDENTIAL` are redacted in UI snapshots and archives. The real values stay in the main-process MCP settings file so existing connections can still use them.

When editing an existing server, leaving `[redacted]` in an env value keeps the stored secret.
