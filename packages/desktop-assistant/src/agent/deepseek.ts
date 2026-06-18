import { type Api, getModel, type Model } from "@earendil-works/pi-ai";
import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	type DeepSeekApiConnection,
	normalizeApiConnectionMode,
	normalizeDeepSeekRelayModelId,
	resolveDeepSeekApiConnection,
} from "../shared/deepseek-connection.ts";
import type {
	ApiConnectionMode,
	DeepSeekRelayModelOption,
	DesktopAssistantSettings,
	DesktopAuthStatus,
} from "../shared/types.ts";

export const DEEPSEEK_PROVIDER = "deepseek";
export const DEEPSEEK_RUNTIME_PROVIDER = "desktop-deepseek";
export const DEEPSEEK_OFFICIAL_AUTH_PROVIDER = "deepseek-official";
export const DEEPSEEK_RELAY_AUTH_PROVIDER = "deepseek-relay";
export const DEEPSEEK_PRO_MODEL = "deepseek-v4-pro";
export const DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";

export type DeepSeekModelId = typeof DEEPSEEK_PRO_MODEL | typeof DEEPSEEK_FLASH_MODEL;

export function isDeepSeekModelId(modelId: string): modelId is DeepSeekModelId {
	return modelId === DEEPSEEK_PRO_MODEL || modelId === DEEPSEEK_FLASH_MODEL;
}

export function getDeepSeekModel(modelId: DesktopAssistantSettings["modelId"]): Model<Api> {
	if (!isDeepSeekModelId(modelId)) {
		throw new Error(`Unsupported DeepSeek model: ${modelId}`);
	}
	const model = getModel(DEEPSEEK_PROVIDER, modelId);
	if (!model) {
		throw new Error(`DeepSeek model not found: ${modelId}`);
	}
	return model as Model<Api>;
}

export function getDeepSeekAuthProvider(settings: DesktopAssistantSettings): string {
	return normalizeApiConnectionMode(settings.apiConnectionMode) === "relay"
		? DEEPSEEK_RELAY_AUTH_PROVIDER
		: DEEPSEEK_OFFICIAL_AUTH_PROVIDER;
}

export function getDeepSeekRuntimeModelId(mode: ApiConnectionMode, modelId: string): string {
	if (normalizeApiConnectionMode(mode) === "relay") {
		const normalizedRelayModelId = normalizeDeepSeekRelayModelId(modelId);
		if (!normalizedRelayModelId) {
			throw new Error("Relay DeepSeek model is required");
		}
		return normalizedRelayModelId;
	}
	if (!isDeepSeekModelId(modelId)) {
		throw new Error(`Unsupported DeepSeek model: ${modelId}`);
	}
	return modelId;
}

export async function syncDeepSeekRuntimeAuth(
	authStorage: AuthStorage,
	settings: DesktopAssistantSettings,
): Promise<void> {
	authStorage.removeRuntimeApiKey(DEEPSEEK_PROVIDER);
	authStorage.removeRuntimeApiKey(DEEPSEEK_RUNTIME_PROVIDER);
	const authProvider = getDeepSeekAuthProvider(settings);
	const key = await authStorage.getApiKey(authProvider, { includeFallback: false });
	if (key) {
		authStorage.setRuntimeApiKey(DEEPSEEK_RUNTIME_PROVIDER, key);
		return;
	}

	if (authProvider === DEEPSEEK_OFFICIAL_AUTH_PROVIDER) {
		const legacyCredential = authStorage.get(DEEPSEEK_PROVIDER);
		if (legacyCredential?.type === "api_key") {
			const legacyKey = await authStorage.getApiKey(DEEPSEEK_PROVIDER, { includeFallback: false });
			authStorage.set(DEEPSEEK_OFFICIAL_AUTH_PROVIDER, legacyCredential);
			authStorage.remove(DEEPSEEK_PROVIDER);
			if (legacyKey) {
				authStorage.setRuntimeApiKey(DEEPSEEK_RUNTIME_PROVIDER, legacyKey);
				return;
			}
		}
	}

	if (authProvider === DEEPSEEK_OFFICIAL_AUTH_PROVIDER && process.env.DEEPSEEK_API_KEY) {
		authStorage.setRuntimeApiKey(DEEPSEEK_RUNTIME_PROVIDER, process.env.DEEPSEEK_API_KEY);
		return;
	}
}

