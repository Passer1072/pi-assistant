/**
 * forge-core — 通用「自演化 MCP」核心（App 无关）
 * ================================================
 * 让 AI 在遇到现有工具做不到的功能时，能像人一样在目标应用里逆向、试验、并把新能力
 * **以数据形式持久化为新工具**（只增不删改 + 安全门），无需改代码、无需重启。
 *
 * 设计要点（与最终确认的策略一致）：
 *  - 只增不删改：forge_register_tool 只能追加；重名（内置或已锻造）直接拒绝。AI 不能删除工具。
 *  - 安全门：新锻造的工具默认未信任，调用时返回安全门提示，要求用户在插件页【信任】或【拒绝】。
 *    一旦用户信任，之后永久可用，无需再次确认。
 *  - 用户可手动删除「锻造的」工具；代码写死的内置工具不在注册表里，天然不可删。
 *  - App 无关：核心只依赖一个「适配器」(evalInApp / ensureReady)。任意 Electron/CEF 应用
 *    都能用自己的适配器接入。注册表按 appId 分区，是可移植 JSON，可跨 AI / 跨机器分享。
 *
 * 注册表位置：默认 forge/registry/extensions.json（软件自身目录，便于分享）。
 * 可用环境变量 FORGE_REGISTRY_PATH 覆盖（测试用）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const DEFAULT_REGISTRY_PATH = join(dirname(fileURLToPath(import.meta.url)), "registry", "extensions.json");
const NAME_RE = /^[a-z][a-z0-9_]{1,48}$/;

export function registryPath() {
	return process.env.FORGE_REGISTRY_PATH || DEFAULT_REGISTRY_PATH;
}

export function loadRegistry() {
	try {
		const data = JSON.parse(readFileSync(registryPath(), "utf8"));
		if (data && Array.isArray(data.extensions)) return data;
	} catch {
		// missing/corrupt → start empty
	}
	return { version: 1, extensions: [] };
}

function saveRegistry(reg) {
	const p = registryPath();
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify(reg, null, 2), "utf8");
}

function zodShapeFromSchema(schema) {
	const shape = {};
	for (const [key, def] of Object.entries(schema || {})) {
		const d = def || {};
		let t = d.type === "number" ? z.number() : d.type === "boolean" ? z.boolean() : z.string();
		if (d.description) t = t.describe(String(d.description));
		if (!d.required) t = t.optional();
		shape[key] = t;
	}
	return shape;
}

function okResult(value) {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function errResult(message) {
	return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, message }, null, 2) }] };
}

/**
 * @param {object} opts
 * @param {string} opts.appId            稳定的应用标识，注册表按它分区，例如 "netease-cloud-music"
 * @param {(js:string)=>Promise<any>} opts.evalInApp   在目标应用上下文里执行 JS 表达式并按值返回
 * @param {()=>Promise<any>} opts.ensureReady          确保适配器的「钥匙」就绪（如 __store/__request）
 * @param {string[]} opts.builtinToolNames             代码写死的内置工具名（受保护，不可被覆盖/删除）
 */
