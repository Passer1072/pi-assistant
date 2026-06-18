# 网易云音乐控制方法 · 研究记录

> 本文记录我们如何在**不注入 DLL、不修改任何文件**的前提下，实现对网易云音乐
> （NetEase Cloud Music）3.x 的完整程序化控制。目标读者是想理解原理、并在网易云
> 更新后能自己重新定位接口的开发者。
>
> 验证环境：网易云音乐 **3.1.32.205206**（CEF / Chromium 91 内核），Windows 11。

---

## 0. 一句话结论

网易云 3.x 是一个 **CEF（Chromium Embedded Framework）应用**。用
`--remote-debugging-port` 启动它，就能通过 **Chrome DevTools Protocol (CDP)** 在它的
页面里执行任意 JavaScript，直接驱动它**自己的 Redux(dva) store** 和**内部 Web API
请求工厂**——这和 BetterNCM 插件能做的事是同一层，但**不碰磁盘上的任何文件**，因此
不会触发让 BetterNCM 闪退的“启动完整性保护”。

```
AI 助手 ──MCP(stdio)──▶ netease-music-mcp-server.mjs ──CDP(WebSocket)──▶ 网易云 CEF 页面
                                                  Runtime.evaluate 注入 JS
                                                  → window.__ncm_store.dispatch(...)
                                                  → window.__ncm_request({url})(params)
```

---

## 1. 为什么不走 BetterNCM / Chromatic（DLL 注入）

- 旧 **BetterNCM 1.3.x** 用 **DLL 劫持**（在安装目录放一个被 NCM 加载的代理 DLL）注入，
  只适配到网易云 **3.0.x**。
- 网易云 **3.1.x** 增加了**启动时文件完整性校验 + 进程内模块扫描**，一旦发现安装目录被
  改、或进程里有外来 DLL，就拒绝启动 / 闪退。
- **Chromatic**（BetterNCM 的重写继任者，`std-microblock/chromatic`，v2.0.0-pre）改进了
  技术，但截至研究时对 3.1.x 的支持仍不完善，自动安装器明确报“此版本暂不支持”。

> 教训：失败的不是“注入器写得不好”，而是**注入层（改文件 / 塞 DLL）正面撞上了反篡改**。
> 换一个**不改文件**的注入层（CDP 调试通道），问题消失。

---

## 2. 关键突破：确认 CDP 可用

网易云的壳是 CEF，CEF 支持 Chromium 的标准开关 `--remote-debugging-port`。先验证它没被
编译期裁掉：

```powershell
& "D:\CloudMusic\CloudMusic\cloudmusic.exe" --remote-debugging-port=9222
# 然后检查端口
Invoke-RestMethod http://127.0.0.1:9222/json/version
```

返回：

```json
{
  "Browser": "Chrome/91.0.4472.169",
  "V8-Version": "9.1.269.40",
  "User-Agent": "... NeteaseMusicDesktop/3.1.32.205206",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/..."
}
```

`http://127.0.0.1:9222/json` 列出页面目标，其中主界面是：

```
title: 网易云音乐
type:  page
url:   orpheus://orpheus/pub/app.html
webSocketDebuggerUrl: ws://127.0.0.1:9222/devtools/page/<ID>
```

连上这个 page 的 `webSocketDebuggerUrl`，用 CDP 的 `Runtime.evaluate` 即可在页面里跑 JS。

> **这一步是整个方案的开关**：端口能开 → 走轻松的 CDP 方案；端口被裁 → 才需要考虑
> “启动后 DLL 注入”等硬核手段。本版本端口可用。

---

## 3. 网易云 3.x 前端架构（探测得出）

在页面里枚举全局对象，得到：

