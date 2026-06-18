# 自演化 MCP 框架（forge）· 详细设计与使用

> 目标：让**任意 AI**在遇到现有 MCP 工具做不到的功能时，能像我们逆向网易云那样，
> 自己探明做法、试验、并**把新能力持久化为新工具**，从而让 MCP 的能力**随用随长**。
>
> 这是 [02-通用方法论](./02-通用方法论.md) 的「自动化」版：把人做的逆向→封装流程，固化成
> AI 可调用的元工具 + 一套只增不删改、带安全门的注册机制。
>
> 速览见 [00-速查卡](./00-速查卡.md)；落地代码见 `mcp-servers/forge/`。

---

## 1. 为什么需要它

一个手写的 MCP 插件，工具集是**固定**的。但用户的需求是无穷的：今天要「听歌识曲」，
明天要「按 bpm 筛歌」。每次都让人去逆向 + 写代码 + 发版，太慢。

forge 的思路：**把「逆向 + 封装成工具」这件事本身做成工具**，交给 AI 自己做。AI 用我们
验证过的方法（三把钥匙 + 验证驱动）现场逆向，把成果登记成一个新 MCP 工具，立刻可用。

---

## 2. 核心架构（App 无关 + 适配器）

```
                ┌─────────────── forge-core.mjs（App 无关）───────────────┐
                │  注册表读写(只增) · 安全门 · 工具包装 · 元工具工厂        │
                └───────────────▲───────────────────────▲────────────────┘
                                │ 适配器(每个 App 一个)   │ 注册表(可移植 JSON)
            ┌───────────────────┴──────┐         ┌───────┴───────────────────────┐
            │ evalInApp(js)            │         │ registry/extensions.json       │
            │ ensureReady()            │         │ 按 appId 分区, 跨 AI/跨机器分享 │
            │ builtinToolNames[]       │         └────────────────────────────────┘
            └──────────────────────────┘
   网易云 server          QQ音乐 server(未来)        任意 Electron/CEF App server
```

- **forge-core**：零业务逻辑。只认一个「适配器」：能在目标应用上下文里执行 JS、一个就绪钩子、
  以及内置工具名清单（受保护）。
- **适配器**：每个目标 App 提供。本质就是它的「三把钥匙」bootstrap + 一个 `evalInApp`。
  网易云的适配器 = CDP `Runtime.evaluate` + `ensureBootstrapped`。
- **注册表**：一个可移植 JSON（`mcp-servers/forge/registry/extensions.json`），按 `appId` 分区。
  拷给别人即可共享 AI 锻造出来的能力。

> 「通用多 App」是通过 **forge-core 作为共享库 + 每个 App 的 server 各自实例化它** 实现的——
> 不需要一个巨型多 App 进程。新 App 只要写个适配器就能拥有自演化能力。

---

## 3. AI 的自演化闭环（协议）

```
① 失败/缺能力
   AI 调某工具失败，或 forge_list_capabilities 发现没有合适工具
② 逆向（只读）
   forge_probe { js }  →  在 App 里枚举 redux action / API 端点 / 模块，探明「怎么做」
   （方法同 03-逆向技术手册：扫 store、扫 __wpr.m 源码、调 __ncm_request 试接口）
③ 试验（不持久化）
   forge_test_tool { jsBody, args }  →  用样例参数跑一遍候选实现，确认正确
④ 登记（追加）
   forge_register_tool { name, description, jsBody, inputSchema?, notes? }
   →  追加到注册表（重名拒绝），热注册为 MCP 工具，状态【未信任】
⑤ 安全门
   AI 调用新工具 → 被拦截，返回「未信任」提示
   →  AI 必须明确告诉用户：「检测到新工具 X，请到【插件管理→MCP能力详情→锻造的工具】信任/拒绝」
⑥ 用户信任（一次，永久）
   用户在插件页点【信任】→ 注册表 trusted=true → 工具即可正常调用
```

`jsBody` 约定：一个 **async 函数体**，参数对象名为 `args`，需 `return` 结果。运行时执行
`(async (args)=>{ <jsBody> })(<入参>)`。里面可用适配器注入的全局句柄（网易云：
`window.__ncm_store` / `window.__ncm_request` / `window.__wpr`）。

---

## 4. 四个 forge 元工具

| 工具 | 入参 | 作用 |
|---|---|---|
| `forge_probe` | `{js}` | 只读探测：在 App 里执行一段 JS 并按 JSON 返回。逆向用。 |
| `forge_test_tool` | `{jsBody, args?}` | 试跑候选实现，不持久化。`jsBody` 内用 `args`。 |
| `forge_register_tool` | `{name, description, jsBody, inputSchema?, notes?}` | 登记新工具（追加；重名/内置名/非法名拒绝）。登记后未信任。 |
| `forge_list_capabilities` | `{}` | 列内置工具 + 已锻造工具（含信任态）。 |

