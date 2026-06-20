#!/usr/bin/env node
/**
 * NetEase Cloud Music — CDP control MCP server
 * =============================================
 * Controls a running NetEase Cloud Music (网易云音乐) 3.x client WITHOUT any
 * file injection or DLL hijacking. It talks to the client's built-in Chromium
 * DevTools Protocol (CDP) endpoint, which is exposed when the client is started
 * with `--remote-debugging-port`. Through CDP it runs JavaScript inside the
 * client page and drives the app's own Redux (dva) store + internal Web-API
 * request factory.
 *
 * This sidesteps the startup-integrity protection that breaks BetterNCM/Chromatic
 * on NCM >= 3.1, because no file on disk is modified — we only attach a debugger.
 *
 * See RESEARCH.md in this folder for how every internal hook below was discovered.
 *
 * Runtime: Node >= 21 (uses global WebSocket + fetch). No extra dependencies
 * beyond @modelcontextprotocol/sdk and zod (already vendored in this repo).
 *
 * Env vars:
 *   NCM_DEBUG_HOST   default 127.0.0.1
 *   NCM_DEBUG_PORT   default 9222
 *   NCM_EXE_PATH     path to cloudmusic.exe (enables auto-launch)
 *   NCM_AUTO_LAUNCH  "1" to auto-launch the client with the debug port when not reachable
 */

import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createForge } from "../forge/forge-core.mjs";

const HOST = process.env.NCM_DEBUG_HOST || "127.0.0.1";
const PORT = Number(process.env.NCM_DEBUG_PORT || 9222);
const EXE_PATH = process.env.NCM_EXE_PATH || "";
const AUTO_LAUNCH = process.env.NCM_AUTO_LAUNCH === "1";
const CDP_BASE = `http://${HOST}:${PORT}`;

// ---------------------------------------------------------------------------
// JS injected into the NCM page. Idempotent: safe to run before every command.
// Establishes three handles on `window`:
//   __wpr          webpack require (gives access to all 1700+ internal modules)
//   __ncm_store    the redux/dva store (read playback state, dispatch actions)
//   __ncm_request  module-12 `.a` request factory (call any signed NCM Web API)
//   __ncm_progress latest playback-progress emission (best effort)
// ---------------------------------------------------------------------------
const BOOTSTRAP = String.raw`(function () {
  const out = { wpr: false, store: false, request: false, progress: false };
  // 1) webpack require via the jsonp execute-push trick
  try {
    if (!window.__wpr && Array.isArray(window.webpackJsonp)) {
      window.webpackJsonp.push([[99999], { 999999: function (m, e, r) { window.__wpr = r; } }, [[999999]]]);
    }
  } catch (e) {}
  out.wpr = !!window.__wpr;

  // 2) redux store via React fiber walk
  try {
    if (!window.__ncm_store) {
      const root = document.querySelector('#root') || document.body.firstElementChild;
      const fk = root && Object.keys(root).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactInternalInstance'));
      if (fk) {
        const stack = [root[fk]]; const seen = new Set(); let steps = 0;
        while (stack.length && steps < 30000) {
          steps++; const n = stack.pop();
          if (!n || seen.has(n)) continue; seen.add(n);
          const mp = n.memoizedProps;
          if (mp && mp.store && typeof mp.store.dispatch === 'function' && typeof mp.store.getState === 'function') {
            window.__ncm_store = mp.store; break;
          }
          if (n.child) stack.push(n.child);
          if (n.sibling) stack.push(n.sibling);
        }
      }
    }
  } catch (e) {}
  out.store = !!window.__ncm_store;

  // 3) request factory: an export named 'a' that takes {url,method,cacheStrategy} -> (params) => Promise
  try {
    if (!window.__ncm_request && window.__wpr && window.__wpr.c) {
      const R = window.__wpr;
      for (const id of Object.keys(R.c)) {
        let exp; try { exp = R.c[id].exports; } catch (e) { continue; }
        if (exp && typeof exp.a === 'function') {
          const s = Function.prototype.toString.call(exp.a);
          if (/url/.test(s) && /method/.test(s) && /cacheStrategy/.test(s)) { window.__ncm_request = exp.a; break; }
        }
      }
    }
  } catch (e) {}
  out.request = !!window.__ncm_request;

  // 4) best-effort progress subscription (audioPlayerPlayProgress$ in the audio bridge module)
  try {
    if (!window.__ncm_progressSub && window.__wpr && window.__wpr.c) {
      const R = window.__wpr;
      for (const id of Object.keys(R.c)) {
        let exp; try { exp = R.c[id].exports; } catch (e) { continue; }
        if (exp && exp.audioPlayerPlayProgress$ && typeof exp.audioPlayerPlayProgress$.subscribe === 'function') {
          window.__ncm_progress = null;
          window.__ncm_progressSub = exp.audioPlayerPlayProgress$.subscribe(function (v) { window.__ncm_progress = v; });
          break;
        }
      }
    }
  } catch (e) {}
  out.progress = !!window.__ncm_progressSub;

  return out;
})()`;

// ---------------------------------------------------------------------------
// Minimal CDP client over the page websocket.
// ---------------------------------------------------------------------------
let ws = null;
let wsReady = null;
let nextId = 1;
const pending = new Map();

async function resolvePageWsUrl() {
  const res = await fetch(`${CDP_BASE}/json`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`CDP /json returned HTTP ${res.status}`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("No NCM page target found on the debug port.");
  return page.webSocketDebuggerUrl;
}

function closeSocket() {
  if (ws) {
    try { ws.close(); } catch {}
  }
  ws = null;
  wsReady = null;
  for (const [, p] of pending) p.reject(new Error("CDP socket closed"));
  pending.clear();
}

async function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (wsReady) return wsReady;
  wsReady = (async () => {
    const url = await resolvePageWsUrl();
    await new Promise((resolve, reject) => {
      const sock = new WebSocket(url);
      const timer = setTimeout(() => { try { sock.close(); } catch {}; reject(new Error("CDP websocket connect timeout")); }, 5000);
      sock.addEventListener("open", () => { clearTimeout(timer); ws = sock; resolve(); });
      sock.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP websocket error")); });
      sock.addEventListener("close", () => { closeSocket(); });
      sock.addEventListener("message", (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); } catch { return; }
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          p.resolve(msg);
        }
      });
    });
  })();
  try { await wsReady; } finally { wsReady = null; }
}

