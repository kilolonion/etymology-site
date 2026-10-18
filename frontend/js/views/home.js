// 今日：报头 →（读完后的提醒询问）→ 一块像手机主屏幕的桌面。
// 桌面上的小组件可以自由添加、移除、换大小、拖动排列（见 desk.js）；这里只管每个组件画什么。
// 同一个组件在不同尺寸下取舍内容：大的多给几行，小的只留最要紧的。

import { reasonText, reminderPrompt } from "../components.js";
import { actions, api, cnDate, esc, icon, rich, render, weekday } from "../lib.js";
import { emblem, primaryTheme, THEMES, themeOf, themeTag, tint } from "../themes.js";
import { loadLayout, mountDesk, shell } from "../desk.js";

/** 单词越长，字号越小 */
const sizeClass = (w) => (w.length <= 8 ? "xl" : w.length <= 13 ? "l" : "m");
const eraLabel = (c) => (c < 0 ? `公元前 ${-c} 世纪` : `${c} 世纪`);

/** 这一次首页用到的数据；词条目录、专题、收藏可能晚一点到 */
let ctx = null;

export async function viewHome() {
  const t = await api("/today");
  const [discover, prompt] = await Promise.all([api("/next"), t.done ? reminderPrompt() : ""]);
  // 下面几个组件要用词条目录、专题、收藏；平时早就预取好了，第一次打开时最多等一小会儿，等不到就先画别的
  const extra = Promise.all([api("/entries"), api("/themes"), api("/starred")]);
  const quick = await Promise.race([extra, new Promise((r) => setTimeout(r, 500))]);
  ctx = { t, discover: discover.entry, all: quick?.[0] ?? null, themes: quick?.[1] ?? null, starred: quick?.[2] ?? null };
  const mine = ctx;

  render(`
    ${masthead(t)}
    ${prompt}
    <section class="desk" aria-label="桌面">
      <div class="desk-bar">
        <button class="btn sm" data-desk="add">${icon("plus")}添加小组件</button>
        <button class="btn sm ghost" data-desk="reset">恢复默认</button>
        <button class="btn sm primary" data-desk="done">完成</button>
      </div>
      <div class="desk-grid">${layoutHtml()}</div>
      <p class="desk-empty">桌面空了，点上面的“添加小组件”摆点东西吧</p>
      <div class="desk-foot"><button class="text-btn" data-desk="edit">${icon("grid")}编辑主屏幕</button><span>也可以长按任意卡片</span></div>
    </section>`);

  const desk = mountDesk(document.querySelector(".desk"), { widgets: WIDGETS, defaults: DEFAULTS, render: widget });
  document.querySelector(".desk").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const q = new FormData(ev.target).get("q")?.toString().trim();
    location.hash = q ? `#/explore?q=${encodeURIComponent(q)}` : "#/explore";
  });

  if (!quick) {
    const data = await extra.catch(() => null);
    if (!data || ctx !== mine) return;
    [ctx.all, ctx.themes, ctx.starred] = data;
    desk.refresh(Object.keys(WIDGETS).filter((id) => WIDGETS[id].late));
  }
}

function masthead(t) {
  return `<header class="mast">
    <div class="mast-meta"><span class="no">No. ${t.issue} · Etymon</span><span class="date">${cnDate(t.day)} · ${weekday(t.day)}</span></div>
    <h1 class="mast-title"><span class="seal"></span>词源一日</h1>
    <p class="mast-sub">A Word &amp; Its Story, Every Day</p>
    <div class="mast-rule"></div>
  </header>`;
}

// ---------- 组件清单 ----------

/** 快捷图标：颜色借用各专题的配色 */
const PALETTE = Object.values(THEMES).map((x) => x.color);
const APPS = {
  "app-explore": ["探索", "explore", "#/explore", 0],
  "app-routes": ["语源之路", "route", "#/explore/routes", 5],
  "app-timeline": ["时间长廊", "hourglass", "#/explore/timeline", 3],
  "app-az": ["按字母", "letters", "#/explore/az", 2],
  "app-starred": ["我的收藏", "star", "#/me/starred", 11],
  "app-history": ["阅读记录", "clock", "#/me/history", 4],
  "app-random": ["随机一词", "shuffle", "", 7],
  "app-me": ["我的", "me", "#/me", 12],
  "app-reminder": ["每日提醒", "bell", "#/me/reminder", 1],
};

