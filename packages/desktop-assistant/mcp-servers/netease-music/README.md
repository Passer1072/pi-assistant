# netease-music · 网易云音乐控制 MCP 插件

通过 **CDP（Chromium DevTools Protocol）** 控制网易云音乐 3.x —— **零注入、不改任何文件、
不触发启动保护**。原理与逐步研究过程见 [RESEARCH.md](./RESEARCH.md)。

- 引擎：[`netease-music-mcp-server.mjs`](./netease-music-mcp-server.mjs)（Node，零额外依赖）
- 启动器：[`launch-netease-debug.ps1`](./launch-netease-debug.ps1)

---

## 工作前提

网易云音乐必须以 **`--remote-debugging-port`** 启动。用启动器一键搞定（不会修改安装目录）：

```powershell
./launch-netease-debug.ps1                       # 默认 D:\CloudMusic\CloudMusic\cloudmusic.exe，端口 9222
./launch-netease-debug.ps1 -Force                # 若网易云已在运行（无调试端口），重启它带上端口
./launch-netease-debug.ps1 -ExePath "X:\...\cloudmusic.exe" -Port 9222
```

> 想让“点开桌面图标也带调试端口”，可把网易云快捷方式的目标改成
> `"...\cloudmusic.exe" --remote-debugging-port=9222`。

---

## 在 Desktop Assistant 里启用

设置 → MCP 管理 → 添加：

```json
{
  "name": "网易云音乐",
  "enabled": true,
  "transport": "stdio",
  "command": "node",
  "args": ["C:/pythonProject/Desktop_Assistant/packages/desktop-assistant/mcp-servers/netease-music/netease-music-mcp-server.mjs"],
  "env": {
    "NCM_DEBUG_PORT": "9222",
    "NCM_EXE_PATH": "D:\\CloudMusic\\CloudMusic\\cloudmusic.exe",
    "NCM_AUTO_LAUNCH": "1"
  },
  "toolNamePrefix": "ncm",
  "timeoutMs": 15000
}
```

打开全局 MCP 开关，点 Test / Refresh。工具会以 `mcp_ncm_<tool>` 暴露给 AI。

> 也可以在“设置 → 插件管理”里点“安装”网易云插件，会自动写好上面的配置（见仓库
> `software-plugin-manager.ts`）。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `NCM_DEBUG_HOST` | `127.0.0.1` | 调试主机 |
| `NCM_DEBUG_PORT` | `9222` | 调试端口（要与启动时一致）|
| `NCM_EXE_PATH` | 空 | cloudmusic.exe 路径（配合自动启动）|
| `NCM_AUTO_LAUNCH` | 空 | `"1"` 时，连不上就自动用调试端口拉起网易云 |

---

## 工具清单

### 读取
- `get_playback_state` —— 当前歌曲/歌手/专辑/音量/模式/队列；`playing` 以**进度是否推进**为准
  （网易云内部 `playingState` 不可靠/颠倒，已不用它判断）
- `get_queue` —— 当前播放队列（resourceId / 歌名 / 歌手）

### 播放控制
- `play` · `pause` · `toggle_play` · `stop`
- `next_track` · `previous_track` —— 上一首 / 下一首（队列模式下，FM 模式自动转 FM 切歌）
- `seek {seconds}` —— 跳进度
- `set_volume {volume:0-100}` —— 设置**网易云内部音量**（非系统音量）
- `change_volume {delta:-100~100}` —— 在当前网易云音量上相对增减（「大点声/小点声」）
- `toggle_mute`
- `set_play_mode {mode: list_loop|single_loop|shuffle|order}` —— 列表循环 / 单曲循环 / 随机 / 顺序

### 点歌 / 播放
- `play_queue_track {resourceId}` —— 播放队列中的某首
- `play_song_by_id {id}` —— 按 song id 播放任意歌
- `play_song_by_name {query, preferArtist?}` —— 搜索并播放最佳匹配
- `play_playlist {id, limit?}` —— 用歌单替换队列并开始播放
- `play_my_playlist {name, limit?}` —— 按名称播放我的歌单（如「我喜欢的音乐」，自动识别收藏夹）
- `play_artist {query, limit?}` —— 搜索歌手并播放其热门歌曲（query 传歌手名或 id）
- `play_album {query, limit?}` —— 搜索专辑并播放整张（query 传专辑名或 id）
- `add_to_queue {id?|query?, next?}` —— 加入播放队列不打断当前；next=true 插「下一首」

### 红心 / 收藏 / 歌单管理
- `like_song {id?, like?}` —— 给歌曲点红心（加入/移出「我喜欢的音乐」，默认当前歌）
- `subscribe_playlist {id, subscribe?}` —— 收藏 / 取消收藏歌单
- `create_playlist {name, privacy?}` —— 创建新歌单
- `get_song_url {id?, level?}` —— 获取歌曲可播放地址

### 发现 / 私人FM
- `get_daily_recommend {limit?}` —— 每日推荐歌曲列表
- `play_daily_recommend {limit?}` —— 一键播放每日推荐
- `play_personal_fm` —— 开始私人FM（心动模式）
- `fm_next` / `fm_trash` —— 私人FM 下一首 / 扔进垃圾桶（不喜欢）

### 搜索 / 信息 / 评论
- `search {keyword, type?, limit?}` —— type: song|album|artist|playlist|user|mv|lyric|podcast
- `get_lyric {id?}` —— 歌词（默认当前歌）
- `get_user_playlists {limit?}` —— 我的歌单（含 `isFavorites` 标记收藏夹）
- `get_playlist_tracks {id, limit?}` —— 歌单曲目
- `get_song_comments {id?, limit?, offset?}` —— 歌曲热评+最新评论（默认当前歌，供 AI 总结；offset 翻页）

### 高级 / 逃生口（可做“尚未单独封装”的任何事）
- `ncm_api {url, method?, params?}` —— 调任意网易云 Web API（自动签名）
- `ncm_dispatch {type, payload?}` —— 派发任意 Redux action
- `ncm_eval {expression}` —— 在网易云页面内执行任意 JS

---

## 自检 / 排错

```powershell
# 1) 端口在不在
Invoke-RestMethod http://127.0.0.1:9222/json/version

# 2) 直接测 MCP server（仓库根目录）
node .tmp/mcp_test_client.mjs   # 若保留了测试脚本
```

- **“Cannot reach NetEase Cloud Music CDP …”**：网易云没带调试端口启动 → 跑启动器。
- **“redux store not found / request factory not found”**：网易云还没加载完或未登录 →
  等界面出来再试。
- **切歌/点歌后状态没变成“播放中”**：后台启动的实例音频设备可能未真正出声，曲目选择
  是对的；前台正常使用时会出声。
- 网易云大版本更新后接口失效：见 [RESEARCH.md §7 自愈指南](./RESEARCH.md)。