function cdpSend(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const timer = setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP method ${method} timed out`)); }
    }, 15000);
    const wrappedResolve = (v) => { clearTimeout(timer); resolve(v); };
    pending.set(id, { resolve: wrappedResolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** Evaluate a JS expression in the page; returns the (by-value) result. */
async function evalInPage(expression) {
  await ensureConnected();
  const resp = await cdpSend("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    allowUnsafeEvalBlockedByCSP: true,
  });
  if (resp.error) throw new Error(`CDP error: ${JSON.stringify(resp.error)}`);
  const r = resp.result || {};
  if (r.exceptionDetails) {
    throw new Error(`JS exception: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  }
  if (r.result && r.result.subtype === "error") {
    throw new Error(`JS error: ${r.result.description}`);
  }
  return r.result ? r.result.value : undefined;
}

let launchAttempted = false;
let launchStartedAt = 0;
async function ensureConnected() {
  // already reachable?
  try {
    await connect();
    return;
  } catch {}

  if (AUTO_LAUNCH && EXE_PATH) {
    // (re)launch if we never did, or the last launch was long ago (e.g. user closed NCM again)
    if (!launchAttempted || Date.now() - launchStartedAt > 60000) {
      launchAttempted = true;
      launchStartedAt = Date.now();
      try {
        const child = spawn(EXE_PATH, [`--remote-debugging-port=${PORT}`], {
          cwd: dirname(EXE_PATH),
          detached: true,
          stdio: "ignore",
        });
        child.on("error", () => {}); // bad path / launch failure must not crash the server
        child.unref();
      } catch {}
    }
    // Only spend a SHORT budget here — never block to the MCP tool timeout. If NCM is still loading,
    // return a clear, actionable message so the AI waits a few seconds and retries ONCE (not spam).
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        await connect();
        return;
      } catch {}
    }
    const secs = Math.max(1, Math.round((Date.now() - launchStartedAt) / 1000));
    throw new Error(
      `网易云音乐正在启动中（已 ${secs}s，通常 10~20s 加载完）。已自动为你启动它，请等几秒后【再调用一次本工具】即可——` +
        `不要反复重试，也不要改用桌面自动化打开。`,
    );
  }
  throw new Error(
    `无法连接网易云音乐调试端口 ${CDP_BASE}。请先用 --remote-debugging-port=${PORT} 启动网易云音乐（launch-netease-debug.ps1）。`,
  );
}

/** Run the bootstrap and make sure the store + request factory are available. */
async function ensureBootstrapped(needRequest = false) {
  await ensureConnected();
  let status = await evalInPage(BOOTSTRAP);
  if (!status.store || (needRequest && !status.request)) {
    // The page may still be loading; retry a couple of times.
    for (let i = 0; i < 5 && (!status.store || (needRequest && !status.request)); i++) {
      await new Promise((r) => setTimeout(r, 600));
      status = await evalInPage(BOOTSTRAP);
    }
  }
  if (!status.store) throw new Error("NCM redux store not found yet — is the client fully loaded and logged in?");
  if (needRequest && !status.request) throw new Error("NCM internal request factory not found yet — try again once the client UI is loaded.");
  return status;
}

// ---------------------------------------------------------------------------
// JS helpers injected for specific operations (kept as builders for clarity).
// ---------------------------------------------------------------------------
const JS = {
  state: String.raw`(function(){
    const st = window.__ncm_store.getState();
    const p = st.playing || {};
    const ct = p.curTrack || {};
    const arts = (p.resourceArtists && p.resourceArtists.length ? p.resourceArtists
                  : (ct.ar || ct.artists || [])).map(function(a){ return a && (a.name || a); }).filter(Boolean);
    const pr = window.__ncm_progress;
    return {
      name: p.resourceName || ct.name,
      artists: arts,
      album: (ct.al && ct.al.name) || p.resourceAlbumName || null,
      trackId: p.resourceTrackId || p.onlineResourceId,
      durationSec: p.resourceDuration || (ct.dt ? Math.round(ct.dt/1000) : (ct.duration ? Math.round(ct.duration/1000) : 0)),
      positionSec: (pr && typeof pr[1] === 'number') ? Math.round(pr[1]*10)/10 : null,
      coverUrl: p.resourceCoverUrl,
      volume: p.playingVolume,
      playMode: p.playingMode,
      // 注意：网易云内部 playingState 在本版本不可靠（甚至颠倒），仅原样附带供参考，
      // 判断播放/暂停请用 get_playback_state（基于进度是否推进）。
      playingStateRaw: p.playingState,
      queueLength: (st.playingList && st.playingList.curPlayingList && st.playingList.curPlayingList.length) || 0
    };
  })()`,

  positionSec: String.raw`(function(){ var p=window.__ncm_progress; return (p && typeof p[1]==='number') ? p[1] : null; })()`,

  queue: String.raw`(function(){
    const q = (window.__ncm_store.getState().playingList || {}).curPlayingList || [];
    return q.slice(0, 200).map(function(it, i){
      const t = it.track || {};
      return { index:i, resourceId:String(it.resourceId), name:(t.name||it.text||''),
        artists:((t.ar||t.artists||[]).map(function(a){return a&&a.name;}).filter(Boolean)),
        durationMs: t.dt || t.duration };
    });
  })()`,
};