export async function configureDeepSeekDefaults(
	modelRegistry: ModelRegistry,
	authStorage: AuthStorage,
	settings: DesktopAssistantSettings,
): Promise<Model<Api>> {
	await syncDeepSeekRuntimeAuth(authStorage, settings);
	applyDeepSeekConnection(modelRegistry, settings);
	const connection = resolveDeepSeekApiConnection(settings);
	const registered = modelRegistry.find(
		DEEPSEEK_RUNTIME_PROVIDER,
		getDeepSeekRuntimeModelId(connection.mode, settings.modelId),
	);
	if (!registered) {
		throw new Error(`DeepSeek model registry entry missing: ${settings.modelId}`);
	}
	return registered;
}

export function applyDeepSeekConnection(modelRegistry: ModelRegistry, settings: DesktopAssistantSettings): void {
	const connection = resolveDeepSeekApiConnection(settings);
	const sourceModels =
		connection.mode === "relay"
			? buildRelayRuntimeModels(settings, connection)
			: [getDeepSeekModel(DEEPSEEK_PRO_MODEL), getDeepSeekModel(DEEPSEEK_FLASH_MODEL)];
	modelRegistry.registerProvider(DEEPSEEK_RUNTIME_PROVIDER, {
		name: "DeepSeek Desktop Assistant",
		baseUrl: connection.baseUrl,
		apiKey: "$DESKTOP_ASSISTANT_DEEPSEEK_API_KEY",
		models: sourceModels,
	});
}

function buildRelayRuntimeModels(settings: DesktopAssistantSettings, connection: DeepSeekApiConnection): Model<Api>[] {
	const proTemplate = getDeepSeekModel(DEEPSEEK_PRO_MODEL);
	const flashTemplate = getDeepSeekModel(DEEPSEEK_FLASH_MODEL);
	const relayModels = settings.deepseekRelayModels ?? [];
	const configuredModelId = normalizeDeepSeekRelayModelId(settings.modelId);
	const ids = relayModels.map((model) => normalizeDeepSeekRelayModelId(model.id)).filter((id): id is string => !!id);
	const runtimeIds = ids.length > 0 ? ids : configuredModelId ? [configuredModelId] : [];
	return runtimeIds.map((id) => {
		const option = relayModels.find((model) => model.id === id);
		const template = /flash/i.test(id) ? flashTemplate : proTemplate;
		return {
			id,
			name: option?.label || id,
			api: "openai-completions" as const,
			provider: DEEPSEEK_RUNTIME_PROVIDER,
			baseUrl: connection.baseUrl,
			reasoning: template.reasoning ?? false,
			thinkingLevelMap: template.thinkingLevelMap,
			input: template.input ?? ["text"],
			cost: template.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: template.contextWindow ?? 128000,
			maxTokens: template.maxTokens ?? 8192,
			headers: template.headers,
			compat: {
				...(template.compat ?? {}),
				supportsStore: false,
				maxTokensField: "max_tokens" as const,
			},
		} satisfies Model<"openai-completions">;
	});
}

export function getConfiguredDeepSeekModel(
	modelRegistry: ModelRegistry,
	settings: DesktopAssistantSettings,
): Model<Api> {
	applyDeepSeekConnection(modelRegistry, settings);
	const connection = resolveDeepSeekApiConnection(settings);
	const model = modelRegistry.find(
		DEEPSEEK_RUNTIME_PROVIDER,
		getDeepSeekRuntimeModelId(connection.mode, settings.modelId),
	);
	if (!model) {
		throw new Error(`DeepSeek model registry entry missing: ${settings.modelId}`);
	}
	return model;
}