| 全局 | 类型 | 含义 |
|---|---|---|
| `window.channel` | object | 原生桥：`channel.call("namespace.method", cb, args)` |
| `window.webpackJsonp` | array(38) | 老式 webpack 的 chunk 数组，共 **~1700 个模块** |
| `window.APP_CONF` | object | 应用配置：`appver/appkey/apiDomain/deviceId...` |
| `window.api` | object(空) | 没用 |
| `MusicCorona / MusicAPM` | - | NCM 内部模块 |

进一步发现：
- 播放不走 DOM `<audio>`（`document.querySelectorAll('audio').length === 0`），由原生层处理。
- 前端是 **React + dva(Redux)**：模块里能看到 `namespace/state/reducers/effects/subscriptions`
  结构，以及 `@@router`、`ConnectedRouter`、`createContext`。

所以控制分两层：
- **底层音频**：`channel.call("audioplayer.play/pause/stop/seek", ...)`（模块 1131 封装）。
- **高层播放逻辑**（下一首、点歌、队列、当前歌曲）：**派发 Redux action** + 读 store。

---

## 4. 拿到三把“钥匙”

### 4.1 钥匙一：webpack require（访问全部内部模块）

`webpackJsonp` 是数组，模块以数组下标存放。用标准 **execute-push 技巧**把
`__webpack_require__` 抠出来：

```js
window.webpackJsonp.push([[99999], { 999999: function (m, e, r) { window.__wpr = r; } }, [[999999]]]);
// 之后 window.__wpr 就是 __webpack_require__
// __wpr.c = 已实例化模块缓存; __wpr.m = 模块工厂源
```

### 4.2 钥匙二：Redux store（读状态 + 派发动作）

store 没挂在 window 上，但可以从 **React fiber** 回溯找到（react-redux 的 `Provider`
把 store 放在 `memoizedProps.store`）：

```js
const root = document.querySelector('#root');
const fk = Object.keys(root).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactInternalInstance'));
const stack = [root[fk]]; const seen = new Set();
while (stack.length) {
  const n = stack.pop(); if (!n || seen.has(n)) continue; seen.add(n);
  const mp = n.memoizedProps;
  if (mp && mp.store && mp.store.dispatch && mp.store.getState) { window.__ncm_store = mp.store; break; }
  if (n.child) stack.push(n.child);
  if (n.sibling) stack.push(n.sibling);
}
```

本机只走了 3 步就找到。`store.getState()` 的切片：

```
router, @@dva, $$MainWindow, historyList, dbPlayingList, sidebar, fmPlaying,
download, playingList, abtest, configCenter, assignedAudioEffect, playing,
audioEffect, host, app, setting, page:*, async:*
```

两个最重要的切片：
- **`playing`** —— 当前播放状态（见 §5.1）。
- **`playingList.curPlayingList`** —— 当前播放队列（数组）。
- `fmPlaying` —— 私人 FM 状态。

### 4.3 钥匙三：Web API 请求工厂（搜索 / 歌单 / 详情）

网易云所有 API 调用都长这样（在模块 15 里能看到上百个）：

```js
Object(r.a)({ url: "/api/cloudsearch/pc", method: "POST" })(params)   // 自动签名 + 带 cookie
```

`r.a` 是**核心请求工厂**。全局扫描“导出名为 `a`、源码含 url/method/cacheStrategy、且返回
一个函数”的模块，定位到 **模块 12** 的 `.a`：

```js
for (const id of Object.keys(window.__wpr.c)) {
  const exp = window.__wpr.c[id].exports;
  if (exp && typeof exp.a === 'function') {
    const s = Function.prototype.toString.call(exp.a);
    if (/url/.test(s) && /method/.test(s) && /cacheStrategy/.test(s)) { window.__ncm_request = exp.a; break; }
  }
}
// 用法：await window.__ncm_request({url:'/api/cloudsearch/pc',method:'POST'})({s:'周杰伦',type:1,limit:30})
```

> 三把钥匙的获取代码合并成 `BOOTSTRAP`，幂等，写在 MCP server 里，每次命令前都会跑一遍
> （应对网易云页面刷新）。

---