function dispatchExpr(type, payloadJson) {
  return `(function(){ window.__ncm_store.dispatch(${stringifyAction(type, payloadJson)}); return {ok:true, type:${JSON.stringify(type)}}; })()`;
}
function stringifyAction(type, payloadJson) {
  return payloadJson === undefined
    ? `{type:${JSON.stringify(type)}}`
    : `{type:${JSON.stringify(type)}, payload:${payloadJson}}`;
}

// Combine a dispatch with reading back the resulting state, after a short wait.
async function dispatchAndState(type, payloadJson, waitMs = 350) {
  await ensureBootstrapped(false);
  await evalInPage(dispatchExpr(type, payloadJson));
  await new Promise((r) => setTimeout(r, waitMs));
  const observedState = await evalInPage(JS.state);
  return { ok: true, action: type, observedState };
}

// Reliable play/pause detection: the store's playingState is unreliable (can be inverted in this
// build), so we use ground truth = whether the playback POSITION advances over a short window.
async function readPosition() {
  const v = await evalInPage(JS.positionSec);
  return typeof v === "number" ? v : null;
}
async function detectPlaying(sampleMs = 650) {
  const a = await readPosition();
  await new Promise((r) => setTimeout(r, sampleMs));
  const b = await readPosition();
  if (a === null || b === null) return false;
  return b > a + 0.05;
}

const CUR_TRACK_ID = `(function(){return String(window.__ncm_store.getState().playing.resourceTrackId||'');})()`;

// Robust skip that works in ALL play modes (顺序/随机/单曲/心动 playAi/私人FM). jump2Track handles
// most modes; if the track didn't change (e.g. 心动/FM), fall back to the FM skip. One call = done.
async function skipTrack(flag) {
  await ensureBootstrapped(false);
  const before = await evalInPage(CUR_TRACK_ID);
  await evalInPage(dispatchExpr("playingList/jump2Track", `{flag:${flag}}`));
  await new Promise((r) => setTimeout(r, 700));
  let after = await evalInPage(CUR_TRACK_ID);
  if (after === before) {
    await evalInPage(dispatchExpr(flag > 0 ? "fmPlaying/playNext" : "fmPlaying/playPre", "{}"));
    await new Promise((r) => setTimeout(r, 800));
    after = await evalInPage(CUR_TRACK_ID);
  }
  return {
    ok: true,
    action: flag > 0 ? "next_track" : "previous_track",
    changed: after !== before,
    observedState: await evalInPage(JS.state),
  };
}

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "netease-music", version: "1.0.0" });
const BUILTIN_TOOLS = new Set();

function ok(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}
function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, message }, null, 2) }] };
}
function tool(name, title, description, inputSchema, handler) {
  BUILTIN_TOOLS.add(name);
  server.registerTool(name, { title, description, inputSchema }, async (args) => {
    try {
      return ok(await handler(args || {}));
    } catch (e) {
      return fail(e);
    }
  });
}

// ---- read ----
tool("get_playback_state", "Get playback state",
  "读取网易云当前播放状态（歌曲/歌手/专辑/音量/模式/队列）。playing 字段以【进度是否推进】为准——" +
    "网易云内部 playingState 在本版本不可靠甚至颠倒，切勿用它判断；判断是否在播放就看本工具返回的 playing。",
  {}, async () => {
    await ensureBootstrapped(false);
    const state = await evalInPage(JS.state);
    const playing = await detectPlaying();
    return { ...state, playing, playState: playing ? "playing" : "paused" };
  });

tool("get_queue", "Get play queue",
  "List the current play queue (up to 200 items) with resourceId, name and artists.",
  {}, async () => { await ensureBootstrapped(false); return { ok: true, queue: await evalInPage(JS.queue) }; });

// ---- transport ----
tool("play", "Play / resume", "Resume playback of the current track.", {},
  () => dispatchAndState("playing/resume", "{}"));
tool("pause", "Pause", "Pause playback.", {},
  () => dispatchAndState("playing/pause", "{}"));
tool("toggle_play", "Toggle play/pause", "切换播放/暂停。基于【进度是否推进】检测真实状态后再显式播放或暂停（不依赖不可靠的 playingState）。", {},
  async () => {
    await ensureBootstrapped(false);
    const wasPlaying = await detectPlaying();
    await evalInPage(dispatchExpr(wasPlaying ? "playing/pause" : "playing/resume", "{}"));
    await new Promise((r) => setTimeout(r, 500));
    const nowPlaying = await detectPlaying();
    return { ok: true, action: wasPlaying ? "pause" : "resume", wasPlaying, nowPlaying, observedState: await evalInPage(JS.state) };
  });
tool("stop", "Stop", "Stop playback.", {},
  () => dispatchAndState("playing/stop", "{}"));
tool("next_track", "Next track", "下一首。自动适配所有播放模式（顺序/随机/单曲/心动/私人FM），一次调用即切歌，无需你判断模式。", {},
  () => skipTrack(1));
tool("previous_track", "Previous track", "上一首。自动适配所有播放模式，一次调用即切歌。", {},
  () => skipTrack(-1));

tool("seek", "Seek", "Seek the current track to a position in seconds.",
  { seconds: z.number().min(0) },
  ({ seconds }) => dispatchAndState("playing/setPlayingPosition", `{duration:${Number(seconds)}}`));

tool("set_volume", "Set volume", "Set playback volume (0-100).",
  { volume: z.number().min(0).max(100) },
  ({ volume }) => dispatchAndState("playing/setVolume", `{volume:${Math.max(0, Math.min(1, Number(volume) / 100))}}`));

tool("toggle_mute", "Toggle mute", "Toggle mute on/off.", {},
  () => dispatchAndState("playing/switchMute", "{}"));

