import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	configureDeepSeekDefaults,
	DEEPSEEK_OFFICIAL_AUTH_PROVIDER,
	DEEPSEEK_RELAY_AUTH_PROVIDER,
	DEEPSEEK_RUNTIME_PROVIDER,
	getConfiguredDeepSeekModel,
	getDeepSeekAuthStatus,
	getDeepSeekModel,
	getDeepSeekRuntimeModelId,
	parseRelayModelsResponse,
	selectPreferredRelayModel,
	validateDeepSeekApiKey,
} from "../src/agent/deepseek.ts";
import { DesktopAgentService, normalizeSettings } from "../src/agent/desktop-agent-service.ts";
import { DryRunDesktopAutomationHost } from "../src/desktop/automation-host.ts";
import {
	DEFAULT_DEEPSEEK_RELAY_API_BASE_URL,
	normalizeDeepSeekApiBaseUrl,
	resolveDeepSeekApiConnection,
} from "../src/shared/deepseek-connection.ts";
import { DEFAULT_DESKTOP_ASSISTANT_SETTINGS } from "../src/shared/types.ts";

describe("DeepSeek desktop defaults", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("defaults token saving mode off for older settings", () => {
		expect(normalizeSettings({}).tokenSaving.enabled).toBe(false);
		expect(normalizeSettings({ tokenSaving: { enabled: true } }).tokenSaving.enabled).toBe(true);
	});

	it("defaults cross-conversation memory off for older settings", () => {
		expect(normalizeSettings({}).memory).toEqual({
			enabled: false,
			maxInjected: 5,
			autoExtract: false,
			allowExternalContextExtraction: false,
			allowAssistantDerivedFacts: false,
		});
	});

	it("normalizes and preserves explicit memory settings", () => {
		expect(
			normalizeSettings({
				memory: {
					enabled: true,
					maxInjected: 99,
					autoExtract: true,
					allowExternalContextExtraction: true,
					allowAssistantDerivedFacts: true,
				},
			}).memory,
		).toEqual({
			enabled: true,
			maxInjected: 20,
			autoExtract: true,
			allowExternalContextExtraction: true,
			allowAssistantDerivedFacts: true,
		});
	});

	it("defaults auto title generation on for older settings", () => {
		expect(normalizeSettings({}).autoTitle.enabled).toBe(true);
		expect(normalizeSettings({ autoTitle: { enabled: false } }).autoTitle.enabled).toBe(false);
	});

	it("defaults the error-self-summary experiment off for older settings", () => {
		expect(normalizeSettings({}).experimental.errorSelfSummary.enabled).toBe(false);
		expect(
			normalizeSettings({
				experimental: { errorSelfSummary: { enabled: true }, liveFlow: { enabled: false } },
			}).experimental.errorSelfSummary.enabled,
		).toBe(true);
	});

	it("persists experimental settings across service restarts", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "desktop-assistant-experimental-"));
		try {
			const service = new DesktopAgentService({
				cwd: process.cwd(),
				agentDir,
				host: new DryRunDesktopAutomationHost(),
			});

			await service.updateSettings({
				experimental: {
					errorSelfSummary: { enabled: true },
					liveFlow: { enabled: true },
				},
			});

			const restarted = new DesktopAgentService({
				cwd: process.cwd(),
				agentDir,
				host: new DryRunDesktopAutomationHost(),
			});

			expect(restarted.snapshot().settings.experimental).toEqual({
				errorSelfSummary: { enabled: true },
				liveFlow: { enabled: true },
			});
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("defaults older settings to official API connection", () => {
		expect(normalizeSettings({}).apiConnectionMode).toBe("official");
		expect(
			normalizeSettings({ apiConnectionMode: "relay", apiBaseUrl: " https://www.dreamfield.top " }),
		).toMatchObject({
			apiConnectionMode: "relay",
			apiBaseUrl: "https://www.dreamfield.top",
		});
	});

	it("normalizes relay URLs to OpenAI-compatible v1 base URLs", () => {
		expect(normalizeDeepSeekApiBaseUrl("relay", "https://www.dreamfield.top")).toBe(
			DEFAULT_DEEPSEEK_RELAY_API_BASE_URL,
		);
		expect(normalizeDeepSeekApiBaseUrl("relay", "https://www.dreamfield.top/")).toBe(
			DEFAULT_DEEPSEEK_RELAY_API_BASE_URL,
		);
		expect(normalizeDeepSeekApiBaseUrl("relay", "https://www.dreamfield.top/v1")).toBe(
			DEFAULT_DEEPSEEK_RELAY_API_BASE_URL,
		);
		expect(normalizeDeepSeekApiBaseUrl("relay", "https://www.dreamfield.top/v1/chat/completions")).toBe(
			DEFAULT_DEEPSEEK_RELAY_API_BASE_URL,
		);
	});

	it("uses built-in DeepSeek V4 models", () => {
		const pro = getDeepSeekModel("deepseek-v4-pro");
		const flash = getDeepSeekModel("deepseek-v4-flash");

		expect(pro.provider).toBe("deepseek");
		expect(pro.baseUrl).toBe("https://api.deepseek.com");
		expect(pro.compat).toMatchObject({ thinkingFormat: "deepseek" });
		expect(flash.provider).toBe("deepseek");
	});

	it("uses discovered relay model IDs directly", () => {
		expect(getDeepSeekRuntimeModelId("official", "deepseek-v4-pro")).toBe("deepseek-v4-pro");
		expect(getDeepSeekRuntimeModelId("official", "deepseek-v4-flash")).toBe("deepseek-v4-flash");
		expect(getDeepSeekRuntimeModelId("relay", "Deepseek-v4-flash")).toBe("Deepseek-v4-flash");
	});

	it("parses relay model discovery responses", () => {
		const models = parseRelayModelsResponse({
			data: [
				{
					id: "Deepseek-v4-pro",
					owned_by: "newapi",
					supported_endpoint_types: ["openai", "anthropic"],
				},
				{
					id: "Deepseek-v4-flash",
					owned_by: "newapi",
					supported_endpoint_types: ["openai"],
				},
			],
		});

		expect(models).toEqual([
			{
				id: "Deepseek-v4-pro",
				label: "Deepseek-v4-pro",
				ownedBy: "newapi",
				supportedEndpointTypes: ["openai", "anthropic"],
			},
			{
				id: "Deepseek-v4-flash",
				label: "Deepseek-v4-flash",
				ownedBy: "newapi",
				supportedEndpointTypes: ["openai"],
			},
		]);
		expect(selectPreferredRelayModel(models)?.id).toBe("Deepseek-v4-pro");
	});

	it("keeps API keys out of source-backed config", async () => {
		const authStorage = AuthStorage.inMemory();
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const previous = process.env.DEEPSEEK_API_KEY;
		process.env.DEEPSEEK_API_KEY = "test-runtime-key";

		try {
			const model = await configureDeepSeekDefaults(modelRegistry, authStorage, DEFAULT_DESKTOP_ASSISTANT_SETTINGS);
			const status = getDeepSeekAuthStatus(authStorage, DEFAULT_DESKTOP_ASSISTANT_SETTINGS);

			expect(model.id).toBe("deepseek-v4-pro");
			expect(model.provider).toBe(DEEPSEEK_RUNTIME_PROVIDER);
			expect(status.needsRotationWarning).toBe(true);
			expect(authStorage.get("deepseek")).toBeUndefined();
			expect(authStorage.getAuthStatus(DEEPSEEK_RUNTIME_PROVIDER).source).toBe("runtime");
		} finally {
			if (previous === undefined) {
				delete process.env.DEEPSEEK_API_KEY;
			} else {
				process.env.DEEPSEEK_API_KEY = previous;
			}
		}
	});

	it("applies relay base URL to runtime DeepSeek models", async () => {
		const authStorage = AuthStorage.inMemory();
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const relaySettings = normalizeSettings({
			...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
			apiConnectionMode: "relay",
			apiBaseUrl: "https://www.dreamfield.top",
			modelId: "DeepSeek-V4-Pro",
			deepseekRelayModels: [{ id: "DeepSeek-V4-Pro", label: "DeepSeek-V4-Pro" }],
		});

		const relayModel = await configureDeepSeekDefaults(modelRegistry, authStorage, relaySettings);
		expect(relayModel.id).toBe("DeepSeek-V4-Pro");
		expect(relayModel.api).toBe("openai-completions");
		expect(relayModel.baseUrl).toBe(DEFAULT_DEEPSEEK_RELAY_API_BASE_URL);
		expect(relayModel.provider).toBe(DEEPSEEK_RUNTIME_PROVIDER);
		expect(getConfiguredDeepSeekModel(modelRegistry, relaySettings)).toMatchObject({
			id: "DeepSeek-V4-Pro",
			api: "openai-completions",
			baseUrl: DEFAULT_DEEPSEEK_RELAY_API_BASE_URL,
		});

		const officialModel = await configureDeepSeekDefaults(
			modelRegistry,
			authStorage,
			normalizeSettings({ ...DEFAULT_DESKTOP_ASSISTANT_SETTINGS, apiConnectionMode: "official" }),
		);
		expect(officialModel.id).toBe("deepseek-v4-pro");
		expect(officialModel.baseUrl).toBe("https://api.deepseek.com");

		modelRegistry.registerProvider(DEEPSEEK_RUNTIME_PROVIDER, { baseUrl: "https://stale.example.com/v1" });
		const restoredOfficialModel = await configureDeepSeekDefaults(
			modelRegistry,
			authStorage,
			normalizeSettings({ ...DEFAULT_DESKTOP_ASSISTANT_SETTINGS, apiConnectionMode: "official" }),
		);
		expect(restoredOfficialModel.id).toBe("deepseek-v4-pro");
		expect(restoredOfficialModel.baseUrl).toBe("https://api.deepseek.com");
	});

	it("applies discovered relay model IDs to runtime models", async () => {
		const authStorage = AuthStorage.inMemory();
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const relaySettings = normalizeSettings({
			...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
			apiConnectionMode: "relay",
			apiBaseUrl: "https://ai.yxkl.cloud",
			modelId: "Deepseek-v4-flash",
			deepseekRelayModels: [
				{ id: "Deepseek-v4-pro", label: "Deepseek-v4-pro" },
				{ id: "Deepseek-v4-flash", label: "Deepseek-v4-flash" },
			],
		});

		const relayModel = await configureDeepSeekDefaults(modelRegistry, authStorage, relaySettings);
		expect(relayModel.id).toBe("Deepseek-v4-flash");
	});

	it("validates API keys against the selected connection URL", async () => {
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			if (String(url).endsWith("/models")) {
				return new Response(
					JSON.stringify({
						data: [
							{ id: "Deepseek-v4-pro", supported_endpoint_types: ["openai", "anthropic"] },
							{ id: "Deepseek-v4-flash", supported_endpoint_types: ["openai"] },
						],
					}),
					{ status: 200 },
				);
			}
			return new Response("{}", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const discoveredModels = await validateDeepSeekApiKey(
			"test-key",
			resolveDeepSeekApiConnection(
				normalizeSettings({
					...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
					apiConnectionMode: "relay",
					apiBaseUrl: "https://ai.yxkl.cloud",
				}),
			),
			undefined,
		);

		expect(discoveredModels).toEqual([
			{
				id: "Deepseek-v4-pro",
				label: "Deepseek-v4-pro",
				ownedBy: undefined,
				supportedEndpointTypes: ["openai", "anthropic"],
			},
			{
				id: "Deepseek-v4-flash",
				label: "Deepseek-v4-flash",
				ownedBy: undefined,
				supportedEndpointTypes: ["openai"],
			},
		]);
		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			"https://ai.yxkl.cloud/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
			}),
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"https://ai.yxkl.cloud/v1/chat/completions",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
				body: JSON.stringify({
					model: "Deepseek-v4-pro",
					messages: [{ role: "user", content: "Reply exactly: ok" }],
					max_tokens: 2,
					temperature: 0,
					stream: false,
				}),
			}),
		);
	});

	it("persists validated API keys for the next launch", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "desktop-assistant-auth-"));
		try {
			const service = new DesktopAgentService({
				cwd: process.cwd(),
				agentDir,
				host: new DryRunDesktopAutomationHost(),
				validateApiKey: async () => undefined,
			});

			const snapshot = await service.updateApiKey("persisted-test-key");

			expect(snapshot.apiKeyStatus.state).toBe("valid");
			expect(snapshot.authStatus.configured).toBe(true);
			expect(snapshot.authStatus.source).toBe("stored");
			expect(service.getAuthStorage().get(DEEPSEEK_OFFICIAL_AUTH_PROVIDER)).toMatchObject({
				type: "api_key",
				key: "persisted-test-key",
			});
			expect(service.getAuthStorage().get("deepseek")).toBeUndefined();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("passes relay connection settings when saving API keys", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "desktop-assistant-relay-auth-"));
		try {
			const validateApiKey = vi.fn(async () => [
				{ id: "Deepseek-v4-pro", label: "Deepseek-v4-pro" },
				{ id: "Deepseek-v4-flash", label: "Deepseek-v4-flash" },
			]);
			const service = new DesktopAgentService({
				cwd: process.cwd(),
				agentDir,
				host: new DryRunDesktopAutomationHost(),
				settings: {
					...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
					apiConnectionMode: "relay",
					apiBaseUrl: "https://www.dreamfield.top",
				},
				validateApiKey,
			});

			const snapshot = await service.updateApiKey("relay-test-key");

			expect(service.getAuthStorage().get(DEEPSEEK_RELAY_AUTH_PROVIDER)).toMatchObject({
				type: "api_key",
				key: "relay-test-key",
			});
			expect(service.getAuthStorage().get(DEEPSEEK_OFFICIAL_AUTH_PROVIDER)).toBeUndefined();
			expect(snapshot.settings.modelId).toBe("Deepseek-v4-pro");
			expect(snapshot.settings.deepseekRelayModels).toEqual([
				{ id: "Deepseek-v4-pro", label: "Deepseek-v4-pro" },
				{ id: "Deepseek-v4-flash", label: "Deepseek-v4-flash" },
			]);
			expect(validateApiKey).toHaveBeenCalledWith(
				"relay-test-key",
				{
					mode: "relay",
					baseUrl: DEFAULT_DEEPSEEK_RELAY_API_BASE_URL,
				},
				expect.any(AbortSignal),
			);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("stores official and relay API keys independently and hot-switches the runtime key", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "desktop-assistant-auth-switch-"));
		try {
			const service = new DesktopAgentService({
				cwd: process.cwd(),
				agentDir,
				host: new DryRunDesktopAutomationHost(),
				validateApiKey: async () => undefined,
			});

			await service.updateApiKey("official-test-key");
			expect(service.getAuthStorage().get(DEEPSEEK_OFFICIAL_AUTH_PROVIDER)).toMatchObject({
				type: "api_key",
				key: "official-test-key",
			});
			expect(await service.getAuthStorage().getApiKey(DEEPSEEK_RUNTIME_PROVIDER)).toBe("official-test-key");

			await service.updateSettings({ apiConnectionMode: "relay", apiBaseUrl: "https://www.dreamfield.top" });
			expect(service.snapshot().authStatus.configured).toBe(false);
			expect(await service.getAuthStorage().getApiKey(DEEPSEEK_RUNTIME_PROVIDER)).toBeUndefined();

			await service.updateApiKey("relay-test-key");
			expect(service.getAuthStorage().get(DEEPSEEK_RELAY_AUTH_PROVIDER)).toMatchObject({
				type: "api_key",
				key: "relay-test-key",
			});
			expect(await service.getAuthStorage().getApiKey(DEEPSEEK_RUNTIME_PROVIDER)).toBe("relay-test-key");

			await service.updateSettings({ apiConnectionMode: "official" });
			expect(service.snapshot().authStatus.configured).toBe(true);
			expect(await service.getAuthStorage().getApiKey(DEEPSEEK_RUNTIME_PROVIDER)).toBe("official-test-key");
			expect(service.getAuthStorage().get(DEEPSEEK_RELAY_AUTH_PROVIDER)).toMatchObject({
				type: "api_key",
				key: "relay-test-key",
			});
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("initializes and hot-toggles conversation thinking independently from settings defaults", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "desktop-assistant-thinking-"));
		try {
			const service = new DesktopAgentService({
				cwd: process.cwd(),
				agentDir,
				host: new DryRunDesktopAutomationHost(),
				settings: {
					...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
					thinkingLevel: "medium",
				},
			});

			await service.initialize();
			expect(service.snapshot().conversationThinking).toMatchObject({
				enabled: true,
				effectiveLevel: "medium",
				supported: true,
			});

			await service.updateConversationThinking(false);
			expect(service.snapshot().conversationThinking).toMatchObject({
				enabled: false,
				effectiveLevel: "off",
			});

			await service.updateConversationThinking(true);
			expect(service.snapshot().conversationThinking).toMatchObject({
				enabled: true,
				effectiveLevel: "high",
			});

			await service.updateSettings({ thinkingLevel: "low" });
			expect(service.snapshot().conversationThinking).toMatchObject({
				enabled: true,
				effectiveLevel: "high",
			});

			await service.newConversation();
			expect(service.snapshot().conversationThinking).toMatchObject({
				enabled: true,
				effectiveLevel: "low",
			});
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
