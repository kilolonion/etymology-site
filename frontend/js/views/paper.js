// 日报：主页“今天的一个词”之外的一整版。头版（今天的词）→ 头条 → 接着读 → 今日专题 → 同一时代同一条路 → 冷门 → 还值得一读 → 温故。
// 每人每天一份，当天不变；从这里点进文章、读完返回，回到原来的位置，读过的盖上“已读”。

import { reasonText } from "../components.js?v=212dd6fbae";
import { api, cnDate, esc, fmtDay, icon, local, render, rich, srcMark, weekday } from "../lib.js?v=212dd6fbae";
import { primaryTheme, themeTag, tint } from "../themes.js?v=212dd6fbae";

const eraText = (c) => (c < 0 ? `公元前 ${-c} 世纪` : `${c} 世纪`);

/** 日报自己的几种推荐理由，其余交给通用的 reasonText */
function why(r) {
  if (!r) return "";
  const w = (x) => `<em>${esc(x)}</em>`;
  switch (r.type) {
    case "era": return `和今天的 ${w(r.word)} 同在${eraText(r.era)}`;
    case "road": return `和今天的 ${w(r.word)} 一样从${esc(r.lang)}出发`;
    case "fresh": return `你还没读过「${esc(r.theme)}」`;
    case "recall": return `${r.ago} 天前读过`;
    default: return reasonText(r);
  }
}

/** 日报里下一篇没读的（跳过 current） */
export function nextFromPaper(current) {
  const list = local.get("paper-ids", null);
  if (!list || list.day !== new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" })) return null;
  const read = new Set(local.get("paper-read", []));
  return list.items.find((x) => x.id !== current && !read.has(x.id)) ?? null;
}

/** 文章读完时记一下，返回日报时不用等接口就能先盖章 */
export function notePaperRead(id) {
  const read = new Set(local.get("paper-read", []));
  read.add(id);
  local.set("paper-read", [...read].slice(-60));
}

const stamp = (s) => (s.read ? `<span class="pp-stamp" aria-label="已读">已读</span>` : "");

function story(s, { recall = false, big = false } = {}) {
  const theme = primaryTheme(s);
  const body = recall || s.read ? (s.keyline ? rich(s.keyline) : "") : rich(s.teaser || "");
  const reason = why(s.reason);
  return `<a class="pp-story${big ? " lead" : ""}${s.read ? " read" : ""}${recall ? " recall" : ""}" href="#/w/${esc(s.id)}" style="${tint(s)}">
    <span class="pp-top">${theme ? themeTag(theme) : ""}${stamp(s)}</span>
    <b class="pp-word">${esc(s.headword)}${srcMark(s)}</b>
    <span class="pp-mean">${esc(s.meaning ?? "")}</span>
    <span class="pp-text">${recall ? `<small>一句话记住</small>` : ""}${body}</span>
    ${reason ? `<span class="pp-why">${icon("spark")}${reason}</span>` : ""}
  </a>`;
}

export async function viewPaper(_, q) {
  const day = q?.get("day") ?? "";
  const p = await api(`/paper${day ? `?day=${encodeURIComponent(day)}` : ""}`);
  document.title = `日报 · ${fmtDay(p.day, { weekday: false })} · 词源一日`;

  // 记下今天这份的顺序（头条、各版），读完时“再读一个”按这个顺序接着往下
  const all = [p.lead, ...p.sections.flatMap((s) => (s.key === "recall" ? [] : s.items))].filter(Boolean);
  if (p.today) {
    local.set("paper-ids", { day: p.day, items: all.map((x) => ({ id: x.id, headword: x.headword })) });
    local.set("paper-read", [...p.sections.flatMap((s) => s.items), p.lead].filter((x) => x?.read).map((x) => x.id));
  }

  const pct = p.total ? Math.round((p.read / p.total) * 100) : 0;
  const issues = p.days.length > 1
    ? `<nav class="pp-issues" aria-label="往期">${p.days
        .map((d) => `<a href="#/paper${d === p.days[0] && p.today ? "" : `?day=${d}`}"${d === p.day ? ` aria-current="page"` : ""}>${fmtDay(d, { weekday: false })}</a>`)
        .join("")}</nav>`
    : "";
  const front = p.front
    ? `<a class="pp-front${p.front.read ? " read" : ""}" href="#/w/${esc(p.front.id)}" style="${tint(p.front)}">
        <small>头版 · 今天的词</small><b>${esc(p.front.headword)}</b><span>${p.front.read ? esc(p.front.meaning) : rich(p.front.teaser ?? "")}</span>${stamp(p.front)}
      </a>`
    : "";

  render(`
    <button class="back" data-action="back">${icon("left")}返回</button>
    <header class="pp-mast">
      <div class="pp-meta"><span>No. ${p.issue} · The Etymon Daily</span><span>${cnDate(p.day)} · ${weekday(p.day)}</span></div>
      <h1>词源日报</h1>
      <div class="pp-rule"></div>
      <div class="pp-progress">
        <span>${p.today ? "今天" : "这一期"} ${p.total} 篇 · 已读 <b>${p.read}</b></span>
        <span class="progress"><span style="width:${pct}%"></span></span>
      </div>
      ${issues}
    </header>
    ${front}
    ${p.lead ? `<section class="pp-sec"><h2 class="kicker">头条<span class="en">Headline</span></h2>${story(p.lead, { big: true })}</section>` : ""}
    ${p.sections
      .map(
        (s) => `<section class="pp-sec pp-${esc(s.key)}">
          <h2 class="kicker">${esc(s.title)}<span class="en">${esc(s.en)}</span></h2>
          ${s.note ? `<p class="pp-note">${esc(s.note)}</p>` : ""}
          <div class="pp-grid">${s.items.map((x) => story(x, { recall: s.key === "recall" })).join("")}</div>
        </section>`,
      )
      .join("")}
    <footer class="pp-end">
      <span class="seal"></span>
      <p>${p.today ? "今天的日报就到这里，明天早上换新的一版" : "这是往期的日报"}</p>
      <div class="acts"><a class="btn sm" href="#/">回到今日</a><a class="btn sm ghost" href="#/explore">去探索</a></div>
    </footer>`);
}
