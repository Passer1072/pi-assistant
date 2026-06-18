"""
cdp.py — 一个最小、可复用的 CDP（Chromium DevTools Protocol）探测客户端。

用于给 CEF / Electron / Chromium 内核的桌面应用做逆向：连上以
`--remote-debugging-port` 启动的应用，在它的页面里执行任意 JavaScript。

依赖：pip install websocket-client

典型用法：
    from cdp import CDP
    cdp = CDP(port=9222)
    print(cdp.eval("document.title"))
    print(cdp.eval("(async()=>{ return 1+1 })()"))   # 支持 async/Promise

⚠️ 重要：不要在注入的 JS 里用长 setInterval/setTimeout 分多次采样——后台窗口会被
Chromium 节流。需要“等一会儿再读”时，用本模块的 eval + Python 的 time.sleep + 再 eval。
"""
from __future__ import annotations

import json
import time
import urllib.request

import websocket  # pip install websocket-client


class CDP:
    def __init__(self, host: str = "127.0.0.1", port: int = 9222, timeout: float = 20.0):
        self.base = f"http://{host}:{port}"
        self._id = 0
        self.ws = websocket.create_connection(self._page_ws_url(), timeout=timeout)

    def _page_ws_url(self) -> str:
        data = json.loads(urllib.request.urlopen(self.base + "/json", timeout=5).read())
        pages = [t for t in data if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
        if not pages:
            raise RuntimeError("没有找到 page 目标。应用是否带 --remote-debugging-port 启动？")
        return pages[0]["webSocketDebuggerUrl"]

    def version(self) -> dict:
        return json.loads(urllib.request.urlopen(self.base + "/json/version", timeout=5).read())

    def eval(self, expression: str):
        """在页面里求值一个 JS 表达式，返回按值序列化的结果。支持 async/Promise 表达式。"""
        self._id += 1
        req_id = self._id
        self.ws.send(json.dumps({
            "id": req_id,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
                "allowUnsafeEvalBlockedByCSP": True,
            },
        }))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") != req_id:
                continue  # 忽略事件/其它响应
            if "error" in msg:
                raise RuntimeError(f"CDP error: {msg['error']}")
            result = msg.get("result", {}).get("result", {})
            if result.get("subtype") == "error":
                raise RuntimeError(f"JS error: {result.get('description')}")
            exc = msg.get("result", {}).get("exceptionDetails")
            if exc:
                raise RuntimeError(f"JS exception: {exc.get('exception', {}).get('description', exc.get('text'))}")
            return result.get("value")

    def eval_then_read(self, action_expr: str, read_expr: str, wait: float = 0.5):
        """先执行 action（如 dispatch），Python 侧等待，再读状态。避开后台定时器节流。"""
        self.eval(action_expr)
        time.sleep(wait)
        return self.eval(read_expr)

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass
