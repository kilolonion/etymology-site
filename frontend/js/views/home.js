// 今日：报头 → 今天的封面 →（读完后）明日预告 → 旧词重逢 → 本周 → 随手翻一页

import { letter, reasonText, reminderPrompt } from "../components.js";
import { actions, api, cnDate, empty, esc, icon, render, rich, weekday } from "../lib.js";
import { emblem, primaryTheme, themeTag, tint } from "../themes.js";

/** 单词越长，封面字号越小 */
const sizeClass = (w) => (w.length <= 8 ? "xl" : w.length <= 13 ? "l" : "m");

export async function viewHome() {
  const t = await api("/today");
  const e = t.entry;
  if (!e) {
    render(empty("词库里还没有词条"));
    return;
  }
  const [discover, prompt] = await Promise.all([api("/next"), t.done ? reminderPrompt() : ""]);

  render(`
    ${masthead(t)}
    <div class="home-grid">
      <div class="home-main">${t.done ? doneCover(e) : cover(e, t.reason)}</div>
      <aside class="home-side">
        ${t.done ? letter(t.tomorrow) : ""}
        ${prompt}
        ${recall(t.resurface)}
        ${week(t)}
        ${discoverCard(discover.entry)}
      </aside>
    </div>`);
}

function masthead(t) {
  return `<header class="mast">
    <div class="mast-meta"><span class="no">No. ${t.issue} · Etymon</span><span class="date">${cnDate(t.day)} · ${weekday(t.day)}</span></div>
    <h1 class="mast-title"><span class="seal"></span>词源一日</h1>
    <p class="mast-sub">A Word &amp; Its Story, Every Day</p>
    <div class="mast-rule"></div>
  </header>`;
}

function cover(e, reason) {
  const theme = primaryTheme(e);
  const why = reasonText(reason);
  return `<a class="lead" href="#/w/${esc(e.id)}" style="${tint(e)}">
    ${emblem(theme)}
    <div class="lead-top">${themeTag(theme)}<span class="mins">约 3 分钟</span></div>
    ${why ? `<p class="lead-why">${why}</p>` : ""}
    <div class="lead-word ${sizeClass(e.headword)}">
      <b>${esc(e.headword)}</b>
      <span>/${esc(e.ipa)}/ · ${esc(e.meaning)}</span>
    </div>
    <p class="lead-q">${rich(e.teaser)}</p>
    <span class="lead-cta">读这个故事 ${icon("arrow")}</span>
  </a>`;
}

function doneCover(e) {
  const theme = primaryTheme(e);
  return `<a class="lead done" href="#/w/${esc(e.id)}" style="${tint(e)}">
    ${emblem(theme)}
    <div class="lead-top">${themeTag(theme)}<span class="stamp">已<br>读</span></div>
    <div class="lead-word ${sizeClass(e.headword)}">
      <b>${esc(e.headword)}</b>
      <span>${esc(e.meaning)}</span>
    </div>
    ${e.keyline ? `<p class="lead-key"><small>一句话记住</small>${rich(e.keyline)}</p>` : ""}
    <span class="lead-cta ghost">再看一遍 ${icon("arrow")}</span>
  </a>`;
}

/** 旧词重逢：先只看单词，点一下翻面看“一句话记住” */
function recall(x) {
  if (!x) return "";
  return `<section class="panel-card recall" style="${tint(x)}">
    <div class="sec-head"><h2>旧词重逢</h2><span>${x.ago} 天前读过</span></div>
    <div class="flip" data-action="flip" role="button" tabindex="0" aria-label="翻面查看 ${esc(x.headword)} 的来历">
      <div class="face face-front">
        ${emblem(primaryTheme(x))}
        <b>${esc(x.headword)}</b>
        <span>还记得它的来历吗？想一想，再点一下</span>
      </div>
      <div class="face face-back">
        <p>${rich(x.keyline || x.meaning)}</p>
        <a href="#/w/${esc(x.id)}">重读全文 ${icon("arrow")}</a>
      </div>
    </div>
  </section>`;
}

actions.flip = (el) => el.classList.toggle("flipped");

const WEEK_CN = ["一", "二", "三", "四", "五", "六", "日"];

/** 本周七日格：读过的那天盖一枚专题色圆章 */
function week(t) {
  const s = t.stats;
  const cells = t.week
    .map((d, i) => {
      const isToday = d.day === t.day;
      const future = d.day > t.day;
      const date = Number(d.day.slice(8));
      const x = d.entry;
      const state = future ? "future" : x?.read ? "read" : isToday ? "today" : x ? "missed" : "none";
      const mark = x?.read
        ? `<span class="mark" style="${tint(x)}">${esc(x.headword[0])}</span>`
        : `<span class="mark"></span>`;
      const inner = `<span class="wd">${WEEK_CN[i]}</span><span class="dn">${date}</span>${mark}`;
      const cls = `day ${state}${isToday ? " is-today" : ""}`;
      return x && !future
        ? `<a class="${cls}" href="#/w/${esc(x.id)}" title="${esc(x.headword)}">${inner}</a>`
        : `<span class="${cls}">${inner}</span>`;
    })
    .join("");
  return `<section class="panel-card week">
    <div class="sec-head"><h2>本周</h2><span>连续 <b>${s.streak}</b> 天 · 已读 <b>${s.read}</b> / ${s.total}</span></div>
    <div class="days">${cells}</div>
  </section>`;
}

/** 随手翻一页：另一个没读过的词，先看问题，有兴趣再点 */
function discoverCard(x) {
  if (!x) return "";
  const theme = primaryTheme(x);
  return `<section class="panel-card discover" style="${tint(x)}">
    <div class="sec-head"><h2>随手翻一页</h2><button class="shuffle" data-action="shuffle" data-id="${esc(x.id)}">${icon("shuffle")}换一个</button></div>
    <a class="disc" href="#/w/${esc(x.id)}">
      ${emblem(theme)}
      ${themeTag(theme)}
      <p class="disc-q">${rich(x.teaser)}</p>
      ${reasonText(x.reason) ? `<p class="disc-why">${reasonText(x.reason)}</p>` : ""}
      <span class="disc-word"><b>${esc(x.headword)}</b>${icon("arrow")}</span>
    </a>
  </section>`;
}

actions.shuffle = async (el) => {
  el.disabled = true;
  const { entry } = await api(`/next?shuffle=1&skip=${encodeURIComponent(el.dataset.id)}`);
  const box = el.closest(".discover");
  if (entry && box) {
    box.outerHTML = discoverCard(entry);
    document.querySelector(".discover .disc")?.animate(
      [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
      { duration: 260, easing: "ease-out" },
    );
  } else el.disabled = false;
};
