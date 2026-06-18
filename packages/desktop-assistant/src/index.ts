export { getDeepSeekAuthStatus, getDeepSeekModel } from "./agent/deepseek.ts";
export { DesktopAgentService } from "./agent/desktop-agent-service.ts";
export { DryRunDesktopAutomationHost, WindowsDesktopAutomationHost } from "./desktop/automation-host.ts";
export { PowerShellService } from "./desktop/powershell-service.ts";
export { createDesktopToolDefinitions } from "./desktop/tools.ts";
export type * from "./shared/types.ts";
export { VoiceBridge } from "./voice/voice-bridge.ts";
