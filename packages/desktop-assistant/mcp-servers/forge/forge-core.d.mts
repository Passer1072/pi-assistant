import type { z } from "zod";

export interface ForgeExtension {
	appId: string;
	name: string;
	description: string;
	inputSchema?: Record<string, { type: "string" | "number" | "boolean"; required?: boolean; description?: string }>;
	jsBody: string;
	trusted: boolean;
	origin: string;
	createdBy: string;
	createdAt: string;
	notes?: string;
}

export interface ForgeServerLike {
	registerTool(
		name: string,
		definition: {
			title?: string;
			description?: string;
			inputSchema?: Record<string, z.ZodType> | Record<string, never>;
		},
		handler: (args: unknown) => Promise<unknown>,
	): void;
}

export interface ForgeOptions {
	appId: string;
	evalInApp: (js: string) => Promise<unknown>;
	ensureReady: () => Promise<unknown>;
	builtinToolNames?: string[];
}

export interface Forge {
	appId: string;
	listExtensions(): ForgeExtension[];
	registerStoredExtensions(server: ForgeServerLike): void;
	registerMetaTools(server: ForgeServerLike): void;
}

export function registryPath(): string;
export function loadRegistry(): { version: 1; extensions: ForgeExtension[] };
export function createForge(options: ForgeOptions): Forge;
export function listAllExtensions(): ForgeExtension[];
export function setExtensionTrust(appId: string, name: string, trusted: boolean): boolean;
export function deleteExtension(appId: string, name: string): boolean;
export function ensureRegistryFile(): void;
