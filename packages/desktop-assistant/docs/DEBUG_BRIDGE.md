# Desktop Assistant Debug Bridge

The Debug Bridge is a local-only control surface for co-debugging a running Pi Desktop Assistant from another AI or script.

It is disabled by default, binds only to `127.0.0.1`, and every route except `/health` requires a bearer token. Treat the token as a full-control secret: it can drive conversations, approve confirmations, reload the app, and read settings exposed by the live app snapshot.

## Start

PowerShell:

```powershell
$env:DA_DEBUG_BRIDGE = "1"
npm run dev
```

Optional environment variables:

```powershell
$env:DA_DEBUG_BRIDGE_PORT = "49250"
$env:DA_DEBUG_BRIDGE_TOKEN = "choose-a-long-local-secret"
$env:DA_DEBUG_BRIDGE_FORCE = "1"
```

`DA_DEBUG_BRIDGE_FORCE=1` allows startup in a packaged build. Use it only for local incident debugging.

## Get Token And Port

On startup the app writes:

```text
<agentDir>/debug-bridge.json
```

The file contains:

```json
{
  "port": 49250,
  "token": "...",
  "baseUrl": "http://127.0.0.1:49250",
  "mcpUrl": "http://127.0.0.1:49250/mcp",
  "openapiUrl": "http://127.0.0.1:49250/openapi.json",
  "docPath": "packages/desktop-assistant/docs/DEBUG_BRIDGE.md",
  "pid": 12345
}
```

Verify stale files with `GET /health`.

## REST API

Set helpers:

```powershell
$h = Get-Content "$env:APPDATA\@earendil-works\pi-desktop-assistant\agent\debug-bridge.json" | ConvertFrom-Json
$base = $h.baseUrl
$auth = @{ Authorization = "Bearer $($h.token)" }
```

Health does not require a token:

```powershell
Invoke-RestMethod "$base/health"
```

All other routes require `Authorization: Bearer <token>`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/capabilities` | Bridge capability catalog. |
| `GET` | `/openapi.json` | Small OpenAPI description. |
| `GET` | `/sessions` | List live sessions. |
| `GET` | `/sessions/:id` | Read focused session snapshot or non-focused history page without changing focus. |
| `POST` | `/sessions` | Create and focus a new session. |
| `POST` | `/sessions/:id/prompt` | Send `{ "message": "...", "attachments": [] }` as the user. |
| `POST` | `/sessions/:id/focus` | Focus a session explicitly. |
| `POST` | `/sessions/:id/close` | Close a live session without deleting history. |
| `POST` | `/sessions/:id/abort` | Abort a running session. |
| `POST` | `/confirmations/:id/approve` | Approve a pending confirmation. |
| `POST` | `/confirmations/:id/reject` | Reject a pending confirmation. |
| `GET` | `/settings` | Return settings from `service.snapshot().settings`. |
| `PATCH` | `/settings` | Deep-merge nested settings before calling `updateSettings`. |
| `GET` | `/logs?limit=100` | Return recent in-memory logs. |
| `POST` | `/actions/reload` | Reload all app windows. |
| `POST` | `/actions/relaunch` | Relaunch the app. |
| `POST` | `/actions/clear-cache` | Clear Electron cache. |
| `GET` | `/introspect` | Return MCP, sandbox, sessions, memory, uptime, and pid. |

Examples:

```powershell
Invoke-RestMethod "$base/sessions" -Headers $auth

$sessionId = (Invoke-RestMethod "$base/sessions" -Headers $auth).focusedSessionId

Invoke-RestMethod "$base/sessions/$sessionId/prompt" `
  -Method Post `
  -Headers $auth `
  -ContentType "application/json" `
  -Body (@{ message = "Say exactly: debug bridge ok" } | ConvertTo-Json)

Invoke-RestMethod "$base/settings" -Headers $auth

Invoke-RestMethod "$base/settings" `
  -Method Patch `
  -Headers $auth `
  -ContentType "application/json" `
  -Body (@{ browser = @{ allowAiControl = $true } } | ConvertTo-Json)

Invoke-RestMethod "$base/actions/reload" -Method Post -Headers $auth
```

`GET /sessions/:id` is read-only. It never changes the user's focused session. To read a different session as the full live snapshot, call `POST /sessions/:id/focus` first.

`GET /settings` reflects the live snapshot settings. Some areas that are already redacted before they reach the snapshot, such as MCP server environment secrets, may still be redacted.

## WebSocket Events

Connect to:

```text
ws://127.0.0.1:49250/events?token=<token>
```

The socket first sends a full snapshot:

```json
{ "type": "snapshot", "snapshot": {} }
```

Then it forwards raw `DesktopAssistantEvent` payloads without the Office bridge truncation:

```json
{ "type": "streaming_text", "streamingText": "..." }
```

Log entries are sent separately:

```json
{ "type": "log", "entry": { "id": "...", "ts": 0, "cat": "system", "title": "..." } }
```

## Co-Debug Loop

1. Modify code.
2. `POST /actions/reload`.
3. `POST /sessions/:id/prompt` with the scenario to verify.
4. Watch `/events`, or poll `GET /sessions/:id` until the session is idle.
5. Inspect logs with `GET /logs`.
6. Iterate.

## MCP

The MCP endpoint is stateless Streamable HTTP at:

```text
http://127.0.0.1:49250/mcp
```

Server-initiated notifications are not the event stream; use WebSocket `/events` for live updates.

Claude Code:

```powershell
claude mcp add --transport http debug-bridge http://127.0.0.1:49250/mcp --header "Authorization: Bearer <token>"
```

Codex `~/.codex/config.toml`:

```toml
[mcp_servers.debug-bridge]
url = "http://127.0.0.1:49250/mcp"
headers = { Authorization = "Bearer <token>" }
```

MCP resources:

- `debug://guide`
- `debug://capabilities`
- `debug://session/{id}`

MCP prompt:

- `cojoint_debug_session`

## Security Rules

- The bridge starts only when `DA_DEBUG_BRIDGE=1`.
- Packaged builds are blocked unless `DA_DEBUG_BRIDGE_FORCE=1`.
- The server listens only on `127.0.0.1`.
- HTTP, WebSocket, and MCP requests must use `Host: 127.0.0.1:<port>` or `Host: localhost:<port>`.
- Non-empty `Origin` headers are rejected.
- Mutating routes write audit entries to the service log with `source:"debug-bridge"`.
