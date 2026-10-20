// 今日：报头 →（读完后的提醒询问）→ 一块像手机主屏幕的桌面。
// 桌面上的小组件可以自由添加、移除、换大小、拖动排列（见 desk.js）；这里只管每个组件画什么。
// 同一个组件在不同尺寸下取舍内容：大的多给几行，小的只留最要紧的。

import { reasonText, reminderPrompt, sayBtn } from "../components.js?v=212dd6fbae";
import { actions, api, cnDate, esc, icon, local, render, rich, srcMark, weekday } from "../lib.js?v=212dd6fbae";
import { emblem, primaryTheme, THEMES, themeOf, themeTag, tint } from "../themes.js?v=212dd6fbae";
import { loadLayout, mountDesk, shell } from "../desk.js?v=212dd6fbae";
import { readMinutes } from "./entry.js?v=212dd6fbae";

/** 单词越长，字号越小 */
const sizeClass = (w) => (w.length <= 8 ? "xl" : w.length <= 13 ? "l" : "m");
const eraLabel = (c) => (c < 0 ? `公元前 ${-c} 世纪` : `${c} 世纪`);

/** 这一次首页用到的数据；词条目录、专题、收藏可能晚一点到 */
let ctx = null;

export async function viewHome() {
  // /today 和 /next 互相不依赖，一起发（原来串行，首次打开白白多一个往返）；提醒询问要看 today 的 done，等 today 回来再算
  const todayReq = api("/today");
  const nextReq = api("/next");
  nextReq.catch(() => {}); // today 先失败（比如 401）时，next 的失败没人接，别变成“未处理的拒绝”
  const t = await todayReq;
  const [discover, prompt] = await Promise.all([nextReq, t.done ? reminderPrompt() : ""]);
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
  stats: { name: "阅读统计", desc: "读了多少、连续几天", sizes: ["s", "m", "bar"], icon: "spark", group: "widget", draw: wStats },
  quiz: { name: "考考你", desc: "看“一句话记住”，猜是哪个读过的词", sizes: ["m", "l"], icon: "quiz", group: "widget", draw: wQuiz, late: true },
  board: { name: "排行榜", desc: "今天 / 这周大家各读了几个词（只露名字第一个字）", sizes: ["m", "l", "s"], icon: "users", group: "widget", draw: wBoard },
  example: { name: "今日例句", desc: "今天这个词怎么用，可以听", sizes: ["m", "s"], icon: "quote", group: "widget", draw: wExample },
  kin: { name: "今天这个词的亲戚", desc: "参见、同根、同典故、衍生的词", sizes: ["m", "l"], icon: "users", group: "widget", draw: wKin },
  era: { name: "同一个世纪", desc: "和今天的词在同一个世纪起步的故事", sizes: ["m", "l"], icon: "hourglass", group: "widget", draw: wEra, late: true },
  road: { name: "同一条路", desc: "和今天的词经同一串语言来到英语", sizes: ["m", "l"], icon: "route", group: "widget", draw: wRoad, late: true },
  waiting: { name: "收藏待读", desc: "收藏了还没读完的词", sizes: ["m", "l"], icon: "star", group: "widget", draw: wWaiting, late: true },
  collect: { name: "专题进度", desc: "快集齐的专题", sizes: ["s", "m", "l"], icon: "grid", group: "widget", draw: wCollect, late: true },
  ...Object.fromEntries(
    Object.entries(APPS).map(([id, [name, ic]]) => [id, { name, desc: "快捷图标", sizes: ["icon"], icon: ic, group: "app", draw: wApp }]),
  ),
};

/**
 * 默认的桌面：宽屏 8 列时，搜索条和四个图标在左、今天的词在右上；
 * 往下左右两半一块块配对（中号对中号、两个小号拼一块），最后一块中号旁边摞一行图标和一条统计，宽屏上不留空洞
 */
const DEFAULTS = [
  ["search", "bar"], ["today", "l"],
  ["app-explore", "icon"], ["app-routes", "icon"], ["app-timeline", "icon"], ["app-az", "icon"],
  ["week", "m"], ["recall", "s"], ["tomorrow", "s"], ["discover", "m"],
  ["kin", "m"], ["quiz", "m"],
  ["example", "s"], ["collect", "s"], ["board", "m"],
  ["road", "m"], ["era", "m"],
  ["waiting", "m"],
  ["app-starred", "icon"], ["app-history", "icon"], ["app-random", "icon"], ["app-me", "icon"], ["stats", "bar"],
];

const layoutHtml = () => loadLayout(WIDGETS, DEFAULTS).map(([id, size]) => widget(id, size)).join("");

function widget(id, size) {
  const w = WIDGETS[id];
  return shell(id, size, w, w.draw(size, id));
}

/** link：[地址, 文字] 是标题栏右边的链接；传字符串就只是一句说明 */
const card = (cls, title, link, body, style = "") => `<div class="w-body w-card ${cls}"${style ? ` style="${style}"` : ""}>
  <div class="w-head"><h2>${title}</h2>${Array.isArray(link) ? `<a href="${link[0]}">${link[1]}${icon("right")}</a>` : link ? `<span>${link}</span>` : ""}</div>
  ${body}
</div>`;

