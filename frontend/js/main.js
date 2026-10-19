// 入口：路由、全局动作、登录状态

import { actions, api, beginNav, empty, esc, hooks, invalidate, nav, prefetch, render, skeleton, skeletonFor, speak, toast } from "./lib.js";
import { clearOfflineData, flushReads, precacheLoaded, setOffline, warmForOffline } from "./offline.js";
import { initPull } from "./pull.js";
import { disablePush, registerSW } from "./push.js";
import "./wordcard.js";
import { viewAccount } from "./views/account.js";
import { viewAdmin } from "./views/admin.js";
import { renderJoin, renderJoinWhileLoggedIn, renderLogin } from "./views/auth.js";
import { viewEntry } from "./views/entry.js";
import { invalidateSummaries, viewAZ, viewExplore, viewRoutes, viewTheme, viewTimeline } from "./views/explore.js";
import { viewHome } from "./views/home.js";
import { viewHistory, viewMe, viewReminder, viewStarred } from "./views/me.js";

const dec = decodeURIComponent;

/** [路径正则, 高亮的标签, 页面] */
const ROUTES = [
  [/^$/, "today", () => viewHome()],
  // 旧的故事模式链接直接转到文章页
  [/^read\/([^/?]+)/, "explore", (m) => location.replace(`#/w/${m[1]}`)],
  [/^w\/(.+)$/, "explore", (m) => viewEntry(dec(m[1]))],
  [/^explore$/, "explore", (_, q) => viewExplore(q)],
  [/^explore\/t\/(.+)$/, "explore", (m, q) => viewTheme(dec(m[1]), q)],
  [/^explore\/az$/, "explore", () => viewAZ()],
  [/^explore\/routes$/, "explore", () => viewRoutes()],
  [/^explore\/timeline$/, "explore", () => viewTimeline()],
  [/^me$/, "me", () => viewMe()],
  [/^me\/starred$/, "me", () => viewStarred()],
  [/^me\/history$/, "me", () => viewHistory()],
  [/^me\/reminder$/, "me", () => viewReminder()],
  [/^me\/account$/, "me", () => viewAccount()],
  [/^me\/admin$/, "me", (_, q) => viewAdmin(q)],
];

let navCount = 0;

// ---------- 多级跳转：返回时回到原来的位置，返回按钮写明回哪里 ----------
//
// 每一层页面的状态记在它自己的 history.state 里（浏览器前进后退时自动带回来）：
//   y / open：滚动位置、哪些折叠块是展开的；
//   from：从哪一页点进来的（返回按钮写它的名字）；
//   root / depth：在文章之间连续跳了几层、最早是从哪个列表页出发的（可以一步回去）。

/** 当前屏幕上画的是哪一页（渲染完才更新，加载中途的滚动不算它的） */
let shown = null; // { hash, path, state }
/** 文章页的标题（单词），返回按钮要用 */
const titles = new Map();

const STATIC_LABELS = {
  "": "今日", explore: "探索", "explore/az": "按字母", "explore/routes": "语源之路", "explore/timeline": "时间长廊",
  me: "我的", "me/starred": "我的收藏", "me/history": "阅读记录", "me/reminder": "每日提醒", "me/account": "账号与安全", "me/admin": "管理后台",
};

function labelOf(hash) {
  const h = hash.replace(/^#\/?/, "");
  const [path, qs] = h.split("?");
  const q = new URLSearchParams(qs ?? "");
  if (path === "explore" && q.get("q")) return `搜索“${q.get("q")}”`;
  if (path.startsWith("explore/t/")) return dec(path.slice(10));
  if (path.startsWith("w/")) return titles.get(dec(path.slice(2))) ?? dec(path.slice(2));
  return STATIC_LABELS[path] ?? "上一页";
}

const openIndexes = () =>
  [...document.querySelectorAll("#app details")].flatMap((d, i) => (d.open ? [i] : []));

function restoreOpen(list) {
  if (!list) return;
  const all = [...document.querySelectorAll("#app details")];
  for (const d of all) d.open = false;
  for (const i of list) if (all[i]) all[i].open = true;
}

/** 把这一页的滚动位置、展开状态记进它的 history 条目 */
function saveState() {
  if (!shown || parseHash().path !== shown.path) return;
  shown.hash = location.hash; // 搜索页改关键词时地址是 replaceState 换的
  shown.state = { ...shown.state, y: Math.round(scrollY), open: openIndexes() };
  try {
    history.replaceState(shown.state, "");
  } catch {}
}
let saveTimer;
addEventListener("scroll", () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 150);
}, { passive: true });
document.addEventListener("toggle", () => setTimeout(saveState), true);
// 点链接跳走之前先记一下（滚动的记录可能还没来得及写）
document.addEventListener("click", saveState, true);

