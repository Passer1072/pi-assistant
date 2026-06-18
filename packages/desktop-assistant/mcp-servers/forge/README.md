# forge — 通用「自演化 MCP」框架

> 让 AI 在遇到现有工具做不到的功能时，能像人一样**在目标应用里逆向、试验，并把新能力
> 以数据形式持久化为新工具**——只增不删改、带安全门、App 无关、可跨 AI / 跨机器分享。

- 核心：[`forge-core.mjs`](./forge-core.mjs)（App 无关，零业务逻辑）
- 注册表：[`registry/extensions.json`](./registry/extensions.json)（可移植 JSON，便于分享）
- 主进程侧（UI 的信任/删除）：`src/plugins/forge-registry.ts`
- UI：插件管理页「MCP 能力详情 → 锻造的工具」区块

---

## 30 秒看懂

```
AI 想做某事 → 没有现成工具
  → forge_probe  在 App 里只读探测，逆向出怎么做
  → forge_test_tool  用样例参数试跑候选实现（不持久化）
  → forge_register_tool  登记成新工具（追加到注册表，默认【未信任】）
  → 调用它 → 撞【安全门】→ AI 提示用户去插件页【信任】
  → 用户点【信任】（一次，永久）→ 工具可用
```

**铁律：只增不删改。** AI 永远只能 append 新工具，重名直接拒绝；AI 不能删；用户可删
（仅限锻造的工具，代码写死的内置工具不在注册表里、删不了）。

---

## 设计原则（与产品决策一致）

| 维度 | 决策 |
|---|---|
| 审批门 | 锻造的新工具默认**未信任**；调用即撞安全门。用户**信任一次后永久有效**。撞门时 AI 必须明确告知用户去信任/拒绝。 |
| 删除权 | **AI 不能删/改**任何工具；**用户可删**锻造的工具；**内置工具不可删**（不在注册表里）。 |
| 范围 | **通用多 App 框架**：核心 App 无关，每个 App 提供一个「适配器」。 |
| 网络 | 锻造工具的 JS **不做网络白名单限制**（为支持多 App / 跨 App 互联）。 |
| 存储 | 注册表放**软件自身目录**（`mcp-servers/forge/registry/extensions.json`），可移植、可分享。 |

---

## 给 App 接入（写一个适配器）

forge 核心只依赖一个**适配器**：能在目标应用上下文执行 JS + 一个就绪钩子。任意
Electron/CEF 应用都能接入（拿到它的「三把钥匙」后，见 playbook 的逆向手册）。

```js
import { createForge } from "../forge/forge-core.mjs";

const forge = createForge({
  appId: "your-app-id",                 // 注册表按它分区，全局唯一
  evalInApp: (js) => evalInApp(js),     // 在目标应用里执行 JS 表达式，按值返回（如 CDP Runtime.evaluate）
  ensureReady: () => ensureReady(),     // 确保适配器的全局句柄就绪（如 window.__store/__request）
  builtinToolNames: [...BUILTIN_TOOLS], // 代码写死的内置工具名（受保护，不可被覆盖/删除）
});
forge.registerMetaTools(server);        // 注册 forge_probe / forge_test_tool / forge_register_tool / forge_list_capabilities
forge.registerStoredExtensions(server); // 把注册表里属于本 App 的、已锻造的工具注册为 MCP 工具
```

> 网易云适配器见 `mcp-servers/netease-music/netease-music-mcp-server.mjs` 末尾。

---

## forge 元工具（暴露给 AI）

| 工具 | 作用 |
|---|---|
| `forge_probe {js}` | 在 App 里**只读探测**（逆向 redux action / API 端点 / 模块）。自演化第一步。 |
| `forge_test_tool {jsBody, args?}` | 用样例参数**试跑**候选实现，不持久化。`jsBody` 内用 `args` 取参、需 `return`。 |
| `forge_register_tool {name, description, jsBody, inputSchema?, notes?}` | **登记新工具**（追加，重名拒绝）。登记后未信任，调用撞安全门。 |
| `forge_list_capabilities` | 列出本 App 的内置工具 + 已锻造工具（含信任态）。 |

锻造工具的实现 `jsBody` 是一个 async 函数体，参数对象名为 `args`，需 `return` 结果；
运行时通过 `(async (args)=>{ <jsBody> })(参数)` 在 App 上下文执行。

---

## 注册表格式（`registry/extensions.json`，可分享）

```jsonc
{
  "version": 1,
  "extensions": [
    {
      "appId": "netease-cloud-music",
      "name": "get_current_song_id",        // 小写字母开头，仅 [a-z0-9_]
      "description": "返回当前歌曲 id",
      "inputSchema": { "id": { "type": "number", "required": true } },
      "jsBody": "return window.__ncm_store.getState().playing.resourceTrackId;",
      "trusted": false,                       // 用户信任后置 true
      "origin": "forge",                      // 只有 forge 来源可被用户删除
      "createdBy": "ai",
      "createdAt": "2026-06-10T...Z",
      "notes": "逆向依据：..."
    }
  ]
}
```

> 直接把这个 JSON 拷给别人/另一台机器，即可共享 AI 锻造出来的能力（共享后仍需对方用户
> 信任一次）。MCP server 在**每次调用**时从磁盘重读信任态/存在性，因此 UI 的信任/删除
> 立即生效，无需重启。

---

## 安全模型

- **安全门**：未信任的锻造工具调用即被拦截，返回明确提示要求 AI 让用户去信任/拒绝。
- **只增不删改**：没有任何「编辑/删除」的 AI 接口；要「改」一个工具只能登记一个新名字
  （如 `xxx_v2`），旧的不动 → 零回归。
- **内置受保护**：内置工具名 + forge_* 元工具名都受保护，不能被锻造工具覆盖。
- **审计**：每条记录带 `createdBy/createdAt/notes/jsBody`，用户可在 UI 展开查看实现代码。

> 详细原理与逆向方法见学习资料：`docs/app-control-plugin-playbook/05-自演化MCP框架.md`。