/** 没内容时：图标 + 标题 + 一句话。小格子里竖着排，扁的格子里横着排（见 CSS） */
const quiet = (title, text, ic = "spark", go = null) => `<div class="w-body w-card w-quiet"><div class="q-in">
  <span class="q-ic">${icon(ic)}</span>
  <div><h2>${title}</h2><p>${text}</p>${go ? `<a class="q-go" href="${go[0]}">${go[1]}${icon("right")}</a>` : ""}</div>
</div></div>`;
const loading = (title) => `<div class="w-body w-card w-wait-load"><div class="w-head"><h2>${title}</h2></div><span class="sk"></span><span class="sk"></span></div>`;

/** 一行小词条：单词 + 一句（没读过给问题，读过给“一句话记住”） */
const blurb = (x) => rich(x.read ? x.keyline || x.meaning : x.teaser);
const miniRow = (x, text) => `<a class="mini" href="#/w/${esc(x.id)}" style="${tint(x)}">
  <b>${esc(x.headword)}${srcMark(x)}</b><span>${text ?? blurb(x)}</span>${x.read ? `<i class="seen">已读</i>` : ""}
</a>`;
/** 大号组件的头条：单词放大，下面是完整的一句 */
const featureRow = (x, text) => `<a class="feature" href="#/w/${esc(x.id)}" style="${tint(x)}">
  ${emblem(primaryTheme(x))}<b>${esc(x.headword)}${srcMark(x)}</b><span class="m">${esc(x.meaning)}</span><p>${text ?? blurb(x)}</p>
</a>`;