/** 新打开的一页：记下从哪来；在文章之间连续跳时，记下出发的那个列表页和跳了几层 */
function arrive(path) {
  if (history.state?.v) return history.state; // 前进 / 后退回来的，原样用
  const st = { v: 1 };
  if (shown && shown.path !== path) {
    st.from = { hash: shown.hash, label: labelOf(shown.hash) };
    if (path.startsWith("w/")) {
      const prevEntry = shown.path.startsWith("w/");
      st.root = prevEntry ? shown.state?.root ?? st.from : st.from;
      st.depth = prevEntry ? (shown.state?.depth ?? 1) + 1 : 1;
    }
  }
  try {
    history.replaceState(st, "");
  } catch {}
  return st;
}

/** 返回按钮写上回哪里；在文章之间跳了两层以上，再给一个“回到出发的列表”的按钮 */
function decorateBack(st, path) {
  const back = document.querySelector("#app .back");
  if (!back) return;
  if (st.from && navCount > 1) {
    const label = st.from.label.length > 12 ? st.from.label.slice(0, 11) + "…" : st.from.label;
    back.lastChild.textContent = label;
    back.title = `返回${st.from.label}`;
  }
  if (path.startsWith("w/") && st.depth >= 2 && st.root) {
    back.insertAdjacentHTML(
      "afterend",
      `<button class="back root" data-action="back-root" data-depth="${st.depth}">回到${esc(st.root.label.length > 10 ? st.root.label.slice(0, 9) + "…" : st.root.label)}</button>`,
    );
  }
}

/** 当前这一页：数据在后台换新且确实变了，才重新画一遍 */
let current = null;
let rerenderTimer;

function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, qs] = h.split("?");
  return { path: path.replace(/\/$/, ""), query: new URLSearchParams(qs ?? "") };
}

/** 三个主 tab 才自动重画；文章页有阅读计时，重画会打断它 */
const isTab = (path) => path === "" || path === "explore" || path === "me";
const isTyping = () => document.activeElement?.matches?.("input, textarea, select");

/** 登录后空闲时先拉一遍常用接口，切 tab 时几乎瞬时 */
let warmed = false;
function warmCache() {
  if (warmed) return;
  warmed = true;
  prefetch(["/today", "/next", "/entries", "/themes", "/shelf", "/history", "/reminder", "/me", "/starred"]);
  // 离线阅读：补交离线时读完的词，把可能要读的词先存下来
  syncReads();
  setTimeout(() => {
    precacheLoaded();
    warmForOffline(api);
  }, 4000);
}

async function route() {
  navCount++;
  const { path, query } = parseHash();
  const signal = beginNav();

  // 邀请链接 #/join/邀请码：没登录就进注册页
  const join = path.match(/^join(?:\/(.+))?$/);
  if (join) {
    // 邀请页不继承上一页的版式（文章页的 bleed 会把顶栏藏掉），也别让后台重画盖掉它
    document.body.classList.remove("bleed", "home");
    document.title = "词源一日";
    current = null;
    const { loggedIn, user } = await api("/auth").catch((err) => {
      if (err.status !== 401) throw err;
      return { loggedIn: false };
    });
    if (signal.aborted) return;
    if (loggedIn) renderJoinWhileLoggedIn(user);
    else await renderJoin(join[1] ? dec(join[1]) : "");
    return;
  }

  const hit = ROUTES.map(([re, tab, view]) => ({ m: path.match(re), tab, view })).find((r) => r.m);
  if (!hit) {
    location.replace("#/");
    return;
  }

  // 文章页的题头在手机上铺满到顶部，隐藏顶栏
  document.body.classList.toggle("bleed", path.startsWith("w/"));
  document.body.classList.toggle("home", path === "");
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.tab === hit.tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  document.title = "词源一日";

  // 重画时重新读地址栏，搜索页换了关键词也对得上
  current = { path, run: () => hit.view(hit.m, parseHash().query), used: new Set(), live: isTab(path) };

  // 接口慢的时候先出骨架，别让人对着空白页（快的话不闪）
  const slow = setTimeout(() => {
    if (!signal.aborted && !nav.rendered) skeleton(skeletonFor(path)); // 视图已经画出来的，别再拿骨架屏盖掉
  }, 120);

  const st = arrive(path);
  try {
    await hit.view(hit.m, query);
    if (signal.aborted) return;
    current.used = new Set(nav.used);
    if (path.startsWith("w/")) titles.set(dec(path.slice(2)), document.title.split(" · ")[0]);
    decorateBack(st, path);
    // 后退回来的：展开过的块重新展开，滚回原来的位置；新打开的从顶上开始
    restoreOpen(st.open);
    window.scrollTo(0, st.y ?? 0);
    shown = { hash: location.hash, path, state: st };
    warmCache();
  } catch (err) {
    if (signal.aborted || err?.name === "AbortError" || err.status === 401) return;
    document.body.classList.remove("bleed");
    render(
      err.status === 404
        ? empty("找不到这个词条，可能是链接写错了", `<a class="btn sm" href="#/">回到今日</a><a class="btn sm ghost" href="#/explore">去探索</a>`)
        : err.offline
        ? empty("离线中，这一页还没有存下来<br>联网后再来看看", `<a class="btn sm" href="#/">回到今日</a><button class="btn sm ghost" data-action="reload">重试</button>`)
        : empty(`出错了：${esc(err.message)}`, `<button class="btn sm" data-action="reload">重新加载</button>`),
    );
  } finally {
    clearTimeout(slow);
  }
}

