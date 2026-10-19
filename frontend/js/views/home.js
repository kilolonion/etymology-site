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
  <b>${esc(x.headword)}</b><span>${text ?? blurb(x)}</span>${x.read ? `<i class="seen">已读</i>` : ""}
</a>`;
/** 大号组件的头条：单词放大，下面是完整的一句 */
const featureRow = (x, text) => `<a class="feature" href="#/w/${esc(x.id)}" style="${tint(x)}">
  ${emblem(primaryTheme(x))}<b>${esc(x.headword)}</b><span class="m">${esc(x.meaning)}</span><p>${text ?? blurb(x)}</p>
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
    <div class="w-top">${themeTag(theme)}${t.done ? `<span class="stamp">已<br>读</span>` : `<span class="mins">约 3 分钟</span>`}</div>
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

function wRecall() {
  const x = ctx.t.resurface;
  if (!x) return quiet("旧词重逢", "读过的词隔几天会回到这里，考考你还记不记得", "clock");
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
      .map((d, i) => `<i class="${d.entry?.read ? "on" : d.day === t.day ? "now" : ""}" ${d.entry?.read ? `style="${tint(d.entry)}"` : ""}><em>${WEEK_CN[i]}</em></i>`)
      .join("");
    return `<a class="w-body w-card w-streak" href="#/me/history">
      <small>连续阅读</small>
      <p class="num"><b>${s.streak}</b><span>天</span></p>
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
      // 格子高的时候，读过的那天下面写上读的是哪个词
      const word = x?.read ? `<span class="ww" style="${tint(x)}">${esc(x.headword)}</span>` : `<span class="ww"></span>`;
      const inner = `<span class="wd">${WEEK_CN[i]}</span><span class="dn">${Number(d.day.slice(8))}</span>${mark}${word}`;
      const cls = `day ${state}${isToday ? " is-today" : ""}`;
      return x && !future ? `<a class="${cls}" href="#/w/${esc(x.id)}" title="${esc(x.headword)}">${inner}</a>` : `<span class="${cls}">${inner}</span>`;
    })
    .join("");
  return `<div class="w-body w-card w-week">
    <div class="w-head"><h2>本周</h2><span>连续 <b>${s.streak}</b> 天 · 已读 <b>${s.read}</b></span></div>
    <div class="days">${cells}</div>
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
      <span class="w-wordline"><b>${esc(x.headword)}</b>${size === "l" ? `<span class="m">${esc(x.meaning)}</span>` : ""}${icon("arrow")}</span>
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
  return `<a class="w-body w-card w-stats wide" href="#/me">
    <div class="big"><small>已读</small><p class="num"><b>${s.read}</b><span>个词</span></p>${bar}<span class="pct">全书 ${s.total} 个词的 ${pct}%</span></div>
    <ul><li><b>${s.streak}</b>天连续</li><li><b>${s.starred}</b>个收藏</li><li><b>${s.total - s.read}</b>个没读</li></ul>
  </a>`;
}

const REL = { 衍生: "衍生", 同根: "同根", 同典故: "同典故", 参见: "参见" };

