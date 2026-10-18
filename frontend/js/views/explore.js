// 探索：搜索、专题（大专题再分子专题）、语源之路、时间长廊、按字母。想多看一点的时候来这里。

import { actions, api, empty, esc, icon, invalidate, render, rich, row } from "../lib.js";
import { fold, foldHead } from "../components.js";
import { emblem, primaryTheme, themeOf, tint } from "../themes.js";

/** 词条目录：api 自己有短缓存，这里不再另存一份 */
const loadSummaries = () => api("/entries");
export const invalidateSummaries = () => invalidate("/entries");

export async function viewExplore(query) {
  const [themes, all] = await Promise.all([api("/themes"), loadSummaries()]);
  const total = all.filter((s) => !s.redirect).length;
  const q = query.get("q") ?? "";

  render(`
    <header class="page-head"><h1>探索<span class="en">Explore</span></h1><p>${total} 个词条，按专题或字母随意翻</p></header>
    <div class="search-wrap">
      <input class="search" id="q" type="search" placeholder="搜单词、释义，或故事里的内容" value="${esc(q)}" autocomplete="off" enterkeyhint="search">
    </div>
    <div id="explore-body"></div>`);

  const body = document.getElementById("explore-body");
  // 词最多的具体专题放大展示；“人名”“地名”这种笼统的排最后
  const vague = (t) => (t.theme === "人名" || t.theme === "地名" ? 1 : 0);
  const halls = [...themes].sort((a, b) => vague(a) - vague(b) || b.count - a.count);
  const home = `
    <h3 class="kicker" style="margin-top:12px">专题展厅 <span class="en">Galleries</span></h3>
    <div class="gallery">${halls.map((t, i) => hall(t, i === 0)).join("")}</div>
    <h3 class="kicker">换个角度 <span class="en">Other Ways In</span></h3>
    <div class="browse-links">
      <a class="az-link" href="#/explore/routes"><b>语源之路</b><span>Routes</span></a>
      <a class="az-link" href="#/explore/timeline"><b>时间长廊</b><span>Timeline</span></a>
      <a class="az-link" href="#/explore/az"><b>按字母浏览</b><span>A — Z</span></a>
    </div>`;

  const show = async (text) => {
    if (!text) {
      body.innerHTML = home;
      return;
    }
    const hits = await api(`/search?q=${encodeURIComponent(text)}`);
    if (document.getElementById("q")?.value.trim() !== text) return; // 已经输入了新的内容
    body.innerHTML = hits.length
      ? `<p class="eyebrow hits">找到 ${hits.length} 个</p><div class="list">${hits.map((h) => row(h, { query: text })).join("")}</div>`
      : empty(`没有找到“${esc(text)}”`, suggest(all));
  };

  const input = document.getElementById("q");
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const text = input.value.trim();
      history.replaceState(null, "", text ? `#/explore?q=${encodeURIComponent(text)}` : "#/explore");
      show(text);
    }, 180);
  });
  await show(q);
}

/** 搜不到时给几个可以直接点开的词，优先没读过的 */
function suggest(all) {
  const pool = all.filter((s) => !s.redirect);
  const unread = pool.filter((s) => !s.read);
  const picks = [...(unread.length >= 4 ? unread : pool)].sort(() => Math.random() - 0.5).slice(0, 4);
  return `<p class="try">换个说法，比如中文释义；或者从这几个词开始：</p>
    <div class="chips">${picks.map((s) => `<a class="chip" href="#/w/${esc(s.id)}" style="${tint(s)}">${esc(s.headword)}</a>`).join("")}</div>`;
}

function hall(t, featured) {
  const meta = themeOf(t.theme);
  const pct = Math.round((t.read / t.count) * 100);
  return `<a class="hall${featured ? " featured" : ""}" href="#/explore/t/${encodeURIComponent(t.theme)}" style="--t:${meta.color}">
    ${emblem(t.theme)}
    <span class="en">${meta.en}</span>
    <h3>${esc(t.theme)}</h3>
    <span class="words">${t.sample.map(esc).join(" · ")}</span>
    <span class="foot"><span>${t.count} 个词</span><span class="meter"><span style="width:${pct}%"></span></span><span>${t.read ? `${t.read} 已读` : "未读"}</span></span>
  </a>`;
}

