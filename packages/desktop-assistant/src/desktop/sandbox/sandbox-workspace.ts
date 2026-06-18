import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Real OS paths the sandbox path-tokens (<documents>, <sandbox>, …) resolve to.
 * The main process fills this in (via Electron `app.getPath`); tests construct it
 * directly. Keeping resolution data-driven keeps the rest of the engine pure and
 * machine-independent.
 */
export interface SandboxPathContext {
	sandboxRoot: string;
	tempDir: string;
	home: string;
	documents: string;
	desktop: string;
	downloads: string;
	/** Directory where prompt attachments are extracted. */
	attachments: string;
	windows: string;
	system32: string;
	programFiles: string;
	programFilesX86: string;
	/** App install/resources dir (built-in skills) — always protected. */
	appResources: string;
}

const TOKEN_KEYS: Record<string, keyof SandboxPathContext> = {
	"<sandbox>": "sandboxRoot",
	"<temp>": "tempDir",
	"<home>": "home",
	"<userprofile>": "home",
	"<documents>": "documents",
	"<desktop>": "desktop",
	"<downloads>": "downloads",
	"<attachments>": "attachments",
	"<windows>": "windows",
	"<system32>": "system32",
	"<programfiles>": "programFiles",
	"<programfiles86>": "programFilesX86",
	"<appresources>": "appResources",
};

/** Build a path context from the OS, allowing callers to override known dirs. */
export function buildSandboxPathContext(
	overrides: Partial<SandboxPathContext> & Pick<SandboxPathContext, "sandboxRoot">,
): SandboxPathContext {
	const home = overrides.home ?? os.homedir();
	const windows = overrides.windows ?? process.env.SystemRoot ?? "C:\\Windows";
	return {
		sandboxRoot: overrides.sandboxRoot,
		tempDir: overrides.tempDir ?? path.join(overrides.sandboxRoot, "tmp"),
		home,
		documents: overrides.documents ?? path.join(home, "Documents"),
		desktop: overrides.desktop ?? path.join(home, "Desktop"),
		downloads: overrides.downloads ?? path.join(home, "Downloads"),
		attachments: overrides.attachments ?? path.join(overrides.sandboxRoot, "attachments"),
		windows,
		system32: overrides.system32 ?? path.join(windows, "System32"),
		programFiles: overrides.programFiles ?? process.env.ProgramFiles ?? "C:\\Program Files",
		programFilesX86: overrides.programFilesX86 ?? process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
		appResources: overrides.appResources ?? process.cwd(),
	};
}

/** Expand `%VAR%` and a leading `~` against the environment / home directory. */
function expandEnv(input: string): string {
	return input
		.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole)
		.replace(/^~(?=[\\/]|$)/, os.homedir());
}

function realpathBestEffort(p: string): string {
	try {
		return fs.realpathSync.native(p);
	} catch {
		// Path (or a suffix) does not exist yet — realpath the longest existing
		// ancestor so junction/symlink escapes are still resolved for new files.
		const parts = p.split(/[\\/]+/);
		for (let i = parts.length - 1; i > 0; i--) {
			const ancestor = parts.slice(0, i).join("\\");
			try {
				const real = fs.realpathSync.native(ancestor);
				return path.join(real, ...parts.slice(i));
			} catch {
				// keep walking up
			}
		}
		return p;
	}
}

/**
 * Resolve a single path token (e.g. `<documents>`) or pass through a literal path,
 * expanding env vars and `~`. Unknown `<...>` tokens are returned unchanged.
 */
export function resolvePathToken(token: string, ctx: SandboxPathContext): string {
	const key = TOKEN_KEYS[token.trim().toLowerCase()];
	if (key) return ctx[key];
	return expandEnv(token.trim());
}

/** Resolve and canonicalize a list of root specs (tokens or literal paths). */
export function expandRoots(roots: string[], ctx: SandboxPathContext): string[] {
	const out: string[] = [];
	for (const r of roots) {
		const resolved = resolvePathToken(r, ctx);
		if (!resolved) continue;
		out.push(canonicalize(resolved, ctx.sandboxRoot, { realpath: false }));
	}
	return out;
}

export interface CanonicalizeOptions {
	/**
	 * Resolve symlinks/junctions (default false). Containment checks use lexical
	 * canonicalization so a root and the paths under it compare consistently even
	 * when the workspace lives under a junctioned directory (e.g. %TEMP%).
	 */
	realpath?: boolean;
}

/**
 * Produce a comparable absolute Windows path: env-expanded, made absolute against
 * `baseDir`, normalized, backslash-separated, with a lowercased drive letter and no
 * trailing separator. Case is otherwise preserved for display; use {@link isWithin}
 * for case-insensitive containment checks.
 */
export function canonicalize(input: string, baseDir: string, options: CanonicalizeOptions = {}): string {
	let p = expandEnv(String(input).trim());
	if (!p) return "";
	if (!path.isAbsolute(p)) p = path.resolve(baseDir, p);
	p = path.normalize(p);
	if (options.realpath === true) p = realpathBestEffort(p);
	p = p.replace(/\//g, "\\");
	if (/^[A-Za-z]:/.test(p)) p = p[0].toLowerCase() + p.slice(1);
	if (p.length > 3 && p.endsWith("\\")) p = p.slice(0, -1);
	return p;
}

/** Case-insensitive containment: is `child` equal to or under `root`? */
export function isWithin(root: string, child: string): boolean {
	if (!root || !child) return false;
	const r = root.toLowerCase();
	const c = child.toLowerCase();
	if (c === r) return true;
	const prefix = r.endsWith("\\") ? r : `${r}\\`;
	return c.startsWith(prefix);
}

/** True when `p` (canonicalized) lives inside any of the given roots. */
export function isWithinAny(roots: string[], p: string): boolean {
	return roots.some((root) => isWithin(root, p));
}
