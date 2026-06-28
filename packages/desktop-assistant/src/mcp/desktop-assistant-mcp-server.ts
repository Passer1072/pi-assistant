import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PersonalSkillRepositoryService } from "../agent/personal-skill-repository.ts";
import type {
	AutomationPermissionMode,
	DesktopAssistantSettings,
	DesktopAssistantSnapshot,
	DesktopCapabilityId,
	MemorySettings,
	VoiceSettings,
	WebSearchMode,
} from "../shared/types.ts";
import { AUTOMATION_PERMISSION_MODES } from "../shared/types.ts";

export interface DesktopAssistantMcpServerOptions {
	getSettings: () => DesktopAssistantSettings;
	updateSettings: (update: Partial<DesktopAssistantSettings>) => Promise<DesktopAssistantSnapshot>;
	requestRoute: (route: "settings" | "mcp") => void | Promise<void>;
	personalSkills?: PersonalSkillRepositoryService;
	requestPersonalSkillManager?: () => void | Promise<void>;
}

const capabilityIdSchema = z.enum(["system", "document", "ppt", "excel"]);
const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
const permissionModeSchema = z.enum(AUTOMATION_PERMISSION_MODES);
const webSearchModeSchema = z.enum(["off", "auto", "on"]);

const voiceUpdateSchema = z
	.object({
		enabled: z.boolean().optional(),
		wakeWordEnabled: z.boolean().optional(),
		wakeWord: z.string().min(1).optional(),
		language: z.string().min(2).optional(),
		postWakeWaitMs: z.number().int().min(1000).max(30000).optional(),
		endSilenceMs: z.number().int().min(300).max(5000).optional(),
		fuzzyThreshold: z.number().min(0.1).max(1).optional(),
		sttProvider: z.enum(["openai", "siliconflow", "groq", "custom"]).optional(),
		sttBaseUrl: z.string().optional(),
		sttModel: z.string().min(1).optional(),
		wakeEngine: z.enum(["kws", "auto", "openwakeword", "vosk"]).optional(),
		owwModelUrl: z.string().optional(),
		activeOwwModelId: z.string().optional(),
		owwThreshold: z.number().min(0).max(1).optional(),
		kwsSensitivity: z.number().min(0).max(1).optional(),
		kwsKeywords: z.string().optional(),
	})
	.strict();

const memoryUpdateSchema = z
	.object({
		enabled: z.boolean().optional(),
		maxInjected: z.number().int().min(0).max(20).optional(),
		autoExtract: z.boolean().optional(),
		allowExternalContextExtraction: z.boolean().optional(),
		allowAssistantDerivedFacts: z.boolean().optional(),
	})
	.strict();

const capabilityUpdateSchema = z
	.object({
		id: capabilityIdSchema,
		enabled: z.boolean().optional(),
		commandFirst: z.boolean().optional(),
	})
	.strict();

const personalSkillIdSchema = z.string().min(1).max(64);
const personalSkillSaveSchema = z
	.object({
		id: z.string().min(1).max(64).optional(),
		title: z.string().min(1),
		description: z.string().min(1),
		tags: z.array(z.string()).optional(),
		content: z.string().min(1),
		sourceSessionId: z.string().optional(),
		overwrite: z.boolean().optional(),
	})
	.strict();

const settingsUpdateSchema = z
	.object({
		thinkingLevel: thinkingLevelSchema.optional(),
		permissionMode: permissionModeSchema.optional(),
		webSearchMode: webSearchModeSchema.optional(),
		voice: voiceUpdateSchema.optional(),
		memory: memoryUpdateSchema.optional(),
		ttsEnabled: z.boolean().optional(),
		capability: capabilityUpdateSchema.optional(),
	})
	.strict();