## 5. 完整控制地图（实测）

### 5.1 读：`playing` 切片关键字段

| 字段 | 含义 |
|---|---|
| `playingState` | 1=播放 2=暂停 3=错误 4=结束 0=空（见模块 1131 的 `IAUDIOPLAYER_PLAYING_STATE`）|
| `resourceName` | 当前歌名 |
| `resourceArtists` / `curTrack.ar` | 歌手数组 |
| `curTrack` | 完整曲目对象（id/name/al/ar/dt...）|
| `resourceTrackId` / `onlineResourceId` | 当前 trackId |
| `resourceDuration` | 时长（秒）|
| `resourceCoverUrl` | 封面 |
| `playingVolume` | 音量 0~1 |
| `playingMode` | `playCycle`(顺序) / `playOneCycle`(单曲) / `playRandom`(随机) |

> 🐞 **`playingState` 不可靠！** 实测本版本里它**甚至是颠倒的**（resume→播放中时为 2、
> pause→暂停时为 1），不要用它判断播放/暂停。**可靠判断 = 看播放进度是否推进**：订阅
> `audioPlayerPlayProgress$`（模块 1131）拿 `[id, 秒, ...]`，隔 ~650ms 采样两次，位置推进=播放中。
> （本插件 `get_playback_state` 即如此实现。）

### 5.2 写：可派发的 Redux action（`store.dispatch({type, payload})`）

这些 action 名是从模块源码里用正则 `/(playing|playingList|fmPlaying)\/\w+/` 提取的**真实
字符串**（非猜测），payload 形状是逐个读 effect 源码确认的：

| 功能 | action `type` | `payload` | 备注 |
|---|---|---|---|
| 播放/恢复 | `playing/resume` | `{}` | |
| 暂停 | `playing/pause` | `{}` | |
| 播放↔暂停切换 | `playing/switchResumeOrPause` | `{triggerScene:'...'}` | **必须带 payload**，否则 saga 内部读 `n.triggerScene` 抛错 |
| 停止 | `playing/stop` | `{}` | |
| 下一首 | `playingList/jump2Track` | `{flag:1}` | FM 模式自动转 `fmPlaying/playNext` |
| 上一首 | `playingList/jump2Track` | `{flag:-1}` | |
| 跳进度 | `playing/setPlayingPosition` | `{duration:<秒>}` | |
| 设音量 | `playing/setVolume` | `{volume:<0~1>}` | |
| 静音切换 | `playing/switchMute` | `{}` | |
| 切播放模式 | `playing/switchPlayingMode` | `{mode:'playRandom'}` | |
| 播放队列内某歌 | `playing/playOneTrackInPlayingList` | `{item:'<resourceId>'}` | item 为字符串时按 resourceId 在队列里查 |
| 播放任意歌曲对象 | `playing/playOneTrackInPlayingList` | `{item:{...}}` | item 为对象时直接用，**可播放队列外的歌**（见 §5.4）|
| 替换整个队列 | `playingList/replaceCurPlayingList` | `{list:[item,...]}` | 写入 DB，需配合下面刷新 |
| 刷新队列与当前歌 | `playingList/refreshCurPlayingListAndCurPlaying` | `{}` | |

> ⚠️ dva 的 effect 是异步 saga；`dispatch` 后状态不会同步更新，需等一会儿（200~600ms）
> 再读 `getState()`。

### 5.3 关键内部模块

| 模块 id | 导出 | 用途 |
|---|---|---|
| **12** | `.a` | **Web API 请求工厂** |
| **15** | `hh/ne/...`(混淆名) | 上百个具体 API 封装（按 url 区分）|
| **1131** | `setAudioPlayerPlay/Pause/Stop/seek`、`audioPlayerPlayState$`、`audioPlayerPlayProgress$` | 底层音频桥 + RxJS 状态流 |
| **1283** | `NativeApis`、`OrpheusCommand` | 原生命令分发器 |
| **4** | `PlayStatus`、`IAUDIOPLAYER_PLAYING_STATE`、`MiniPlayerState` 等 | 枚举常量 |
| **2875** | `PLAYMODE_MAP` | 播放模式映射 |