/** group：组件库里的分组；late：要等词条目录 / 专题 / 收藏到了再画 */
const WIDGETS = {
  today: { name: "今天的词", desc: "今天推送的单词和它的问题", sizes: ["l", "m"], icon: "today", group: "widget", draw: wToday },
  search: { name: "搜索", desc: "搜单词、释义或故事里的内容", sizes: ["bar"], icon: "search", group: "widget", draw: wSearch },
  tomorrow: { name: "明日预告", desc: "读完今天的词，揭晓明天的问题", sizes: ["s", "m"], icon: "book", group: "widget", draw: wTomorrow },
  recall: { name: "旧词重逢", desc: "隔一段时间回想一个读过的词", sizes: ["s", "m"], icon: "spark", group: "widget", draw: wRecall },
  week: { name: "本周", desc: "这一周每天读了什么", sizes: ["m", "s"], icon: "today", group: "widget", draw: wWeek },
  discover: { name: "随手翻一页", desc: "推荐一个没读过的词，可以换", sizes: ["m", "l"], icon: "shuffle", group: "widget", draw: wDiscover },
  stats: { name: "阅读统计", desc: "读了多少、连续几天", sizes: ["s", "m"], icon: "spark", group: "widget", draw: wStats },
  kin: { name: "今天这个词的亲戚", desc: "参见、同根、同典故、衍生的词", sizes: ["m", "l"], icon: "users", group: "widget", draw: wKin },
  era: { name: "同一个世纪", desc: "和今天的词在同一个世纪起步的故事", sizes: ["m", "l"], icon: "hourglass", group: "widget", draw: wEra, late: true },
  road: { name: "同一条路", desc: "和今天的词经同一串语言来到英语", sizes: ["m", "l"], icon: "route", group: "widget", draw: wRoad, late: true },
  waiting: { name: "收藏待读", desc: "收藏了还没读完的词", sizes: ["m", "l"], icon: "star", group: "widget", draw: wWaiting, late: true },
  collect: { name: "专题进度", desc: "快集齐的专题", sizes: ["s", "m", "l"], icon: "grid", group: "widget", draw: wCollect, late: true },
  ...Object.fromEntries(
    Object.entries(APPS).map(([id, [name, ic]]) => [id, { name, desc: "快捷图标", sizes: ["icon"], icon: ic, group: "app", draw: wApp }]),
  ),
};

/** 默认的桌面：宽屏 8 列时，搜索条和四个图标在左、今天的词在右上 */
const DEFAULTS = [
  ["search", "bar"], ["today", "l"],
  ["app-explore", "icon"], ["app-routes", "icon"], ["app-timeline", "icon"], ["app-az", "icon"],
  ["week", "m"], ["recall", "s"], ["tomorrow", "s"], ["discover", "m"],
  ["kin", "m"], ["stats", "s"], ["collect", "s"], ["road", "m"], ["era", "m"], ["waiting", "m"],
  ["app-starred", "icon"], ["app-history", "icon"], ["app-random", "icon"], ["app-me", "icon"],
];

const layoutHtml = () => loadLayout(WIDGETS, DEFAULTS).map(([id, size]) => widget(id, size)).join("");

function widget(id, size) {
  const w = WIDGETS[id];
  return shell(id, size, w, w.draw(size, id));
}

const card = (cls, title, link, body, style = "") => `<div class="w-body w-card ${cls}"${style ? ` style="${style}"` : ""}>
  <div class="w-head"><h2>${title}</h2>${link ? `<a href="${link[0]}">${link[1]}${icon("right")}</a>` : ""}</div>
  ${body}
</div>`;
const quiet = (title, text) => `<div class="w-body w-card w-quiet"><div class="w-head"><h2>${title}</h2></div><p>${text}</p></div>`;
const loading = (title) => `<div class="w-body w-card w-quiet"><div class="w-head"><h2>${title}</h2></div><span class="sk"></span><span class="sk"></span></div>`;

/** 一行小词条：单词 + 问题（读过的给“一句话记住”） */
const miniRow = (x, text) => `<a class="mini" href="#/w/${esc(x.id)}" style="${tint(x)}">
  <b>${esc(x.headword)}</b><span>${text ?? rich(x.read ? x.keyline || x.meaning : x.teaser)}</span>${x.read ? `<i class="seen">已读</i>` : ""}
</a>`;

