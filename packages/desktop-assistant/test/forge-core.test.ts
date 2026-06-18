import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// forge-core is a plain ESM module shared by app MCP servers (app-agnostic forge core).
import {
	createForge,
	deleteExtension,
	listAllExtensions,
	setExtensionTrust,
} from "../mcp-servers/forge/forge-core.mjs";

function fakeServer() {
	const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
	return {
		registerTool(name: string, _def: unknown, handler: (args: unknown) => Promise<unknown>) {
			handlers.set(name, handler);
		},
		has: (name: string) => handlers.has(name),
		call: (name: string, args: unknown) => handlers.get(name)?.(args),
		names: () => [...handlers.keys()],
	};
}

function text(result: unknown): Record<string, unknown> {
	const content = (result as { content?: { text?: string }[] }).content;
	return JSON.parse(content?.[0]?.text ?? "{}") as Record<string, unknown>;
}
function isError(result: unknown): boolean {
	return Boolean((result as { isError?: boolean }).isError);
}

let dir: string;
let regPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "forge-"));
	regPath = join(dir, "extensions.json");
	process.env.FORGE_REGISTRY_PATH = regPath;
});
afterEach(() => {
	delete process.env.FORGE_REGISTRY_PATH;
	rmSync(dir, { recursive: true, force: true });
});

function makeForge(server: ReturnType<typeof fakeServer>) {
	const calls: string[] = [];
	const forge = createForge({
		appId: "demo-app",
		evalInApp: async (js: string) => {
			calls.push(js);
			return { ran: true };
		},
		ensureReady: async () => {},
		builtinToolNames: ["play", "pause"],
	});
	forge.registerMetaTools(server);
	forge.registerStoredExtensions(server);
	return { forge, calls };
}

describe("forge core (self-evolving MCP)", () => {
	it("registers a new tool additively; it is gated until trusted, then runs", async () => {
		const server = fakeServer();
		const { calls } = makeForge(server);

		// AI registers a new tool
		const reg = text(
			await server.call("forge_register_tool", {
				name: "do_thing",
				description: "demo",
				jsBody: "return 1",
				inputSchema: { x: { type: "number", required: true } },
			}),
		);
		expect(reg.ok).toBe(true);
		expect(reg.trusted).toBe(false);
		expect(server.has("do_thing")).toBe(true);

		// calling it while untrusted hits the safety gate (no eval happens)
		const gated = await server.call("do_thing", { x: 1 });
		expect(isError(gated)).toBe(true);
		expect(text(gated).message).toContain("安全门");
		expect(calls.length).toBe(0);

		// user trusts it
		expect(setExtensionTrust("demo-app", "do_thing", true)).toBe(true);

		// now it executes
		const okRun = await server.call("do_thing", { x: 1 });
		expect(isError(okRun)).toBeFalsy();
		expect(calls.length).toBe(1);
		expect(calls[0]).toContain("return 1");
	});

	it("is additive only: rejects duplicate and built-in names", async () => {
		const server = fakeServer();
		makeForge(server);

		await server.call("forge_register_tool", { name: "alpha", description: "d", jsBody: "return 1" });
		const dup = text(
			await server.call("forge_register_tool", { name: "alpha", description: "d", jsBody: "return 2" }),
		);
		expect(dup.ok).toBe(false);
		expect(dup.message).toMatch(/只增不改|已存在/);

		const builtinClash = text(
			await server.call("forge_register_tool", { name: "play", description: "d", jsBody: "return 1" }),
		);
		expect(builtinClash.ok).toBe(false);
		expect(builtinClash.message).toContain("内置");

		// registry still only has the one valid extension
		expect(listAllExtensions().filter((e: { appId: string }) => e.appId === "demo-app")).toHaveLength(1);
	});

	it("rejects illegal tool names", async () => {
		const server = fakeServer();
		makeForge(server);
		const bad = text(
			await server.call("forge_register_tool", { name: "Bad-Name!", description: "d", jsBody: "return 1" }),
		);
		expect(bad.ok).toBe(false);
		expect(bad.message).toContain("非法");
	});

	it("user can delete a forged tool; deleted tool refuses to run", async () => {
		const server = fakeServer();
		const { calls } = makeForge(server);
		await server.call("forge_register_tool", { name: "temp_tool", description: "d", jsBody: "return 1" });
		setExtensionTrust("demo-app", "temp_tool", true);

		expect(deleteExtension("demo-app", "temp_tool")).toBe(true);

		const afterDelete = await server.call("temp_tool", {});
		expect(isError(afterDelete)).toBe(true);
		expect(text(afterDelete).message).toContain("已被用户删除");
		expect(calls.length).toBe(0);
		expect(listAllExtensions().filter((e: { appId: string }) => e.appId === "demo-app")).toHaveLength(0);
	});

	it("exposes capabilities (builtin + forged with trust state)", async () => {
		const server = fakeServer();
		makeForge(server);
		await server.call("forge_register_tool", { name: "cap_tool", description: "d", jsBody: "return 1" });
		const caps = text(await server.call("forge_list_capabilities", {}));
		expect(caps.builtin).toEqual(expect.arrayContaining(["play", "pause"]));
		expect(caps.forged).toEqual([expect.objectContaining({ name: "cap_tool", trusted: false })]);
	});
});
