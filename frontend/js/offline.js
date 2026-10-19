// 离线阅读：离线提示、预先缓存要读的词、离线时的“读完”先记在本地、退出时清掉缓存。
// 真正的缓存在 sw.js 里；这里只负责页面这一侧。不引用 lib.js，免得循环依赖。

const API_CACHE = "ety-api"; // 和 sw.js 里的名字一致
const PENDING = "ety-pending-reads";

// ---------- 离线提示 ----------

let offlineNow = false;
/** 收到离线时的旧数据（或请求发不出去）就挂上提示条；拿到新数据就摘掉 */
export function setOffline(flag) {
  if (flag === offlineNow) return;
  offlineNow = flag;
  document.body.classList.toggle("offline", flag);
  let bar = document.querySelector(".offline-bar");
  if (flag && !bar) {
    bar = document.createElement("div");
    bar.className = "offline-bar";
    bar.setAttribute("role", "status");
    bar.textContent = "离线中 · 显示的是之前存下的内容";
    document.body.append(bar);
  }
  bar?.toggleAttribute("hidden", !flag);
}

// ---------- 离线时读完的词：先记在本地，联网后补交 ----------

const readPending = () => {
  try {
    return JSON.parse(localStorage.getItem(PENDING) ?? "[]");
  } catch {
    return [];
  }
};
const writePending = (list) => {
  try {
    if (list.length) localStorage.setItem(PENDING, JSON.stringify(list));
    else localStorage.removeItem(PENDING);
  } catch {}
};

/** manual：手动点的“标为已读”（不算进排行榜和连续天数），补交时原样带上 */
export function queueRead(id, read, manual = false) {
  writePending([...readPending().filter((x) => x.id !== id), { id, read, manual }]);
}

/** 把离线时记下的“读完 / 标为未读”补交给服务器；交成功一条删一条 */
export async function flushReads(post) {
  let list = readPending();
  for (const x of list) {
    try {
      await post(x.id, x.read, !!x.manual);
      list = list.filter((y) => y.id !== x.id);
      writePending(list);
    } catch (err) {
      if (err?.offline) return; // 还是没网，下次再说
      list = list.filter((y) => y.id !== x.id); // 词条没了之类的，丢掉
      writePending(list);
    }
  }
}

// ---------- 预先缓存 ----------

/** 第一次打开时 Service Worker 还没接管页面，已加载的 css/js/字体没经过它，告诉它补存一份 */
export async function precacheLoaded() {
  const reg = await navigator.serviceWorker?.ready.catch(() => null);
  if (!reg?.active) return;
  const urls = performance
    .getEntriesByType("resource")
    .map((r) => r.name)
    .filter((u) => u.startsWith(location.origin) && /\.(js|css|woff2|png|svg)(\?|$)/.test(u));
  reg.active.postMessage({ type: "precache", urls: [location.origin + "/", ...urls] });
}

/** 把可能要读的词先拉一遍，经过 Service Worker 时就存下来：今天的、明天的、接着读、收藏的、最近读过的 */
export async function warmForOffline(api) {
  if (!navigator.onLine || !("caches" in window)) return;
  const [t, starred, history] = await Promise.all([api("/today"), api("/starred"), api("/history")]).catch(() => []);
  if (!t) return;
  const ids = [
    t.entry?.id,
    t.tomorrow?.id,
    ...(t.entry?.upNext ?? []).map((x) => x.id),
    t.resurface?.id,
    ...(starred ?? []).map((s) => s.id),
    ...(history ?? []).flatMap((d) => d.entries.map((s) => s.id)),
  ].filter(Boolean);
  const cache = await caches.open(API_CACHE);
  for (const id of [...new Set(ids)].slice(0, 60)) {
    const url = `/api/entries/${encodeURIComponent(id)}`;
    if (await cache.match(url)) continue;
    try {
      await fetch(url, { credentials: "same-origin" });
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 150)); // 别和正在看的页面抢带宽
  }
}

/** 退出 / 换人登录：清掉上一个账号的接口缓存和没交的阅读记录 */
export async function clearOfflineData() {
  writePending([]);
  if ("caches" in window) await caches.delete(API_CACHE).catch(() => {});
}
