import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Main-process access to the forge extension registry.
 *
 * The registry is the SAME portable JSON file that the app MCP servers' forge core
 * (mcp-servers/forge/forge-core.mjs) reads/writes. The MCP server re-reads trust/existence
 * on every forged-tool call, so trust/delete done here take effect immediately (no restart).
 *
 * Rules enforced here (user-facing side):
 *  - User can trust / reject (delete an untrusted one) / delete a FORGED tool.
 *  - Built-in (code) tools are NOT in this registry, so they can never be deleted here.
 *  - The AI never deletes — only forge_register_tool appends (handled inside forge-core).
 */

export interface ForgeExtension {
	appId: string;
	name: string;
	description: string;
	inputSchema?: Record<string, { type: "string" | "number" | "boolean"; required?: boolean; description?: string }>;
	jsBody: string;
	trusted: boolean;
	origin: "forge";
	createdBy?: string;
	createdAt?: string;
	notes?: string;
}

interface ForgeRegistryFile {
	version: number;
	extensions: ForgeExtension[];
}

const REGISTRY_RELATIVE = join("mcp-servers", "forge", "registry", "extensions.json");
const FORGE_DIR_RELATIVE = join("mcp-servers", "forge");

let cachedPath: string | undefined;

export function resolveForgeRegistryPath(): string {
	if (process.env.FORGE_REGISTRY_PATH) return process.env.FORGE_REGISTRY_PATH;
	if (cachedPath) return cachedPath;
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 12; i++) {
		for (const base of [dir, join(dir, "packages", "desktop-assistant")]) {
			const file = join(base, REGISTRY_RELATIVE);
			if (existsSync(file)) {
				cachedPath = file;
				return file;
			}
			// registry file may not exist yet; accept as long as the forge dir is present
			if (existsSync(join(base, FORGE_DIR_RELATIVE))) {
				cachedPath = join(base, REGISTRY_RELATIVE);
				return cachedPath;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	// last resort: alongside this module
	cachedPath = join(dirname(fileURLToPath(import.meta.url)), REGISTRY_RELATIVE);
	return cachedPath;
}

function load(): ForgeRegistryFile {
	try {
		const data = JSON.parse(readFileSync(resolveForgeRegistryPath(), "utf8")) as Partial<ForgeRegistryFile>;
		if (Array.isArray(data.extensions)) return { version: data.version ?? 1, extensions: data.extensions };
	} catch {
		// missing / corrupt → empty
	}
	return { version: 1, extensions: [] };
}

function save(reg: ForgeRegistryFile): void {
	const path = resolveForgeRegistryPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(reg, null, 2), "utf8");
}

export function listForgeExtensions(): ForgeExtension[] {
	return load().extensions;
}

export function setForgeExtensionTrust(appId: string, name: string, trusted: boolean): boolean {
	const reg = load();
	const ext = reg.extensions.find((e) => e.appId === appId && e.name === name);
	if (!ext) return false;
	ext.trusted = Boolean(trusted);
	save(reg);
	return true;
}

/** Delete a FORGED tool (origin === "forge"). Built-in tools are never in the registry. */
export function deleteForgeExtension(appId: string, name: string): boolean {
	const reg = load();
	const before = reg.extensions.length;
	reg.extensions = reg.extensions.filter((e) => !(e.appId === appId && e.name === name && e.origin === "forge"));
	if (reg.extensions.length === before) return false;
	save(reg);
	return true;
}
