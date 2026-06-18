# 方案：自动会话标题（Auto Conversation Title）

> 目标：像主流 AI 一样，在用户发出**首条消息**并得到一次完整回复后，由模型自动总结出一个简短标题，写进会话列表（抽屉里的历史会话 + 顶部多会话 tab），并持久化。失败时静默回退到现有的"截取首/末条用户消息"逻辑，绝不阻塞或破坏对话本身。

本文档面向"接手实现的另一位 AI"。先讲清现状与数据流（前因后果），再给出分阶段的改法（怎么改），最后列出边界情况与测试。所有行号引用基于撰写时的代码，改之前请以实际文件为准。

---

## 1. 现状：标题现在是怎么来的

当前**没有任何持久化标题**，列表上显示的"标题"都是每次读取时即时从消息里截出来的，因此标题会随着对话推进不断变化。共有两个来源：

### 1.1 历史会话列表（抽屉，已归档/空闲会话）

- `DesktopAgentService.listConversationHistory()` → `buildHistoryEntry(summary)`
  - 文件：`src/agent/desktop-agent-service.ts:780` 和 `:1422`
  - 关键行 `:1436`：
    ```ts
    title: latestMessages.lastUserMessage?.slice(0, 28) || "新对话",
    ```
  - 注意：用的是**最后一条**用户消息的前 28 字，不是第一条；每发一轮就会变。
- 数据来自归档 `index.json` → `ConversationArchiveSummary`（见 `src/agent/conversation-archive.ts:53`），summary 又是从每个会话的 `metadata.json`（`ConversationArchiveMetadata`，`:24`）汇总而来。

### 1.2 多会话 tab（活跃会话 roster）

- `DesktopAgentService.buildSessionSummaries()` → `deriveSessionTitle(context)`
  - 文件：`src/agent/desktop-agent-service.ts:416` 和 `:433`
  - 逻辑：从内存里的 `context.messages` 倒序找最后一条非空用户消息，`slice(0,28)`；没有就回退到 `metadata.lastUserMessage`，再没有就 `"新对话"`。

### 1.3 标题如何到达 UI

- 渲染端 `App.tsx`：
  - `refreshHistory()`（`renderer/src/App.tsx:144`）调用 `window.desktopAssistant.listConversationHistory()`，把结果经 `toStoredConversation`（`renderer/src/conversation-history.ts:4`）存进 `conversations` state。
  - **关键**：`useEffect`（`renderer/src/App.tsx:338-341`）在 `liveSnapshot.messages.length` / `timeline.length` 变化时就 `refreshHistory()`。也就是说**每来一条消息，历史列表都会重新拉取**——所以只要后端把标题持久化好，列表会自然刷新出来。
  - 抽屉渲染：`renderer/src/components/Drawer.tsx:143`（tab：`session.title`）与 `:177`（历史：`conversation.title`）。
- 类型链：`ConversationHistoryEntry`（`src/shared/types.ts:1175`，含 `title: string`）→ IPC → `StoredConversation`（`renderer/src/app-types.ts:3`）。tab 用的是 `SessionSummary`（也含 `title`，来自 snapshot）。

**结论**：UI 与类型早已有 `title` 字段，无需新增展示字段。我们要做的是：① 真正生成一个语义标题；② 持久化它；③ 让上面两个 `title` 来源**优先用持久化标题**。

---

## 2. 现有可复用的基础设施

### 2.1 归档/持久化层（`src/agent/conversation-archive.ts`）

- 每个会话一个目录 `save/conversations/<sessionId>/`，内含 `metadata.json` / `events.jsonl` / `conversation.json` / `session.jsonl`。
- `ConversationArchiveWriter`（`:343`）负责单会话写入：
  - `write(kind, payload)`：往 `events.jsonl` 追加事件（异步缓冲）。
  - `writeMetadata()`（`:553`）：生成 `metadata.json`，这是我们要扩展的落点。
  - `flushSnapshots()`（`:453`）：把 metadata/conversation.json 落盘并触发 `coordinator.flushIndex()` 重建 `index.json`。
- `ConversationArchiveCoordinator`（`:169`）：跨会话，负责 `index.json` 与 summary 汇总（`readSummaryFromMetadata` `:304`）。
- **要点**：任何要进入历史列表的字段，**必须写进 `metadata.json`，并在 `readSummaryFromMetadata` 里读进 `ConversationArchiveSummary`**，否则 index 重建后会丢。

### 2.2 一次性轻量 LLM 调用（已有范例）

