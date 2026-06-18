import type { AutomationPermissionMode, AutomationRiskLevel } from "../shared/types.ts";

const HIGH_RISK_PATTERNS = [
	/\bshutdown\b/i,
	/\brestart\b/i,
	/\bformat\b/i,
	/\bremove-item\b/i,
	/\brm\s+-/i,
	/\bdel(?:ete)?\b/i,
	/\bsudo\b/i,
	/\bwinget\s+(install|uninstall|upgrade)\b/i,
	/\breg\s+(add|delete|import)\b/i,
	/\bnet\s+user\b/i,
	/\bbitlocker\b/i,
	/\bfirewall\b/i,
	/\bpayment\b/i,
	/\bpassword\b/i,
	/\bprivacy\b/i,
	/\bclear-recyclebin\b/i,
];

const MEDIUM_RISK_PATTERNS = [
	/\bset-executionpolicy\b/i,
	/\bstart-process\b/i,
	/\bnew-item\b/i,
	/\bcopy-item\b/i,
	/\bmove-item\b/i,
	/\bsettings\b/i,
	/\bcontrol\b/i,
];

export function classifyAutomationRisk(text: string): AutomationRiskLevel {
	if (HIGH_RISK_PATTERNS.some((pattern) => pattern.test(text))) {
		return "high";
	}
	if (MEDIUM_RISK_PATTERNS.some((pattern) => pattern.test(text))) {
		return "medium";
	}
	return "low";
}

export function requiresConfirmation(riskLevel: AutomationRiskLevel, mode: AutomationPermissionMode): boolean {
	if (mode === "full_access") {
		return false;
	}
	if (mode === "sandbox") {
		return true;
	}
	if (mode === "automatic") {
		return riskLevel === "high";
	}
	return riskLevel === "high";
}
