// 公共工具：请求、转义、图标、朗读、提示

import { setOffline } from "./offline.js";
import { tint } from "./themes.js";
import { linkItalic, linkText } from "./words.js";

const PATHS = {
  today: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  explore: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  me: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5c1.2-3.8 4.2-5.6 7.5-5.6s6.3 1.8 7.5 5.6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
  sound: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  shuffle: '<path d="M3 7h3.5c4.5 0 6.5 10 11 10H21M3 17h3.5c1.8 0 3.1-1.6 4.3-3.6M13.2 9.6C14.4 8 15.7 7 17.5 7H21M18.5 4.5 21 7l-2.5 2.5M18.5 14.5 21 17l-2.5 2.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M14.5 8.5l2 2"/>',
  users: '<circle cx="9" cy="8" r="3.3"/><path d="M3 20c.9-3.4 3.3-5 6-5s5.1 1.6 6 5"/><path d="M15.5 4.9a3.3 3.3 0 0 1 0 6.3M17.5 15.3c1.7.6 3 2.1 3.5 4.7"/>',
  route: '<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8"/>',
  hourglass: '<path d="M6.5 3h11M6.5 21h11M7.5 3c0 5 9 6 9 9s-9 4-9 9M16.5 3c0 5-9 6-9 9s9 4 9 9"/>',
  letters: '<path d="M3.5 18 7.5 6l4 12M5 14h5M14 8.5h6l-6 9.5h6"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  minus: '<path d="M6.5 12h11"/>',
  resize: '<path d="M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5l-6 6M4.5 19.5l6-6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
};

export const icon = (name, cls = "i") =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name]}</svg>`;

export const esc = (s = "") =>
  String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

/**
 * 转义后把 *斜体* 变成 <em>。
 * link：给书里有的词加上词卡链接（只用在不在链接里的文字上，链接里再套链接不合法）；
 * used：这一篇里已经链过的词条（含这篇自己），每个词只链第一次；tap：其余英文词也能点（例句）。
 */
export function rich(s = "", { link = false, used = new Set(), tap = false } = {}) {
  if (!link) return esc(s).replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return String(s)
    .split(/\*([^*]+)\*/)
    .map((p, i) => (i % 2 ? `<em>${linkItalic(p, used)}</em>` : linkText(p, used, tap)))
    .join("");
}

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

export function fmtDay(day, { weekday = true } = {}) {
  const [y, m, d] = day.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${m} 月 ${d} 日${weekday ? ` · ${WEEKDAYS[wd]}` : ""}`;
}

const CN = "〇一二三四五六七八九";
const cnSmall = (n) => (n <= 10 ? (n === 10 ? "十" : CN[n]) : n < 20 ? "十" + CN[n % 10] : CN[Math.floor(n / 10)] + "十" + (n % 10 ? CN[n % 10] : ""));

/** 报头日期：二〇二六年十月十八日 */
export function cnDate(day) {
  const [y, m, d] = day.split("-").map(Number);
  return `${String(y).replace(/\d/g, (c) => CN[c])}年${cnSmall(m)}月${cnSmall(d)}日`;
}

export function weekday(day) {
  const [y, m, d] = day.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 13) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

// ---------- 朗读：先放服务器取来的真人录音 / 词典发音，取不到再用浏览器自带的语音 ----------

/** 英音还是美音，记在本机 */
export const getAccent = () => local.get("accent", "uk");
export const setAccent = (a) => local.set("accent", a === "us" ? "us" : "uk");

// 用 Web Audio 播：点按的那一刻就把 AudioContext 唤醒，iPhone 上等音频取回来之后也能出声；
// 也不用管 <audio> 的分段请求。
let ctx = null;
let playing = null; // { src, btn }

function stopSpeaking() {
  if (playing) {
    try {
      playing.src?.stop();
    } catch {}
    playing.btn?.classList.remove("playing", "loading");
    playing = null;
  }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

function pickVoice(lang) {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.replace("_", "-").startsWith("en"));
  const score = (v) =>
    (v.lang.replace("_", "-") === lang ? 4 : 0) +
    (/natural|neural|premium|enhanced|增强|高品质/i.test(v.name) ? 3 : 0) +
    (/google|microsoft|siri|daniel|samantha|serena|kate|arthur|ava|zoe/i.test(v.name) ? 1 : 0) +
    (v.localService ? 0 : 0.5);
  return voices.sort((a, b) => score(b) - score(a))[0] ?? null;
}

function speakLocally(text, accent, btn) {
  const me = { src: null, btn };
  playing = me;
  btn?.classList.remove("loading");
  if (!("speechSynthesis" in window)) return stopSpeaking();
  const lang = accent === "us" ? "en-US" : "en-GB";
  const u = new SpeechSynthesisUtterance(text);
  u.voice = pickVoice(lang);
  u.lang = u.voice?.lang ?? lang;
  u.rate = 0.9;
  u.onend = u.onerror = () => {
    if (playing === me) {
      btn?.classList.remove("playing");
      playing = null;
    }
  };
  btn?.classList.add("playing");
  speechSynthesis.speak(u);
}