const PLAY_MODE_MAP = { list_loop: "playCycle", single_loop: "playOneCycle", shuffle: "playRandom", order: "playOrder" };
tool("set_play_mode", "Set play mode", "设置网易云播放模式：list_loop 列表循环 / single_loop 单曲循环 / shuffle 随机播放 / order 顺序播放。",
  { mode: z.enum(["list_loop", "single_loop", "shuffle", "order"]) },
  ({ mode }) => dispatchAndState("playing/switchPlayingMode", `{playingMode:${JSON.stringify(PLAY_MODE_MAP[mode])}}`));

tool("change_volume", "Adjust volume (relative)", "在当前网易云音量基础上增减（delta -100~100），用于「大点声/小点声」。",
  { delta: z.number().min(-100).max(100) },
  async ({ delta }) => {
    await ensureBootstrapped(false);
    const expr = String.raw`(function(){
      const s=window.__ncm_store; const v=s.getState().playing.playingVolume||0;
      const nv=Math.max(0,Math.min(1, v + (${Number(delta)}/100)));
      s.dispatch({type:'playing/setVolume', payload:{volume:nv}});
      return {ok:true, volumePercent:Math.round(nv*100)};
    })()`;
    const r = await evalInPage(expr);
    await new Promise((res) => setTimeout(res, 300));
    return { ...r, observedState: await evalInPage(JS.state) };
  });

// ---- play specific ----
tool("play_queue_track", "Play track in queue", "Play a track that is already in the current queue, by its resourceId.",
  { resourceId: z.union([z.string(), z.number()]) },
  ({ resourceId }) => dispatchAndState("playing/playOneTrackInPlayingList", `{item:${JSON.stringify(String(resourceId))}}`, 600));

tool("play_song_by_id", "Play song by id", "Play any song by its NetEase song id (fetches detail, builds a play item, plays it immediately).",
  { id: z.union([z.string(), z.number()]) },
  async ({ id }) => {
    await ensureBootstrapped(true);
    const expr = String.raw`(async function(){
      const store=window.__ncm_store, req=window.__ncm_request;
      const id=${JSON.stringify(String(id))};
      const det=await req({url:'/api/v3/song/detail',method:'POST'})({c:JSON.stringify([{id:Number(id)}])});
      const track=(det&&det.songs&&det.songs[0])||{id:Number(id),name:''};
      const mk=${QUEUE_ITEM_FROM_TRACK}; const item=mk(track,0);
      store.dispatch({type:'playing/playOneTrackInPlayingList', payload:{item:item}});
      return {requestedId:id, name:track.name};
    })()`;
    const r = await evalInPage(expr);
    await new Promise((res) => setTimeout(res, 800));
    return { ok: true, action: "play_song_by_id", requested: r, observedState: await evalInPage(JS.state) };
  });

tool("play_song_by_name", "Search and play", "Search for a song by name and immediately play the top match.",
  { query: z.string(), preferArtist: z.string().optional() },
  async ({ query, preferArtist }) => {
    await ensureBootstrapped(true);
    const expr = String.raw`(async function(){
      const store=window.__ncm_store, req=window.__ncm_request;
      const sr=await req({url:'/api/cloudsearch/pc',method:'POST'})({s:${JSON.stringify(query)},type:1,limit:10});
      let songs=(sr&&sr.result&&sr.result.songs)||[];
      const pref=${JSON.stringify(preferArtist || "")};
      if(pref){ const m=songs.find(s=>(s.ar||[]).some(a=>(a.name||'').includes(pref))); if(m) songs=[m].concat(songs); }
      if(!songs.length) return {found:false};
      const s=songs[0]; const id=s.id;
      const mk=${QUEUE_ITEM_FROM_TRACK}; const item=mk(s,0);
      store.dispatch({type:'playing/playOneTrackInPlayingList', payload:{item:item}});
      return {found:true, id:id, name:s.name, artists:(s.ar||[]).map(a=>a.name)};
    })()`;
    const r = await evalInPage(expr);
    if (!r.found) return { ok: false, message: `No song found for "${query}".` };
    await new Promise((res) => setTimeout(res, 800));
    return { ok: true, action: "play_song_by_name", played: r, observedState: await evalInPage(JS.state) };
  });

// ---- search & info (signed Web API) ----
const SEARCH_TYPES = { song: 1, album: 10, artist: 100, playlist: 1000, user: 1002, mv: 1004, lyric: 1006, podcast: 1009 };

tool("search", "Search", "Search NetEase Cloud Music. type: song|album|artist|playlist|user|mv|lyric|podcast.",
  { keyword: z.string(), type: z.enum(Object.keys(SEARCH_TYPES)).optional(), limit: z.number().int().min(1).max(100).optional() },
  async ({ keyword, type = "song", limit = 20 }) => {
    await ensureBootstrapped(true);
    const expr = String.raw`(async function(){
      const req=window.__ncm_request;
      const r=await req({url:'/api/cloudsearch/pc',method:'POST'})({s:${JSON.stringify(keyword)},type:${SEARCH_TYPES[type]},limit:${Number(limit)}});
      const res=r&&r.result||{};
      if(res.songs) return {type:'song', items:res.songs.map(s=>({id:s.id,name:s.name,artists:(s.ar||[]).map(a=>a.name),album:s.al&&s.al.name,durationMs:s.dt}))};
      if(res.playlists) return {type:'playlist', items:res.playlists.map(p=>({id:p.id,name:p.name,trackCount:p.trackCount,creator:p.creator&&p.creator.nickname}))};
      if(res.albums) return {type:'album', items:res.albums.map(a=>({id:a.id,name:a.name,artist:a.artist&&a.artist.name,size:a.size}))};
      if(res.artists) return {type:'artist', items:res.artists.map(a=>({id:a.id,name:a.name,albumSize:a.albumSize}))};
      return {type:${JSON.stringify(type)}, raw:res};
    })()`;
    return { ok: true, ...(await evalInPage(expr)) };
  });

