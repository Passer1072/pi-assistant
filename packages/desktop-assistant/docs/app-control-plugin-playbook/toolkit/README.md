# 探测脚本工具箱（可直接复用）

给任意 CEF / Electron / Chromium 内核桌面应用做逆向时的起手工具。

## 文件

- `cdp.py` —— 最小可复用的 CDP 客户端：连上调试端口、在页面里执行 JS（含避开后台节流的
  `eval_then_read`）。
- `discover.py` —— 对目标应用跑“标准发现流程”，一键定位三把钥匙（webpack require / Redux
  store / API 请求工厂）并列出可派发的 action。

## 准备

```bash
pip install websocket-client
```

```powershell
# 让目标应用带调试端口启动（不改任何文件）
& "<安装目录>\app.exe" --remote-debugging-port=9222
```

## 用法

```bash
# 一键发现（命名空间正则按目标应用调整）
python discover.py --port 9222 --ns "playing|playingList|player|queue"
```

```python
# 或在自己的脚本里精细探测
from cdp import CDP
cdp = CDP(port=9222)

print(cdp.version())
print(cdp.eval("document.title"))

# 拿到三把钥匙后（discover.py 跑完已挂到 window 上）：
print(cdp.eval("Object.keys(window.__store.getState())"))
print(cdp.eval("(async()=>await window.__request({url:'/api/...',method:'POST'})({}))()"))

# 控制类操作：先 dispatch，等一会儿，再读状态（避开后台定时器节流）
state = cdp.eval_then_read(
    "window.__store.dispatch({type:'playing/pause'})",
    "window.__store.getState().playing.playingState",
    wait=0.5,
)
print(state)
cdp.close()
```

## 注意事项（务必先读）

1. **不要在注入的 JS 里用长 setInterval/setTimeout 分多次采样** —— 后台窗口会被 Chromium
   节流。需要“等一会儿再读”就用 `eval_then_read`（时序放在 Python 侧）。
2. **动作名/参数以源码为准**：`discover.py` 提取的是“源码里出现过的字符串”，具体 payload
   形状要读对应 effect 源码确认（见 03 手册 §4）。
3. **按特征定位、勿写死模块 id**：应用更新后 id/混淆名会变，靠签名特征才稳。
4. **定位 ≠ 可用**：每定位一个接口，立刻在运行实例上实测。

> 配套阅读：上级目录 [03-逆向技术手册.md](../03-逆向技术手册.md)；成品参考
> `mcp-servers/netease-music/netease-music-mcp-server.mjs`。
