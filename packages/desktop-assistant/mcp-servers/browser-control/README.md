# Browser Control MCP

Controls Chrome/Edge from Desktop Assistant.

中文快速安装说明见 [安装教程.md](./安装教程.md).

It supports two modes:

- Normal browser mode: controls your already-open daily browser through a local extension.
- Dedicated debug browser mode: launches or connects to a separate Chrome/Edge instance with CDP enabled for full isolated control.

## Add to MCP Manager

Open Settings -> MCP Manager -> Add, then fill:

```json
{
  "name": "Browser Control",
  "enabled": true,
  "transport": "stdio",
  "command": "node",
  "args": [
    "C:/pythonProject/Desktop_Assistant/packages/desktop-assistant/mcp-servers/browser-control/browser-control-mcp-server.mjs"
  ],
  "env": {
    "BROWSER_MCP_HOST": "127.0.0.1",
    "BROWSER_MCP_PORT": "17890",
    "BROWSER_MCP_BACKEND": "extension",
    "BROWSER_MCP_DEBUG_PORT": "9223"
  },
  "timeoutMs": 60000,
  "toolNamePrefix": "browser"
}
```

Field-by-field:

- Command: `node`
- Args: `C:/pythonProject/Desktop_Assistant/packages/desktop-assistant/mcp-servers/browser-control/browser-control-mcp-server.mjs`
- Env:
  - `BROWSER_MCP_HOST=127.0.0.1`
  - `BROWSER_MCP_PORT=17890`
  - `BROWSER_MCP_BACKEND=extension`
  - `BROWSER_MCP_DEBUG_PORT=9223`
- Prefix: `browser`
- Timeout: `60000`

After saving, click Test or Refresh. The server can connect before the extension is loaded; `bridge_status` will show whether a browser extension is connected.

## Load the extension

Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select:

```text
C:\pythonProject\Desktop_Assistant\packages\desktop-assistant\mcp-servers\browser-control\extension
```

Edge:

1. Open `edge://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the same `extension` folder.

The extension defaults to:

```text
http://127.0.0.1:17890
```

If you change `BROWSER_MCP_PORT` or set `BROWSER_MCP_TOKEN`, click the extension icon, open options, and update Bridge URL / Token.

## Tools

Desktop Assistant exposes them with the configured prefix, for example:

- `mcp_browser_bridge_status`
- `mcp_browser_list_tabs`
- `mcp_browser_active_tab`
- `mcp_browser_activate_tab`
- `mcp_browser_open_url`
- `mcp_browser_close_tab`
- `mcp_browser_reload`
- `mcp_browser_go_back`
- `mcp_browser_go_forward`
- `mcp_browser_read_page`
- `mcp_browser_query_elements`
- `mcp_browser_click`
- `mcp_browser_double_click`
- `mcp_browser_hover`
- `mcp_browser_type_text`
- `mcp_browser_set_value`
- `mcp_browser_press_key`
- `mcp_browser_scroll`
- `mcp_browser_select_option`
- `mcp_browser_check`
- `mcp_browser_wait_for`
- `mcp_browser_screenshot`
- `mcp_browser_evaluate_js`
- `mcp_browser_run_cdp_command`
- `mcp_browser_get_storage`
- `mcp_browser_set_storage`
- `mcp_browser_get_cookies`
- `mcp_browser_set_cookie`
- `mcp_browser_delete_cookie`
- `mcp_browser_drag_and_drop`
- `mcp_browser_launch_debug_browser`
- `mcp_browser_connect_debug_browser`
- `mcp_browser_close_debug_browser`

Controlled-tab + virtual-cursor tools (added):

- `mcp_browser_take_control` — take over a tab by `tabId` (from `list_tabs`) or open one by `url`; marks it `🟢 AI 操作中` and adds a virtual cursor.
- `mcp_browser_release_control` — restore the tab title, remove the cursor, detach the debugger.
- `mcp_browser_transfer_control` / `mcp_browser_transfer_cursor` — move control / the virtual cursor to another tab.
- `mcp_browser_controlled_status` / `mcp_browser_set_primary_tab` — list controlled tabs / choose the default target.
- `mcp_browser_cursor_move` / `cursor_click` / `cursor_double_click` / `cursor_right_click` / `cursor_hover` / `cursor_drag` — move an on-page virtual mouse along a smooth human-like path, then act with trusted events.
- `mcp_browser_cursor_type` — virtual mouse focuses a field, then types via trusted per-key events scoped to that tab only.
- `mcp_browser_find_element` — one best match with a stable `elementId` + center point (the input for `cursor_*`).
- `mcp_browser_read_main_content` / `read_tab` / `read_accessibility_tree` / `frames` — token-frugal, DOM/text reads.
- `mcp_browser_get_attributes` / `set_attributes` / `read_console` / `read_network` — element attributes and CDP console/network capture.
- `mcp_browser_batch` — run several steps in one call to cut round-trips/tokens.

## Normal Browser Mode

This is the default. It uses your already-open Chrome/Edge with your normal tabs and login state.

Use cases:

- Read the current page.
- Extract tables, links, buttons, forms, headings, images, and visible text.
- Find elements by CSS selector, text, role, tag, or returned `elementId`.
- Click, type, select, scroll, wait, screenshot, read cookies/storage, or run JS.

### Take control of a tab (AI / user independence)

The AI never operates "whatever tab is active". Instead it **takes control** of a specific tab and targets it by id:

1. `list_tabs` → pick a tab, or `take_control { url }` to open a fresh one.
2. `take_control { tabId }` → the tab is marked `🟢 AI 操作中` in the tab strip and a virtual cursor appears.
3. All later actions (omitting `tabId`) hit that tab — so **you can keep using other tabs** and switching tabs never disturbs the AI, and vice versa.
4. `release_control` when done to restore the title, remove the cursor, and clear the debugger banner.

All sessions share all tabs and can operate across tabs; input on the same tab is serialized so parallel sessions never garble each other.

### Virtual cursor + keyboard

`cursor_*` tools render a fake mouse pointer **inside the page** (a `pointer-events:none` overlay, with a Pi-accent `#6aa9ff` halo) and glide it along a smooth, eased, human-like path before clicking with a trusted event. The pointer self-animates at 60fps in the page (so motion stays fluid regardless of round-trip latency). This pointer lives only in the page — it **never moves your real OS mouse**, so it can't fight your physical cursor. Use `transfer_cursor` to move it to another tab.