// 后台拉到的新数据和屏幕上那页有关，就悄悄重画一次（滚动位置不变）
hooks.onRevalidate = (path) => {
  if (!current?.live || !current.used.has(path)) return;
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(async () => {
    const page = current;
    // 正在编辑首页桌面时别重画，不然拖到一半卡片就没了
    if (!page?.live || !page.used.has(path) || isTyping() || document.body.classList.contains("desk-editing")) return;
    const y = scrollY;
    const open = openIndexes();
    try {
      await page.run();
      if (shown) decorateBack(shown.state, page.path);
      restoreOpen(open);
      window.scrollTo(0, y);
    } catch {}
  }, 90);
};

// 下拉刷新：清掉接口缓存，把当前这一页重新画一遍（不整页重载）；顺便让 Service Worker 检查前端新版本
async function refreshPage() {
  navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
  syncReads();
  const page = current;
  if (!page) return location.reload();
  invalidate();
  const open = openIndexes();
  await page.run();
  if (current !== page) return; // 刷新途中切到别的页了
  page.used = new Set(nav.used);
  if (shown) decorateBack(shown.state, page.path);
  restoreOpen(open);
}
initPull(refreshPage);

// ---------- 全局动作 ----------

actions.say = (el) => speak(el.dataset.text, el);

actions.reload = () => location.reload();

actions.star = async (el) => {
  const id = el.dataset.id;
  const starred = el.getAttribute("aria-pressed") !== "true";
  for (const b of document.querySelectorAll(`[data-action="star"][data-id="${CSS.escape(id)}"]`)) {
    b.setAttribute("aria-pressed", String(starred));
  }
  await api(`/entries/${id}/star`, { method: "POST", body: { starred } });
  invalidateSummaries();
  toast(starred ? "已收藏" : "已取消收藏");
};

/** 在文章之间跳了好几层：一步回到出发的列表页（走浏览器历史，那一页的位置和展开状态都还在） */
actions["back-root"] = (el) => history.go(-Number(el.dataset.depth));

actions.back = () => {
  if (navCount > 1) history.back();
  else location.hash = parseHash().path.startsWith("me/") ? "#/me" : "#/explore";
};

/** 退出：先取消这台设备的推送订阅（免得下一个登录的人收到你的提醒），清掉离线缓存，再整页刷新清掉内存里的数据 */
actions.logout = async () => {
  await disablePush().catch(() => {});
  await api("/logout", { method: "POST" });
  await clearOfflineData();
  location.replace("#/");
  location.reload();
};

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-action]");
  if (!el || el.disabled) return;
  // 动作区域里的普通链接（如翻面卡片背面的“重读全文”）照常跳转
  const link = ev.target.closest("a[href]");
  if (link && link !== el && el.contains(link)) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  ev.preventDefault();
  Promise.resolve(fn(el, ev)).catch((err) => {
    if (err.status !== 401) toast(err.message || "出错了");
  });
});


// ---------- 登录 ----------

// 会话过期：先摘掉当前页的状态，免得后台刷新又把旧页面画回来盖住登录表单
hooks.onUnauthorized = () => {
  current = null;
  renderLogin();
};

// 可聚焦的“按钮式”元素（如翻面卡片）支持回车 / 空格
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" && ev.key !== " ") return;
  const el = ev.target.closest('[role="button"][data-action]');
  if (!el) return;
  ev.preventDefault();
  el.click();
});

// 被下一趟导航打断是正常的，只有真正的错误才打到控制台
const boot = () => route().catch((err) => {
  if (err?.name !== "AbortError" && err?.status !== 401) console.error(err);
});

window.addEventListener("hashchange", boot);
/** 离线时读完的词，联网后补交 */
const syncReads = () => flushReads((id, read, manual) => api(`/entries/${encodeURIComponent(id)}/read`, { method: "POST", body: { read, manual } }));
addEventListener("online", () => {
  setOffline(false);
  syncReads();
});
addEventListener("offline", () => setOffline(true));

// 滚动位置由我们自己按页面恢复（内容是异步画出来的，浏览器自己恢复会落空）
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
registerSW();
boot();