const sayUrl = (q, accent = getAccent()) => `/api/say?accent=${accent}&q=${encodeURIComponent(q)}`;

/** 先把发音取回来存着（打开文章时取单词的），点朗读时就不用等 */
export function warmSpeech(text) {
  const q = text.replace(/\*/g, "").replace(/\s+/g, " ").trim();
  if (q && navigator.onLine) fetch(sayUrl(q), { credentials: "same-origin" }).catch(() => {});
}

/** 读一段英文。btn 是被点的按钮：取音频时闪一闪，读的时候高亮；读的时候再点一下就停 */
export function speak(text, btn = null) {
  const q = text.replace(/\*/g, "").replace(/\s+/g, " ").trim();
  if (!q) return;
  const again = btn && playing?.btn === btn;
  stopSpeaking();
  if (again) return;
  const accent = getAccent();
  const AC = window.AudioContext ?? window.webkitAudioContext;
  if (q.length > 200 || !AC) {
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    return speakLocally(q, accent, btn);
  }
  ctx ??= new AC();
  ctx.resume?.(); // 必须在点按的同一拍里调用
  const me = { src: null, btn };
  playing = me;
  btn?.classList.add("playing", "loading");
  (async () => {
    const res = await fetch(sayUrl(q, accent), { credentials: "same-origin" });
    if (!res.ok) throw new Error(String(res.status));
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    if (playing !== me) return; // 等的时候又点了别的
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => {
      if (playing === me) stopSpeaking();
    };
    me.src = src;
    btn?.classList.remove("loading");
    src.start();
  })().catch(() => {
    if (playing === me) speakLocally(q, accent, btn); // 服务器取不到发音、离线又没存过：用浏览器的语音
  });
}
if ("speechSynthesis" in window) speechSynthesis.getVoices();

/** 401 时由 main.js 注入的处理函数（显示登录页） */
export const hooks = { onUnauthorized: () => {}, onRevalidate: () => {} };

// ---------- 导航作用域：切页时可以中止上一趟请求 ----------

/** 每次 hashchange 开一趟导航：取消上一趟的 GET，记下这趟用到了哪些接口 */
export const nav = { id: 0, ctrl: null, used: new Set() };

export function beginNav() {
  nav.ctrl?.abort();
  nav.ctrl = new AbortController();
  nav.used = new Set();
  nav.id++;
  return nav.ctrl.signal;
}

// ---------- GET 的内存短缓存（stale-while-revalidate） ----------

const FRESH = 25_000; // 这么新就直接用，不发请求
const KEEP = 5 * 60_000; // 更旧就丢掉，重新拉
const MAX_KEYS = 120;

const cache = new Map(); // path -> { data, at }
const inflight = new Map(); // path -> { promise, signal }
let epoch = 0; // 写操作后加一，用来丢弃旧数据回填

function fill(path, data) {
  cache.delete(path); // 重新插到队尾，淘汰时先丢最久没用的
  cache.set(path, { data, at: Date.now() });
  if (cache.size > MAX_KEYS) cache.delete(cache.keys().next().value);
}

/** 作废缓存：不传前缀就全清 */
export function invalidate(prefix) {
  epoch++;
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
}

async function request(path, { method = "GET", body } = {}, signal) {
  const write = method !== "GET";
  let res;
  try {
    res = await fetch("/api" + path, {
      method,
      credentials: "same-origin",
      headers: write ? { "content-type": "application/json" } : undefined,
      body: write ? JSON.stringify(body ?? {}) : undefined,
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    // 请求根本发不出去：没网（读的请求由 Service Worker 兜底，走到这里的多半是写操作）
    setOffline(true);
    throw Object.assign(new Error("离线中，联网后再试"), { offline: true });
  }
  // Service Worker 拿缓存顶上时会带 x-offline
  setOffline(res.headers.get("x-offline") === "1");
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    hooks.onUnauthorized();
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  }
  if (!res.ok) {
    throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status, offline: res.headers.get("x-offline") === "1" });
  }
  return data;
}

/** 同一个地址同时只发一次请求；带 signal 的显式请求不跟别的请求合流 */
function getData(path, signal) {
  const cur = inflight.get(path);
  if (cur && (cur.signal === signal || !cur.signal)) return cur.promise;
  const promise = request(path, {}, signal).finally(() => {
    if (inflight.get(path)?.promise === promise) inflight.delete(path);
  });
  inflight.set(path, { promise, signal });
  return promise;
}

/** 旧数据已经画在屏幕上了，后台把这页的数据悄悄换新；变了自己再画一遍 */
function revalidate(path) {
  const startEpoch = epoch;
  getData(path)
    .then((data) => {
      if (startEpoch !== epoch) return; // 中途写过东西，这批数据作废
      const hit = cache.get(path);
      const changed = !hit || JSON.stringify(hit.data) !== JSON.stringify(data);
      fill(path, data);
      if (changed) hooks.onRevalidate(path);
    })
    .catch(() => {});
}