> 注意：模块 681 的 `play/pause/setVolume` 是 **Lottie 动画库**（version 5.13.0），**不是**
> 播放器，别被名字骗了。

### 5.4 播放任意歌曲（点歌）的可行路径（实测）

`playOneTrackInPlayingList` 的 item 传**对象**时会直接使用它，因此可以播放队列外的任意歌：

```js
const id = 3357698666; // 搜索得到的 song id
const det = await window.__ncm_request({url:'/api/v3/song/detail',method:'POST'})({c: JSON.stringify([{id}])});
const track = det.songs[0];
const item = { id, resourceId:String(id), trackId:String(id), resourceType:'track',
  track, localTrack:null, displayOrder:0, randomOrder:0, isPlayedOnce:false,
  ai:false, aiRcmd:false, scene:'', href:'', text:track.name,
  // ⚠️ 关键：fromInfo / referInfo 必须是【合法对象】，绝不能是 null！
  // 播放器会 `const {originalScene}=item.fromInfo` 解构它，null 会抛 TypeError，
  // 导致音频不出声、且读这个状态的页面（如「推荐」）一起崩（`sourceData of null`）。
  fromInfo:{originalScene:'track', originalResourceType:'track', computeSourceResourceType:'track', sourceData:{}, trialMode:0},
  referInfo:{addrefer:'', multirefers:[]} };
window.__ncm_store.dispatch({type:'playing/playOneTrackInPlayingList', payload:{item}});
```

实测：当前曲目立刻切到目标歌，且 `window.__ncm_progress` 进度正常推进（真正出声）。

> 🐞 **踩坑记录**：早期版本把 `fromInfo/referInfo` 设成 `null`，导致用工具点歌后**音频不播、
> 推荐页报错**。真实队列项的 `fromInfo` 形如
> `{originalScene, originalResourceType, computeSourceResourceType, sourceData:{id,name,coverImgUrl}, trialMode}`。
> 自己构造 item 时务必给**非空对象**（字段可留空/默认，但不能是 null）。
> 应急恢复：用 `playOneTrackInPlayingList {item:'<队列里真实项的 resourceId>'}`（字符串）即可，
> 因为字符串会让 NCM 用它自己的合法 item。

> 🐞 **字段缩写名 vs 完整名（封面/图片加载失败）**：搜索/详情 API 返回的 track 用**缩写名**
> `al`(专辑)/`ar`(歌手)/`dt`(时长)，但播放器的资源更新代码读**完整名** `album`/`artists`/`duration`
> （`resourceCoverUrl = track.album.picUrl`）。直接把 API 的 track 塞进 item → `track.album` 是
> undefined → 封面为空、专辑/歌手图片加载失败（歌能放）。**构造 item 前必须规范化**：
> `track.album = track.al; track.artists = track.ar; track.duration = track.dt;`，并把
> `fromInfo.sourceData` 填上 `{id, name, coverImgUrl}`。

### 5.5 常用 Web API 端点（模块 15 里抓到的，配合钥匙三调用）

| 端点 | 用途 |
|---|---|
| `/api/cloudsearch/pc` | 搜索（type: 1 歌曲 / 10 专辑 / 100 歌手 / 1000 歌单）|
| `/api/v3/song/detail` | 歌曲详情（参数 `c: JSON.stringify([{id}])`）|
| `/api/song/lyric` | 歌词（`{id, lv:-1, kv:-1, tv:-1}`）|
| `/api/user/playlist` | 用户歌单（`{uid, limit, offset}`）|
| `/api/v6/playlist/detail` | 歌单详情/曲目（`{id, n, s:8}`）|
| `/api/v3/discovery/recommend/songs` | 每日推荐（返回 `data.dailySongs`）|
| `/api/song/enhance/privilege` | 播放权限 |
| `/api/song/enhance/player/url/v1` | 歌曲播放地址（`{ids:JSON.stringify([id]), level}`）|
| `/api/song/like` | 点红心（`{trackId, like}`，返回我喜欢歌单 `playlistId`）|
| `/api/v1/radio/get` | 私人FM 列表（`{imageFm:1}`）|
| `/api/playlist/subscribe` `/api/playlist/unsubscribe` | 收藏 / 取消收藏歌单（`{id}`）|
| `/api/playlist/create` | 创建歌单（`{name, privacy:0/10}`）|

