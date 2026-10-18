// 入口：路由、全局动作、登录状态

import { actions, api, beginNav, empty, esc, hooks, nav, prefetch, render, skeleton, skeletonFor, speak, toast } from "./lib.js";
import { disablePush, registerSW } from "./push.js";
import { viewAccount, viewAdmin } from "./views/account.js";
import { renderJoin, renderJoinWhileLoggedIn, renderLogin } from "./views/auth.js";
import { viewEntry } from "./views/entry.js";
import { invalidateSummaries, viewAZ, viewExplore, viewTheme } from "./views/explore.js";
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
  [/^explore\/t\/(.+)$/, "explore", (m) => viewTheme(dec(m[1]))],
  [/^explore\/az$/, "explore", () => viewAZ()],
  [/^me$/, "me", () => viewMe()],
  [/^me\/starred$/, "me", () => viewStarred()],
  [/^me\/history$/, "me", () => viewHistory()],
  [/^me\/reminder$/, "me", () => viewReminder()],
  [/^me\/account$/, "me", () => viewAccount()],
  [/^me\/admin$/, "me", () => viewAdmin()],
];

let navCount = 0;

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
    if (!signal.aborted) skeleton(skeletonFor(path));
  }, 120);

  try {
    await hit.view(hit.m, query);
    if (signal.aborted) return;
    current.used = new Set(nav.used);
    window.scrollTo(0, 0);
    warmCache();
  } catch (err) {
    if (signal.aborted || err?.name === "AbortError" || err.status === 401) return;
    document.body.classList.remove("bleed");
    render(
      err.status === 404
        ? empty("找不到这个词条，可能是链接写错了", `<a class="btn sm" href="#/">回到今日</a><a class="btn sm ghost" href="#/explore">去探索</a>`)
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
    if (!page?.live || !page.used.has(path) || isTyping()) return;
    const y = scrollY;
    try {
      await page.run();
      window.scrollTo(0, y);
    } catch {}
  }, 90);
};

// ---------- 全局动作 ----------

actions.say = (el) => speak(el.dataset.text);

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

actions.back = () => {
  if (navCount > 1) history.back();
  else location.hash = parseHash().path.startsWith("me/") ? "#/me" : "#/explore";
};

/** 退出：先取消这台设备的推送订阅（免得下一个登录的人收到你的提醒），再整页刷新清掉内存里的数据 */
actions.logout = async () => {
  await disablePush().catch(() => {});
  await api("/logout", { method: "POST" });
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
registerSW();
boot();
