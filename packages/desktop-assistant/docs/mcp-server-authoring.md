# Writing MCP servers for Desktop Assistant

Desktop Assistant currently supports local `stdio` MCP servers. HTTP transport is reserved in the config model but not enabled yet.

## Server contract

An external app-control MCP should:

- expose tools for direct app actions instead of mouse-click recipes;
- return structured, short results that say what changed and how it was verified;
- avoid secrets in tool results, logs, resources, and prompts;
- fail clearly when the target app is closed, not logged in, or lacks a needed API;
- provide read-only inspect tools alongside write tools.

Desktop Assistant exposes each tool as `mcp_<serverPrefix>_<toolName>`.

## Minimal Node stdio server

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "chrome-controller", version: "1.0.0" });

server.registerTool(
  "open_url",
  {
    title: "Open URL",
    description: "Open a URL in Chrome through the app's direct control layer.",
    inputSchema: {
      url: z.string().url()
    }
  },
  async ({ url }) => {
    // Replace this with Chrome DevTools Protocol, native messaging, or app API code.
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, openedUrl: url })
        }
      ]
    };
  }
);

await server.connect(new StdioServerTransport());
```

## Recommended tools

For a controllable desktop app, prefer these categories:

- `app_get_state`: read current app state.
- `app_list_targets`: list tabs, playlists, documents, devices, windows, or controllable objects.
- `app_execute_action`: direct high-level action with validation.
- `app_update_settings`: safe app settings only.
- `app_open_view`: ask the app to show a specific page or panel.

For Chrome, this could be `list_tabs`, `activate_tab`, `open_url`, `run_devtools_command`, and `get_page_summary`.

For NetEase Cloud Music, this could be `search_track`, `play_track`, `pause`, `next`, `get_playback_state`, and `set_volume`.

## Result shape

Return JSON text in MCP `content`:

```json
{
  "ok": true,
  "action": "play_track",
  "target": "Crying Over You",
  "observedState": {
    "playing": true,
    "track": "Crying Over You"
  }
}
```

On failure:

```json
{
  "ok": false,
  "errorCode": "APP_NOT_RUNNING",
  "message": "NetEase Cloud Music is not running.",
  "nextActions": ["Open NetEase Cloud Music", "Retry play_track"]
}
```

## Desktop Assistant config

```json
{
  "name": "NetEase Cloud Music",
  "enabled": true,
  "transport": "stdio",
  "command": "node",
  "args": ["C:/mcp/netease-cloud-music/server.js"],
  "toolNamePrefix": "netease",
  "timeoutMs": 10000
}
```

After saving, enable the MCP global switch and click Test or Refresh.