`cursor_type` pairs with the virtual mouse: it focuses a field then types via trusted per-key CDP events. Like all CDP input, these go **only to that tab's renderer** — never to the OS, your physical keyboard, or any other tab. So the AI can type into background tab A while you type into tab B (or a chat app) with zero crosstalk.

**Auto-fallback:** plain `click` / `type_text` first try the fast code-driven path; if that fails they automatically fall back **once** to the virtual cursor (`cursor_click` / `cursor_type`) instead of repeatedly retrying the failing call.

While a tab is controlled, Chrome's debugger stays attached for the whole session (so the synthetic motion stream doesn't flicker), and Chrome shows a "is debugging this browser" banner until `release_control`. Background (hidden) tabs still receive input correctly; only their in-page animation is throttled by Chrome until you look at them. Reading the console/network temporarily enables the CDP `Runtime`/`Log`/`Network` domains for that tab.

## Dedicated Debug Browser Mode

Use this when the user or model explicitly needs full isolated control, or when a site blocks extension/content-script operations.

Call:

```text
mcp_browser_launch_debug_browser
```

Optional input:

```json
{
  "browser": "auto",
  "url": "https://example.com"
}
```

After that, most tools can use:

```json
{
  "backend": "debug"
}
```

Example:

```json
{
  "backend": "debug",
  "url": "https://example.com"
}
```

with `mcp_browser_open_url`.

The debug browser uses a separate profile by default:

```text
%TEMP%\desktop-assistant-browser-mcp-debug-profile-<debug-port>
```

You can override it with:

```text
BROWSER_MCP_DEBUG_USER_DATA=C:\path\to\profile
```

## Backend Selection

Each tool accepts optional:

```json
{
  "backend": "extension"
}
```

or:

```json
{
  "backend": "debug"
}
```

`BROWSER_MCP_BACKEND=extension` keeps normal browser mode as default. `BROWSER_MCP_BACKEND=debug` makes the dedicated debug browser default. `BROWSER_MCP_BACKEND=auto` uses the extension if connected, otherwise launches/uses the debug browser.

## Security Notes

This MCP can read and control pages, cookies, storage, and forms visible to the browser. Only enable it for a local assistant you trust.

Recommended:

- Keep `BROWSER_MCP_HOST=127.0.0.1`.
- Set `BROWSER_MCP_TOKEN` if other local software may access `127.0.0.1:17890`.
- Use dedicated debug browser mode for risky automation.
