// Service Worker：推送通知 + 离线阅读。
//
// 缓存策略（都是为了“有网时永远是新的，没网时还能读”）：
// - 带内容哈希版本号的 css/js（部署脚本打的 ?v=0123abcd89）：同一个地址内容永远不变，先读缓存；
// - 页面本身、没带哈希的静态文件（本地开发时）：先走网络，失败才用缓存；
// - 字体、图标：先读缓存；
// - 发音 /api/say：同一段话的发音不会变，先读缓存（单独一个缓存，不随退出登录清掉，太多了删最早的）；
// - GET /api：先走网络，成功的回包顺手存一份。网络慢但没断时，手里有旧数据才在 4 秒后（下拉刷新 12 秒）先给旧数据（标 x-stale，
//   不算离线），网络请求不掐断，回来照样存；网关错误（502/503/504，后端重启时）先自动重试一次；
//   手里什么都没有就一直等网络（慢总比报“离线”强）。真的没网又没存过，回 503；
// - 页面导航（2026-10-21 起）：存过页面就**直接用存的**（打开不再等一个来回），后台去取线上页面；
//   线上有新版本时，先把新版本的 css/js 全部预取进缓存，最后才把新页面换进缓存并通知页面“新版本已就绪”，
//   所以点“刷新”或下次打开都是瞬间、而且新旧文件不会混搭。第一次来（没存过）就等网络；
// - 页面要求时（请求头 x-ety-swr），接口先给缓存、后台换新：只用今天（北京时间）存的、且晚于本机最近一次写操作的缓存，
//   页面拿到后会再要一次新数据，变了就悄悄重画；
// - 登录态（/api/auth、/api/me）永不走缓存：旧的“已登录”会把过期会话的人带进一个全是 401 的空壳页。
// 退出登录时页面会清掉接口缓存，换人登录看不到上一个人的数据。

const STATIC = "ety-static";
const API = "ety-api";
const AUDIO = "ety-audio";
const AUDIO_MAX = 400;
const NET_TIMEOUT = 4000;
/** 下拉刷新时（请求头 x-ety-fresh: 1）多等一会儿网络 */
const FRESH_TIMEOUT = 12000;
const HASHED = /[?&]v=[0-9a-f]{10}$/;
// 管理、推送、邀请、登录态这些接口不缓存（auth / me 决定“是不是已登录”，不能拿旧的顶上）
const NO_CACHE_API = /^\/api\/(admin|push|invites|login|logout|register|auth|me)(\/|\?|$)/;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(
    self.clients.claim().then(() =>
      // 换上新 SW 后，打开着的页面大概率还在跑旧版前端，提醒它们刷新
      self.clients.matchAll({ type: "window" }).then((list) => {
        // 自己的版本号就在脚本地址里（/sw.js?v=xxxx）；页面拿它和自己的版本比，一样就不提示
        const version = new URL(self.location.href).searchParams.get("v") ?? "";
        for (const client of list) client.postMessage({ type: "updated", version });
      }),
    ),
  ),
);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") event.respondWith(page(req, event));
  else if (url.pathname === "/api/say") event.respondWith(audioGet(req));
  else if (url.pathname.startsWith("/api/")) {
    if (!NO_CACHE_API.test(url.pathname)) event.respondWith(apiGet(req, event));
  } else if (HASHED.test(url.search) || /^\/(fonts|icons)\//.test(url.pathname)) event.respondWith(cacheFirst(req));
  else event.respondWith(networkFirst(req, STATIC));
});

/** 等网络最多 ms 毫秒；超时或失败都返回 undefined。ms 为 0 表示不设上限（只有真的失败才放弃） */
async function tryNetwork(req, ms) {
  if (!ms) {
    try {
      return await fetch(req);
    } catch {
      return undefined;
    }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(req, { signal: ctrl.signal });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(STATIC)).put(req, res.clone());
  return res;
}

async function networkFirst(req, name) {
  const old = await caches.match(req);
  const res = await tryNetwork(req, old ? NET_TIMEOUT : 0); // 手里没有旧的，就别催网络
  if (res?.ok) {
    (await caches.open(name)).put(req, res.clone());
    return res;
  }
  return res ?? old ?? Response.error();
}

/** 页面 HTML 里的整体版本号（<meta name="ety-version">），老页面没有就退回 main.js 的版本号 */
const versionOf = (html = "") =>
  html.match(/<meta name="ety-version" content="([\w.-]+)"/)?.[1] ?? html.match(/\/js\/main\.js\?v=([\w.-]+)/)?.[1] ?? "";
/** 页面引用的本站 css/js（带 ?v=），新版本就绪前要先全部存好 */
const assetsOf = (html = "") => [...html.matchAll(/(?:href|src)="(\/[^"]+\?v=[\w.-]+)"/g)].map((m) => m[1]);

/**
 * 页面：所有路由都是同一个 index.html，按 "/" 存一份。
 * 存过就直接给存的（不等网络），同时后台检查线上版本；第一次来才等网络（多慢都等，别替浏览器判“打不开”）。
 */
async function page(req, event) {
  const old = await caches.match("/");
  if (old) {
    event?.waitUntil(refreshShell().catch(() => {}));
    return old;
  }
  const res = await tryNetwork(req, 0);
  if (res?.ok) {
    const html = await res.clone().text();
    const cache = await caches.open(STATIC);
    await cache.put("/", res.clone());
    event?.waitUntil(precache(assetsOf(html)).catch(() => {}));
    return res;
  }
  return res ?? Response.error();
}

/** 把一批地址存进静态缓存（已有的跳过）；任何一个取不到就抛错，调用方据此不切换版本 */
async function precache(urls) {
  const cache = await caches.open(STATIC);
  await Promise.all(
    urls.map(async (u) => {
      if (await cache.match(u)) return;
      const res = await fetch(u, { cache: "no-cache" });
      if (!res.ok) throw new Error(`precache ${u} ${res.status}`);
      await cache.put(u, res);
    }),
  );
}

/**
 * 后台取一次线上页面：版本没变就顺手更新存的那份；变了就先把新版本的 css/js 全部存好，
 * 再一次性把页面换成新的、清掉旧文件，最后告诉打开着的页面“新版本已就绪”。同一时间只跑一趟。
 */
let shellJob = null;
function refreshShell() {
  shellJob ??= (async () => {
    try {
      const res = await fetch("/", { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) return { changed: false };
      const html = await res.clone().text();
      const version = versionOf(html);
      if (!version) return { changed: false };
      const cache = await caches.open(STATIC);
      const old = await cache.match("/");
      const oldVersion = old ? versionOf(await old.text()) : "";
      if (oldVersion === version) {
        await cache.put("/", res);
        return { changed: false, version };
      }
      await precache(assetsOf(html));
      await cache.put("/", res);
      await pruneStatic(html);
      for (const client of await self.clients.matchAll({ type: "window" })) client.postMessage({ type: "ready", version });
      return { changed: true, version };
    } finally {
      shellJob = null;
    }
  })();
  return shellJob;
}

async function audioGet(req) {
  const cache = await caches.open(AUDIO);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.status === 200) {
    await cache.put(req, res.clone());
    const keys = await cache.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - AUDIO_MAX))) cache.delete(k);
  }
  return res;
}

/** 新页面换进缓存后，清掉它没引用的旧版本 css/js（字体、图标不带版本号，留着） */
async function pruneStatic(html) {
  const keep = new Set(assetsOf(html));
  const cache = await caches.open(STATIC);
  for (const key of await cache.keys()) {
    const u = new URL(key.url);
    if (!u.searchParams.get("v")) continue;
    if (!keep.has(u.pathname + u.search)) cache.delete(key);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 网关错误（后端重启、Cloudflare 一时连不上源站）：短暂的，值得马上再试一次 */
const TRANSIENT = new Set([502, 503, 504, 520, 521, 522, 523, 524]);

/** 发一次请求；网关错误时隔一下再试一次。网络本身断了返回 undefined */
async function fetchApi(req) {
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await fetch(req.clone());
    } catch {
      if (i >= 1) return undefined;
      await sleep(800);
      continue;
    }
    if (!TRANSIENT.has(res.status) || i >= 1) return res;
    await sleep(1200);
  }
}

/** 给缓存里的旧回包打个标记：x-offline（连不上服务器）或 x-stale（网络慢 / 服务器出错，先给旧的） */
async function marked(hit, flag) {
  const headers = new Headers(hit.headers);
  headers.set(flag, "1");
  return new Response(await hit.blob(), { status: hit.status, headers });
}

/** 北京时间的日期（YYYY-MM-DD）：今天存的接口缓存才拿来“先给缓存” */
const cnDay = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
const SWR_MAX_AGE = 12 * 3600_000;

/** 同一个接口地址同时只发一个网络请求（“先给缓存”后台换新的那个请求，和页面紧跟着要新数据的请求合并） */
const apiInflight = new Map();
function netApi(req) {
  const key = req.url;
  let job = apiInflight.get(key);
  if (!job) {
    job = fetchApi(req)
      .then(async (res) => {
        if (res?.ok) {
          // 存的时候记下存入时间，“先给缓存”时要看它是不是今天、是不是晚于最近一次写操作
          const headers = new Headers(res.headers);
          headers.set("x-ety-at", String(Date.now()));
          const copy = new Response(await res.clone().blob(), { status: res.status, statusText: res.statusText, headers });
          await (await caches.open(API)).put(key, copy);
        }
        return res;
      })
      .finally(() => apiInflight.delete(key));
    apiInflight.set(key, job);
  }
  // 每个调用方拿一份自己的副本（Response 的 body 只能读一次）
  return job.then((res) => res?.clone());
}

/**
 * 接口：先走网络。手里有旧数据时最多等 4 秒（下拉刷新 12 秒），等不到先给旧数据，
 * 但网络请求不掐断，回来后存进缓存，页面过几秒再取就是新的了。
 * 页面带 x-ety-swr（值是本机最近一次写操作的时间）时：缓存是今天存的、晚于那次写操作、不到 12 小时，就立刻给缓存，后台换新。
 */
async function apiGet(req, event) {
  const hit = await caches.match(req);
  const swr = req.headers.get("x-ety-swr");
  if (hit && swr != null) {
    const at = Number(hit.headers.get("x-ety-at") || 0);
    const now = Date.now();
    if (at && at > Number(swr || 0) && now - at < SWR_MAX_AGE && cnDay(at) === cnDay(now)) {
      event?.waitUntil(netApi(req).catch(() => {}));
      return marked(hit, "x-swr");
    }
  }
  const net = netApi(req);
  if (hit) {
    const wait = req.headers.get("x-ety-fresh") === "1" ? FRESH_TIMEOUT : NET_TIMEOUT;
    const res = await Promise.race([net, sleep(wait).then(() => "slow")]);
    if (res === "slow") {
      event?.waitUntil(net.catch(() => {}));
      return marked(hit, "x-stale");
    }
    if (res?.ok) return res;
    if (res && !TRANSIENT.has(res.status) && res.status < 500) return res; // 401、404 之类照实返回
    return marked(hit, res ? "x-stale" : "x-offline");
  }
  // 一份存货都没有（比如第一次来）就一直等，慢总比报“离线”强
  const res = await net;
  if (res) return res;
  return new Response(JSON.stringify({ error: "离线中，这一页还没有缓存" }), {
    status: 503,
    headers: { "content-type": "application/json", "x-offline": "1" },
  });
}

/** 页面告诉我：这些文件已经加载过了（第一次打开时我还没接管，它们没经过我），补存一份 */
self.addEventListener("message", (event) => {
  // 页面问：线上有没有新版本？有就预取好再回 ready（refreshShell 里会广播），没有回 none
  if (event.data?.type === "check") {
    event.waitUntil(
      refreshShell()
        .then((r) => !r.changed && event.source?.postMessage({ type: "none", version: r.version ?? "" }))
        .catch(() => {}),
    );
    return;
  }
  if (event.data?.type !== "precache") return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC);
      for (const u of event.data.urls ?? []) {
        const url = new URL(u, self.location.origin);
        if (url.origin !== self.location.origin || (await cache.match(url))) continue;
        try {
          const res = await fetch(url);
          if (res.ok) await cache.put(url, res);
        } catch {}
      }
    })(),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "词源一日", {
      body: data.body || "",
      tag: data.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