`src/agent/deepseek.ts:195` 的 `validateDeepSeekApiKey()` 就是一个独立的 `fetch` 到 `${connection.baseUrl}/chat/completions` 的单次非流式调用范例。生成标题完全可以照搬这种"裸 fetch、不走 agent runtime"的方式，省事且不污染会话上下文。

需要的料：
- `connection = resolveDeepSeekApiConnection(settings)` → `{ mode, baseUrl }`（`src/shared/deepseek-connection.ts`）。
- `apiKey = await authStorage.getApiKey(getDeepSeekAuthProvider(settings), { includeFallback: false })`。
- 模型 id：优先用 **flash**（便宜）：`getDeepSeekRuntimeModelId(connection.mode, DEEPSEEK_FLASH_MODEL)`；relay 模式下若 flash 不存在则回退 `getDeepSeekRuntimeModelId(connection.mode, settings.modelId)`。

### 2.3 触发时机（`ConversationContext`）

- `handleSessionEvent`（`src/agent/conversation-context.ts:450`）里 `event.type === "agent_end"` 分支（`:507-540`）是**一轮 agent 跑完**的位置。`!event.willRetry` 时本轮真正结束，已有 `extractMemoriesFromLatestTurn()`（`:526`）等收尾动作——这是触发标题生成的天然钩子。
- `ConversationContext` 持有 `this.archive`（writer）、`this.messages`、`this.deps`。它通过 `this.deps` 回调拿跨会话能力（settings、emit、snapshot 等），见 `ConversationContextDeps`（`:96`）。它**不直接持有 authStorage**——所以 LLM 调用要通过新增的 dep 回调下放到 `DesktopAgentService`（service 持有 `authStorage`/`modelRegistry`/`settings`，见 `:202`、`:485` 的 `buildContextDeps`）。

---

## 3. 设计总览

**触发**：每个会话在**第一轮完整对话结束后**（首条 user + 首次 assistant 回复都已落地）生成一次标题；生成成功即写入 `metadata.json` 并刷新 index/snapshot；之后不再自动改（除非用户手动重命名或回退逻辑）。

**调用链**：
```
ConversationContext.handleSessionEvent(agent_end, !willRetry)
  └─ maybeGenerateConversationTitle()            // 新增，带一次性 guard
       ├─ this.deps.generateConversationTitle({userMessage, assistantMessage, signal})   // 新 dep
       │     └─ DesktopAgentService 实现：取 settings+authKey+connection → 调
       │           generateConversationTitle()（新模块 conversation-title.ts，裸 fetch）
       └─ 成功 → this.archive.setTitle(title, "auto")     // 新增 writer 方法
                   ├─ 持久化进 metadata.json（writeMetadata 带上 title）
                   ├─ write("conversation_title_generated", {...}) 进 events.jsonl
                   └─ flushSnapshots() → flushIndex()（index.json 带上 title）
       └─ emitSnapshot()/emitSessionStatus()      // 让 tab + 抽屉即时更新
```

**读取**：
- `buildHistoryEntry`：`title: summary.title?.trim() || <现有回退>`。
- `deriveSessionTitle`：先读 `metadata.title`，再回退现有逻辑。

**开关**：新增设置 `autoTitle.enabled`（默认 `true`），关掉时完全走旧的回退逻辑。

---

## 4. 分阶段实现

### 阶段 A — 数据模型：让 `title` 可持久化

**A1. 扩展归档元数据类型**（`src/agent/conversation-archive.ts`）

- `ConversationArchiveMetadata`（`:24`）新增：
  ```ts
  title?: string;
  titleSource?: "auto" | "manual";   // 区分自动 vs 用户手动改名（手动不被自动覆盖）
  ```
- `ConversationArchiveSummary`（`:53`）新增同样的 `title?` / `titleSource?`。
- `readSummaryFromMetadata`（`:304`）把它们从 metadata 读进 summary：
  ```ts
  title: metadata.title,
  titleSource: metadata.titleSource,
  ```

**A2. Writer 持有并写出 title**（`ConversationArchiveWriter`，`:343`）

