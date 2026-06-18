---
name: system-operation
description: Windows system operation capability for controlling the desktop through background commands, system APIs, safe PowerShell, process launch, window control, and GUI automation when needed.
---

# System Operation Capability

Use this skill whenever the user asks to control the Windows desktop, system settings, apps, windows, audio, display, input, files, shell tasks, or other OS-level behavior.

## Operating Policy

- Prefer direct background commands, Windows APIs, PowerShell, process launch, or dedicated desktop tools over opening visible Settings pages.
- Open Windows Settings only when the user explicitly asks to view a settings page, or when no direct background operation is available.
- Use dedicated tools first when they match the task:
  - `find_app` to search installed applications by partial name before attempting to launch.
  - `open_app` for launching applications once the name or path is known.
  - `set_audio_device_or_volume` for mute, unmute, and volume changes.
  - `window_control` and `get_screen_context` for window inspection and focus planning.
  - `desktop_observe` to inspect the active window and visible windows before and after GUI automation.
  - `media_control` for play, pause, next, previous, and system media playback commands.
  - `app_interaction` for supported high-level app workflows such as NetEase Cloud Music search/play.
  - `shell_command_safe` for low-risk Windows operations without a dedicated tool.
  - `keyboard_mouse` only after command/API options are insufficient or the task requires GUI interaction.
- Treat low-risk system operations as executable directly under the configured permission mode.
- Respect confirmation gates for shutdown, restart, delete, install/uninstall, account, privacy, payment, credential, firewall, registry, and other high-risk actions.
- Report progress and results as concise user-visible steps. Do not expose private chain of thought.

## Tool Selection Matrix

- System settings: use dedicated tools such as `set_audio_device_or_volume` and `set_display_brightness_or_scale`; use `open_windows_settings` only as a fallback or when the user asks to view Settings.
- App launch: use `open_app` for known names and `find_app` when the launch target is uncertain.
- Window state: use `desktop_observe`, `get_screen_context`, and `window_control focus` before raw keyboard or mouse input.
- Media playback: use `media_control` or `app_interaction` first. Do not use `keyboard_mouse` spacebar as the first or only playback action.
- Raw GUI automation: use `keyboard_mouse` only after observing/focusing the target window and when no direct or high-level tool covers the task.

## Execution Loop

For computer-control tasks, follow this loop:

1. Plan the direct tool path from the user's target.
2. Observe relevant desktop/window state when the current UI matters.
3. Execute the most specific tool available.
4. Verify the result from tool output or desktop state.
5. If confidence is low, use the tool's `nextActions` or a fallback tool before claiming completion.

## Media Playback

When the user asks to play music or control playback:

- Prefer `app_interaction` for supported players, especially NetEase Cloud Music song search/play.
- Use `media_control` for play, pause, next, previous, and global playback commands.
- After any playback command, verify with `desktop_observe`, `get_screen_context`, or the structured tool result.
- Never claim that music is playing merely because `keyboard_mouse` pressed space. A key press is only an input event, not proof of playback.
- If verification confidence is low, say what was attempted and continue with a fallback such as focusing the player, using `media_control play`, or retrying `app_interaction` with the exact song/artist.

## Opening Applications — Step-by-Step

Use this flow whenever the user asks to open, launch, or start an application:

0. **Prefer `open_app` for known/common names because it has persistent launch memory.**
   `open_app` can resolve previously learned aliases from `app-launch-cache.json` and automatically falls back to search when a remembered launch path becomes stale. For apps the user has opened before, call `open_app` directly with the user's app name.

1. **Try the common exe name directly first.**
   Call `open_app` with the familiar exe/app name: `notepad`, `chrome`, `code`, `steam`, `vlc`.
   Built-in system tools always work by name: `calc`, `mspaint`, `taskmgr`, `explorer`.

2. **If the first attempt fails, immediately call `find_app` — do not give up.**
   Use the app's **native/displayed name** as the query, especially for Chinese apps:
   - User says "打开微信" → query: `微信`  (NOT "WeChat")
   - User says "打开钉钉" → query: `钉钉`  (NOT "DingTalk")
   - User says "打开剪映" → query: `剪映`
   - User says "open WeChat" → query: `WeChat` (also try `微信` if first fails)
   - User says "open VS Code" → query: `Visual Studio Code`

   `find_app` searches:
   - Desktop shortcuts (user + public)
   - Start Menu shortcuts (user + common)
   - Installed app list (Store/UWP via Get-StartApps)
   - Registry uninstall entries
   - Program Files, user install directories, common Chinese app paths

3. **If the first `find_app` query returns no results, try alternate names.**
   - Try both Chinese and English: "微信" then "WeChat"
   - Try the publisher/vendor name: "Tencent", "网易", "字节跳动"
   - Try the exe base name: "WeChatApp", "DingTalk"

4. **Use the `launch` value from results directly — do not modify it.**
   - `kind: "lnk"` — Start Menu / Desktop shortcut path → pass to `open_app` as-is
   - `kind: "app"` — `shell:AppsFolder\AppId` for Store/UWP apps → pass to `open_app` as-is
   - `kind: "installed"` / `kind: "exe"` — full `.exe` path → pass to `open_app` as-is

5. **After launch, `open_app` verifies the window appeared.**
   If verification fails, inform the user the app may still be loading.

6. **Never claim an app was opened without a successful tool call.**
   If all `find_app` attempts fail, tell the user honestly and ask them to confirm the app name
   or provide the installation path.

## Execution Style

1. Identify the user intent and choose the most direct system operation path.
2. Prefer a background command or dedicated tool.
3. Use screen/window context only when the current UI state matters.
4. Fall back to Settings or GUI automation only when direct execution is unavailable.
5. Summarize what was changed and whether any confirmation is waiting.