tool("get_lyric", "Get lyric", "Get the lyric for a song id (defaults to the current track).",
  { id: z.union([z.string(), z.number()]).optional() },
  async ({ id }) => {
    await ensureBootstrapped(true);
    const expr = String.raw`(async function(){
      const req=window.__ncm_request, store=window.__ncm_store;
      let sid=${id === undefined ? "null" : JSON.stringify(String(id))};
      if(!sid){ sid=store.getState().playing.resourceTrackId; }
      const r=await req({url:'/api/song/lyric',method:'POST'})({id:Number(sid),lv:-1,kv:-1,tv:-1});
      return {id:sid, lyric:(r&&r.lrc&&r.lrc.lyric)||null, translation:(r&&r.tlyric&&r.tlyric.lyric)||null};
    })()`;
    return { ok: true, ...(await evalInPage(expr)) };
  });

tool("get_user_playlists", "Get my playlists", "List the logged-in user's playlists (created + favourited).",
  { limit: z.number().int().min(1).max(1000).optional() },
  async ({ limit = 100 }) => {
    await ensureBootstrapped(true);
    const expr = String.raw`(async function(){
      const req=window.__ncm_request, store=window.__ncm_store;
      const uid=(store.getState().playingList||{}).latestUid || (store.getState().app&&store.getState().app.userId);
      const r=await req({url:'/api/user/playlist',method:'POST'})({uid:uid,limit:${Number(limit)},offset:0,includeVideo:true});
      return {uid:uid, playlists:((r&&r.playlist)||[]).map(p=>({id:p.id,name:p.name,trackCount:p.trackCount,subscribed:p.subscribed,isFavorites:p.specialType===5,creator:p.creator&&p.creator.nickname}))};
    })()`;
    return { ok: true, ...(await evalInPage(expr)) };
  });

tool("get_playlist_tracks", "Get playlist tracks", "Get the tracks of a playlist by id.",
  { id: z.union([z.string(), z.number()]), limit: z.number().int().min(1).max(1000).optional() },
  async ({ id, limit = 100 }) => {
    await ensureBootstrapped(true);
    const expr = String.raw`(async function(){
      const req=window.__ncm_request;
      const r=await req({url:'/api/v6/playlist/detail',method:'POST'})({id:Number(${JSON.stringify(String(id))}),n:${Number(limit)},s:8});
      const pl=r&&r.playlist||{};
      return {id:pl.id, name:pl.name, trackCount:pl.trackCount,
        tracks:((pl.tracks)||[]).slice(0,${Number(limit)}).map(t=>({id:t.id,name:t.name,artists:(t.ar||[]).map(a=>a.name),durationMs:t.dt}))};
    })()`;
    return { ok: true, ...(await evalInPage(expr)) };
  });

tool("play_playlist", "Play a playlist", "Replace the play queue with a playlist's tracks and start playing it.",
  { id: z.union([z.string(), z.number()]), limit: z.number().int().min(1).max(500).optional() },
  async ({ id, limit = 100 }) => {
    await ensureBootstrapped(true);
    const expr = String.raw`(async function(){
      const req=window.__ncm_request, store=window.__ncm_store;
      const r=await req({url:'/api/v6/playlist/detail',method:'POST'})({id:Number(${JSON.stringify(String(id))}),n:${Number(limit)},s:8});
      const pl=r&&r.playlist||{};
      const tracks=(pl.tracks||[]).slice(0,${Number(limit)});
      if(!tracks.length) return {ok:false, message:'playlist has no tracks'};
      const list=tracks.map(${QUEUE_ITEM_FROM_TRACK});
      store.dispatch({type:'playingList/replaceCurPlayingList', payload:{list:list}});
      store.dispatch({type:'playingList/refreshCurPlayingListAndCurPlaying', payload:{}});
      store.dispatch({type:'playing/playOneTrackInPlayingList', payload:{item:list[0]}});
      return {ok:true, name:pl.name, count:list.length, first:list[0].text};
    })()`;
    const r = await evalInPage(expr);
    await new Promise((res) => setTimeout(res, 900));
    return { ...r, observedState: await evalInPage(JS.state) };
  });

// ---- favourites / red-heart ----
tool("like_song", "Like / unlike song", "给歌曲点红心（加入/移出「我喜欢的音乐」）。默认当前歌曲。",
  { id: z.union([z.string(), z.number()]).optional(), like: z.boolean().optional() },
  async ({ id, like = true }) => {
    await ensureBootstrapped(true);
    const sid = id === undefined ? "null" : JSON.stringify(String(id));
    const expr = String.raw`(async function(){
      const req=window.__ncm_request, store=window.__ncm_store;
      let sid=${sid}; if(!sid) sid=store.getState().playing.resourceTrackId;
      if(!sid || String(sid)==='0') return {ok:false, message:'当前没有可操作的歌曲，请传入 id'};
      const r=await req({url:'/api/song/like',method:'POST'})({trackId:Number(sid), like:${like ? "true" : "false"}});
      return {ok:(r&&r.code)===200, code:r&&r.code, trackId:String(sid), like:${like ? "true" : "false"}, favPlaylistId:r&&r.playlistId};
    })()`;
    return await evalInPage(expr);
  });

tool("get_song_url", "Get song URL", "获取歌曲的可播放地址。默认当前歌曲。",
  { id: z.union([z.string(), z.number()]).optional(), level: z.enum(["standard", "higher", "exhigh", "lossless", "hires"]).optional() },
  async ({ id, level = "standard" }) => {
    await ensureBootstrapped(true);
    const sid = id === undefined ? "null" : JSON.stringify(String(id));
    const expr = String.raw`(async function(){
      const store=window.__ncm_store;
      let sid=${sid}; if(!sid) sid=store.getState().playing.resourceTrackId;
      const r=await window.__ncm_request({url:'/api/song/enhance/player/url/v1',method:'POST'})({ids:JSON.stringify([Number(sid)]),level:${JSON.stringify(level)},encodeType:'flac'});
      const d=(r&&r.data&&r.data[0])||{};
      return {ok:(r&&r.code)===200, id:String(sid), url:d.url, br:d.br, level:d.level, size:d.size};
    })()`;
    return await evalInPage(expr);
  });