export async function viewTheme(name, query) {
  const items = await api(`/themes/${encodeURIComponent(name)}`);
  const unread = items.filter((s) => !s.read);
  const read = items.filter((s) => s.read);
  const pct = Math.round((read.length / items.length) * 100);
  const meta = themeOf(name);
  // 分了子专题的（风俗与生活）：顶上一排子专题，点一下只看那一类
  const subs = new Map();
  for (const s of items) if (s.subtheme) subs.set(s.subtheme, (subs.get(s.subtheme) ?? 0) + 1);
  const sub = subs.has(query?.get("sub")) ? query.get("sub") : "";
  render(`
    <button class="back" data-action="back">${icon("left")}探索</button>
    <header class="band" style="--t:${meta.color}">
      ${emblem(name)}
      <span class="en">${meta.en}</span>
      <h1>${esc(name)}</h1>
      ${meta.desc ? `<p class="band-desc">${esc(meta.desc)}</p>` : ""}
      <p class="band-meta"><span>${items.length} 个词</span><span>已读 ${read.length}</span>${unread.length ? "" : "<span>全部读完 ✓</span>"}</p>
      <div class="progress"><span style="width:${pct}%"></span></div>
    </header>
    ${subs.size ? `<nav class="subs" aria-label="子专题">${[["", items.length], ...[...subs].sort((x, y) => y[1] - x[1])]
      .map(([k, n]) => `<button data-action="sub" data-sub="${esc(k)}" aria-pressed="${k === sub}">${k ? esc(k) : "全部"}<span>${n}</span></button>`)
      .join("")}</nav>` : ""}
    <div id="theme-body">${themeBody(items, sub)}</div>`);

  actions.sub = (el) => {
    const next = el.dataset.sub;
    for (const b of document.querySelectorAll(".subs button")) b.setAttribute("aria-pressed", String(b === el));
    document.getElementById("theme-body").innerHTML = themeBody(items, next);
    history.replaceState(null, "", `#/explore/t/${encodeURIComponent(name)}${next ? `?sub=${encodeURIComponent(next)}` : ""}`);
  };
}

function themeBody(items, sub) {
  const list = sub ? items.filter((s) => s.subtheme === sub) : items;
  const unread = list.filter((s) => !s.read);
  const read = list.filter((s) => s.read);
  // 读过的：先露出 6 张，其余收起；整块也能收起，专心看还没读的
  const SHOW_R = 6;
  const recalls = `<div class="recalls">${read.slice(0, SHOW_R).map(recallCard).join("")}</div>${
    read.length > SHOW_R ? `<details class="more-q"><summary>再看 ${read.length - SHOW_R} 个</summary><div class="recalls">${read.slice(SHOW_R).map(recallCard).join("")}</div></details>` : ""}`;
  return `
    ${unread.length ? fold(foldHead("还没读", `${unread.length} to go`), questions(unread), { key: "theme.unread" }) : ""}
    ${read.length ? fold(foldHead("读过的", "Remembered", `${read.length} 个`), recalls, { key: "theme.read" }) : ""}`;
}

/** 没读过的：只露出问题，勾起好奇；太多时先显示一部分 */
const SHOW_Q = 8;
function questions(items) {
  const card = (s) => `<a class="qcard" href="#/w/${esc(s.id)}" style="${tint(s)}">
    ${emblem(primaryTheme(s))}
    <p>${rich(s.teaser)}</p>
    <span class="w"><b>${esc(s.headword)}</b>${icon("arrow")}</span>
  </a>`;
  const head = items.slice(0, SHOW_Q).map(card).join("");
  const rest = items.slice(SHOW_Q);
  return `<div class="qcards">${head}</div>${
    rest.length ? `<details class="more-q"><summary>再看 ${rest.length} 个</summary><div class="qcards">${rest.map(card).join("")}</div></details>` : ""
  }`;
}

/** 读过的：单词 + 一句话记住，方便回想 */
const recallCard = (s) => `<a class="rcard" href="#/w/${esc(s.id)}" style="${tint(s)}">
  <b>${esc(s.headword)}</b>
  <p>${rich(s.keyline || s.meaning)}</p>
  ${s.starred ? icon("star", "star-s") : ""}
</a>`;

export async function viewAZ() {
  const all = await loadSummaries();
  const groups = new Map();
  for (const s of all) {
    if (!groups.has(s.letter)) groups.set(s.letter, []);
    groups.get(s.letter).push(s);
  }
  render(`
    <button class="back" data-action="back">${icon("left")}探索</button>
    <header class="page-head"><h1>按字母<span class="en">A to Z</span></h1><p>按书中顺序排列。点字母展开那一组，不用从头翻到尾</p></header>
    <div class="letters">${"ABCDEFGHIJKLMNOPQRSTUVWXYZ"
      .split("")
      .map((l) => `<button data-action="jump" data-letter="${l}" ${groups.has(l) ? "" : "disabled"}>${l}</button>`)
      .join("")}<button class="all" data-action="toggle-letters">全部展开</button></div>
    ${[...groups]
      .map(([l, list]) => {
        const read = list.filter((s) => s.read && !s.redirect).length;
        return fold(
          `<h2 class="group-letter" id="letter-${l}">${l}</h2><span class="group-meta">${list.length} 个词${read ? ` · 已读 ${read}` : ""}</span>`,
          `<div class="list">${list.map((s) => row(s)).join("")}</div>`,
          { open: false, cls: "letter-group" },
        );
      })
      .join("")}`);
}

/** 点字母：展开那一组并滚过去 */
actions.jump = (el) => {
  const h = document.getElementById(`letter-${el.dataset.letter}`);
  const d = h?.closest("details");
  if (d) d.open = true;
  h?.scrollIntoView({ behavior: "smooth" });
};

actions["toggle-letters"] = (el) => {
  const groups = [...document.querySelectorAll(".letter-group")];
  const open = !groups.every((d) => d.open);
  for (const d of groups) d.open = open;
  el.textContent = open ? "全部收起" : "全部展开";
};