/**
 * 请求后端 /api。GET 走内存短缓存（25 秒内直接返回，过期先给旧数据再后台拉新）；
 * 改动数据的请求一律发 JSON（后端据此防跨站伪造），写完清空缓存。
 */
export async function api(path, { method = "GET", body, fresh = false } = {}) {
  if (method !== "GET") {
    const data = await request(path, { method, body });
    invalidate(); // 收藏、读完、改设置都可能影响别的页面
    return data;
  }

  nav.used.add(path);
  const hit = cache.get(path);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && !fresh && age < KEEP) {
    if (age > FRESH) revalidate(path);
    return hit.data;
  }

  const startEpoch = epoch;
  const data = await getData(path, nav.ctrl?.signal);
  if (startEpoch === epoch) fill(path, data);
  return data;
}

/** 空闲时预热几个常用接口，切 tab 时先有东西可画 */
export function prefetch(paths = []) {
  const idle = (fn) => ("requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 2500 }) : setTimeout(fn, 1200));
  idle(async () => {
    for (const path of paths) {
      const hit = cache.get(path);
      if (hit && Date.now() - hit.at < FRESH) continue;
      const startEpoch = epoch;
      try {
        const data = await getData(path);
        if (startEpoch === epoch) fill(path, data); // 中途写过东西就别回填了
      } catch {}
      await new Promise((r) => setTimeout(r, 120)); // 别和首屏抢带宽
    }
  });
}

const $app = document.getElementById("app");

export function render(html) {
  $app.removeAttribute("aria-busy");
  $app.innerHTML = `<div class="view">${html}</div>`;
}

// ---------- 骨架屏：接口慢的时候先占住版面，别让人对着白屏 ----------

const bar = (h, w = "100%") => `<span class="sk" style="height:${h}px;width:${w}"></span>`;
const lines = (n) => `<div class="sk-lines">${bar(13).repeat(n)}</div>`;

export function skeleton(kind = "page") {
  const heads = {
    home: `<div class="sk-mast">${bar(12, "46%")}<div class="sk-rule"></div>${bar(34, "72%")}${bar(12, "34%")}</div>
      <div class="sk-home"><div class="sk-cover"></div><div class="sk-cards">${`<div class="sk-card"></div>`.repeat(3)}</div></div>`,
    explore: `<div class="sk-head">${bar(11, "90px")}${bar(28, "160px")}</div>
      <div class="sk-search"></div>
      <div class="sk-halls">${`<div class="sk-hall"></div>`.repeat(6)}</div>`,
    me: `<div class="sk-head">${bar(11, "90px")}${bar(28, "120px")}</div>
      <div class="sk-me"><div class="sk-panel"></div><div class="sk-cards">${`<div class="sk-card"></div>`.repeat(2)}</div></div>`,
    entry: `<div class="sk-hero"></div>${lines(7)}`,
    page: `<div class="sk-head">${bar(11, "90px")}${bar(28, "180px")}</div>${lines(6)}`,
  };
  $app.setAttribute("aria-busy", "true");
  $app.innerHTML = `<div class="view sk-view" aria-hidden="true">${heads[kind] ?? heads.page}</div>`;
}

/** 路由页面对应的骨架形状 */
export const skeletonFor = (path) =>
  path === "" ? "home" : path.startsWith("w/") ? "entry" : path.startsWith("explore") ? "explore" : path.startsWith("me") ? "me" : "page";

let toastTimer;
export function toast(text) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

/** 本机的小偏好（阅读进度、关掉的提示），读写失败时静默忽略 */
export const local = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

/** 空状态：一枚淡印章、一句话，再给一两个去处 */
export const empty = (text, acts = "") =>
  `<div class="empty"><span class="seal"></span><div>${text}</div>${acts ? `<div class="empty-acts">${acts}</div>` : ""}</div>`;

/** 列表行：左侧圆点是词条的专题色 */
export function row(s, { sub = "meaning", query = "" } = {}) {
  let snippet = "";
  if (s.snippet) {
    snippet = esc(s.snippet);
    if (query) {
      const q = esc(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      snippet = snippet.replace(new RegExp(q, "gi"), (m) => `<mark>${m}</mark>`);
    }
    snippet = `<span class="row-snip">${snippet}</span>`;
  }
  const target = s.redirect ?? s.id;
  const text = s.redirect ? `见 ${esc(s.redirect)}` : sub === "teaser" && !s.read ? esc(s.teaser) : esc(s.meaning);
  return `<a class="row${s.read || s.redirect ? " read" : ""}" href="#/w/${esc(target)}" ${s.themes ? `style="${tint(s)}"` : ""}>
    <span class="dot"></span>
    <span class="row-head">${esc(s.headword)}</span>
    <span class="row-flag">${s.daily ? `<span class="pushed">当日推送</span>` : ""}${s.starred ? icon("star", "star-s") : ""}<span class="badge">未读</span></span>
    <span class="row-sub">${text}</span>
    ${snippet}
  </a>`;
}

/** 全局动作表：元素上写 data-action="名字"，点击时调用 actions[名字](el, event) */
export const actions = {};