// ---- discovery: daily recommend ----
tool("get_daily_recommend", "Daily recommended songs", "获取每日推荐歌曲列表（每日 30 首）。",
  { limit: z.number().int().min(1).max(100).optional() },
  async ({ limit = 30 }) => {
    await ensureBootstrapped(true);
    const expr = String.raw`(async function(){
      const r=await window.__ncm_request({url:'/api/v3/discovery/recommend/songs',method:'POST'})({});
      const songs=((r&&r.data&&r.data.dailySongs)||[]).slice(0,${Number(limit)});
      return {ok:(r&&r.code)===200, count:songs.length,
        songs:songs.map(s=>({id:s.id,name:s.name,artists:(s.ar||[]).map(a=>a.name),album:s.al&&s.al.name,durationMs:s.dt}))};
    })()`;
    return await evalInPage(expr);
  });

tool("play_daily_recommend", "Play daily recommend", "用每日推荐歌曲替换播放队列并开始播放。",
  { limit: z.number().int().min(1).max(100).optional() },
  async ({ limit = 30 }) => {
    await ensureBootstrapped(true);
    const expr = String.raw`(async function(){
      const req=window.__ncm_request, store=window.__ncm_store;
      const r=await req({url:'/api/v3/discovery/recommend/songs',method:'POST'})({});
      const tracks=((r&&r.data&&r.data.dailySongs)||[]).slice(0,${Number(limit)});
      if(!tracks.length) return {ok:false, message:'no daily songs'};
      const list=tracks.map(${QUEUE_ITEM_FROM_TRACK});
      store.dispatch({type:'playingList/replaceCurPlayingList', payload:{list:list}});
      store.dispatch({type:'playingList/refreshCurPlayingListAndCurPlaying', payload:{}});
      store.dispatch({type:'playing/playOneTrackInPlayingList', payload:{item:list[0]}});
      return {ok:true, count:list.length, first:list[0].text};
    })()`;
    const r = await evalInPage(expr);
    await new Promise((res) => setTimeout(res, 900));
    return { ...r, observedState: await evalInPage(JS.state) };
  });

// ---- personal FM (心动模式) ----
tool("play_personal_fm", "Play personal FM", "开始播放私人FM（心动模式）。", {},
  () => dispatchAndState("fmPlaying/fmPlay", "{}", 800));
tool("fm_next", "Personal FM next", "私人FM 跳到下一首。", {},
  () => dispatchAndState("fmPlaying/playNext", "{}", 600));
tool("fm_trash", "Personal FM trash", "私人FM 把当前歌曲扔进垃圾桶（不喜欢并跳过）。", {},
  () => dispatchAndState("fmPlaying/trash", "{}", 600));

// ---- playlists: subscribe / create ----
tool("subscribe_playlist", "Subscribe / 收藏 playlist", "收藏或取消收藏一个歌单。",
  { id: z.union([z.string(), z.number()]), subscribe: z.boolean().optional() },
  async ({ id, subscribe = true }) => {
    await ensureBootstrapped(true);
    const url = subscribe ? "/api/playlist/subscribe" : "/api/playlist/unsubscribe";
    const expr = String.raw`(async function(){
      const r=await window.__ncm_request({url:${JSON.stringify(url)},method:'POST'})({id:Number(${JSON.stringify(String(id))})});
      return {ok:(r&&r.code)===200, code:r&&r.code};
    })()`;
    return { action: subscribe ? "subscribe" : "unsubscribe", id: String(id), ...(await evalInPage(expr)) };
  });

tool("create_playlist", "Create playlist", "创建一个新歌单。",
  { name: z.string(), privacy: z.boolean().optional() },
  async ({ name, privacy = false }) => {
    await ensureBootstrapped(true);
    const expr = String.raw`(async function(){
      const r=await window.__ncm_request({url:'/api/playlist/create',method:'POST'})({name:${JSON.stringify(name)}, privacy:${privacy ? 10 : 0}});
      return {ok:(r&&r.code)===200, code:r&&r.code, id:r&&r.id, name:(r&&r.playlist&&r.playlist.name)};
    })()`;
    return await evalInPage(expr);
  });

tool("play_my_playlist", "Play my playlist by name", "按名称找到「我的歌单」并播放（如「我喜欢的音乐」）。支持模糊匹配。",
  { name: z.string(), limit: z.number().int().min(1).max(500).optional() },
  async ({ name, limit = 100 }) => {
    await ensureBootstrapped(true);
    const expr = String.raw`(async function(){
      const req=window.__ncm_request, store=window.__ncm_store;
      const st=store.getState(); const uid=(st.playingList||{}).latestUid||(st.app&&st.app.userId);
      const pr=await req({url:'/api/user/playlist',method:'POST'})({uid:uid,limit:1000,offset:0});
      const lists=(pr&&pr.playlist)||[];
      const q=${JSON.stringify(name)};
      const FAV=/^(我喜欢的音乐|我喜欢|喜欢的音乐|红心|喜欢列表|我的红心)$/;
      let pl=lists.find(p=>p.name===q);
      if(!pl && FAV.test(q.trim())) pl=lists.find(p=>p.specialType===5);  // 收藏夹「我喜欢的音乐」实际名为「<昵称>喜欢的音乐」
      if(!pl) pl=lists.find(p=>p.name&&p.name.includes(q)) || lists.find(p=>p.name&&q.includes(p.name));
      if(!pl) return {ok:false, message:'未找到歌单: '+q, available:lists.slice(0,12).map(p=>p.name)};
      const dr=await req({url:'/api/v6/playlist/detail',method:'POST'})({id:Number(pl.id),n:${Number(limit)},s:8});
      const tracks=((dr&&dr.playlist&&dr.playlist.tracks)||[]).slice(0,${Number(limit)});
      if(!tracks.length) return {ok:false, message:'歌单为空: '+pl.name};
      const arr=tracks.map(${QUEUE_ITEM_FROM_TRACK});
      store.dispatch({type:'playingList/replaceCurPlayingList', payload:{list:arr}});
      store.dispatch({type:'playingList/refreshCurPlayingListAndCurPlaying', payload:{}});
      store.dispatch({type:'playing/playOneTrackInPlayingList', payload:{item:arr[0]}});
      return {ok:true, playlist:pl.name, id:pl.id, count:arr.length, first:arr[0].text};
    })()`;
    const r = await evalInPage(expr);
    await new Promise((res) => setTimeout(res, 900));
    return { ...r, observedState: await evalInPage(JS.state) };
  });

