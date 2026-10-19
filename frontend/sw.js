// Service Worker：推送通知 + 离线阅读。
//
// 缓存策略（都是为了“有网时永远是新的，没网时还能读”）：
// - 带内容哈希版本号的 css/js（部署脚本打的 ?v=0123abcd89）：同一个地址内容永远不变，先读缓存；
// - 页面本身、没带哈希的静态文件（本地开发时）：先走网络，失败才用缓存；
// - 字体、图标：先读缓存；
// - 发音 /api/say：同一段话的发音不会变，先读缓存（单独一个缓存，不随退出登录清掉，太多了删最早的）；
// - GET /api：先走网络，成功的回包顺手存一份。网络慢但没断时，手里有旧数据才在 4 秒后改用旧数据；
//   手里什么都没有就一直等网络（慢总比报“离线”强）。真的没网又没存过，回 503；
// - 页面导航：缓存里有旧页面才限时（4 秒），没有就交给浏览器自己去取，不替它判死刑；
// - 登录态（/api/auth、/api/me）永不走缓存：旧的“已登录”会把过期会话的人带进一个全是 401 的空壳页。
// 退出登录时页面会清掉接口缓存，换人登录看不到上一个人的数据。

const STATIC = "ety-static";
const API = "ety-api";
const AUDIO = "ety-audio";
const AUDIO_MAX = 400;
const NET_TIMEOUT = 4000;
const HASHED = /[?&]v=[0-9a-f]{10}$/;
// 管理、推送、邀请、登录态这些接口不缓存（auth / me 决定“是不是已登录”，不能拿旧的顶上）
const NO_CACHE_API = /^\/api\/(admin|push|invites|login|logout|register|auth|me)(\/|\?|$)/;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(
    self.clients.claim().then(() =>
      // 换上新 SW 后，打开着的页面大概率还在跑旧版前端，提醒它们刷新
      self.clients.matchAll({ type: "window" }).then((list) => {
        const version = self.registration.active?.scriptURL.match(/v=([\w.-]+)/)?.[1] ?? "";
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
    if (!NO_CACHE_API.test(url.pathname)) event.respondWith(apiGet(req));
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

/**
 * 页面：所有路由都是同一个 index.html，按 "/" 存一份；顺带清掉旧版本的静态文件。
 * 第一次来（还没存过页面）：不设超时，网络多慢都等，别在 4 秒时替浏览器判“打不开”；
 * 以前存过：最多等 4 秒，等不到就先给旧页面，让离线 / 慢网也能进。
 */
async function page(req, event) {
  const old = await caches.match("/");
  const res = await tryNetwork(req, old ? NET_TIMEOUT : 0);
  if (res?.ok) {
    const html = await res.clone().text();
    (await caches.open(STATIC)).put("/", res.clone());
    const ver = html.match(/main\.js\?v=([0-9a-f]{10})/)?.[1];
    if (ver) pruneStatic(ver);
    return res;
  }
  // 网络太慢先给了旧页面：后台接着把新页面拉下来存好，下一次打开就是新的，不会一直停在旧版
  if (!res && old) {
    const fresh = tryNetwork(req, 0).then((r) => {
      if (r?.ok) caches.open(STATIC).then((c) => c.put("/", r.clone()));
      return r?.ok;
    });
    event?.waitUntil(fresh);
  }
  return res ?? old ?? Response.error();
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

async function pruneStatic(ver) {
  const cache = await caches.open(STATIC);
  for (const key of await cache.keys()) {
    const v = new URL(key.url).searchParams.get("v");
    if (v && /^[0-9a-f]{10}$/.test(v) && v !== ver) cache.delete(key);
  }
}

async function apiGet(req) {
  const hit = await caches.match(req);
  // 有旧数据可退才限时；一份存货都没有（比如第一次来）就一直等，慢总比报“离线”强
  const res = await tryNetwork(req, hit ? NET_TIMEOUT : 0);
  if (res?.ok) {
    (await caches.open(API)).put(req, res.clone());
    return res;
  }
  if (res && res.status !== 0 && res.status < 500) return res; // 401、404 之类照实返回
  if (hit) {
    // 标一下“这是离线时的旧数据”，页面据此显示离线提示
    const headers = new Headers(hit.headers);
    headers.set("x-offline", "1");
    return new Response(await hit.blob(), { status: hit.status, headers });
  }
  return new Response(JSON.stringify({ error: "离线中，这一页还没有缓存" }), {
    status: 503,
    headers: { "content-type": "application/json", "x-offline": "1" },
  });
}

/** 页面告诉我：这些文件已经加载过了（第一次打开时我还没接管，它们没经过我），补存一份 */
self.addEventListener("message", (event) => {
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
