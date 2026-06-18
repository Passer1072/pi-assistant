# 语音唤醒

桌面助手默认使用 **sherpa-onnx 关键词检测（KWS）** 作为唤醒引擎：原生、全离线、无需联网，
也无需自己训练模型。唤醒词以“模型 token”的文本形式给出（默认唤醒词「小派」对应拼音 token
`x iǎo p ài`），因此换词只是改一行文本，而不是重训一个模型——这正是它比旧的 openWakeWord 方案
更易用、更可靠的原因。

引擎优先级（见 [`renderer/src/voice/wake-word.ts`](../renderer/src/voice/wake-word.ts)）：

```
KWS（sherpa-onnx，默认） → openWakeWord（需自训练模型） → Vosk → 浏览器识别
```

运行链路：

```
麦克风(渲染进程) → 重采样 16kHz → IPC 流式帧 → 主进程 KWS(sherpa-onnx)
  → 命中关键词 → 通过 IPC 回传 wake 事件 → 进入“等待说话”
```

KWS 推理是原生代码，跑在 **主进程**（而不是渲染进程）：渲染进程用现有的麦克风采集把 16kHz 单声道
帧通过 IPC 持续推给主进程，主进程喂给 sherpa-onnx 流式解码器，命中后回传唤醒事件。音频只在本机
进程间传输，不出网。

相关代码：
- 主进程引擎：[`src/voice/kws-service.ts`](../src/voice/kws-service.ts)
- 关键词构造（纯函数，已测）：[`src/voice/kws-keywords.ts`](../src/voice/kws-keywords.ts)
- 渲染端探测器：[`renderer/src/voice/kws-detector.ts`](../renderer/src/voice/kws-detector.ts)
- 引擎选择/兜底：[`renderer/src/voice/wake-word.ts`](../renderer/src/voice/wake-word.ts)
- IPC：`startWakeKws` / `wakeKwsAudio` / `stopWakeKws` / `wakeKwsEvent`（[types.ts](../src/shared/types.ts)）
- 配置项：`VoiceSettings.wakeEngine`（默认 `"kws"`）/ `kwsSensitivity` / `kwsKeywords`

## 一、下载模型（一次性，离线运行）

```bash
npm install            # 安装 sherpa-onnx-node（含预编译 win-x64 原生二进制，N-API，无需 rebuild）
npm run fetch:kws      # 下载 KWS 模型并解压到 resources/kws/
```

`fetch:kws` 会写入（约 13MB）：
- `resources/kws/encoder.onnx` / `decoder.onnx` / `joiner.onnx`
- `resources/kws/tokens.txt`
- `resources/kws/keywords.txt`（默认 `小派` 关键词，仅作参考/兜底）

模型来自 sherpa-onnx 的 WenetSpeech KWS（约 3.3M 参数，流式 zipformer，建模单元为拼音 声母+韵母）。
`resources/kws/*.onnx` 已加入 `.gitignore`，由 `fetch:kws` 现取，不入库。

> 模型文件缺失时，KWS 自动回退到 Vosk/浏览器识别，并在唤醒覆盖层提示运行 `npm run fetch:kws`。

## 二、调参

设置页 → 语音 → “唤醒方案”选择 **本地唤醒**，下方“唤醒灵敏度”滑杆即可调节：

- `kwsSensitivity`（0–1，默认 `0.6`）：越高越容易唤醒。内部映射为 sherpa-onnx 的关键词阈值
  `keywordsThreshold`（灵敏度 0 → 阈值 0.35 较严，1 → 0.10 较松），见
  [`sensitivityToThreshold`](../src/voice/kws-keywords.ts)。
- 唤醒词太短（如「小派」只有两个音节）天然更易误触发；构造关键词时已加 `:2.0` 提升召回，
  并按灵敏度写入 `#<threshold>`。误唤醒偏多就调低灵敏度，唤不醒就调高。

### 自定义唤醒词（任意中文，自动转换）

直接在设置页「唤醒词」里填任意中文词即可——会**自动转拼音 token**并对照模型 `tokens.txt` 校验，
无需手动转换。实现见 [`wakeWordToTokens`](../src/voice/kws-keywords.ts)：用 `pinyin-pro`（纯 JS、
离线）取带调拼音，再按声母+韵母切成模型 token，例如：

- `小派` → `x iǎo p ài`
- `你好问问` → `n ǐ h ǎo w èn w èn`
- `贾维斯` → `j iǎ w éi s ī`

注意事项与高级覆盖：

- 转换在主进程进行（`KwsService` 从 `tokens.txt` 读取词表）。若某个音节的 token 不在模型词表中
  （非中文、生僻读音等），该词转换失败并回退到默认 `小派`。
- 多音字按 `pinyin-pro` 的默认读音处理；个别词读音不对时，用 `VoiceSettings.kwsKeywords` 手动覆盖
  整行关键词：`<token...> @<显示名> :<boost> #<threshold>`，例如 `n ǐ h ǎo w èn w èn @你好问问 :2.0 #0.2`。
  填了覆盖项就以它为准，忽略自动转换与灵敏度阈值。

### 运行中再次唤醒 = 打断（仅当前会话）

唤醒并说完话发送给模型后，**唤醒监听会继续运行**（仅在录音那几秒暂停）。模型回答/执行任务期间再次
说唤醒词，会**立即打断**当前会话的模型生成与正在执行的动作，然后直接开始录入新指令。实现见
[`voice-controller.ts`](../renderer/src/voice/voice-controller.ts)：`beginVoiceInput` 开头调用
`interruptActiveRun()`（`isRunning` 时对 `focusedSessionId` 调 `abort`，等同停止按钮、仅限当前会话），
并把 prompt 改为**不阻塞派发**（`dispatchPrompt`），这样模型运行期间唤醒监听照常工作。

## 三、备选引擎：openWakeWord（自训练）

仍保留 openWakeWord 作为可选引擎（设置页“唤醒方案”→ openWakeWord）。它通过 `onnxruntime-web`
在 Web Worker 中全离线运行，但**依赖用户自训练的 `.onnx` 分类器**，训练质量直接决定唤醒效果——
这也是默认改用 KWS 的原因。

```bash
npm run fetch:wake     # 下载 openWakeWord 基础模型(melspectrogram/embedding)到 resources/public
```

链路：麦克风 → 16kHz → `melspectrogram.onnx` → `embedding_model.onnx` → 自训练分类器 `.onnx`
→ 激活概率 ≥ `owwThreshold` 触发。训练用合成语音（TTS）+ 负样本，导出 ONNX 后在设置页“导入模型”。
模型存于 `userData/wake-word-models/`，`owwThreshold`（默认 `0.5`）调高减少误唤醒、调低提高唤醒率。

## 四、注意事项

- `sherpa-onnx-node` 是 N-API 原生模块（与 `node-window-manager`、`@nut-tree-fork/nut-js` 一致），
  Electron 下无需 `electron-rebuild`。打包（electron-builder）时需把它的 `.node` 与依赖 DLL 以及
  `resources/kws/` 一并 unpack 出 asar。
- `resources/kws/` 在 `resources/public` 之外，不会被 Vite 打进渲染产物；主进程按
  `resolve(__dirname, "../../../resources/kws")` 读取。
- KWS 推理在“监听唤醒”期间运行——包含空闲期**和模型回答期**（以支持运行中打断），仅在录音那几秒
  暂停；模型小、CPU 开销很小。