export function getDeepSeekAuthStatus(authStorage: AuthStorage, settings: DesktopAssistantSettings): DesktopAuthStatus {
	const authProvider = getDeepSeekAuthProvider(settings);
	const status = authStorage.getAuthStatus(authProvider);
	const legacyStatus =
		authProvider === DEEPSEEK_OFFICIAL_AUTH_PROVIDER && !status.configured && !status.source
			? authStorage.getAuthStatus(DEEPSEEK_PROVIDER)
			: undefined;
	const envStatus =
		authProvider === DEEPSEEK_OFFICIAL_AUTH_PROVIDER &&
		!status.configured &&
		!status.source &&
		process.env.DEEPSEEK_API_KEY
			? ({ configured: false, source: "environment", label: "DEEPSEEK_API_KEY" } as const)
			: undefined;
	const effectiveStatus =
		legacyStatus?.source || legacyStatus?.configured ? legacyStatus : envStatus?.source ? envStatus : status;
	return {
		configured: effectiveStatus.configured,
		source: effectiveStatus.source ?? effectiveStatus.label,
		needsRotationWarning: true,
	};
}

export async function validateDeepSeekApiKey(
	apiKey: string,
	connection: DeepSeekApiConnection,
	signal?: AbortSignal,
): Promise<DeepSeekRelayModelOption[] | undefined> {
	const relayModels =
		connection.mode === "relay" ? await fetchDeepSeekRelayModels(apiKey, connection, signal) : undefined;
	const model =
		connection.mode === "relay"
			? selectPreferredRelayModel(relayModels ?? [])?.id
			: getDeepSeekRuntimeModelId(connection.mode, DEEPSEEK_FLASH_MODEL);
	if (!model) {
		throw new Error("DeepSeek API validation failed: relay returned no available models");
	}
	const response = await fetch(`${connection.baseUrl}/chat/completions`, {
		method: "POST",
		signal,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "Reply exactly: ok" }],
			max_tokens: 2,
			temperature: 0,
			stream: false,
		}),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`DeepSeek API validation failed: HTTP ${response.status}${body ? ` ${body.slice(0, 180)}` : ""}`);
	}
	return relayModels;
}

export async function fetchDeepSeekRelayModels(
	apiKey: string,
	connection: DeepSeekApiConnection,
	signal?: AbortSignal,
): Promise<DeepSeekRelayModelOption[]> {
	const response = await fetch(`${connection.baseUrl}/models`, {
		method: "GET",
		signal,
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`DeepSeek model discovery failed: HTTP ${response.status}${body ? ` ${body.slice(0, 180)}` : ""}`,
		);
	}
	const payload = (await response.json()) as unknown;
	return parseRelayModelsResponse(payload);
}

export function parseRelayModelsResponse(payload: unknown): DeepSeekRelayModelOption[] {
	if (typeof payload !== "object" || payload === null) return [];
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data)) return [];
	const seen = new Set<string>();
	const models: DeepSeekRelayModelOption[] = [];
	for (const item of data) {
		const record = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : undefined;
		const rawId = typeof item === "string" ? item : typeof record?.id === "string" ? record.id : undefined;
		const id = normalizeDeepSeekRelayModelId(rawId);
		if (!id || seen.has(id)) continue;
		const supportedEndpointTypes = Array.isArray(record?.supported_endpoint_types)
			? record.supported_endpoint_types.filter((value): value is string => typeof value === "string")
			: Array.isArray(record?.supportedEndpointTypes)
				? record.supportedEndpointTypes.filter((value): value is string => typeof value === "string")
				: undefined;
		if (
			supportedEndpointTypes &&
			supportedEndpointTypes.length > 0 &&
			!supportedEndpointTypes.some((value) => value.toLowerCase() === "openai")
		) {
			continue;
		}
		seen.add(id);
		models.push({
			id,
			label: typeof record?.name === "string" && record.name.trim() ? record.name.trim() : id,
			ownedBy:
				typeof record?.owned_by === "string"
					? record.owned_by
					: typeof record?.ownedBy === "string"
						? record.ownedBy
						: undefined,
			supportedEndpointTypes,
		});
	}
	return models;
}

export function selectPreferredRelayModel(
	models: readonly DeepSeekRelayModelOption[],
): DeepSeekRelayModelOption | undefined {
	return models[0];
}