- 新增字段：`private title: string | undefined;` 和 `private titleSource: "auto" | "manual" | undefined;`
- `restoreMetadata()`（`:533`）里恢复：读到 `parsed.title` / `parsed.titleSource` 就赋值（保证进程重启/会话重开后不丢、不重复生成）。
- `writeMetadata()`（`:553`）的 metadata 对象里加上 `title: this.title, titleSource: this.titleSource`。
- 新增方法：
  ```ts
  /** 设置会话标题并持久化。manual 优先级更高，auto 不会覆盖已存在的 manual。*/
  async setTitle(title: string, source: "auto" | "manual"): Promise<void> {
      const trimmed = title.trim();
      if (!trimmed) return;
      if (this.titleSource === "manual" && source === "auto") return;   // 别盖掉用户改名
      this.title = trimmed;
      this.titleSource = source;
      this.write("conversation_title_generated", { title: trimmed, source });
      await this.flushSnapshots();   // 落 metadata + 重建 index
  }
  /** 只读，供 service 决定是否需要生成 / 回退展示。*/
  getTitle(): string | undefined { return this.title; }
  hasTitle(): boolean { return !!this.title; }
  ```
- `ConversationArchiveStore` facade（`:913`）如需要可加 `setTitle` 透传，但多会话路径直接用 `context.archive`（writer），通常不必动 facade。

> 注：`AiReadableConversationArchive`（conversation.json）**不必**加 title，历史列表只读 summary/metadata 即可。少改一处。

### 阶段 B — 生成器：独立的标题生成模块

**B1. 新文件 `src/agent/conversation-title.ts`**

纯函数式、无副作用、可单测。签名建议：
```ts
export interface GenerateTitleInput {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    userMessage: string;
    assistantMessage?: string;
    signal?: AbortSignal;
}

/** 失败一律返回 undefined（调用方静默回退），绝不抛。*/
export async function generateConversationTitle(input: GenerateTitleInput): Promise<string | undefined>;

/** 纯函数：模型原始输出 → 规范化标题（去引号/书名号/标点/换行，截断）。导出以便单测。*/
export function sanitizeConversationTitle(raw: string): string;
```

实现要点：
- 裸 `fetch(`${baseUrl}/chat/completions`)`，`stream:false`、`temperature:0`、`max_tokens` 小（如 24）。
- system prompt（中文，约束输出）：
  > 你是会话标题生成器。根据用户的首条消息（及可选的助手回复）总结一个**简短**标题。要求：直接输出标题本身；不超过 12 个汉字或 20 个英文字符；不要标点、引号、书名号、句号；不要解释；用与用户相同的语言。
- user 内容：把 `userMessage`（截断到 ~500 字）和可选 `assistantMessage`（截断到 ~200 字）拼进去。
- `sanitizeConversationTitle`：去首尾空白、去包裹的引号/书名号 `"" '' 「」 《》`、去换行、去结尾标点、按字符数截断（建议 ≤ 18 以留余量），空串返回 `""`。
- 任何非 2xx、超时、解析失败 → `return undefined`。建议加 `AbortController` + ~8s 超时。

> 为什么不用 agent runtime？标题生成是与会话上下文无关的一次性小调用，走裸 fetch 不会把这次调用塞进会话历史、不触发工具、不计入会话 token 统计，最省事也最不容易出 bug。已有 `validateDeepSeekApiKey`（`deepseek.ts:209`）作为同款范例。

### 阶段 C — 接线：把生成能力从 service 下放到 context

**C1. 扩展 `ConversationContextDeps`**（`src/agent/conversation-context.ts:96`）
```ts
/** 生成会话标题；无 key/离线/出错时返回 undefined。由 service 用 authStorage+settings 实现。*/
generateConversationTitle(input: {
    userMessage: string;
    assistantMessage?: string;
    signal?: AbortSignal;
}): Promise<string | undefined>;
```

**C2. service 实现该 dep**（`src/agent/desktop-agent-service.ts:485` 的 `buildContextDeps`）
```ts
generateConversationTitle: (input) => this.generateConversationTitle(input),
```
并新增私有方法（service 持有 `this.authStorage`/`this.settings`）：
```ts
private async generateConversationTitle(input: {
    userMessage: string; assistantMessage?: string; signal?: AbortSignal;
}): Promise<string | undefined> {
    if (!this.settings.autoTitle?.enabled) return undefined;          // 开关
    const connection = resolveDeepSeekApiConnection(this.settings);
    const apiKey = await this.authStorage.getApiKey(getDeepSeekAuthProvider(this.settings), { includeFallback: false });
    if (!apiKey) return undefined;                                     // 没配 key → 回退
    let modelId: string;
    try {
        modelId = getDeepSeekRuntimeModelId(connection.mode, DEEPSEEK_FLASH_MODEL);
    } catch {
        modelId = getDeepSeekRuntimeModelId(connection.mode, this.settings.modelId);   // relay 无 flash 时回退
    }
    return generateConversationTitle({
        baseUrl: connection.baseUrl, apiKey, modelId,
        userMessage: input.userMessage, assistantMessage: input.assistantMessage, signal: input.signal,
    });
}
```
（顶部 import：`generateConversationTitle` from `./conversation-title.ts`；`DEEPSEEK_FLASH_MODEL`、`getDeepSeekRuntimeModelId`、`getDeepSeekAuthProvider` 已在 `deepseek.ts` 导出，按需补 import。）

