# Steam Control MCP

Controls Steam through the public `steam://` URL protocol and local Steam VDF
manifests. It does not inject code into Steam and does not modify the Steam
installation directory.

## Desktop Assistant config

```json
{
  "name": "Steam Control",
  "enabled": true,
  "transport": "stdio",
  "command": "node",
  "args": ["C:/pythonProject/Desktop_Assistant/packages/desktop-assistant/mcp-servers/steam/steam-mcp-server.mjs"],
  "env": {
    "STEAM_ROOT": "D:\\steam",
    "STEAM_EXE_PATH": "D:\\steam\\steam.exe",
    "STEAM_AUTO_LAUNCH": "1"
  },
  "toolNamePrefix": "steam",
  "timeoutMs": 15000
}
```

The plugin manager can install this configuration automatically.

## Tools

- `get_status`
- `launch_steam`
- `close_steam`
- `list_libraries`
- `list_installed_games`
- `find_game`
- `open_view`
- `open_store_page`
- `open_game_page`
- `run_game`
- `install_game`
- `uninstall_game`
- `verify_game_files`
- `create_desktop_shortcut`
- `inspect_manifest`
- `open_steam_url`

`close_steam` defaults to `steam.exe -shutdown`. It only uses `taskkill` when
called with `force=true`.