/** 一串单词小标签；读过的实心 */
const wordChips = (list) =>
  `<div class="chips left">${list
    .map((s) => `<a class="chip${s.read ? " read" : ""}" href="#/w/${esc(s.id)}" style="${tint(s)}" title="${esc(s.meaning ?? "")}">${esc(s.headword)}</a>`)
    .join("")}</div>`;
const readOf = (list) => list.filter((s) => s.read).length;
/** 词多的格子先露出一部分，其余收起 */
const SHOW_CHIPS = 24;
const moreChips = (list) =>
  list.length <= SHOW_CHIPS + 4
    ? wordChips(list)
    : `${wordChips(list.slice(0, SHOW_CHIPS))}<details class="more-q chips-more"><summary>再看 ${list.length - SHOW_CHIPS} 个</summary>${wordChips(list.slice(SHOW_CHIPS))}</details>`;
const arrow = '<i aria-hidden="true">→</i>';

/** 语源之路：从哪种语言出发、经过哪些语言来到英语 */
export async function viewRoutes() {
  const all = (await loadSummaries()).filter((s) => !s.redirect && s.langs?.length);
  const groupBy = (key) => {
    const m = new Map();
    for (const s of all) {
      const k = key(s);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    }
    return [...m].sort((a, b) => b[1].length - a[1].length);
  };
  const origins = groupBy((s) => s.langs[0]);
  const routes = groupBy((s) => s.langs.join("|"));
  const common = routes.filter(([, l]) => l.length >= 3);
  const max = origins[0]?.[1].length ?? 1;
  // 美国英语本身就是英语，路线不再接“英语”
  const path = (k) => {
    const ls = k.split("|");
    return [...ls.map(esc), ...(ls.at(-1) === "美国英语" ? [] : ["<b>英语</b>"])].join(arrow);
  };

  render(`
    <button class="back" data-action="back">${icon("left")}探索</button>
    <header class="page-head"><h1>语源之路<span class="en">Routes</span></h1>
      <p>${all.length} 个词标注了来源语言。路线按语言大致的先后排列，是近似的走法，细节以正文为准。</p></header>

    <h3 class="kicker">出发地 <span class="en">Origins</span></h3>
    <div class="bars">${origins
      .map(([lang, list]) => `<details class="bar-row">
        <summary><span class="name">${esc(lang)}</span><span class="bar"><span style="width:${(list.length / max) * 100}%"></span></span><span class="n">${list.length}</span></summary>
        ${wordChips(list)}
      </details>`)
      .join("")}</div>

    <h3 class="kicker">常见路线 <span class="en">Well-trodden</span></h3>
    <div class="routes">${common
      .map(([k, list]) => `<details class="route">
        <summary><span class="path">${path(k)}</span><span class="n">${list.length}</span></summary>
        ${wordChips(list)}
      </details>`)
      .join("")}</div>
    <p class="eyebrow note">另有 ${routes.length - common.length} 条少见的路线，可以从上面的出发地里找到。实心的是读过的词。</p>`);
}

const eraLabel = (c) => (c < 0 ? `公元前 ${-c} 世纪` : `${c} 世纪`);
/** 时间长廊里的一格：公元前合成一格，公元 1–10 世纪合成一格，之后每个世纪一格 */
const eraBucket = (c) => (c < 0 ? -1 : c <= 10 ? 10 : c);
const BUCKET_NAME = { [-1]: ["BC", "公元前"], 10: ["1—10", "世纪"] };

/** 时间长廊：按故事起点（正文提到的最早年代）排列 */
export async function viewTimeline() {
  const all = (await loadSummaries()).filter((s) => !s.redirect);
  const dated = all.filter((s) => s.era).sort((a, b) => a.era - b.era);
  const undated = all.filter((s) => !s.era);
  const buckets = new Map();
  for (const s of dated) {
    const b = eraBucket(s.era);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(s);
  }

  render(`
    <button class="back" data-action="back">${icon("left")}探索</button>
    <header class="page-head"><h1>时间长廊<span class="en">Timeline</span></h1>
      <p>按故事的起点排列：正文里提到的最早年代。比如 labyrinth 从公元前 2000 年的克里特讲起，虽然它 14 世纪才进入英语。</p></header>
    <ol class="timeline">${[...buckets]
      .map(([b, list]) => {
        const [big, small] = BUCKET_NAME[b] ?? [String(b), "世纪"];
        const span = b === -1 || b === 10 ? `<span class="span">${eraLabel(list[0].era)} — ${eraLabel(list.at(-1).era)}</span>` : "";
        return `<li class="era">
          <div class="era-mark"><b>${big}</b><span>${small}</span></div>
          <div class="era-body">
            <p class="eyebrow">${list.length} 个词${readOf(list) ? ` · 已读 ${readOf(list)}` : ""}${span}</p>
            ${moreChips(list)}
          </div>
        </li>`;
      })
      .join("")}</ol>
    ${undated.length ? `<details class="route undated"><summary><span class="path">年代不详</span><span class="n">${undated.length}</span></summary>${wordChips(undated)}</details>` : ""}`);
}
