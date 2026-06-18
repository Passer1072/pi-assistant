# Desktop Assistant Renderer Structure

This renderer keeps `App.tsx` as the composition root. Feature UI, shared view helpers, and persistence utilities live in separate modules so future changes can target one surface at a time.

## Entry Point

- `App.tsx`
  - Owns top-level application state, window mode routing, voice controller lifecycle, conversation resume/delete actions, and page transition prewarm.
  - Renders the main chat/settings page stack, the MCP utility window, or the plugin utility window.
  - Should stay focused on orchestration. Move feature UI and feature-specific helpers into the folders below.

## Shared Modules

- `app-types.ts`
  - Renderer-only types shared by multiple views, such as `Route`, `StoredConversation`, and `AppWarning`.
- `app-storage.ts`
  - Local storage persistence for settings.
- `conversation-history.ts`
  - Conversation list normalization and paged history merge helpers.
- `formatters.ts`
  - Small display formatters for time, byte sizes, imported dates, and API key status text.
- `settings-view-model.ts`
  - Settings page constants and settings mutation helpers.
- `voice-ui.ts`
  - Voice state labels, voice tone mapping, and microphone status title building.

## Components And Feature Views

- `components/TitleBar.tsx`
  - Main window title bar, voice badge, web search badge, and window controls.
- `components/WarningToasts.tsx`
  - Warning toast stack used by the main app.
- `components/Drawer.tsx`
  - Conversation drawer and history list controls.
- `chat/ChatView.tsx`
  - Chat screen, composer, streaming answer display, timeline strip, tool call display, and approval panel.
- `settings/SettingsView.tsx`
  - Main settings page, including model/API key/capability/voice/web/history controls and plugin/MCP entry buttons.
- `settings/AppLaunchCacheModal.tsx`
  - Standalone app launch cache modal view.
- `mcp/McpManagerView.tsx`
  - MCP manager utility window and MCP server draft helpers.
- `plugins/PluginManagerView.tsx`
  - Generic software plugin manager utility window.

## Maintenance Notes

- Keep IPC calls inside the feature view that owns the workflow unless top-level app state must be updated.
- Keep cross-feature display helpers in shared modules only when at least two feature views use them.
- Do not move `VoiceController` lifecycle into `ChatView`; it currently coordinates global app state and wake listening, so it belongs in `App.tsx`.
- When adding a new utility window, follow the existing `WINDOW_MODE` pattern in `App.tsx` and put the window body in a feature folder.
- After changing renderer structure, run `node ../../node_modules/typescript/bin/tsc -p tsconfig.renderer.json --noEmit`, relevant Vitest files, and `npm run check`.
