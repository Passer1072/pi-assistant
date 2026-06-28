# Built-in Desktop Assistant MCP

`Desktop Assistant MCP` is the built-in MCP server used as the reference implementation. It runs in-process through an MCP in-memory transport and controls only safe settings for this app.

For full-fidelity local co-debugging from another AI, use the separate [Debug Bridge](DEBUG_BRIDGE.md). The Debug Bridge is disabled by default, protected by a local token, and intentionally exposes privileged session, log, reload, and settings controls.

Personal custom skills are separate from built-in system/capability skills. MCP and AI tools may save, read, search, refresh, or archive only personal skills under `data/personal-skills/`. They cannot maintain built-in skills under `packages/desktop-assistant/skills/`.

The server id is:

```text
desktop-assistant
```

The default tool prefix is:

```text
desktop_assistant
```

## Tools

### `assistant_get_settings`

Returns sanitized current settings. API keys and MCP env secrets are redacted.

Input:

```json
{}
```

### `assistant_update_settings`

Updates safe settings in one call.

Input:

```json
{
  "thinkingLevel": "high",
  "permissionMode": "tiered",
  "webSearchMode": "auto",
  "voice": {
    "enabled": true,
    "wakeWordEnabled": true,
    "wakeWord": "小派",
    "language": "zh-CN"
  },
  "memory": {
    "enabled": true,
    "maxInjected": 5,
    "autoExtract": true
  },
  "ttsEnabled": true,
  "capability": {
    "id": "system",
    "enabled": true
  }
}
```

Allowed `thinkingLevel`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

Allowed `permissionMode`: `tiered`, `automatic`, `sandbox`, `full_access`.

Allowed capability ids: `system`, `document`, `ppt`, `excel`.

Capability updates can enable/disable capabilities and tune safe capability flags, but cannot change capability `skillName` or edit system skill files.

### `assistant_set_web_search`

Sets web search mode while preserving provider credentials.

Input:

```json
{ "mode": "off" }
```

Allowed modes: `off`, `auto`, `on`.

### `assistant_set_voice`

Updates safe voice settings. STT API keys are intentionally excluded.

Input:

```json
{
  "enabled": true,
  "wakeWordEnabled": false,
  "language": "zh-CN",
  "endSilenceMs": 1000
}
```

### `assistant_set_memory`

Updates memory injection settings.

Input:

```json
{
  "enabled": true,
  "maxInjected": 5,
  "autoExtract": true
}
```

### `assistant_set_capability_enabled`

Enables or disables one Desktop Assistant capability.

Input:

```json
{
  "id": "document",
  "enabled": true
}
```

### `assistant_open_settings`

Requests the renderer to open the Settings page.

Input:

```json
{}
```

### `assistant_open_mcp_manager`

Requests the renderer to open the MCP Manager page.

Input:

```json
{}
```

### `personal_skill_search`

Searches only the project-local personal skill repository under `data/personal-skills/`.

Input:

```json
{
  "query": "playlist workflow",
  "limit": 10
}
```

### `personal_skill_read`

Reads one personal custom skill by id. It cannot read built-in system skills.

Input:

```json
{ "id": "playlist-workflow" }
```

### `personal_skill_save`

Saves a personal custom skill or handoff document under `data/personal-skills/<id>/SKILL.md`. Existing entries are not overwritten unless `overwrite` is `true`.

Input:

```json
{
  "id": "playlist-workflow",
  "title": "Playlist workflow",
  "description": "Steps for a repeated NetEase playlist task",
  "tags": ["music", "automation"],
  "content": "# Workflow\n\n1. Search playlist\n2. Verify playback",
  "overwrite": false
}
```

### `personal_skill_archive`

Archives one personal custom skill by moving it under `data/personal-skills/.archive/`. It cannot archive built-in system skills.

Input:

```json
{ "id": "playlist-workflow" }
```

### `personal_skill_refresh`

Refreshes the personal skill repository listing after manual file edits.

Input:

```json
{}
```

### `personal_skill_open_manager`

Requests the renderer to open the Personal Skill Repository page.

Input:

```json
{}
```

## Resources

### `desktop-assistant://settings/current`

Sanitized current settings JSON.

### `desktop-assistant://capabilities`

Current capability settings JSON.

### `desktop-assistant://mcp/example-config`

Minimal external stdio MCP configuration.

### `desktop-assistant://personal-skills`

Project-local personal custom skills under `data/personal-skills/`. These are not built-in system skills.

## Prompts

### `configure_desktop_assistant`

Guides an AI to inspect and safely update settings.

### `diagnose_desktop_assistant_settings`

Guides an AI to inspect why a setting or capability is not active.

### `explain_available_controls`

Guides an AI to explain which settings are controllable and which are intentionally excluded.

## Exposed tool names in Desktop Assistant

When the global MCP switch is enabled, these tools appear with the default prefix:

```text
mcp_desktop_assistant_assistant_get_settings
mcp_desktop_assistant_assistant_update_settings
mcp_desktop_assistant_assistant_set_web_search
mcp_desktop_assistant_assistant_set_voice
mcp_desktop_assistant_assistant_set_memory
mcp_desktop_assistant_assistant_set_capability_enabled
mcp_desktop_assistant_assistant_open_settings
mcp_desktop_assistant_assistant_open_mcp_manager
mcp_desktop_assistant_personal_skill_search
mcp_desktop_assistant_personal_skill_read
mcp_desktop_assistant_personal_skill_save
mcp_desktop_assistant_personal_skill_archive
mcp_desktop_assistant_personal_skill_refresh
mcp_desktop_assistant_personal_skill_open_manager
```