/** 没读过的排前面，同类里按日期散列打乱（每天看到的不一样） */
function pick(list, n) {
  const seed = ctx.t.day;
  const h = (s) => [...(seed + s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return [...list].sort((a, b) => Number(!!a.read) - Number(!!b.read) || h(a.id) - h(b.id)).slice(0, n);
}

// ---------- 各个组件 ----------

function wToday() {
  const { t } = ctx;
  const e = t.entry;
  if (!e) return quiet("今天的词", "词库里还没有词条", "today");
  const theme = primaryTheme(e);
  const why = t.done ? "" : reasonText(t.reason);
  const line = t.done && e.keyline ? `<p class="w-q key"><small>一句话记住</small>${rich(e.keyline)}</p>` : `<p class="w-q">${rich(e.teaser)}</p>`;
  return `<a class="w-body w-cover${t.done ? " done" : ""}" href="#/w/${esc(e.id)}" style="${tint(e)}">
    ${emblem(theme)}
    <div class="w-top">${themeTag(theme)}${t.done ? `<span class="stamp">已<br>读</span>` : `<span class="mins">约 ${readMinutes(e)} 分钟</span>`}</div>
    ${why ? `<p class="w-why">${why}</p>` : ""}
    <div class="w-word ${sizeClass(e.headword)}"><b>${esc(e.headword)}</b><span>/${esc(e.ipa)}/ · ${esc(e.meaning)}</span></div>
    ${line}
    <span class="w-cta">${t.done ? "再看一遍" : "读这个故事"} ${icon("arrow")}</span>
  </a>`;
}

/** 搜索：一条胶囊输入框，下面一行“试试”的词，点了直接搜 */
const TRY = ["神话", "拉丁语", "星期", "法语", "战争", "国王", "颜色", "海", "吃", "钱", "罗马", "圣经"];
function wSearch() {
  const day = Number(ctx.t.day.replace(/-/g, ""));
  const tries = Array.from({ length: 3 }, (_, i) => TRY[(day + i * 5) % TRY.length]);
  return `<div class="w-body w-search">
    <form class="pill" role="search">${icon("search")}<input name="q" type="search" placeholder="搜单词、释义，或故事里的内容" autocomplete="off" enterkeyhint="search" aria-label="搜索"></form>
    <p class="tries"><span>试试</span>${tries.map((q) => `<a href="#/explore?q=${encodeURIComponent(q)}">${esc(q)}</a>`).join("")}</p>
  </div>`;
}

/** 明日预告：一个信封，封口压着火漆；读完今天的词才拆得开 */
function wTomorrow() {
  const { t } = ctx;
  const open = t.done && t.tomorrow;
  const inner = `<span class="flap" aria-hidden="true"></span><span class="wax">源</span>
    <div class="note"><p class="label">明日预告${open ? "" : ` · 未拆封`}</p>
    <p class="q">${open ? rich(t.tomorrow.teaser) : "读完今天的词，这封信就能拆开"}</p></div>`;
  return open
    ? `<a class="w-body w-letter" href="#/w/${esc(t.tomorrow.id)}" title="等不及？点开提前读">${inner}</a>`
    : `<div class="w-body w-letter locked">${inner}</div>`;
}

/** 旧词按这几个间隔回来（和后端 daily.ts 的 INTERVALS 一致） */
const STEPS = [3, 7, 14, 30, 60, 120, 240];

/** 间隔复习的进度条：走到第几站了 */
function recallTrack(k) {
  return `<ol class="rc-track" aria-label="间隔复习：第 ${k + 1} 站，共 ${STEPS.length} 站">${STEPS
    .map((s, i) => `<li class="${i < k ? "past" : i === k ? "now" : ""}"><span>${s}</span></li>`)
    .join("")}</ol>`;
}

function wRecall(size) {
  const x = ctx.t.resurface;
  if (!x) return quiet("旧词重逢", "读过的词隔几天会回到这里，考考你还记不记得", "clock");
  const theme = primaryTheme(x);
  // 中号是扁的：正面底下多一条间隔复习的进度，背面带上释义和来源语言
  const wide = size === "m";
  return `<div class="w-body w-recall${wide ? " wide" : ""}" style="${tint(x)}">
    <div class="flip" data-action="flip" role="button" tabindex="0" aria-label="翻面查看 ${esc(x.headword)} 的来历">
      <div class="face face-front">
        ${emblem(theme)}
        <small>旧词重逢 · ${x.ago} 天前</small>
        <b>${esc(x.headword)}</b>
        <span>还记得它的来历吗？点一下翻面</span>
        ${wide ? recallTrack(x.stage ?? 0) : ""}
      </div>
      <div class="face face-back">
        ${wide ? `<small class="rc-meta"><b>${esc(x.headword)}</b>${esc(x.meaning)}${x.langs?.length ? ` · ${esc(x.langs.join(" → "))}` : ""}</small>` : ""}
        <p>${rich(x.keyline || x.meaning)}</p>
        ${recallButtons(x)}
      </div>
    </div>
  </div>`;
}

/** 背面：记得 / 忘了。记得就推后下次见面，忘了明天再来；今天点过的显示结果 */
function recallButtons(x) {
  if (x.reviewed) {
    const when = x.due ? daysUntil(x.due) : 0;
    return `<div class="rc-done">${x.reviewed === "ok" ? `${icon("check")}记得，${when} 天后再见` : "明天再来考你一次"}<a href="#/w/${esc(x.id)}">重读${icon("right")}</a></div>`;
  }
  return `<div class="rc-acts">
    <button data-action="recall" data-id="${esc(x.id)}" data-ok="1">${icon("check")}记得</button>
    <button data-action="recall" data-id="${esc(x.id)}" data-ok="0">忘了</button>
    <a href="#/w/${esc(x.id)}">重读${icon("right")}</a>
  </div>`;
}

const daysUntil = (day) => Math.max(1, Math.round((Date.parse(day) - Date.parse(ctx.t.day)) / 86_400_000));

actions.recall = async (el, ev) => {
  ev?.stopPropagation?.();
  const box = el.closest(".w");
  const x = ctx.t.resurface;
  if (!box || !x) return;
  for (const b of box.querySelectorAll("[data-action=recall]")) b.disabled = true;
  const ok = el.dataset.ok === "1";
  const r = await api(`/entries/${encodeURIComponent(el.dataset.id)}/review`, { method: "POST", body: { ok } }).catch(() => null);
  if (!r) {
    for (const b of box.querySelectorAll("[data-action=recall]")) b.disabled = false;
    return;
  }
  Object.assign(x, { reviewed: ok ? "ok" : "no", due: r.dueDay, stage: r.stage });
  box.outerHTML = widget("recall", box.dataset.size);
  // 重画后保持翻在背面
  document.querySelector('.w[data-w="recall"] .flip')?.classList.add("flipped");
};

actions.flip = (el, ev) => {
  // 背面的按钮、链接自己处理，不翻回去
  if (ev?.target?.closest?.("button, a")) return;
  el.classList.toggle("flipped");
};

const WEEK_CN = ["一", "二", "三", "四", "五", "六", "日"];

function wWeek(size) {
  const { t } = ctx;
  const s = t.stats;
  if (size === "s") {
    const dots = t.week
      .map((d, i) => `<i class="${d.entry?.read ? "on" : d.day === t.day ? "now" : ""}" ${d.entry?.read ? `style="${tint(d.entry)}"` : ""}><em>${WEEK_CN[i]}</em></i>`)
      .join("");
    return `<a class="w-body w-card w-streak" href="#/me/history">
      <small>连续阅读</small>
      <p class="num"><b>${s.streak}</b><span>天</span></p>
      <p class="dots" aria-label="本周">${dots}</p>
    </a>`;
  }
  const p = t.progress ?? { today: 0, goal: 1, repair: null, patched: [] };
  const patched = new Set(p.patched);
  const cells = t.week
    .map((d, i) => {
      const isToday = d.day === t.day;
      const future = d.day > t.day;
      const x = d.entry;
      // 补签的那天：没读推送的词，但第二天多读补上了
      const fixed = !x?.read && patched.has(d.day);
      const state = future ? "future" : x?.read ? "read" : fixed ? "patched" : isToday ? "today" : x ? "missed" : "none";
      const mark = x?.read ? `<span class="mark" style="${tint(x)}">${esc(x.headword[0])}</span>` : fixed ? `<span class="mark" title="补签">补</span>` : `<span class="mark"></span>`;
      // 格子高的时候，读过的那天下面写上读的是哪个词
      const word = x?.read ? `<span class="ww" style="${tint(x)}">${esc(x.headword)}</span>` : `<span class="ww"></span>`;
      const inner = `<span class="wd">${WEEK_CN[i]}</span><span class="dn">${Number(d.day.slice(8))}</span>${mark}${word}`;
      const cls = `day ${state}${isToday ? " is-today" : ""}`;
      return x && !future ? `<a class="${cls}" href="#/w/${esc(x.id)}" title="${esc(x.headword)}"${x.read ? ` style="${tint(x)}"` : ""}>${inner}</a>` : `<span class="${cls}">${inner}</span>`;
    })
    .join("");
  // 底下一行：左边今日目标；右边昨天漏了怎么补，或者今天读没读（没读就给个入口）
  const e = t.entry;
  const r = p.repair;
  const now = r && !r.repaired
    ? `<span class="fix">昨天漏了，今天读满 ${r.need} 个可补签</span>`
    : t.done || !e
      ? `<span class="ok">${icon("check")}${r?.repaired ? "昨天已补签" : "今天读完了"}</span>`
      : `<a href="#/w/${esc(e.id)}">去读今天的 <em>${esc(e.headword)}</em>${icon("right")}</a>`;
  const goal = `<span class="goal${p.today >= p.goal ? " met" : ""}">今日 <b>${p.today}</b>/${p.goal} 个${p.today >= p.goal ? icon("check") : ""}</span>`;
  return `<div class="w-body w-card w-week">
    <div class="w-head"><h2>本周</h2><span>连续 <b>${s.streak}</b> 天 · 已读 <b>${s.read}</b></span></div>
    <div class="days">${cells}</div>
    <p class="wk-foot">${goal}${now}</p>
  </div>`;
}

function wDiscover(size) {
  const x = ctx.discover;
  if (!x) return quiet("随手翻一页", "没读过的词都读完了，了不起", "shuffle");
  const theme = primaryTheme(x);
  const why = reasonText(x.reason);
  return `<div class="w-body w-disc" style="${tint(x)}">
    ${emblem(theme)}
    <div class="w-top">${themeTag(theme)}<button class="shuffle" data-action="shuffle" data-id="${esc(x.id)}">${icon("shuffle")}换一个</button></div>
    <a class="w-disc-link" href="#/w/${esc(x.id)}">
      ${size === "l" ? `<span class="quote" aria-hidden="true">“</span>` : ""}
      <p class="q">${rich(x.teaser)}</p>
      ${why ? `<p class="why">${why}</p>` : ""}
      <span class="w-wordline"><b>${esc(x.headword)}${srcMark(x)}</b>${size === "l" ? `<span class="m">${esc(x.meaning)}</span>` : ""}${icon("arrow")}</span>
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
  const bar = `<span class="meter"><span style="width:${Math.max(pct, 2)}%"></span></span>`;
  if (size === "s") {
    return `<a class="w-body w-card w-stats" href="#/me">
      <small>已读</small><p class="num"><b>${s.read}</b><span>个词</span></p>${bar}<span class="pct">全书 ${pct}%</span>
    </a>`;
  }
  if (size === "bar") {
    // 一条：左边大数字，中间进度，右边连续和收藏
    return `<a class="w-body w-card w-stats strip" href="#/me">
      <p class="num"><b>${s.read}</b><span>个词<br>已读</span></p>
      <div class="mid">${bar}<span class="pct">全书 ${pct}% · 还有 ${s.total - s.read} 个没读</span></div>
      <ul><li><b>${s.streak}</b>天连续</li><li><b>${s.starred}</b>个收藏</li></ul>
    </a>`;
  }
  return `<a class="w-body w-card w-stats wide" href="#/me">
    <div class="big"><small>已读</small><p class="num"><b>${s.read}</b><span>个词</span></p>${bar}<span class="pct">全书 ${s.total} 个词的 ${pct}%</span></div>
    <ul><li><b>${s.streak}</b>天连续</li><li><b>${s.starred}</b>个收藏</li><li><b>${s.total - s.read}</b>个没读</li></ul>
  </a>`;
}

const REL = { 衍生: "衍生", 同根: "同根", 同典故: "同典故", 参见: "参见", 相关: "相关" };

/** 量一下单词在图里有多宽（和 CSS 里 .w-kinmap text 同一个字体）；字体还没加载好时按偏宽的估计兜底 */
let measureCtx = null;
function textWidth(text, px) {
  const guess = text.length * px * 0.62;
  try {
    measureCtx ??= document.createElement("canvas").getContext("2d");
    const family = getComputedStyle(document.documentElement).getPropertyValue("--display").trim() || "serif";
    measureCtx.font = `italic 600 ${px}px ${family}`;
    return Math.max(measureCtx.measureText(text).width, guess * 0.85);
  } catch {
    return guess;
  }
}

/**
 * 小关系图：今天的词单独占中间一行，亲戚分在上下两侧一行行排开，再用虚线连到中间。
 * 以前是沿椭圆摆、胶囊宽度靠估算，长一点的词（左右两侧尤其）就会和中间那个叠在一起；
 * 现在每个胶囊按实际字宽算，一行放不下就换行，中间一行只有今天的词，怎么都不会重叠。
 * tall：中号左边那块近乎方形，画布窄一些。
 */
function kinMap(e, kin, tall = false) {
  const W = tall ? 230 : 300;
  const GAP = 10, ROW = 38, PAD = 8, PH = 24, MAXW = W - PAD * 2;
  const cut = (t) => (t.length > 16 ? t.slice(0, 15) + "…" : t);
  const pillW = (t, px) => Math.min(MAXW, Math.ceil(textWidth(t, px)) + 24);
  const nodes = kin.map((k) => ({ k, text: cut(k.headword), w: pillW(cut(k.headword), 12.5) }));
  // 先上下对半分，各自按宽度装行（一行装不下就另起一行）
  const pack = (list) => {
    const rows = [];
    for (const n of list) {
      const last = rows.at(-1);
      if (last && last.w + GAP + n.w <= MAXW) {
        last.items.push(n);
        last.w += GAP + n.w;
      } else rows.push({ items: [n], w: n.w });
    }
    return rows;
  };
  const top = pack(nodes.filter((_, i) => i % 2 === 0));
  const bottom = pack(nodes.filter((_, i) => i % 2 === 1));
  const H = PAD * 2 + (top.length + bottom.length + 1) * ROW;
  const cx = W / 2;
  const cy = PAD + top.length * ROW + ROW / 2;
  const placed = [];
  const lay = (rows, y0, dir) =>
    rows.forEach((r, ri) => {
      const y = y0 + dir * (ri + 1) * ROW;
      let x = cx - r.w / 2;
      for (const n of r.items) {
        placed.push({ ...n, x: x + n.w / 2, y });
        x += n.w + GAP;
      }
    });
  // 上面的行从中间往上数，第一行贴着中间
  lay(top, cy, -1);
  lay(bottom, cy, 1);
  const pill = (x, y, w, text, cls) =>
    `<rect x="${(x - w / 2).toFixed(1)}" y="${y - PH / 2}" width="${w}" height="${PH}" rx="${PH / 2}" class="${cls}"/><text x="${x.toFixed(1)}" y="${y + 4.5}">${esc(text)}</text>`;
  const ctext = cut(e.headword);
  const cw = pillW(ctext, 13.5);
  return `<svg class="w-kinmap" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    ${placed.map((n) => `<line x1="${cx}" y1="${cy}" x2="${n.x.toFixed(1)}" y2="${n.y}"/>`).join("")}
    ${placed.map((n) => `<g class="node" style="${tint(n.k)}">${pill(n.x, n.y, n.w, n.text, "p")}</g>`).join("")}
    <g class="center">${pill(cx, cy, cw, ctext, "p")}</g>
  </svg>`;
}

function wKin(size) {
  const e = ctx.t.entry;
  if (!e) return quiet("今天这个词的亲戚", "", "users");
  const kin = [...e.kin, ...e.seeAlso.map((x) => ({ ...x, rel: "参见" }))];
  // 书里记下的亲戚只有一两个时，接着放“相关的词”（同专题、同语源），格子不至于空一半
  const near = (e.related ?? []).filter((r) => r.id !== e.id && !kin.some((k) => k.id === r.id)).map((x) => ({ ...x, rel: "相关" }));
  if (!kin.length && !near.length) return quiet("今天这个词的亲戚", `书里没给 <em>${esc(e.headword)}</em> 记下亲戚，换一天看看`, "users");
  // 没读完今天的词之前不显示理由，免得剧透
  const line = (k) => `<em class="rel">${REL[k.rel]}</em>${ctx.t.done && k.why ? rich(k.why) : esc(k.meaning)}`;
  const title = kin.length ? "今天这个词的亲戚" : "和今天这个词相关的";
  // 关系图：大号放在上面；中号够宽（电脑上）时放在左边，手机上的中号放不下就藏起来（见 CSS）
  const map = `<div class="kin-map-box">${kinMap(e, (kin.length ? kin : near).slice(0, 6), size !== "l")}</div>`;
  const rows = [...kin, ...near].slice(0, 8).map((k) => miniRow(k, line(k))).join("");
  return card(`w-kin${size === "l" ? " big" : ""}`, title, kin.length ? `${kin.length} 个` : "", `<div class="kin-body">${map}<div class="minis fit">${rows}</div></div>`);
}

const selfSummary = () => ctx.all?.find((s) => s.id === ctx.t.entry?.id);
const others = () => ctx.all.filter((s) => !s.redirect && s.id !== ctx.t.entry?.id);

/** 同一个世纪：大号的世纪数字是这个组件的主角 */
function wEra(size) {
  if (!ctx.all) return loading("同一个世纪");
  const self = selfSummary();
  if (!self?.era) return quiet("同一个世纪", "今天这个词的故事说不准始于哪个年代，去时间长廊里逛逛", "hourglass");
  const same = others().filter((s) => s.era === self.era);
  const bc = self.era < 0;
  const big = `<div class="era-big"><small>${bc ? "公元前" : "同在"}</small><b>${Math.abs(self.era)}</b><span>世纪</span></div>`;
  // 这个世纪的故事不够填满，就补上前后一个世纪的，标明是哪个世纪；放得下几行由 fitRows 按格子高度定
  const list = pick(same, 8);
  const near = list.length >= 8 ? [] : pick(others().filter((s) => s.era && Math.abs(s.era - self.era) === 1), 8 - list.length);
  if (!same.length && !near.length) return `<div class="w-body w-card w-era">${big}<div class="era-list"><p class="alone">这个世纪只有今天这一个故事</p></div></div>`;
  if (size === "l") {
    return `<div class="w-body w-card w-era big">
      <div class="era-band">${big}<a href="#/explore/timeline">这个世纪共 ${same.length + 1} 个故事${icon("right")}</a></div>
      <div class="era-list minis fit">${list.map((x) => miniRow(x)).join("")}
        ${near.length ? `<p class="fit-sep era-near">${list.length ? "前后一个世纪" : "这个世纪只有它，看看前后一个世纪"}</p>${near.map((x) => miniRow(x, `<em class="rel">${eraLabel(x.era)}</em>${blurb(x)}`)).join("")}` : ""}
      </div>
    </div>`;
  }
  const row = (x, note = "") => `<span class="era-row" style="${tint(x)}"><b>${esc(x.headword)}${note ? `<em>${note}</em>` : ""}</b><span>${esc(x.meaning)}</span></span>`;
  return `<a class="w-body w-card w-era" href="#/explore/timeline">${big}
    <div class="era-list fit">${list.map((x) => row(x)).join("")}${near.map((x) => row(x, eraLabel(x.era))).join("")}</div>
  </a>`;
}

/** 同一条路：上面一串语言节点，下面是走这条路的词 */
function wRoad(size) {
  if (!ctx.all) return loading("同一条路");
  const self = selfSummary();
  if (!self?.langs?.length) return quiet("同一条路", "今天这个词没有标来源语言", "route");
  const key = self.langs.join("|");
  const same = others().filter((s) => s.langs?.join("|") === key);
  // 美国英语本身就是英语，路线不再接“英语”；“其他”说清楚是别的语言
  const hops = [...self.langs, ...(self.langs.at(-1) === "美国英语" ? [] : ["英语"])].map((l) => (l === "其他" ? "其他语言" : l));
  const route = `<ol class="hops" style="--n:${hops.length}">${hops
    .map((l, i) => `<li${i === hops.length - 1 ? ` class="end"` : ""}><span>${esc(l)}</span></li>`)
    .join("")}${hops.length === 1 ? `<li class="native"><span>土生土长</span></li>` : ""}</ol>`;
  const link = ["#/explore/routes", same.length ? `共 ${same.length + 1} 个` : "语源之路"];
  // 走完全相同一条路的词常常只有几个：后面接着放“同一个起点出发、路线不同”的词，标个小标题
  const mates = pick(others().filter((s) => s.langs?.[0] === self.langs[0] && s.langs.join("|") !== key), 12);
  const sep = mates.length ? `<p class="fit-sep">${same.length ? "同样" : "没有别的词走这条路，"}从${esc(hops[0])}出发的</p>` : "";
  const title = same.length ? "走同一条路来的" : "走这条路来的";
  if (!same.length && !mates.length) return card("w-road", title, link, `${route}<p class="alone">只有今天这个词走这条路</p>`);
  if (size === "l") {
    return card("w-road big", title, link, `${route}<div class="minis fit">${pick(same, 12).map((x) => miniRow(x)).join("")}${sep}${mates.map((x) => miniRow(x)).join("")}</div>`);
  }
  // 中号：单词 + 释义排成两三栏
  const chip = (s) => `<a class="rchip" href="#/w/${esc(s.id)}" style="${tint(s)}"><b>${esc(s.headword)}</b><span>${esc(s.meaning)}</span></a>`;
  const cell = mates.length ? `<p class="fit-sep rsep">${same.length ? "同样" : "没有别的词走这条路，"}从<b>${esc(hops[0])}</b>出发${icon("right")}</p>` : "";
  return card("w-road", title, link, `${route}<div class="road-grid fit">${pick(same, 12).map(chip).join("")}${cell}${mates.map(chip).join("")}</div>`);
}

function wWaiting(size) {
  if (!ctx.starred) return loading("收藏待读");
  if (!ctx.starred.length) return quiet("收藏待读", "读到喜欢的词点星星收藏，没读完的会排在这里", "star", ["#/explore", "去探索找找"]);
  const list = ctx.starred.filter((x) => !x.read && x.id !== ctx.t.entry?.id);
  // 待读的排完了还有地方，就接着放读过的收藏，带上“一句话记住”，顺便温习
  const seen = ctx.starred.filter((x) => x.read).slice(0, 8).map((x) => miniRow(x)).join("");
  if (!list.length) return card("w-wait", "收藏的词都读完了", ["#/me/starred", `${ctx.starred.length} 个`], `<div class="minis fit">${seen}</div>`);
  const link = ["#/me/starred", `${list.length} 个待读`];
  const more = seen ? `<p class="fit-sep">读过的收藏</p>${seen}` : "";
  if (size === "l") {
    const [first, ...rest] = list;
    return card("w-wait big", "收藏了还没读", link, `${featureRow(first)}<div class="minis fit">${rest.slice(0, 8).map((x) => miniRow(x)).join("")}${more}</div>`);
  }
  return card("w-wait", "收藏了还没读", link, `<div class="minis fit">${list.slice(0, 8).map((x) => miniRow(x)).join("")}${more}</div>`);
}

/** 专题进度：每个专题一枚纹章，外圈是进度 */
function wCollect(size) {
  if (!ctx.themes) return loading("专题进度");
  // 读过一些、还没读完的，差得最少的排前面；“人名”“地名”太笼统，排在最后；都没读过就推荐词多的专题
  const vague = (x) => (x.theme === "人名" || x.theme === "地名" ? 1 : 0);
  const near = ctx.themes.filter((x) => x.read && x.read < x.count).sort((a, b) => vague(a) - vague(b) || a.count - a.read - (b.count - b.read));
  const fresh = ctx.themes.filter((x) => !x.read).sort((a, b) => vague(a) - vague(b) || b.count - a.count);
  // 多给几枚，一行 / 几行放得下多少由 fitRows 按格子大小定
  const list = [...near, ...fresh].slice(0, size === "l" ? 12 : size === "m" ? 6 : 1);
  if (!list.length) return quiet("专题进度", "所有专题都读完了！", "grid");
  const medal = (x) => `<a class="medal-mini" href="#/explore/t/${encodeURIComponent(x.theme)}" style="--t:${themeOf(x.theme).color};--p:${Math.round((x.read / x.count) * 100)}%">
    <span class="ring">${emblem(x.theme)}</span><b>${esc(x.theme)}</b><small>${x.read ? `还差 ${x.count - x.read}` : `${x.count} 个词`}</small>
  </a>`;
  if (size === "s") return `<div class="w-body w-card w-collect one">${medal(list[0])}</div>`;
  const lit = ctx.themes.filter((x) => x.read).length;
  return card(`w-collect${size === "l" ? " big" : ""}`, near.length ? "快集齐的专题" : "还没逛过的专题", ["#/explore", `点亮 ${lit} / ${ctx.themes.length}`], `<div class="medals-row fit">${list.map(medal).join("")}</div>`);
}

// ---------- 考考你 ----------

/** 今天第几题、答对几题；换了一天重新数 */
const quiz = { day: "", n: 0, right: 0, done: 0 };
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 把“一句话记住”里的这个词挖掉，免得一眼看出答案 */
const masked = (x) => x.keyline.replace(new RegExp(escRe(x.headword), "gi"), "＿＿");

/** 出一道题：从读过的词里按日期 + 题号挑一个当答案，再挑几个读过的词当干扰项 */
function quizItem(n) {
  // 待核对的新词不出题（答案本身可能不对）
  const pool = ctx.all.filter((x) => x.read && x.keyline && !x.redirect && x.src !== "ai");
  if (pool.length < 3) return null;
  // FNV-1a：题号只差一位，排出来的顺序也要完全不同（乘 31 累加的那种散列，前缀变了顺序几乎不变）
  const seed = `${ctx.t.day}#${quiz.n}`;
  const h = (s) => {
    let x = 2166136261;
    for (const c of seed + s) x = Math.imul(x ^ c.charCodeAt(0), 16777619);
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
    return (x ^ (x >>> 13)) >>> 0;
  };
  const [answer, ...rest] = [...pool].sort((a, b) => h(a.id) - h(b.id));
  const opts = [answer, ...rest.slice(0, n - 1)].sort((a, b) => h(a.headword) - h(b.headword));
  return { answer, opts };
}

function wQuiz(size) {
  if (!ctx.all) return loading("考考你");
  if (quiz.day !== ctx.t.day) Object.assign(quiz, { day: ctx.t.day, n: 0, right: 0, done: 0 });
  const q = quizItem(size === "l" ? 4 : 3);
  if (!q) return quiet("考考你", "读满 3 个词就能出题，考考自己还记不记得", "quiz");
  const score = quiz.done ? `今天答对 <b>${quiz.right}</b> / ${quiz.done}` : "哪个词的来历是这样？";
  return `<div class="w-body w-card w-quiz" data-answer="${esc(q.answer.id)}">
    <div class="w-head"><h2>考考你</h2><span class="qz-score">${score}</span></div>
    <div class="qz-qbox"><p class="qz-q">${rich(masked(q.answer))}</p></div>
    <div class="qz-opts">${q.opts.map((o) => `<button class="qz-opt" data-action="quiz" data-id="${esc(o.id)}" style="${tint(o)}">${esc(o.headword)}</button>`).join("")}</div>
    <p class="qz-res"><span>题目出自你读过的 ${ctx.t.stats.read} 个词${size === "l" ? "，答完揭晓原句" : ""}</span></p>
  </div>`;
}

actions.quiz = (el) => {
  const box = el.closest(".w-quiz");
  if (!box || box.classList.contains("answered")) return;
  const id = box.dataset.answer;
  const x = ctx.all?.find((s) => s.id === id);
  const ok = el.dataset.id === id;
  quiz.done++;
  if (ok) quiz.right++;
  box.classList.add("answered", ok ? "ok" : "no");
  for (const b of box.querySelectorAll(".qz-opt")) {
    b.disabled = true;
    b.classList.toggle("right", b.dataset.id === id);
  }
  if (!ok) el.classList.add("wrong");
  if (x) box.querySelector(".qz-q").innerHTML = rich(x.keyline);
  // 答对答错都记一次复习：答错的词很快会在“旧词重逢”里再见
  api(`/entries/${encodeURIComponent(id)}/review`, { method: "POST", body: { ok } }).catch(() => {});
  box.querySelector(".qz-score").innerHTML = `今天答对 <b>${quiz.right}</b> / ${quiz.done}`;
  box.querySelector(".qz-res").innerHTML = `<span class="verdict">${icon(ok ? "check" : "close")}${ok ? "答对了" : `是 <em>${esc(x?.headword ?? "")}</em>`}</span>
    <a href="#/w/${esc(id)}">重读${icon("right")}</a><button class="next" data-action="quiz-next">下一题${icon("arrow")}</button>`;
};

actions["quiz-next"] = (el) => {
  const box = el.closest(".w");
  if (!box) return;
  quiz.n++;
  box.outerHTML = widget("quiz", box.dataset.size);
  document.querySelector('.w[data-w="quiz"] .qz-q')?.animate(
    [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
    { duration: 260, easing: "ease-out" },
  );
};

// ---------- 今日例句 ----------

/** 今天这个词的例句：英文可以点着听，下面是中文；放得下几句给几句 */
function wExample(size) {
  const e = ctx.t.entry;
  const list = e?.examples ?? [];
  if (!list.length) return quiet("今日例句", e ? `书里没给 <em>${esc(e.headword)}</em> 配例句` : "", "quote");
  if (size === "s") {
    // 小号只放一句（每天换一句），朗读按钮放在标题栏
    const x = list[Number(ctx.t.day.slice(8)) % list.length];
    return `<div class="w-body w-card w-ex small" style="${tint(e)}">
      <div class="w-head"><h2>今日例句</h2>${sayBtn(x.en, "icon-btn sm")}</div>
      <ol class="ex-list"><li><p class="ex-en"><span>${rich(x.en)}</span></p><p class="ex-zh">${esc(x.zh)}</p></li></ol>
    </div>`;
  }
  const li = (x) => `<li><p class="ex-en"><span>${rich(x.en)}</span>${sayBtn(x.en, "icon-btn sm")}</p><p class="ex-zh">${esc(x.zh)}</p></li>`;
  return `<div class="w-body w-card w-ex" style="${tint(e)}">
    <div class="w-head"><h2>今日例句</h2><a href="#/w/${esc(e.id)}"><em>${esc(e.headword)}</em>${icon("right")}</a></div>
    <ol class="ex-list fit">${list.map(li).join("")}</ol>
  </div>`;
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

// ---------- 排行榜 ----------

/** 今天 / 本周；切换后记在这台设备上 */
let boardRange = local.get("board-range", "day") === "week" ? "week" : "day";
let boardBusy = false;

/** 排行榜单独取（摆上桌面才取）；到了只重画它。切换范围时先留着旧的，新的到了再换 */
function loadBoard() {
  const mine = ctx;
  boardBusy = true;
  api(`/board?range=${boardRange}`)
    .catch(() => false)
    .then((b) => {
      boardBusy = false;
      if (ctx !== mine) return;
      ctx.board = b;
      const el = document.querySelector('.w[data-w="board"]');
      if (el) el.outerHTML = widget("board", el.dataset.size);
    });
}

const RANGE = { day: "今天", week: "本周" };

function wBoard(size) {
  if (ctx.board === undefined && !boardBusy) loadBoard();
  if (ctx.board === undefined) return loading("排行榜");
  if (!ctx.board) return quiet("排行榜", "暂时取不到排行，联网后再看看", "users");
  if (ctx.board.off) return quiet("排行榜", "你在“我的”里关掉了排行榜，别人的榜上也看不到你", "users", ["#/me", "去打开"]);
  const { rows, range } = ctx.board;
  const me = rows.find((r) => r.me);
  const when = RANGE[range];
  const lead = rows[0];
  // 底下一句：我的名次；没人读时鼓励抢第一
  const tied = me && rows.filter((r) => r.rank === me.rank).length > 1;
  const mine = !lead?.n
    ? `${when}还没人读，读一个就是第一`
    : me?.n
      ? `你${when}读了 <b>${me.n}</b> 个 · 第 <b>${me.rank}</b> 名${tied ? "（并列）" : ""}`
      : `你${when}还没读，读一个就能上榜`;

  if (size === "s") {
    return `<div class="w-body w-card w-board one">
      <small>${when}排行 · ${rows.length} 人</small>
      <p class="num">${me?.n ? `<span>第</span><b>${me.rank}</b><span>名</span>` : `<b>—</b>`}</p>
      <p class="sub">${me?.n ? `读了 ${me.n} 个词` : "还没上榜"}</p>
      ${lead?.n ? `<p class="lead"><span class="rk r1">1</span>${esc(lead.name)} · ${lead.n} 个</p>` : ""}
    </div>`;
  }
  const max = Math.max(1, ...rows.map((r) => r.n));
  const row = (r) => `<li class="br${r.me ? " me" : ""}${r.n ? "" : " zero"}">
    <span class="rk${r.n && r.rank <= 3 ? ` r${r.rank}` : ""}">${r.rank}</span>
    <span class="who"><b>${esc(r.name)}${r.me ? `<i>我</i>` : ""}</b>${size === "l" ? `<small>连续 ${r.streak} 天</small>` : ""}</span>
    <span class="bar"><span style="width:${r.n ? Math.max(6, (r.n / max) * 100) : 0}%"></span></span>
    <span class="n">${r.n}</span>
  </li>`;
  const seg = `<span class="seg" role="group" aria-label="排行范围">${Object.entries(RANGE)
    .map(([k, v]) => `<button data-action="board-range" data-range="${k}" aria-pressed="${k === range}">${v}</button>`)
    .join("")}</span>`;
  return `<div class="w-body w-card w-board${size === "l" ? " big" : ""}">
    <div class="w-head"><h2>排行榜</h2>${seg}</div>
    <ol class="board fit">${rows.map(row).join("")}</ol>
    ${size === "l" ? myWeek(ctx.board) : ""}
    <p class="board-me">${mine}</p>
  </div>`;
}

/** 大号底下：自己近 7 天每天读了几个，一天一根小柱子，今天那根用强调色 */
function myWeek({ mine, day }) {
  if (!mine?.length) return "";
  const max = Math.max(1, ...mine.map((d) => d.n));
  const label = (d) => (d === day ? "今" : WEEK_CN[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7]);
  return `<div class="board-mine">
    <small>我这 7 天 · 共 <b>${mine.reduce((a, d) => a + d.n, 0)}</b> 个</small>
    <div class="cols">${mine
      .map((d) => `<span class="${d.day === day ? "now" : ""}" title="${d.day} · ${d.n} 个"><b>${d.n || ""}</b><i style="--h:${(d.n / max) * 100}%"></i><em>${label(d.day)}</em></span>`)
      .join("")}</div>
  </div>`;
}

actions["board-range"] = (el) => {
  if (el.getAttribute("aria-pressed") === "true" || boardBusy) return;
  boardRange = el.dataset.range === "week" ? "week" : "day";
  local.set("board-range", boardRange);
  for (const b of el.parentElement.children) b.setAttribute("aria-pressed", String(b === el));
  loadBoard();
};