> 用户 uid 可从 `store.getState().playingList.latestUid` 读到。
> 以上端点均已在 3.1.32 上实测：每日推荐/FM/歌曲URL 读取返回 code 200，红心 like+取消
> 来回 code 200，私人FM 经 `fmPlaying/fmPlay` 派发后 `playingMode→playFm` 并实际出声。

---

## 6. MCP server 如何使用以上成果

`netease-music-mcp-server.mjs`：

1. `BOOTSTRAP`：每次命令前注入，确保 `window.__wpr / __ncm_store / __ncm_request` 就绪。
2. 读类工具（`get_playback_state`、`get_queue`）→ 读 `store.getState()`。
3. 控制类工具（play/pause/next/seek/volume/...）→ `store.dispatch(...)` + 回读状态。
4. 搜索/歌单/歌词/点歌 → `window.__ncm_request({url})(params)`。
5. 万能逃生口：`ncm_api`（调任意端点）、`ncm_dispatch`（派发任意 action）、`ncm_eval`
   （执行任意 JS）—— 让助手能做“尚未单独封装”的任何事。

详见 [README.md](./README.md) 的工具清单。

---

## 7. 网易云更新后如何重新定位（自愈指南）

接口名（模块 id、混淆导出名、action 名）可能随大版本变。重新定位的顺序：

1. **确认 CDP 仍可用**：`Invoke-RestMethod http://127.0.0.1:9222/json/version`。
2. **三把钥匙是按“特征”而非“写死 id”找的**，通常能自适应：
   - require：execute-push 技巧（webpack 结构不变就有效）。
   - store：fiber 找 `memoizedProps.store`。
   - request：扫描“导出 `a`、源码含 url/method/cacheStrategy”的模块。
3. **action 名**变了：用下面的脚本重新枚举（在页面里跑）：
   ```js
   const set = new Set(); const m = window.__wpr.m;
   for (const id in m) { const s = Function.prototype.toString.call(m[id]);
     (s.match(/["'`](?:playing|playingList|fmPlaying)\/\w+["'`]/g) || []).forEach(x => set.add(x)); }
   [...set].sort();
   ```
4. **payload 形状**变了：在页面里读对应 effect 源码：
   ```js
   const m = window.__wpr.m; let hit;
   for (const id in m){ const s=Function.prototype.toString.call(m[id]);
     const i=s.search(/[*\s,{]setVolume\s*[:(]/); if(i>=0){hit=s.slice(i,i+300);break;} } hit;
   ```
5. **API 端点**变了：扫描 `Object(r.a)({url:"/api/..."` 字符串即可列出全部端点。

> 探测脚本的完整历史保存在仓库 `.tmp/cdp_*.py`（如果还在），是逐步定位的过程留档。

---

## 8. 风险与边界

- **使用条款**：自动化操控理论上违反网易云使用条款，存在账号风险（实际很低，纯本地、
  不刷量）。仅供个人学习/自用。
- **稳定性**：内部接口随版本变；本方案靠“特征定位 + 逃生口”降低维护成本。
- **安全**：调试端口绑定 `127.0.0.1`，但本机其它进程也能连。介意可加 token 网关。
- **不改文件**：本方案全程只“附加调试器 + 跑 JS”，不写网易云目录，随时可逆。