`inputSchema` 形如 `{ "id": {"type":"number","required":true, "description":"歌曲id"} }`，
会被转成 zod 校验；调用时校验后的参数作为 `args` 传入 `jsBody`。

---

## 5. 安全与治理（关键）

| 机制 | 实现 |
|---|---|
| **安全门** | 未信任的锻造工具被调用时直接返回错误提示，**不执行** `jsBody`；提示文案要求 AI 让用户去信任/拒绝。 |
| **只增不删改** | 没有任何「编辑/删除」的 **AI** 接口；`forge_register_tool` 只 append，重名（内置 / forge_* / 已存在）一律拒绝。要「改」就登记新名字（如 `xxx_v2`），旧的不动 → 零回归。 |
| **删除权** | 只有**用户**能删，且只能删 `origin:"forge"` 的工具；**内置工具不在注册表里，删不了**。 |
| **即时生效** | MCP server 在**每次调用**锻造工具时从磁盘重读其信任态/存在性 → 用户在 UI 的信任/删除立即生效，无需重启。 |
| **审计** | 每条记录存 `createdBy/createdAt/notes/jsBody`，UI 可展开看实现代码。 |
| **网络** | 按产品决策**不做白名单限制**（为支持多 App / 跨 App 互联）。因此「信任」这一步就是关键人审关口——务必让用户看清实现再信任。 |

> ⚠️ 因为不限制网络且能执行任意 JS，**安全门 + 用户信任**是唯一也是必须的护栏。撞门时 AI
> 必须如实、显眼地把工具名、用途、实现要点告诉用户，由用户决定信任或拒绝。

---

## 6. 实现地图（代码在哪）

| 部件 | 文件 |
|---|---|
| forge 核心（App 无关） | `mcp-servers/forge/forge-core.mjs`（`createForge` + 数据操作 `listAllExtensions/setExtensionTrust/deleteExtension`） |
| 注册表（可分享 JSON） | `mcp-servers/forge/registry/extensions.json` |
| 网易云适配器接入 | `mcp-servers/netease-music/netease-music-mcp-server.mjs` 末尾的 `createForge({...})` |
| 主进程读/信任/删除 | `src/plugins/forge-registry.ts`（与 forge-core 指向同一文件） |
| IPC / preload / 服务方法 | `ipc.ts` / `preload.ts` / `desktop-agent-service.ts` 的 `listForgeExtensions / setForgeExtensionTrust / deleteForgeExtension` |
| UI（信任/拒绝/删除 + 看实现） | `renderer/src/plugins/PluginManagerView.tsx`「MCP 能力详情 → 锻造的工具」 |
| 引擎单测 | `test/forge-core.test.ts`（登记/重名拒绝/安全门/信任后可用/删除/能力列表） |

---

## 7. 给一个新 App 接入自演化（适配器清单）

1. 按 [02 方法论](./02-通用方法论.md) 拿到该 App 的「三把钥匙」，做出 `evalInApp(js)` 与 `ensureReady()`。
2. 在该 App 的 MCP server 里：
   ```js
   const forge = createForge({ appId:"my-app", evalInApp, ensureReady, builtinToolNames:[...] });
   forge.registerMetaTools(server);
   forge.registerStoredExtensions(server);
   ```
3. 给 UI 的 `forgeAppId` 用该 App 的标识（插件管理页按 `definition.targetSoftware.id` 过滤锻造工具）。
4. 完成。该 App 即拥有 forge_probe/test/register/list 四个元工具与自演化能力，注册表共用同一文件、按 appId 分区。

---

## 8. 设计取舍（FAQ）

- **为什么用「数据」而非「改代码」？** 改代码要发版、有回归风险；数据是 append-only、可热加载、
  可分享、可被用户一键删除，天然满足「只增不删改 + 用户可控」。
- **为什么不让 AI 自己信任？** 那等于没有护栏。信任必须是人审关口。
- **为什么不限制网络？** 为了多 App / 跨 App 互联的可能性。代价是更依赖「用户信任」这道关，
  所以撞门提示必须充分。
- **锻造工具会污染应用状态吗？** 和手写工具一样，取决于 `jsBody`。建议 AI 在 `forge_test_tool`
  阶段充分验证；只读类工具最安全。（参考网易云那次 `fromInfo:null` 教训：构造对象别给 null。）