// ---- play by artist / album ----
// Build a valid NCM play-queue item from a raw API song. Normalizes abbreviated search fields
// (al/ar/dt) to the canonical names the player reads (album/artists/duration), otherwise the cover
// (resourceCoverUrl = track.album.picUrl) and artists come up empty -> "图片加载失败".
const QUEUE_ITEM_FROM_TRACK = `function(raw,i){var t=Object.assign({},raw,{album:raw.al||raw.album,artists:raw.ar||raw.artists,duration:raw.dt||raw.duration,mvid:raw.mv||raw.mvid||0});return {id:t.id,resourceId:String(t.id),trackId:String(t.id),resourceType:'track',track:t,localTrack:null,displayOrder:i||0,randomOrder:i||0,isPlayedOnce:false,ai:false,aiRcmd:false,scene:'',href:'',text:t.name||'',fromInfo:{originalScene:'track',originalResourceType:'track',computeSourceResourceType:'track',sourceData:{id:String(t.id),name:(t.album&&t.album.name)||'',coverImgUrl:(t.album&&t.album.picUrl)||''},trialMode:0},referInfo:{addrefer:'',multirefers:[]}};}`;

tool("play_artist", "Play artist hot songs", "搜索歌手并播放其热门歌曲（替换队列）。query 传歌手名或歌手 id。",
  { query: z.string(), limit: z.number().int().min(1).max(100).optional() },
  async ({ query, limit = 50 }) => {
    await ensureBootstrapped(true);
    const expr = String.raw`(async function(){
      const req=window.__ncm_request, store=window.__ncm_store;
      const q=${JSON.stringify(query)};
      let aid = /^\d+$/.test(q) ? Number(q) : null, aname=q;
      if(!aid){ const sr=await req({url:'/api/cloudsearch/pc',method:'POST'})({s:q,type:100,limit:1});
        const a=sr&&sr.result&&sr.result.artists&&sr.result.artists[0]; if(!a) return {ok:false,message:'未找到歌手: '+q}; aid=a.id; aname=a.name; }
      const r=await req({url:'/api/artist/top/song',method:'POST'})({id:aid});
      const tracks=((r&&r.songs)||[]).slice(0,${Number(limit)});
      if(!tracks.length) return {ok:false,message:'该歌手没有可播放歌曲'};
      const mk=${QUEUE_ITEM_FROM_TRACK};
      const list=tracks.map(mk);
      store.dispatch({type:'playingList/replaceCurPlayingList', payload:{list:list}});
      store.dispatch({type:'playingList/refreshCurPlayingListAndCurPlaying', payload:{}});
      store.dispatch({type:'playing/playOneTrackInPlayingList', payload:{item:list[0]}});
      return {ok:true, artist:aname, artistId:aid, count:list.length, first:list[0].text};
    })()`;
    const r = await evalInPage(expr);
    await new Promise((res) => setTimeout(res, 900));
    return { ...r, observedState: await evalInPage(JS.state) };
  });

tool("play_album", "Play album", "搜索专辑并播放整张（替换队列）。query 传专辑名或专辑 id。",
  { query: z.string(), limit: z.number().int().min(1).max(200).optional() },
  async ({ query, limit = 100 }) => {
    await ensureBootstrapped(true);
    const expr = String.raw`(async function(){
      const req=window.__ncm_request, store=window.__ncm_store;
      const q=${JSON.stringify(query)};
      let alid = /^\d+$/.test(q) ? Number(q) : null, alname=q;
      if(!alid){ const sr=await req({url:'/api/cloudsearch/pc',method:'POST'})({s:q,type:10,limit:1});
        const a=sr&&sr.result&&sr.result.albums&&sr.result.albums[0]; if(!a) return {ok:false,message:'未找到专辑: '+q}; alid=a.id; alname=a.name; }
      const r=await req({url:'/api/v1/album/'+alid,method:'POST'})({});
      const tracks=((r&&r.songs)||[]).slice(0,${Number(limit)});
      if(!tracks.length) return {ok:false,message:'该专辑没有可播放歌曲'};
      const mk=${QUEUE_ITEM_FROM_TRACK};
      const list=tracks.map(mk);
      store.dispatch({type:'playingList/replaceCurPlayingList', payload:{list:list}});
      store.dispatch({type:'playingList/refreshCurPlayingListAndCurPlaying', payload:{}});
      store.dispatch({type:'playing/playOneTrackInPlayingList', payload:{item:list[0]}});
      return {ok:true, album:alname, albumId:alid, count:list.length, first:list[0].text};
    })()`;
    const r = await evalInPage(expr);
    await new Promise((res) => setTimeout(res, 900));
    return { ...r, observedState: await evalInPage(JS.state) };
  });

