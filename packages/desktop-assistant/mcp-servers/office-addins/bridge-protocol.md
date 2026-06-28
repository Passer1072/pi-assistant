# Office Live Add-in Bridge

The Desktop Assistant Office bridge is a local HTTPS/WSS service hosted by the
MCP server process. Office taskpanes connect out to the bridge because desktop
Office cannot expose a browser-style remote debugging port.

## Transport

- Static taskpane content: `https://127.0.0.1:<port>/taskpane.html`
- Config: `GET /config` returns `{ "host": "word", "token": "..." }`
- Health: `GET /health` returns `{ "ok": true, "host": "word" }`
- Status: `GET /bridge/status` returns connection state for plugin tests.
- Commands: `wss://127.0.0.1:<port>/ws?host=<host>&token=<token>`

The bridge is bound to `127.0.0.1`, requires a per-install token, and only
dispatches fixed operation names. It does not provide an arbitrary JavaScript
evaluation endpoint.

## Messages

Server to taskpane:

```json
{ "id": 1, "op": "replace_selection", "args": { "text": "Hello" } }
```

Taskpane response:

```json
{ "id": 1, "ok": true, "state": { "selectionText": "", "paragraphCount": 3 } }
```

Optional taskpane state push:

```json
{ "type": "state", "state": { "selectionText": "current text" } }
```

## Sideloading

Installation writes the generated manifest path to
`HKCU:\Software\Microsoft\Office\16.0\WEF\Developer`, using the manifest path as
both the value name and value. It also creates and trusts a localhost certificate
under the current user so Office can load the taskpane over HTTPS.