**C3. context 在首轮结束后触发**（`src/agent/conversation-context.ts`）

- 新增字段：`private titleGenerationStarted = false;`
- 在 `handleSessionEvent` 的 `agent_end` 且 `!event.willRetry` 分支（`:525` 附近，`extractMemoriesFromLatestTurn()` 旁）调用：
  ```ts
  void this.maybeGenerateConversationTitle();
  ```
- 新方法：
  ```ts
  private async maybeGenerateConversationTitle(): Promise<void> {
      if (this.titleGenerationStarted) return;
      if (this.archive.hasTitle()) { this.titleGenerationStarted = true; return; }  // 重开旧会话已有标题
      const userMessage = findLatestMessageText(this.messages, "user")
          ?? this.messages.find((m) => m.role === "user")?.text;        // 首条 user
      if (!userMessage?.trim()) return;
      const assistantMessage = findLatestMessageText(this.messages, "assistant");
      this.titleGenerationStarted = true;     // 置位在 await 之前，防并发重复触发
      try {
          const title = await this.deps.generateConversationTitle({ userMessage, assistantMessage });
          if (!title) { this.titleGenerationStarted = false; return; }   // 失败允许下轮重试
          await this.archive.setTitle(title, "auto");
          this.emitSnapshot();                  // 焦点会话推全量 snapshot；后台推 session_status
      } catch {
          this.titleGenerationStarted = false;  // 出错允许下轮重试
      }
  }
  ```
  > 取"首条 user 消息"更符合"根据首个消息总结"的直觉；若想用最近一条，改 `find` 为 `findLatestMessageText` 即可。`findLatestMessageText` 已是文件内现成 helper（`:1297`）。

### 阶段 D — 读取端优先用持久化标题

**D1. 历史列表**（`desktop-agent-service.ts:1436`）
```ts
title: summary.title?.trim() || latestMessages.lastUserMessage?.slice(0, 28) || "新对话",
```

**D2. 活跃 tab**（`desktop-agent-service.ts:433` `deriveSessionTitle`）
- 开头先查 writer/metadata 的持久化标题：
  ```ts
  private deriveSessionTitle(context: ConversationContext): string {
      const stored = context.archive.getTitle()
          ?? this.coordinator.getConversationMetadata(context.sessionId)?.title;
      if (stored?.trim()) return stored.trim();
      // …现有回退逻辑不变…
  }
  ```

**D3. 刷新**：`emitSnapshot()` 已驱动焦点会话的 snapshot；后台会话走 `emitSessionStatus()`（roster 含 tab title）。抽屉历史列表因 `App.tsx:338-341` 在消息数变化时 `refreshHistory()` 而自然更新；标题生成发生在 `agent_end` 后、紧接着 service 还会 `flushSnapshots()`，故下一次 `refreshHistory()` 即可读到新 `index.json`。无需新增 IPC。

### 阶段 E — 设置开关

- `DesktopAssistantSettings`（`src/shared/types.ts`，与 `memory`/`tokenSaving` 同级）新增：
  ```ts
  autoTitle: { enabled: boolean };
  ```
- `DEFAULT_DESKTOP_ASSISTANT_SETTINGS` 加默认 `autoTitle: { enabled: true }`。
- 设置合并/迁移：检查 `updateSettings` 的 deep-merge 是否对新嵌套对象安全（缺失时回填默认），必要时在归一化处补 `autoTitle: { enabled: settings.autoTitle?.enabled ?? true }`。
- 设置 UI（`renderer/src/settings/SettingsView.tsx`）加一个开关项（可选，后置）。

### 阶段 F（可选）— 手动重命名

- IPC：`renameConversation({ sessionId, title })` → service 找到（或临时打开）该会话 writer → `setTitle(title, "manual")`。`titleSource:"manual"` 保证不被自动逻辑覆盖（见 A2）。
- preload（`src/main/preload.ts`）+ `desktop-assistant-api.d.ts` + ipc 注册（`src/main/ipc.ts`）补通道。
- Drawer 加"重命名"入口。该阶段独立，可后续再做。

---

## 5. 边界情况与约束（务必遵守）