/** 小关系图：今天的词在中间，亲戚围一圈 */
function kinMap(e, kin) {
  const W = 300, H = 132, cx = W / 2, cy = H / 2;
  // 一两个亲戚时斜着摆（左上、右下），多了沿椭圆均匀排开
  const start = kin.length <= 2 ? (-5 * Math.PI) / 6 : -Math.PI / 2;
  const pos = kin.map((_, i) => {
    const a = start + (i * 2 * Math.PI) / kin.length;
    return [cx + 108 * Math.cos(a), cy + 48 * Math.sin(a)];
  });
  const pill = (x, y, text, cls) => {
    const w = Math.min(120, text.length * 8 + 20);
    return `<rect x="${x - w / 2}" y="${y - 12}" width="${w}" height="24" rx="12" class="${cls}"/><text x="${x}" y="${y + 4.5}">${esc(text)}</text>`;
  };
  return `<svg class="w-kinmap" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    ${pos.map(([x, y]) => `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}"/>`).join("")}
    ${pos.map(([x, y], i) => `<g class="node" style="${tint(kin[i])}">${pill(x, y, kin[i].headword, "p")}</g>`).join("")}
    <g class="center">${pill(cx, cy, e.headword, "p")}</g>
  </svg>`;
}

function wKin(size) {
  const e = ctx.t.entry;
  if (!e) return quiet("今天这个词的亲戚", "", "users");
  const kin = [...e.kin, ...e.seeAlso.map((x) => ({ ...x, rel: "参见" }))];
  if (!kin.length) return quiet("今天这个词的亲戚", `书里没给 <em>${esc(e.headword)}</em> 记下亲戚，换一天看看`, "users");
  // 没读完今天的词之前不显示理由，免得剧透
  const line = (k) => `<em class="rel">${REL[k.rel]}</em>${ctx.t.done && k.why ? rich(k.why) : esc(k.meaning)}`;
  if (size === "l") {
    const shown = kin.slice(0, 6);
    return card("w-kin big", "今天这个词的亲戚", `${kin.length} 个`, `<div class="kin-map-box">${kinMap(e, shown)}</div><div class="minis">${kin.slice(0, 3).map((k) => miniRow(k, line(k))).join("")}</div>`);
  }
  // 放 3 条，格子矮的时候 CSS 只露出前一两条
  return card("w-kin", "今天这个词的亲戚", `${kin.length} 个`, `<div class="minis">${kin.slice(0, 3).map((k) => miniRow(k, line(k))).join("")}</div>`);
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
  if (!same.length) return `<div class="w-body w-card w-era">${big}<div class="era-list"><p class="alone">这个世纪只有今天这一个故事</p></div></div>`;
  if (size === "l") {
    const list = pick(same, 5);
    // 这个世纪的故事不够填满，就补上前后一个世纪的，标明是哪个世纪
    const near = list.length >= 4 ? [] : pick(others().filter((s) => s.era && Math.abs(s.era - self.era) === 1), 4 - list.length);
    return `<div class="w-body w-card w-era big">
      <div class="era-band">${big}<a href="#/explore/timeline">这个世纪共 ${same.length + 1} 个故事${icon("right")}</a></div>
      <div class="era-list">${list.map((x) => miniRow(x)).join("")}
        ${near.length ? `<p class="era-near">前后一个世纪</p>${near.map((x) => miniRow(x, `<em class="rel">${eraLabel(x.era)}</em>${blurb(x)}`)).join("")}` : ""}
      </div>
    </div>`;
  }
  // 中号：这个世纪的词不到 4 个就补上前后一个世纪的，CSS 按格子高度只露出放得下的几行
  const list = pick(same, 4);
  const near = list.length >= 4 ? [] : pick(others().filter((s) => s.era && Math.abs(s.era - self.era) === 1), 4 - list.length);
  const row = (x, note = "") => `<span class="era-row" style="${tint(x)}"><b>${esc(x.headword)}${note ? `<em>${note}</em>` : ""}</b><span>${esc(x.meaning)}</span></span>`;
  return `<a class="w-body w-card w-era" href="#/explore/timeline">${big}
    <div class="era-list">${list.map((x) => row(x)).join("")}${near.map((x) => row(x, eraLabel(x.era))).join("")}</div>
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
  if (!same.length) return card("w-road", "走这条路来的", link, `${route}<p class="alone">只有今天这个词走这条路</p>`);
  if (size === "l") {
    // 多给几条，放不下的由 CSS 按格子高度藏起来（手机上 3 条，宽屏 6 条）；总数在标题栏
    return card("w-road big", "走同一条路来的", link, `${route}<div class="minis">${pick(same, 6).map((x) => miniRow(x)).join("")}</div>`);
  }
  return card("w-road", "走同一条路来的", link, `${route}<p class="road-words">${pick(same, 20)
    .map((s) => `<a href="#/w/${esc(s.id)}" style="${tint(s)}">${esc(s.headword)}</a>`)
    .join(" ")}</p>`);
}

function wWaiting(size) {
  if (!ctx.starred) return loading("收藏待读");
  const list = ctx.starred.filter((x) => !x.read && x.id !== ctx.t.entry?.id);
  if (!list.length) {
    return quiet("收藏待读", ctx.starred.length ? "收藏的词都读完了" : "读到喜欢的词点星星收藏，没读完的会排在这里", "star", ["#/explore", "去探索找找"]);
  }
  const link = ["#/me/starred", `${list.length} 个`];
  if (size === "l") {
    const [first, ...rest] = list;
    return card("w-wait big", "收藏了还没读", link, `${featureRow(first)}<div class="minis">${rest.slice(0, 3).map((x) => miniRow(x)).join("")}</div>`);
  }
  return card("w-wait", "收藏了还没读", link, `<div class="minis">${list.slice(0, 2).map((x) => miniRow(x)).join("")}</div>`);
}

/** 专题进度：每个专题一枚纹章，外圈是进度 */
function wCollect(size) {
  if (!ctx.themes) return loading("专题进度");
  // 读过一些、还没读完的，差得最少的排前面；“人名”“地名”太笼统，排在最后；都没读过就推荐词多的专题
  const vague = (x) => (x.theme === "人名" || x.theme === "地名" ? 1 : 0);
  const near = ctx.themes.filter((x) => x.read && x.read < x.count).sort((a, b) => vague(a) - vague(b) || a.count - a.read - (b.count - b.read));
  const fresh = ctx.themes.filter((x) => !x.read).sort((a, b) => vague(a) - vague(b) || b.count - a.count);
  const list = [...near, ...fresh].slice(0, size === "l" ? 6 : size === "m" ? 3 : 1);
  if (!list.length) return quiet("专题进度", "所有专题都读完了！", "grid");
  const medal = (x) => `<a class="medal-mini" href="#/explore/t/${encodeURIComponent(x.theme)}" style="--t:${themeOf(x.theme).color};--p:${Math.round((x.read / x.count) * 100)}%">
    <span class="ring">${emblem(x.theme)}</span><b>${esc(x.theme)}</b><small>${x.read ? `还差 ${x.count - x.read}` : `${x.count} 个词`}</small>
  </a>`;
  if (size === "s") return `<div class="w-body w-card w-collect one">${medal(list[0])}</div>`;
  const lit = ctx.themes.filter((x) => x.read).length;
  return card(`w-collect${size === "l" ? " big" : ""}`, near.length ? "快集齐的专题" : "还没逛过的专题", ["#/explore", `点亮 ${lit} / ${ctx.themes.length}`], `<div class="medals-row">${list.map(medal).join("")}</div>`);
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
