"""
discover.py — 对任意 CEF/Electron 应用跑一遍“标准发现流程”，定位逆向所需的“三把钥匙”。

它会依次：
  1. 打印 CDP 版本信息
  2. 探测页面全局环境（webpack? 媒体元素? 关键全局）
  3. 抠出 webpack require → window.__wpr
  4. 从 React fiber 回溯找 Redux store → window.__store，并打印 state 切片
  5. 提取真实可派发的 action type（按你给的命名空间正则）
  6. 定位“签名 API 请求工厂” → window.__request

用法：
    python discover.py --port 9222 --ns "playing|playingList|player|queue"

依赖：pip install websocket-client（与 cdp.py 同目录）

注意：这是“发现”工具，定位到接口后请在运行实例上**实测**确认；动作名/参数以源码为准。
"""
from __future__ import annotations

import argparse
import json

from cdp import CDP

PROBE_GLOBALS = r"""
(function () {
  return {
    interestingGlobals: Object.keys(window).filter(k => /player|store|api|app|webpack|channel|conf/i.test(k)).slice(0, 40),
    webpackJsonp: typeof window.webpackJsonp,
    webpackChunk: Object.keys(window).filter(k => /^webpackChunk/.test(k)),
    mediaEls: document.querySelectorAll('audio,video').length,
  };
})()
"""

EXTRACT_REQUIRE = r"""
(function () {
  if (window.__wpr) return { already: true };
  try {
    if (Array.isArray(window.webpackJsonp)) {
      window.webpackJsonp.push([[99999], { 999999: function (m, e, r) { window.__wpr = r; } }, [[999999]]]);
    } else {
      const key = Object.keys(window).find(k => /^webpackChunk/.test(k));
      if (key) window[key].push([[Symbol()], {}, r => { window.__wpr = r; }]);
    }
  } catch (e) { return { error: String(e) }; }
  return { ok: typeof window.__wpr, modules: window.__wpr && window.__wpr.c ? Object.keys(window.__wpr.c).length : 0 };
})()
"""

FIND_STORE = r"""
(function () {
  if (window.__store) return { already: true, stateKeys: Object.keys(window.__store.getState()) };
  const root = document.querySelector('#root') || document.body.firstElementChild;
  if (!root) return { error: 'no root' };
  const fk = Object.keys(root).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactInternalInstance'));
  if (!fk) return { error: 'no react fiber (Vue? 试试 root.__vue__.$store)' };
  const stack = [root[fk]], seen = new Set();
  let steps = 0;
  while (stack.length && steps < 30000) {
    steps++;
    const n = stack.pop(); if (!n || seen.has(n)) continue; seen.add(n);
    const mp = n.memoizedProps;
    if (mp && mp.store && typeof mp.store.dispatch === 'function' && typeof mp.store.getState === 'function') {
      window.__store = mp.store;
      return { ok: true, steps, stateKeys: Object.keys(mp.store.getState()) };
    }
    if (n.child) stack.push(n.child);
    if (n.sibling) stack.push(n.sibling);
  }
  return { error: 'store not found via fiber', steps };
})()
"""

LIST_ACTIONS_TMPL = r"""
(function () {
  if (!window.__wpr || !window.__wpr.m) return { error: 'need __wpr' };
  const re = new RegExp('["\'`]((?:%s)\\/[a-zA-Z0-9_$]+)["\'`]', 'g');
  const set = new Set(), m = window.__wpr.m;
  for (const id in m) {
    let s = ''; try { s = Function.prototype.toString.call(m[id]); } catch (e) { continue; }
    let mm; while ((mm = re.exec(s))) set.add(mm[1]);
  }
  return [...set].sort();
})()
"""

FIND_API_FACTORY = r"""
(function () {
  if (!window.__wpr || !window.__wpr.c) return { error: 'need __wpr' };
  const R = window.__wpr, hits = [];
  for (const id of Object.keys(R.c)) {
    let e; try { e = R.c[id].exports; } catch (x) { continue; }
    if (e && typeof e.a === 'function') {
      const s = Function.prototype.toString.call(e.a);
      if (/url/.test(s) && /method/.test(s) && /cacheStrategy|credentials|fetch/.test(s)) {
        if (!window.__request) window.__request = e.a;
        hits.push({ id, sig: s.slice(0, 160).replace(/\s+/g, ' ') });
      }
    }
  }
  return { picked: !!window.__request, candidates: hits.slice(0, 10) };
})()
"""


def main():
    ap = argparse.ArgumentParser(description="CEF/Electron 应用标准发现流程")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--ns", default="playing|playingList|player|queue|track",
                    help="状态动作命名空间正则（用于提取 dispatch action）")
    args = ap.parse_args()

    cdp = CDP(host=args.host, port=args.port)
    try:
        def show(title, value):
            print(f"\n===== {title} =====")
            print(json.dumps(value, ensure_ascii=False, indent=2))

        show("0) CDP 版本", cdp.version())
        show("1) 全局环境", cdp.eval(PROBE_GLOBALS))
        show("2) webpack require", cdp.eval(EXTRACT_REQUIRE))
        show("3) Redux store", cdp.eval(FIND_STORE))
        show("4) 可派发 action", cdp.eval(LIST_ACTIONS_TMPL % args.ns))
        show("5) API 请求工厂", cdp.eval(FIND_API_FACTORY))
        print("\n完成。三把钥匙已挂在 window.__wpr / window.__store / window.__request 上，可继续手动探测。")
    finally:
        cdp.close()


if __name__ == "__main__":
    main()