export function createForge({ appId, evalInApp, ensureReady, builtinToolNames = [] }) {
	const META_TOOLS = ["forge_probe", "forge_test_tool", "forge_register_tool", "forge_list_capabilities"];
	const protectedNames = new Set([...builtinToolNames, ...META_TOOLS]);

	const listExtensions = () => loadRegistry().extensions.filter((e) => e.appId === appId);
	const findExt = (name) => loadRegistry().extensions.find((e) => e.appId === appId && e.name === name);

	function appendExtension(ext) {
		if (!NAME_RE.test(ext.name)) {
			throw new Error(`工具名「${ext.name}」非法：需小写字母开头，仅含小写字母/数字/下划线(2-49 字符)。`);
		}
		if (protectedNames.has(ext.name)) {
			throw new Error(`「${ext.name}」是受保护的内置工具名，不能覆盖。只能新增——请换新名字或加版本号(如 ${ext.name}_v2)。`);
		}
		const reg = loadRegistry();
		if (reg.extensions.some((e) => e.appId === appId && e.name === ext.name)) {
			throw new Error(`已存在锻造工具「${ext.name}」。本框架只增不改——请换新名字或加版本号(如 ${ext.name}_v2)。`);
		}
		reg.extensions.push(ext);
		saveRegistry(reg);
	}

	const buildCallExpr = (jsBody, args) => `(async function(args){ ${jsBody}\n})(${JSON.stringify(args ?? {})})`;

	function wrapExtensionTool(server, ext) {
		const inputSchema = zodShapeFromSchema(ext.inputSchema);
		const title = `${ext.name} (forged)`;
		const description = `${ext.description || ext.name}　[AI 锻造的扩展工具，受安全门管控]`;
		server.registerTool(ext.name, { title, description, inputSchema }, async (args) => {
			// 调用时从磁盘重读信任态/存在性 → 用户在 UI 的信任/删除立即生效，无需重启
			const live = findExt(ext.name);
			if (!live) return errResult(`工具「${ext.name}」已被用户删除，不再可用。`);
			if (!live.trusted) {
				return errResult(
					`🔒 安全门：锻造工具「${ext.name}」尚未获得用户信任，无法执行。` +
						`请明确告诉用户：「检测到未信任的新工具 ${ext.name}（${live.description || ""}），` +
						`请到【插件管理 → MCP 能力详情 → 锻造的工具】里【信任】或【拒绝】它」，然后再重试。`,
				);
			}
			try {
				await ensureReady();
				return okResult(await evalInApp(buildCallExpr(live.jsBody, args || {})));
			} catch (e) {
				return errResult(e instanceof Error ? e.message : String(e));
			}
		});
	}

	return {
		appId,
		listExtensions,
		/** 把注册表里属于本 App 的扩展全部注册为 MCP 工具（受安全门管控）。 */
		registerStoredExtensions(server) {
			for (const ext of listExtensions()) {
				try {
					wrapExtensionTool(server, ext);
				} catch {
					// 单条损坏不影响其它
				}
			}
		},
		/** 注册 forge_* 元工具（探测 / 试跑 / 登记 / 列能力）。 */
		registerMetaTools(server) {
			server.registerTool(
				"forge_probe",
				{
					title: "Forge: probe app internals",
					description:
						"在目标应用上下文里执行一段【只读探测】JS（返回值按 JSON 返回），用于逆向其内部能力" +
						"（枚举 redux action、API 端点、模块等）。这是你自演化的第一步：先探明怎么做，再 forge_test_tool 验证。",
					inputSchema: { js: z.string().describe("要执行的 JS 表达式体；可用应用适配器注入的全局句柄。") },
				},
				async ({ js }) => {
					try {
						await ensureReady();
						return okResult(await evalInApp(`(async function(){ ${js}\n})()`));
					} catch (e) {
						return errResult(e instanceof Error ? e.message : String(e));
					}
				},
			);

			server.registerTool(
				"forge_test_tool",
				{
					title: "Forge: test a candidate tool",
					description:
						"用给定参数【试跑】一段候选工具的 JS 体（不持久化）。jsBody 内可用 `args` 取参数。" +
						"登记前务必先用它验证逻辑正确。",
					inputSchema: {
						jsBody: z.string().describe("工具实现：一个 async 函数体，参数对象名为 args，需 return 结果。"),
						args: z.record(z.any()).optional().describe("试跑用的参数对象。"),
					},
				},
				async ({ jsBody, args }) => {
					try {
						await ensureReady();
						return okResult(await evalInApp(buildCallExpr(jsBody, args || {})));
					} catch (e) {
						return errResult(e instanceof Error ? e.message : String(e));
					}
				},
			);

			server.registerTool(
				"forge_register_tool",
				{
					title: "Forge: register a new tool (additive, needs trust)",
					description:
						"把一个**新工具**登记进注册表并立即热注册（只增不改；重名会被拒绝）。登记后处于【未信任】状态，" +
						"调用会触发安全门——你必须提示用户去插件页信任后才能使用。jsBody 内用 `args` 取参数、需 return 结果。",
					inputSchema: {
						name: z.string().describe("工具名：小写字母开头，仅小写字母/数字/下划线。"),
						description: z.string().describe("一句话说明这个工具做什么。"),
						jsBody: z.string().describe("实现：async 函数体，参数对象名 args，需 return 结果。"),
						inputSchema: z
							.record(z.object({ type: z.enum(["string", "number", "boolean"]), required: z.boolean().optional(), description: z.string().optional() }))
							.optional()
							.describe('参数定义，如 { "id": {"type":"number","required":true} }'),
						notes: z.string().optional().describe("可选：逆向依据/备注，便于他人/用户审阅。"),
					},
				},
				async ({ name, description, jsBody, inputSchema, notes }) => {
					const ext = {
						appId,
						name,
						description: description || name,
						inputSchema: inputSchema || {},
						jsBody,
						trusted: false,
						origin: "forge",
						createdBy: "ai",
						createdAt: new Date().toISOString(),
						notes: notes || "",
					};
					try {
						appendExtension(ext);
						wrapExtensionTool(server, ext);
						return okResult({
							ok: true,
							name,
							trusted: false,
							message:
								`已登记新工具「${name}」（未信任）。请明确告诉用户：到【插件管理 → MCP 能力详情 → 锻造的工具】` +
								`里【信任】它后即可使用（信任一次后永久有效）。`,
						});
					} catch (e) {
						return errResult(e instanceof Error ? e.message : String(e));
					}
				},
			);

			server.registerTool(
				"forge_list_capabilities",
				{
					title: "Forge: list capabilities",
					description: "列出本应用当前可用的内置工具与已锻造工具（含信任态），帮助你判断该不该新建。",
					inputSchema: {},
				},
				async () =>
					okResult({
						appId,
						builtin: [...builtinToolNames].sort(),
						forged: listExtensions().map((e) => ({ name: e.name, description: e.description, trusted: e.trusted, createdAt: e.createdAt })),
					}),
			);
		},
	};
}

// 供主进程（UI 的信任/删除）复用的纯数据操作 —————————————————————————————
export function listAllExtensions() {
	return loadRegistry().extensions;
}

export function setExtensionTrust(appId, name, trusted) {
	const reg = loadRegistry();
	const ext = reg.extensions.find((e) => e.appId === appId && e.name === name);
	if (!ext) return false;
	ext.trusted = Boolean(trusted);
	saveRegistry(reg);
	return true;
}

/** 删除一个**锻造的**工具（origin==="forge"）。内置工具不在注册表里，天然无法被删。 */
export function deleteExtension(appId, name) {
	const reg = loadRegistry();
	const before = reg.extensions.length;
	reg.extensions = reg.extensions.filter((e) => !(e.appId === appId && e.name === name && e.origin === "forge"));
	if (reg.extensions.length === before) return false;
	saveRegistry(reg);
	return true;
}

export function ensureRegistryFile() {
	if (!existsSync(registryPath())) saveRegistry({ version: 1, extensions: [] });
}