// ---- add to queue (does not change current track) ----
tool("add_to_queue", "Add to play queue", "把一首歌加入当前播放队列，不打断当前播放。next=true 插到「下一首」，否则加到队尾。id 或 query 二选一。",
  { id: z.union([z.string(), z.number()]).optional(), query: z.string().optional(), next: z.boolean().optional() },
  async ({ id, query, next = true }) => {
    await ensureBootstrapped(true);
    if (id === undefined && !query) return { ok: false, message: "需要提供 id 或 query" };
    const idExpr = id === undefined ? "null" : JSON.stringify(String(id));
    const expr = String.raw`(async function(){
      const req=window.__ncm_request, store=window.__ncm_store;
      let s=null, sid=${idExpr};
      if(sid){ const det=await req({url:'/api/v3/song/detail',method:'POST'})({c:JSON.stringify([{id:Number(sid)}])}); s=(det&&det.songs&&det.songs[0]); }
      else { const sr=await req({url:'/api/cloudsearch/pc',method:'POST'})({s:${JSON.stringify(query || "")},type:1,limit:1}); s=(sr&&sr.result&&sr.result.songs&&sr.result.songs[0]); }
      if(!s) return {ok:false, message:'未找到歌曲'};
      const mk=${QUEUE_ITEM_FROM_TRACK}; const item=mk(s,0);
      const cur=store.getState().playingList.curPlayingList.slice();
      if(cur.some(x=>String(x.resourceId)===String(s.id))) return {ok:true, added:s.name, note:'已在队列中', queueLength:cur.length};
      let pos=cur.length;
      if(${next ? "true" : "false"}){ const curId=store.getState().playing.resourceTrackId; let idx=cur.findIndex(x=>String(x.resourceId)===String(curId)); pos=(idx<0?cur.length-1:idx)+1; }
      cur.splice(pos,0,item);
      store.dispatch({type:'playingList/replaceCurPlayingList', payload:{list:cur}});
      store.dispatch({type:'playingList/refreshCurPlayingListAndCurPlaying', payload:{}});
      return {ok:true, added:s.name, position:pos, queueLength:cur.length};
    })()`;
    return await evalInPage(expr);
  });

// ---- comments (for AI summary) ----
tool("get_song_comments", "Get song comments", "获取歌曲评论（热评+最新），供 AI 总结。支持 offset 翻页。默认当前歌曲。",
  { id: z.union([z.string(), z.number()]).optional(), limit: z.number().int().min(1).max(50).optional(), offset: z.number().int().min(0).optional() },
  async ({ id, limit = 15, offset = 0 }) => {
    await ensureBootstrapped(true);
    const sid = id === undefined ? "null" : JSON.stringify(String(id));
    const expr = String.raw`(async function(){
      const req=window.__ncm_request, store=window.__ncm_store;
      let sid=${sid}, tid;
      if(sid){ tid='R_SO_4_'+sid; } else { const p=store.getState().playing; tid=p.resourceCommentThreadId; sid=p.resourceTrackId; }
      if(!tid) return {ok:false, message:'当前没有可取评论的歌曲'};
      const r=await req({url:'/api/v1/resource/comments/'+tid,method:'POST'})({limit:${Number(limit)},offset:${Number(offset)},beforeTime:0});
      const fmt=c=>({user:c.user&&c.user.nickname, likedCount:c.likedCount, time:c.timeStr, content:c.content});
      return {ok:(r&&r.code)===200, id:String(sid), total:r&&r.total, offset:${Number(offset)}, hasMore:!!(r&&r.more),
        hotComments:${Number(offset)}===0 ? ((r&&r.hotComments)||[]).slice(0,${Number(limit)}).map(fmt) : [],
        latestComments:((r&&r.comments)||[]).slice(0,${Number(limit)}).map(fmt)};
    })()`;
    return await evalInPage(expr);
  });

// ---- generic escape hatches (do anything reachable) ----
tool("ncm_api", "Call NetEase API", "Call any NetEase Cloud Music Web API endpoint through the signed internal request factory. Returns the raw JSON.",
  { url: z.string(), method: z.enum(["POST", "GET"]).optional(), params: z.record(z.any()).optional() },
  async ({ url, method = "POST", params = {} }) => {
    await ensureBootstrapped(true);
    const expr = String.raw`(async function(){
      const req=window.__ncm_request;
      const r=await req({url:${JSON.stringify(url)},method:${JSON.stringify(method)}})(${JSON.stringify(params)});
      return r;
    })()`;
    return { ok: true, url, result: await evalInPage(expr) };
  });

tool("ncm_dispatch", "Dispatch redux action", "Dispatch any NetEase dva/redux action (e.g. 'playing/pause'). Advanced — see RESEARCH.md for the action map.",
  { type: z.string(), payload: z.record(z.any()).optional() },
  async ({ type, payload }) => dispatchAndState(type, payload === undefined ? "{}" : JSON.stringify(payload)));

tool("ncm_eval", "Evaluate JS in NCM", "Run an arbitrary JavaScript expression inside the NetEase page (has window.__ncm_store / window.__ncm_request / window.__wpr). Advanced/escape hatch.",
  { expression: z.string() },
  async ({ expression }) => {
    await ensureBootstrapped(false);
    return { ok: true, result: await evalInPage(`(function(){ return (${expression}); })()`) };
  });

// ---- self-evolving forge: meta-tools + stored extensions (app-agnostic core, NCM adapter) ----
const forge = createForge({
  appId: "netease-cloud-music",
  evalInApp: (js) => evalInPage(js),
  ensureReady: () => ensureBootstrapped(true),
  builtinToolNames: [...BUILTIN_TOOLS],
});
forge.registerMetaTools(server);
forge.registerStoredExtensions(server);

await server.connect(new StdioServerTransport());
