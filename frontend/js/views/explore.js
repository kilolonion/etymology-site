// 探索：搜索、专题、按字母。想多看一点的时候来这里。

import { actions, api, empty, esc, icon, invalidate, render, rich, row } from "../lib.js";
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
    <a class="az-link" href="#/explore/az"><b>按字母浏览</b><span>A — Z</span></a>`;

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

export async function viewTheme(name) {
  const items = await api(`/themes/${encodeURIComponent(name)}`);
  const unread = items.filter((s) => !s.read);
  const read = items.filter((s) => s.read);
  const pct = Math.round((read.length / items.length) * 100);
  const meta = themeOf(name);
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
    ${unread.length ? `<h3 class="kicker">还没读 <span class="en">${unread.length} to go</span></h3>${questions(unread)}` : ""}
    ${read.length ? `<h3 class="kicker">读过的 <span class="en">Remembered</span></h3><div class="recalls">${read.map(recallCard).join("")}</div>` : ""}`);
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
    <header class="page-head"><h1>按字母<span class="en">A to Z</span></h1><p>按书中顺序排列</p></header>
    <div class="letters">${"ABCDEFGHIJKLMNOPQRSTUVWXYZ"
      .split("")
      .map((l) => `<button data-action="jump" data-letter="${l}" ${groups.has(l) ? "" : "disabled"}>${l}</button>`)
      .join("")}</div>
    ${[...groups]
      .map(([l, list]) => `<h2 class="group-letter" id="letter-${l}">${l}</h2><div class="list">${list.map((s) => row(s)).join("")}</div>`)
      .join("")}`);
}

actions.jump = (el) => document.getElementById(`letter-${el.dataset.letter}`)?.scrollIntoView({ behavior: "smooth" });
