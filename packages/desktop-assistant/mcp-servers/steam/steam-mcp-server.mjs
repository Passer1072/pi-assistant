#!/usr/bin/env node
/**
 * Steam control MCP server
 * ========================
 *
 * Uses Steam's public URL protocol plus local VDF manifests. It does not inject
 * code into Steam and does not modify the Steam installation directory.
 *
 * Env vars:
 *   STEAM_ROOT         default D:\steam
 *   STEAM_EXE_PATH     optional explicit steam.exe path
 *   STEAM_AUTO_LAUNCH  "1" to launch Steam when a command needs it
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const STEAM_ROOT = resolve(process.env.STEAM_ROOT || "D:\\steam");
const STEAM_EXE_PATH = process.env.STEAM_EXE_PATH || join(STEAM_ROOT, "steam.exe");
const AUTO_LAUNCH = process.env.STEAM_AUTO_LAUNCH === "1";
const STEAM_PROCESS_NAMES = new Set(["steam", "steamwebhelper"]);

const OPEN_VIEWS = [
	"activateproduct",
	"bigpicture",
	"console",
	"downloads",
	"friends",
	"games",
	"library",
	"musicplayer",
	"servers",
	"settings",
	"store",
	"tools",
];

function ok(payload) {
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(error) {
	const message = error instanceof Error ? error.message : String(error);
	return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, message }, null, 2) }] };
}

function tool(server, name, title, description, inputSchema, handler) {
	server.registerTool(name, { title, description, inputSchema }, async (args) => {
		try {
			return ok(await handler(args || {}));
		} catch (error) {
			return fail(error);
		}
	});
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function assertSteamInstall() {
	if (!existsSync(STEAM_EXE_PATH)) {
		throw new Error(`steam.exe not found at ${STEAM_EXE_PATH}. Set STEAM_ROOT or STEAM_EXE_PATH.`);
	}
}

function spawnDetached(command, args = []) {
	const child = spawn(command, args, {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	child.on("error", () => {});
	child.unref();
}

function launchSteam(args = []) {
	assertSteamInstall();
	spawnDetached(STEAM_EXE_PATH, args);
	return { ok: true, action: "launch_steam", exePath: STEAM_EXE_PATH, args };
}

async function queryProcesses() {
	return new Promise((resolveProcesses) => {
		const child = spawn("tasklist.exe", ["/FO", "CSV", "/NH"], { windowsHide: true });
		const chunks = [];
		child.stdout.on("data", (chunk) => chunks.push(chunk));
		child.on("error", () => resolveProcesses([]));
		child.on("close", () => {
			const text = Buffer.concat(chunks).toString("utf8").trim();
			const processes = text
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean)
				.map(parseTasklistCsvLine)
				.filter(Boolean);
			resolveProcesses(processes);
		});
	});
}

function parseTasklistCsvLine(line) {
	const cols = [];
	let cur = "";
	let quoted = false;
	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];
		if (ch === '"') {
			quoted = !quoted;
			continue;
		}
		if (ch === "," && !quoted) {
			cols.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	cols.push(cur);
	const imageName = cols[0]?.trim();
	if (!imageName) return undefined;
	const processName = imageName.replace(/\.exe$/i, "").toLowerCase();
	return {
		imageName,
		processName,
		pid: Number(cols[1]) || undefined,
		sessionName: cols[2],
		memoryUsage: cols[4],
	};
}

async function getSteamProcesses() {
	const processes = await queryProcesses();
	return processes.filter((process) => STEAM_PROCESS_NAMES.has(process.processName));
}

async function isSteamRunning() {
	return (await getSteamProcesses()).length > 0;
}

async function ensureSteamRunning() {
	if (await isSteamRunning()) return;
	if (!AUTO_LAUNCH) {
		throw new Error("Steam is not running. Call launch_steam first or set STEAM_AUTO_LAUNCH=1.");
	}
	launchSteam([]);
	await sleep(1500);
}

async function openSteamUrl(url, { requireRunning = false } = {}) {
	if (!/^steam:\/\/[a-z0-9_/?=&.:%+-]+$/i.test(url)) {
		throw new Error(`Unsupported Steam URL: ${url}`);
	}
	if (requireRunning) await ensureSteamRunning();
	spawnDetached("cmd.exe", ["/c", "start", "", url]);
	return { ok: true, action: "open_steam_url", url };
}

function readTextFile(path) {
	return readFileSync(path, "utf-8");
}

function parseVdf(text) {
	const tokens = [];
	const re = /"((?:\\.|[^"\\])*)"|([{}])/g;
	let match;
	while ((match = re.exec(text))) {
		if (match[1] !== undefined) tokens.push({ type: "string", value: unescapeVdfString(match[1]) });
		else tokens.push({ type: match[2], value: match[2] });
	}
	let index = 0;

	function parseObject() {
		const obj = {};
		while (index < tokens.length) {
			const token = tokens[index];
			if (token.type === "}") {
				index += 1;
				break;
			}
			if (token.type !== "string") {
				index += 1;
				continue;
			}
			const key = token.value;
			index += 1;
			const next = tokens[index];
			if (!next) {
				obj[key] = "";
				break;
			}
			if (next.type === "{") {
				index += 1;
				obj[key] = parseObject();
			} else if (next.type === "string") {
				index += 1;
				obj[key] = next.value;
			} else {
				index += 1;
				obj[key] = "";
			}
		}
		return obj;
	}

	const root = {};
	while (index < tokens.length) {
		const token = tokens[index];
		if (token.type !== "string") {
			index += 1;
			continue;
		}
		const key = token.value;
		index += 1;
		if (tokens[index]?.type === "{") {
			index += 1;
			root[key] = parseObject();
		} else if (tokens[index]?.type === "string") {
			root[key] = tokens[index].value;
			index += 1;
		} else {
			root[key] = "";
		}
	}
	return root;
}

function unescapeVdfString(value) {
	return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function readLibraryFolders() {
	const libraryFile = join(STEAM_ROOT, "steamapps", "libraryfolders.vdf");
	if (!existsSync(libraryFile)) {
		return [
			{
				index: "0",
				path: STEAM_ROOT,
				appCount: countManifests(join(STEAM_ROOT, "steamapps")),
				apps: {},
			},
		];
	}
	const parsed = parseVdf(readTextFile(libraryFile)).libraryfolders || {};
	const entries = Object.entries(parsed)
		.filter(([, value]) => value && typeof value === "object")
		.map(([index, value]) => {
			const path = value.path || (index === "0" ? STEAM_ROOT : undefined);
			const apps = value.apps && typeof value.apps === "object" ? value.apps : {};
			return {
				index,
				path,
				label: value.label || "",
				contentId: value.contentid || value.contentId,
				totalSize: numericString(value.totalsize),
				appCount: Object.keys(apps).length || countManifests(join(path || "", "steamapps")),
				apps,
			};
		})
		.filter((entry) => entry.path);
	if (entries.some((entry) => resolve(entry.path).toLowerCase() === STEAM_ROOT.toLowerCase())) return entries;
	return [
		{
			index: "0",
			path: STEAM_ROOT,
			label: "",
			appCount: countManifests(join(STEAM_ROOT, "steamapps")),
			apps: {},
		},
		...entries,
	];
}

function countManifests(steamappsDir) {
	try {
		return readdirSync(steamappsDir).filter((name) => /^appmanifest_\d+\.acf$/i.test(name)).length;
	} catch {
		return 0;
	}
}

function numericString(value) {
	if (value === undefined || value === null || value === "") return undefined;
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function listManifestFiles() {
	const files = [];
	for (const library of readLibraryFolders()) {
		const steamapps = join(library.path, "steamapps");
		if (!existsSync(steamapps)) continue;
		for (const file of readdirSync(steamapps)) {
			if (!/^appmanifest_\d+\.acf$/i.test(file)) continue;
			files.push({ libraryPath: library.path, manifestPath: join(steamapps, file) });
		}
	}
	return files;
}

function parseAppManifest(file) {
	const parsed = parseVdf(readTextFile(file.manifestPath)).AppState || {};
	const appid = String(parsed.appid || file.manifestPath.match(/appmanifest_(\d+)\.acf$/i)?.[1] || "");
	const installDir = parsed.installdir || "";
	const installPath = installDir ? join(file.libraryPath, "steamapps", "common", installDir) : undefined;
	return {
		appid,
		name: parsed.name || "",
		libraryPath: file.libraryPath,
		manifestPath: file.manifestPath,
		installDir,
		installPath,
		sizeOnDisk: numericString(parsed.SizeOnDisk),
		lastPlayed: numericString(parsed.LastPlayed),
		lastUpdated: numericString(parsed.lastupdated),
		buildId: parsed.buildid,
		stateFlags: numericString(parsed.StateFlags),
		installed: parsed.StateFlags ? (Number(parsed.StateFlags) & 4) === 4 : Boolean(installPath && existsSync(installPath)),
	};
}

function listInstalledApps() {
	return listManifestFiles()
		.map(parseAppManifest)
		.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function findApp({ appid, query }) {
	const apps = listInstalledApps();
	if (appid !== undefined && appid !== null) {
		const target = String(appid);
		const app = apps.find((entry) => entry.appid === target);
		if (!app) throw new Error(`No installed Steam app with appid ${target}.`);
		return app;
	}
	const q = String(query || "").trim().toLowerCase();
	if (!q) throw new Error("Provide appid or query.");
	const exact = apps.find((entry) => entry.name.toLowerCase() === q || entry.appid === q);
	if (exact) return exact;
	const includes = apps.filter((entry) => entry.name.toLowerCase().includes(q));
	if (includes.length === 1) return includes[0];
	if (includes.length > 1) {
		return includes.sort((left, right) => scoreAppMatch(left, q) - scoreAppMatch(right, q))[0];
	}
	throw new Error(`No installed Steam app matched "${query}".`);
}

function scoreAppMatch(app, query) {
	const name = app.name.toLowerCase();
	if (name.startsWith(query)) return 0;
	return name.indexOf(query) + 10;
}

async function closeSteam({ force = false } = {}) {
	const processes = await getSteamProcesses();
	if (processes.length === 0) return { ok: true, action: "close_steam", alreadyClosed: true };
	launchSteam(["-shutdown"]);
	await sleep(2500);
	if (!(await isSteamRunning())) {
		return {
			ok: true,
			action: "close_steam",
			method: "steam_shutdown",
			closed: true,
			force,
			before: processes.map((process) => ({ imageName: process.imageName, pid: process.pid })),
			running: false,
		};
	}
	if (!force) {
		return {
			ok: false,
			action: "close_steam",
			method: "steam_shutdown",
			closed: false,
			force,
			message: "Steam did not exit after steam.exe -shutdown. Retry with force=true if the user explicitly wants a forced close.",
			running: true,
		};
	}
	for (const name of ["steam.exe", "steamwebhelper.exe"]) {
		await new Promise((resolveKill) => {
			const child = spawn("taskkill.exe", ["/IM", name, "/T", "/F"], { windowsHide: true });
			child.on("error", () => resolveKill());
			child.on("close", () => resolveKill());
		});
	}
	await sleep(500);
	return {
		ok: true,
		action: "close_steam",
		method: "taskkill",
		closed: true,
		force,
		before: processes.map((process) => ({ imageName: process.imageName, pid: process.pid })),
		running: await isSteamRunning(),
	};
}

const server = new McpServer({ name: "steam-control", version: "1.0.0" });

tool(server, "get_status", "Get Steam status", "Read Steam install path, process status, libraries, and installed app count.", {}, async () => {
	const libraries = readLibraryFolders().map((library) => ({
		index: library.index,
		path: library.path,
		label: library.label,
		appCount: library.appCount,
		totalSize: library.totalSize,
	}));
	const processes = await getSteamProcesses();
	return {
		ok: true,
		steamRoot: STEAM_ROOT,
		exePath: STEAM_EXE_PATH,
		exeExists: existsSync(STEAM_EXE_PATH),
		running: processes.length > 0,
		processes,
		libraries,
		installedAppCount: listInstalledApps().length,
	};
});

tool(server, "launch_steam", "Launch Steam", "Start Steam from the configured install path.", { args: z.array(z.string()).optional() }, async ({ args = [] }) => launchSteam(args));

tool(
	server,
	"close_steam",
	"Close Steam",
	"Close Steam. Defaults to steam.exe -shutdown; force=true uses taskkill only after Steam does not exit.",
	{ force: z.boolean().optional() },
	async ({ force = false }) => closeSteam({ force }),
);

tool(server, "list_libraries", "List Steam libraries", "List configured Steam library folders from libraryfolders.vdf.", {}, async () => ({
	ok: true,
	libraries: readLibraryFolders().map((library) => ({
		index: library.index,
		path: library.path,
		label: library.label,
		appCount: library.appCount,
		totalSize: library.totalSize,
		appIds: Object.keys(library.apps || {}),
	})),
}));

tool(
	server,
	"list_installed_games",
	"List installed Steam apps",
	"List installed Steam apps/games from appmanifest_*.acf files.",
	{
		query: z.string().optional(),
		limit: z.number().int().min(1).max(500).optional(),
		includePaths: z.boolean().optional(),
	},
	async ({ query, limit = 100, includePaths = true }) => {
		const q = query?.trim().toLowerCase();
		const apps = listInstalledApps()
			.filter((app) => !q || app.name.toLowerCase().includes(q) || app.appid === q)
			.slice(0, limit)
			.map((app) => ({
				appid: app.appid,
				name: app.name,
				installed: app.installed,
				sizeOnDisk: app.sizeOnDisk,
				lastPlayed: app.lastPlayed,
				lastUpdated: app.lastUpdated,
				buildId: app.buildId,
				...(includePaths
					? {
							libraryPath: app.libraryPath,
							installPath: app.installPath,
							manifestPath: app.manifestPath,
						}
					: {}),
			}));
		return { ok: true, count: apps.length, apps };
	},
);

tool(
	server,
	"find_game",
	"Find installed Steam game",
	"Find a single installed Steam app by appid or name substring.",
	{ appid: z.union([z.string(), z.number()]).optional(), query: z.string().optional() },
	async ({ appid, query }) => ({ ok: true, app: findApp({ appid, query }) }),
);

tool(
	server,
	"open_view",
	"Open Steam view",
	"Open a Steam client view such as library, store, downloads, friends, settings, or bigpicture.",
	{ view: z.enum(OPEN_VIEWS), requireRunning: z.boolean().optional() },
	async ({ view, requireRunning = false }) => openSteamUrl(`steam://open/${view}`, { requireRunning }),
);

tool(
	server,
	"open_store_page",
	"Open Steam store page",
	"Open a Steam store app page by appid.",
	{ appid: z.union([z.string(), z.number()]) },
	async ({ appid }) => openSteamUrl(`steam://store/${encodeURIComponent(String(appid))}`),
);

tool(
	server,
	"open_game_page",
	"Open Steam game details",
	"Open an installed game's Steam client details page by appid or name.",
	{ appid: z.union([z.string(), z.number()]).optional(), query: z.string().optional() },
	async ({ appid, query }) => {
		const app = findApp({ appid, query });
		return { ...(await openSteamUrl(`steam://nav/games/details/${app.appid}`)), app };
	},
);

tool(
	server,
	"run_game",
	"Run Steam game",
	"Run an installed Steam game by appid or name through steam://rungameid.",
	{ appid: z.union([z.string(), z.number()]).optional(), query: z.string().optional() },
	async ({ appid, query }) => {
		const app = appid === undefined ? findApp({ query }) : findApp({ appid });
		return { ...(await openSteamUrl(`steam://rungameid/${app.appid}`)), app };
	},
);

tool(
	server,
	"install_game",
	"Install Steam game",
	"Open Steam's install flow for an appid.",
	{ appid: z.union([z.string(), z.number()]) },
	async ({ appid }) => openSteamUrl(`steam://install/${encodeURIComponent(String(appid))}`),
);

tool(
	server,
	"uninstall_game",
	"Uninstall Steam game",
	"Open Steam's uninstall flow for an installed app. Steam will show its own confirmation UI.",
	{ appid: z.union([z.string(), z.number()]).optional(), query: z.string().optional() },
	async ({ appid, query }) => {
		const app = findApp({ appid, query });
		return { ...(await openSteamUrl(`steam://uninstall/${app.appid}`)), app };
	},
);

tool(
	server,
	"verify_game_files",
	"Verify game files",
	"Ask Steam to verify local files for an installed app.",
	{ appid: z.union([z.string(), z.number()]).optional(), query: z.string().optional() },
	async ({ appid, query }) => {
		const app = findApp({ appid, query });
		return { ...(await openSteamUrl(`steam://validate/${app.appid}`)), app };
	},
);

tool(
	server,
	"create_desktop_shortcut",
	"Create desktop shortcut",
	"Ask Steam to create a desktop shortcut for an installed app.",
	{ appid: z.union([z.string(), z.number()]).optional(), query: z.string().optional() },
	async ({ appid, query }) => {
		const app = findApp({ appid, query });
		return { ...(await openSteamUrl(`steam://shortcut/${app.appid}`)), app };
	},
);

tool(
	server,
	"open_steam_url",
	"Open Steam URL",
	"Open an arbitrary steam:// URL for advanced Steam protocol operations.",
	{ url: z.string(), requireRunning: z.boolean().optional() },
	async ({ url, requireRunning = false }) => openSteamUrl(url, { requireRunning }),
);

tool(
	server,
	"inspect_manifest",
	"Inspect app manifest",
	"Return the parsed appmanifest_*.acf data for an installed app.",
	{ appid: z.union([z.string(), z.number()]).optional(), query: z.string().optional() },
	async ({ appid, query }) => {
		const app = findApp({ appid, query });
		const raw = parseVdf(readTextFile(app.manifestPath));
		let installPathSize;
		try {
			installPathSize = app.installPath && existsSync(app.installPath) ? statSync(app.installPath).size : undefined;
		} catch {
			installPathSize = undefined;
		}
		return { ok: true, app, manifest: raw.AppState, installPathSize };
	},
);

await server.connect(new StdioServerTransport());