export function createDesktopAssistantMcpServer(options: DesktopAssistantMcpServerOptions): McpServer {
	const server = new McpServer(
		{
			name: "desktop-assistant-control",
			version: "1.0.0",
		},
		{
			capabilities: {
				tools: {},
				resources: {},
				prompts: {},
			},
		},
	);

	server.registerTool(
		"assistant_get_settings",
		{
			title: "Get assistant settings",
			description:
				"Return a sanitized snapshot of Desktop Assistant settings. Secrets and API keys are never included.",
			inputSchema: {},
		},
		() => textResult({ settings: sanitizeSettings(options.getSettings()) }),
	);

	server.registerTool(
		"assistant_update_settings",
		{
			title: "Update assistant settings",
			description:
				"Update safe Desktop Assistant settings such as thinking level, permission mode, web search mode, voice, memory, TTS, or one capability. API keys cannot be changed through MCP.",
			inputSchema: settingsUpdateSchema.shape,
		},
		async (params) => {
			const update = buildSettingsUpdate(options.getSettings(), params);
			const snapshot = await options.updateSettings(update);
			return textResult({ updated: true, settings: sanitizeSettings(snapshot.settings) });
		},
	);

	server.registerTool(
		"assistant_set_web_search",
		{
			title: "Set web search mode",
			description:
				"Set web search mode to off, auto, or on while preserving the configured provider and credentials.",
			inputSchema: { mode: webSearchModeSchema },
		},
		async ({ mode }) => {
			const snapshot = await options.updateSettings({
				webSearch: { ...options.getSettings().webSearch, mode: mode as WebSearchMode },
			});
			return textResult({ updated: true, webSearch: sanitizeSettings(snapshot.settings).webSearch });
		},
	);

	server.registerTool(
		"assistant_set_voice",
		{
			title: "Set voice settings",
			description: "Update safe voice settings. STT API keys cannot be changed through MCP.",
			inputSchema: voiceUpdateSchema.shape,
		},
		async (voice) => {
			const snapshot = await options.updateSettings({
				voice: mergeVoiceSettings(options.getSettings().voice, voice),
			});
			return textResult({ updated: true, voice: sanitizeSettings(snapshot.settings).voice });
		},
	);

	server.registerTool(
		"assistant_set_memory",
		{
			title: "Set memory settings",
			description: "Enable, disable, or tune conversation memory injection.",
			inputSchema: memoryUpdateSchema.shape,
		},
		async (memory) => {
			const snapshot = await options.updateSettings({
				memory: mergeMemorySettings(options.getSettings().memory, memory),
			});
			return textResult({ updated: true, memory: snapshot.settings.memory });
		},
	);

	server.registerTool(
		"assistant_set_capability_enabled",
		{
			title: "Set capability enabled",
			description: "Enable or disable one Desktop Assistant capability such as system, document, ppt, or excel.",
			inputSchema: {
				id: capabilityIdSchema,
				enabled: z.boolean(),
			},
		},
		async ({ id, enabled }) => {
			const settings = options.getSettings();
			const capabilityId = id as DesktopCapabilityId;
			const snapshot = await options.updateSettings({
				capabilities: {
					...settings.capabilities,
					[capabilityId]: {
						...settings.capabilities[capabilityId],
						enabled,
					},
				},
			});
			return textResult({ updated: true, capability: snapshot.settings.capabilities[capabilityId] });
		},
	);

	server.registerTool(
		"assistant_set_sandbox",
		{
			title: "Tighten sandbox policy",
			description:
				"Tighten the sandbox security policy. Tightening only: you may add deny patterns / protected paths / blocked domains, set a tool gate to confirm or deny, lower the storage quota, or turn on extra restrictions. Loosening (allowlisting, disabling the sandbox, expanding roots) is rejected — the user must do that in Settings.",
			inputSchema: {
				addDenyPatterns: z.array(z.string()).optional(),
				addProtectedPaths: z.array(z.string()).optional(),
				addDomainDenyList: z.array(z.string()).optional(),
				setToolGate: z.object({ tool: z.string().min(1), gate: z.enum(["confirm", "deny"]) }).optional(),
				lowerQuotaMb: z.number().int().min(64).optional(),
				enableBlockNetworkDownload: z.boolean().optional(),
				enableConfineWrites: z.boolean().optional(),
				enableBlockPrivateIps: z.boolean().optional(),
			},
		},
		async (input) => {
			const current = options.getSettings().sandbox;
			const merge = (existing: string[], additions?: string[]) =>
				Array.from(new Set([...existing, ...(additions ?? []).map((s) => s.trim()).filter(Boolean)]));
			const next: DesktopAssistantSettings["sandbox"] = {
				...current,
				preset: "custom",
				workspace: {
					...current.workspace,
					quotaMb:
						input.lowerQuotaMb !== undefined
							? Math.min(current.workspace.quotaMb, input.lowerQuotaMb)
							: current.workspace.quotaMb,
				},
				filesystem: {
					...current.filesystem,
					protectedPaths: merge(current.filesystem.protectedPaths, input.addProtectedPaths),
					confineWritesToRoots: input.enableConfineWrites ? true : current.filesystem.confineWritesToRoots,
				},
				commands: {
					...current.commands,
					denyPatterns: merge(current.commands.denyPatterns, input.addDenyPatterns),
					blockNetworkDownload: input.enableBlockNetworkDownload ? true : current.commands.blockNetworkDownload,
				},
				network: {
					...current.network,
					domainDenyList: merge(current.network.domainDenyList, input.addDomainDenyList),
					blockPrivateIps: input.enableBlockPrivateIps ? true : current.network.blockPrivateIps,
				},
				toolGates: input.setToolGate
					? { ...current.toolGates, [input.setToolGate.tool]: input.setToolGate.gate }
					: current.toolGates,
			};
			const snapshot = await options.updateSettings({ sandbox: next });
			return textResult({ updated: true, sandbox: snapshot.settings.sandbox });
		},
	);

	server.registerTool(
		"assistant_open_settings",
		{
			title: "Open settings",
			description: "Ask Desktop Assistant to open its settings page.",
			inputSchema: {},
		},
		async () => {
			await options.requestRoute("settings");
			return textResult({ opened: true, route: "settings" });
		},
	);

	server.registerTool(
		"assistant_open_mcp_manager",
		{
			title: "Open MCP manager",
			description: "Ask Desktop Assistant to open the MCP management page.",
			inputSchema: {},
		},
		async () => {
			await options.requestRoute("mcp");
			return textResult({ opened: true, route: "mcp" });
		},
	);

	if (options.personalSkills) {
		server.registerTool(
			"personal_skill_search",
			{
				title: "Search personal skills",
				description:
					"Search the project-local personal custom skill repository under data/personal-skills. This does not search or modify built-in system skills.",
				inputSchema: {
					query: z.string(),
					limit: z.number().int().min(1).max(20).optional(),
				},
			},
			({ query, limit }) => textResult(options.personalSkills?.search(query, limit) ?? { skills: [] }),
		);

		server.registerTool(
			"personal_skill_read",
			{
				title: "Read personal skill",
				description:
					"Read one personal custom skill by id from data/personal-skills. This cannot read built-in system skills.",
				inputSchema: {
					id: personalSkillIdSchema,
				},
			},
			({ id }) => textResult(requirePersonalSkills(options).read(id)),
		);

		server.registerTool(
			"personal_skill_save",
			{
				title: "Save personal skill",
				description:
					"Save a user-customized personal skill or handoff document under data/personal-skills. AI maintenance is limited to personal skills and never modifies built-in system skills.",
				inputSchema: personalSkillSaveSchema.shape,
			},
			(params) => textResult(requirePersonalSkills(options).save(params)),
		);

		server.registerTool(
			"personal_skill_archive",
			{
				title: "Archive personal skill",
				description:
					"Archive one personal custom skill by moving it under data/personal-skills/.archive. This cannot archive built-in system skills.",
				inputSchema: {
					id: personalSkillIdSchema,
				},
			},
			({ id }) => textResult(requirePersonalSkills(options).archive(id)),
		);

		server.registerTool(
			"personal_skill_refresh",
			{
				title: "Refresh personal skills",
				description:
					"Refresh the personal skill repository listing after manual file edits. This does not reload built-in system skills.",
				inputSchema: {},
			},
			() => textResult(requirePersonalSkills(options).refresh()),
		);

		server.registerTool(
			"personal_skill_open_manager",
			{
				title: "Open personal skill manager",
				description: "Ask Desktop Assistant to open the Personal Skill Repository management page.",
				inputSchema: {},
			},
			async () => {
				await options.requestPersonalSkillManager?.();
				return textResult({ opened: true, route: "personal-skills" });
			},
		);
	}

	server.registerResource(
		"current_settings",
		"desktop-assistant://settings/current",
		{
			title: "Current Desktop Assistant settings",
			description: "Sanitized current settings snapshot.",
			mimeType: "application/json",
		},
		() => ({
			contents: [
				{
					uri: "desktop-assistant://settings/current",
					mimeType: "application/json",
					text: JSON.stringify(sanitizeSettings(options.getSettings()), null, 2),
				},
			],
		}),
	);

	server.registerResource(
		"capabilities",
		"desktop-assistant://capabilities",
		{
			title: "Desktop Assistant capabilities",
			description: "Capability ids and their current enabled state.",
			mimeType: "application/json",
		},
		() => ({
			contents: [
				{
					uri: "desktop-assistant://capabilities",
					mimeType: "application/json",
					text: JSON.stringify(options.getSettings().capabilities, null, 2),
				},
			],
		}),
	);

	server.registerResource(
		"example_config",
		"desktop-assistant://mcp/example-config",
		{
			title: "Example external MCP config",
			description: "A minimal stdio MCP configuration object accepted by Desktop Assistant.",
			mimeType: "application/json",
		},
		() => ({
			contents: [
				{
					uri: "desktop-assistant://mcp/example-config",
					mimeType: "application/json",
					text: JSON.stringify(
						{
							name: "Chrome Controller",
							enabled: true,
							transport: "stdio",
							command: "node",
							args: ["C:/path/to/chrome-mcp-server.js"],
							toolNamePrefix: "chrome",
							timeoutMs: 10000,
						},
						null,
						2,
					),
				},
			],
		}),
	);

	if (options.personalSkills) {
		server.registerResource(
			"personal_skills",
			"desktop-assistant://personal-skills",
			{
				title: "Personal skills",
				description:
					"Project-local personal custom skills under data/personal-skills. These are not built-in system skills.",
				mimeType: "application/json",
			},
			() => ({
				contents: [
					{
						uri: "desktop-assistant://personal-skills",
						mimeType: "application/json",
						text: JSON.stringify(requirePersonalSkills(options).list(), null, 2),
					},
				],
			}),
		);
	}

	server.registerPrompt(
		"configure_desktop_assistant",
		{
			title: "Configure Desktop Assistant",
			description: "Guide an AI to inspect and update safe Desktop Assistant settings through MCP tools.",
		},
		() => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: "Inspect Desktop Assistant settings, explain the relevant safe controls, then update only the settings I explicitly ask to change.",
					},
				},
			],
		}),
	);

	server.registerPrompt(
		"diagnose_desktop_assistant_settings",
		{
			title: "Diagnose Desktop Assistant settings",
			description: "Guide an AI to diagnose why a capability or mode may not be active.",
		},
		() => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: "Read the current settings and identify which toggles affect the requested Desktop Assistant behavior. Do not change settings unless asked.",
					},
				},
			],
		}),
	);

	server.registerPrompt(
		"explain_available_controls",
		{
			title: "Explain available controls",
			description: "Explain which built-in settings can be controlled by this MCP server.",
		},
		() => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: "List the Desktop Assistant settings this MCP server can control and mention that API keys are intentionally excluded.",
					},
				},
			],
		}),
	);

	return server;
}