1. **绝不阻塞对话**：标题生成是 `void` fire-and-forget，错误吞掉。`prompt()` / `agent_end` 主流程不得 `await` 它。
2. **只生成一次**：`titleGenerationStarted` + `archive.hasTitle()` 双重 guard；重开历史会话若 metadata 已有 title，不再生成。
3. **离线 / 无 API key / relay 无 flash**：`generateConversationTitle` 返回 `undefined`，UI 自动回退旧逻辑，列表照常显示。
4. **多会话安全**：每个 `ConversationContext` 用自己的 `this.archive`（绑定单 sessionId）写各自 metadata，天然隔离；勿用全局 facade 的 active writer 写标题。
5. **成本**：固定用 flash + `max_tokens` 小 + 仅首轮一次；对话内 token 统计不受影响（裸 fetch 不进会话）。
6. **手动优先**：`setTitle` 中 `manual` 不被 `auto` 覆盖。
7. **fork/rebind**：`bindSession`（`conversation-context.ts:259`）切底层 session 时会换 writer。新 writer 的 `restoreMetadata()` 会从新 sessionId 的 metadata 恢复 title；若是全新 sessionId 则无 title，会重新生成一次——可接受（fork 出的新会话本就该有自己的标题）。
8. **语言**：prompt 要求"与用户相同语言"，中文输入得中文标题。
9. **空标题/异常输出**：`sanitizeConversationTitle` 兜底；清洗后为空视为失败（返回 `undefined`）。

---

## 6. 改动文件清单（落地索引）

| 文件 | 改动 |
|---|---|
| `src/agent/conversation-title.ts` | **新增**：`generateConversationTitle` + `sanitizeConversationTitle` |
| `src/agent/conversation-archive.ts` | `ConversationArchiveMetadata`/`ConversationArchiveSummary` 加 `title`/`titleSource`；`readSummaryFromMetadata`、`restoreMetadata`、`writeMetadata` 带上；Writer 加 `setTitle`/`getTitle`/`hasTitle` |
| `src/agent/conversation-context.ts` | `ConversationContextDeps` 加 `generateConversationTitle`；新增 `titleGenerationStarted` + `maybeGenerateConversationTitle()`；`agent_end` 分支触发 |
| `src/agent/desktop-agent-service.ts` | `buildContextDeps` 接线；新增私有 `generateConversationTitle()`；`buildHistoryEntry`(D1) 与 `deriveSessionTitle`(D2) 优先用持久化标题 |
| `src/shared/types.ts` | `DesktopAssistantSettings` + 默认值加 `autoTitle.enabled` |
| `renderer/src/settings/SettingsView.tsx` | （可选）开关 UI |
| `src/main/ipc.ts` / `preload.ts` / `desktop-assistant-api.d.ts` / `Drawer.tsx` | （可选，阶段 F）手动重命名通道与入口 |

> 渲染端展示无需改：`ConversationHistoryEntry.title`、`SessionSummary.title`、`StoredConversation.title`、`Drawer.tsx` 都已就绪。

---

## 7. 测试建议

- **单测 `conversation-title.ts`**：
  - `sanitizeConversationTitle`：去引号/书名号/标点/换行、截断、空串 → `""`。
  - `generateConversationTitle`：mock `fetch`，验证正常返回清洗后的标题；非 2xx / 超时 / 坏 JSON → `undefined`。
- **归档层**（参考现有 `test/conversation-archive.test.ts`）：`setTitle` 后 `metadata.json` 与重建的 `index.json`/summary 都含 title；`manual` 不被 `auto` 覆盖；重启（重建 writer）后 `restoreMetadata` 恢复 title。
- **context 触发**：注入 fake `deps.generateConversationTitle`，发一轮 `agent_end(!willRetry)` 后断言 `archive.getTitle()` 被设置且只触发一次；fake 返回 `undefined` 时不置 title 且允许下轮重试。
- **service 读取**：`buildHistoryEntry`/`deriveSessionTitle` 在有/无持久化标题两种情况下的取值。
- **回归**：`autoTitle.enabled=false` 时完全走旧逻辑、无 LLM 调用。

---

## 8. 推荐落地顺序（每步可独立编译/测试）

1. 阶段 A（数据模型）+ 其单测 → 持久化通路打通（先不接生成，用测试手动 `setTitle` 验证 index/summary）。
2. 阶段 B（生成模块）+ 单测 → 纯函数，零依赖。
3. 阶段 C（接线触发）→ 端到端能在首轮后写出标题。
4. 阶段 D（读取优先级）→ UI 真正显示语义标题。
5. 阶段 E（开关）→ 可关闭。
6. 阶段 F（手动重命名，可选）。