/** 没读过的排前面，同类里按日期散列打乱（每天看到的不一样） */
function pick(list, n) {
  const seed = ctx.t.day;
  const h = (s) => [...(seed + s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return [...list].sort((a, b) => Number(!!a.read) - Number(!!b.read) || h(a.id) - h(b.id)).slice(0, n);
}
const rows = (size) => (size === "l" ? 5 : 2);

// ---------- 各个组件 ----------

function wToday(size) {
  const { t } = ctx;
  const e = t.entry;
  if (!e) return quiet("今天的词", "词库里还没有词条");
  const theme = primaryTheme(e);
  const why = t.done ? "" : reasonText(t.reason);
  const line = t.done && e.keyline ? `<p class="w-q key"><small>一句话记住</small>${rich(e.keyline)}</p>` : `<p class="w-q">${rich(e.teaser)}</p>`;
  return `<a class="w-body w-cover${t.done ? " done" : ""}" href="#/w/${esc(e.id)}" style="${tint(e)}">
    ${emblem(theme)}
    <div class="w-top">${themeTag(theme)}${t.done ? `<span class="stamp">已<br>读</span>` : `<span class="mins">约 3 分钟</span>`}</div>
    ${why ? `<p class="w-why">${why}</p>` : ""}
    <div class="w-word ${sizeClass(e.headword)}"><b>${esc(e.headword)}</b><span>/${esc(e.ipa)}/ · ${esc(e.meaning)}</span></div>
    ${line}
    <span class="w-cta">${t.done ? "再看一遍" : "读这个故事"} ${icon("arrow")}</span>
  </a>`;
}

function wSearch() {
  return `<form class="w-body w-search" role="search">
    ${icon("search")}<input name="q" type="search" placeholder="搜单词、释义，或故事里的内容" autocomplete="off" enterkeyhint="search" aria-label="搜索">
  </form>`;
}

function wTomorrow() {
  const { t } = ctx;
  if (!t.done || !t.tomorrow) {
    return `<div class="w-body w-letter locked"><span class="wax">源</span><p class="label">明日预告</p><p class="q">读完今天的词，这里揭晓明天的问题</p></div>`;
  }
  return `<a class="w-body w-letter" href="#/w/${esc(t.tomorrow.id)}">
    <span class="wax">源</span><p class="label">明日预告</p><p class="q">${rich(t.tomorrow.teaser)}</p>
    <p class="hint">等不及？点开提前读 ${icon("arrow")}</p>
  </a>`;
}

function wRecall() {
  const x = ctx.t.resurface;
  if (!x) return quiet("旧词重逢", "读过的词会隔几天回到这里，帮你回想它的来历");
  return `<div class="w-body w-recall" style="${tint(x)}">
    <div class="flip" data-action="flip" role="button" tabindex="0" aria-label="翻面查看 ${esc(x.headword)} 的来历">
      <div class="face face-front">
        ${emblem(primaryTheme(x))}
        <small>旧词重逢 · ${x.ago} 天前</small>
        <b>${esc(x.headword)}</b>
        <span>还记得它的来历吗？点一下翻面</span>
      </div>
      <div class="face face-back">
        <p>${rich(x.keyline || x.meaning)}</p>
        <a href="#/w/${esc(x.id)}">重读全文 ${icon("arrow")}</a>
      </div>
    </div>
  </div>`;
}

actions.flip = (el) => el.classList.toggle("flipped");

const WEEK_CN = ["一", "二", "三", "四", "五", "六", "日"];

function wWeek(size) {
  const { t } = ctx;
  const s = t.stats;
  if (size === "s") {
    const dots = t.week
      .map((d) => `<i class="${d.entry?.read ? "on" : d.day === t.day ? "now" : ""}" ${d.entry?.read ? `style="${tint(d.entry)}"` : ""}></i>`)
      .join("");
    return `<a class="w-body w-card w-streak" href="#/me/history">
      <small>连续</small><b>${s.streak}</b><span>天</span>
      <p class="dots" aria-label="本周">${dots}</p>
    </a>`;
  }
  const cells = t.week
    .map((d, i) => {
      const isToday = d.day === t.day;
      const future = d.day > t.day;
      const x = d.entry;
      const state = future ? "future" : x?.read ? "read" : isToday ? "today" : x ? "missed" : "none";
      const mark = x?.read ? `<span class="mark" style="${tint(x)}">${esc(x.headword[0])}</span>` : `<span class="mark"></span>`;
      const inner = `<span class="wd">${WEEK_CN[i]}</span><span class="dn">${Number(d.day.slice(8))}</span>${mark}`;
      const cls = `day ${state}${isToday ? " is-today" : ""}`;
      return x && !future ? `<a class="${cls}" href="#/w/${esc(x.id)}" title="${esc(x.headword)}">${inner}</a>` : `<span class="${cls}">${inner}</span>`;
    })
    .join("");
  return card("w-week", "本周", null, `<p class="w-sub">连续 <b>${s.streak}</b> 天 · 已读 <b>${s.read}</b> / ${s.total}</p><div class="days">${cells}</div>`);
}

function wDiscover() {
  const x = ctx.discover;
  if (!x) return quiet("随手翻一页", "没读过的词都读完了，了不起");
  const theme = primaryTheme(x);
  return `<div class="w-body w-disc" style="${tint(x)}">
    ${emblem(theme)}
    <div class="w-top">${themeTag(theme)}<button class="shuffle" data-action="shuffle" data-id="${esc(x.id)}">${icon("shuffle")}换一个</button></div>
    <a class="w-disc-link" href="#/w/${esc(x.id)}">
      <p class="q">${rich(x.teaser)}</p>
      ${reasonText(x.reason) ? `<p class="why">${reasonText(x.reason)}</p>` : ""}
      <span class="w-wordline"><b>${esc(x.headword)}</b>${icon("arrow")}</span>
    </a>
  </div>`;
}

actions.shuffle = async (el) => {
  el.disabled = true;
  const { entry } = await api(`/next?shuffle=1&skip=${encodeURIComponent(el.dataset.id)}`);
  const box = el.closest(".w");
  if (!entry || !box) {
    el.disabled = false;
    return;
  }
  ctx.discover = entry;
  box.outerHTML = widget("discover", box.dataset.size);
  document.querySelector('.w[data-w="discover"] .w-disc-link')?.animate(
    [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
    { duration: 260, easing: "ease-out" },
  );
};

function wStats(size) {
  const s = ctx.t.stats;
  const pct = s.total ? Math.round((s.read / s.total) * 100) : 0;
  if (size === "s") {
    return `<a class="w-body w-card w-stats" href="#/me">
      <small>已读</small><b>${s.read}</b><span>个词 · 全书 ${pct}%</span>
      <span class="meter"><span style="width:${Math.max(pct, 2)}%"></span></span>
    </a>`;
  }
  return `<a class="w-body w-card w-stats wide" href="#/me">
    <div class="w-head"><h2>阅读统计</h2></div>
    <div class="nums"><span><b>${s.read}</b>已读</span><span><b>${s.streak}</b>天连续</span><span><b>${s.starred}</b>收藏</span><span><b>${pct}%</b>全书</span></div>
    <span class="meter"><span style="width:${Math.max(pct, 2)}%"></span></span>
  </a>`;
}

const REL = { 衍生: "衍生", 同根: "同根", 同典故: "同典故", 参见: "参见" };

function wKin(size) {
  const e = ctx.t.entry;
  if (!e) return quiet("亲戚", "");
  const kin = [...e.kin, ...e.seeAlso.map((x) => ({ ...x, rel: "参见" }))];
  if (!kin.length) return quiet("今天这个词的亲戚", `书里没给 <em>${esc(e.headword)}</em> 记下亲戚，换一天看看`);
  // 没读完今天的词之前不显示理由，免得剧透
  return card("w-kin", "今天这个词的亲戚", null, `<div class="minis">${kin
    .slice(0, rows(size))
    .map((k) => miniRow(k, `<em class="rel">${REL[k.rel]}</em>${ctx.t.done && k.why ? rich(k.why) : esc(k.meaning)}`))
    .join("")}</div>`, tint(e));
}

const selfSummary = () => ctx.all?.find((s) => s.id === ctx.t.entry?.id);
const others = () => ctx.all.filter((s) => !s.redirect && s.id !== ctx.t.entry?.id);

function wEra(size) {
  if (!ctx.all) return loading("同一个世纪");
  const self = selfSummary();
  if (!self?.era) return quiet("同一个世纪", "今天这个词的故事说不准是哪个年代，去时间长廊里逛逛吧");
  const same = others().filter((s) => s.era === self.era);
  if (!same.length) return quiet(`同在 ${eraLabel(self.era)}`, "这个世纪只有今天这一个故事");
  return card("w-era", `同在 ${eraLabel(self.era)}`, ["#/explore/timeline", "时间长廊"], `<div class="minis">${pick(same, rows(size)).map((x) => miniRow(x)).join("")}</div>`);
}

function wRoad(size) {
  if (!ctx.all) return loading("同一条路");
  const self = selfSummary();
  if (!self?.langs?.length) return quiet("同一条路", "今天这个词没标来源语言");
  const key = self.langs.join("|");
  const same = others().filter((s) => s.langs?.join("|") === key);
  const path = [...self.langs, ...(self.langs.at(-1) === "美国英语" ? [] : ["英语"])].map(esc).join(` <i aria-hidden="true">→</i> `);
  if (!same.length) return quiet("同一条路", `${path}<br>只有今天这个词走这条路`);
  const n = size === "l" ? 14 : 5;
  return card("w-road", "走同一条路来的", ["#/explore/routes", "语源之路"], `<p class="road">${path}</p>
    <div class="chips left">${pick(same, n).map((s) => `<a class="chip${s.read ? " read" : ""}" href="#/w/${esc(s.id)}" style="${tint(s)}">${esc(s.headword)}</a>`).join("")}</div>
    ${same.length > n ? `<p class="w-sub">共 ${same.length} 个</p>` : ""}`);
}

function wWaiting(size) {
  if (!ctx.starred) return loading("收藏待读");
  const list = ctx.starred.filter((x) => !x.read && x.id !== ctx.t.entry?.id);
  if (!list.length) return quiet("收藏待读", ctx.starred.length ? "收藏的词都读完了" : "读到喜欢的词点星星收藏，没读完的会排在这里");
  return card("w-wait", "收藏了还没读", ["#/me/starred", "我的收藏"], `<div class="minis">${list.slice(0, rows(size)).map((x) => miniRow(x)).join("")}</div>`);
}

function wCollect(size) {
  if (!ctx.themes) return loading("专题进度");
  // 读过一些、还没读完的，差得最少的排前面；“人名”“地名”太笼统，排在最后；都没读过就推荐词多的专题
  const vague = (x) => (x.theme === "人名" || x.theme === "地名" ? 1 : 0);
  const near = ctx.themes.filter((x) => x.read && x.read < x.count).sort((a, b) => vague(a) - vague(b) || a.count - a.read - (b.count - b.read));
  const fresh = ctx.themes.filter((x) => !x.read).sort((a, b) => vague(a) - vague(b) || b.count - a.count);
  const list = [...near, ...fresh].slice(0, size === "l" ? 7 : size === "m" ? 3 : 1);
  if (!list.length) return quiet("专题进度", "所有专题都读完了！");
  const item = (x) => `<a href="#/explore/t/${encodeURIComponent(x.theme)}" style="--t:${themeOf(x.theme).color}">
    ${emblem(x.theme)}<b>${esc(x.theme)}</b><small>${x.read ? `还差 ${x.count - x.read} 个` : `${x.count} 个词`}</small>
    <span class="meter"><span style="width:${Math.max(2, Math.round((x.read / x.count) * 100))}%"></span></span>
  </a>`;
  if (size === "s") {
    const x = list[0];
    return `<a class="w-body w-card w-medal" href="#/explore/t/${encodeURIComponent(x.theme)}" style="--t:${themeOf(x.theme).color};--p:${Math.round((x.read / x.count) * 100)}%">
      <span class="ring">${emblem(x.theme)}</span><b>${esc(x.theme)}</b><small>${x.read ? `${x.read} / ${x.count}` : `${x.count} 个词`}</small>
    </a>`;
  }
  return card("w-collect", near.length ? "快集齐的专题" : "还没逛过的专题", ["#/explore", "全部"], `<div class="collect">${list.map(item).join("")}</div>`);
}

function wApp(size, id) {
  const [name, ic, href, c] = APPS[id];
  const inner = `<span class="app-ic" style="--c:${PALETTE[c % PALETTE.length]}">${icon(ic)}</span><span class="app-name">${name}</span>`;
  return href
    ? `<a class="w-body w-app" href="${href}">${inner}</a>`
    : `<button class="w-body w-app" data-action="random-word">${inner}</button>`;
}

/** 随机一词：从没读过的词里随便挑一个打开 */
actions["random-word"] = async () => {
  const { entry } = await api(`/next?shuffle=1&skip=${encodeURIComponent(ctx?.discover?.id ?? "")}`);
  if (entry) location.hash = `#/w/${entry.id}`;
};