function buildSettingsUpdate(
	current: DesktopAssistantSettings,
	params: z.infer<typeof settingsUpdateSchema>,
): Partial<DesktopAssistantSettings> {
	const update: Partial<DesktopAssistantSettings> = {};
	if (params.thinkingLevel) update.thinkingLevel = params.thinkingLevel;
	if (params.permissionMode) update.permissionMode = params.permissionMode as AutomationPermissionMode;
	if (params.webSearchMode) {
		update.webSearch = { ...current.webSearch, mode: params.webSearchMode };
	}
	if (params.voice) update.voice = mergeVoiceSettings(current.voice, params.voice);
	if (params.memory) update.memory = mergeMemorySettings(current.memory, params.memory);
	if (typeof params.ttsEnabled === "boolean") update.ttsEnabled = params.ttsEnabled;
	if (params.capability) {
		const { id, ...capabilityUpdate } = params.capability;
		update.capabilities = {
			...current.capabilities,
			[id]: {
				...current.capabilities[id],
				...capabilityUpdate,
			},
		};
	}
	return update;
}

function mergeVoiceSettings(current: VoiceSettings, update: z.infer<typeof voiceUpdateSchema>): VoiceSettings {
	return {
		...current,
		...update,
		wakeWord: update.wakeWord?.trim() || current.wakeWord,
		language: update.language?.trim() || current.language,
		sttModel: update.sttModel?.trim() || current.sttModel,
		sttBaseUrl: update.sttBaseUrl?.trim() || undefined,
		owwModelUrl: update.owwModelUrl?.trim() || current.owwModelUrl,
	};
}

function mergeMemorySettings(current: MemorySettings, update: z.infer<typeof memoryUpdateSchema>): MemorySettings {
	return {
		enabled: update.enabled ?? current.enabled,
		maxInjected: update.maxInjected ?? current.maxInjected,
		autoExtract: update.autoExtract ?? current.autoExtract,
		allowExternalContextExtraction: update.allowExternalContextExtraction ?? current.allowExternalContextExtraction,
		allowAssistantDerivedFacts: update.allowAssistantDerivedFacts ?? current.allowAssistantDerivedFacts,
	};
}

function sanitizeSettings(settings: DesktopAssistantSettings): DesktopAssistantSettings {
	return {
		...settings,
		webSearch: {
			...settings.webSearch,
			apiKey: settings.webSearch.apiKey ? "[redacted]" : undefined,
		},
		voice: {
			...settings.voice,
			sttApiKey: settings.voice.sttApiKey ? "[redacted]" : undefined,
		},
		mcp: {
			...settings.mcp,
			servers: settings.mcp.servers.map((server) => ({
				...server,
				env: server.env ? Object.fromEntries(Object.keys(server.env).map((key) => [key, "[redacted]"])) : undefined,
			})),
		},
	};
}

function requirePersonalSkills(options: DesktopAssistantMcpServerOptions): PersonalSkillRepositoryService {
	if (!options.personalSkills) {
		throw new Error("Personal skill repository is not available.");
	}
	return options.personalSkills;
}

function textResult(value: unknown): { content: [{ type: "text"; text: string }] } {
	return {
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
	};
}
