// 日报：主页“今天的一个词”之外的一整版，排得像一份报纸。
//   报头（和首页同一套）→ 报眉：进度、往期 → 头版：左边头条（大标题 + 导语 + 首字下沉的正文开头），
//   右边栏“今日一词”和“本期导读” → 之后每个栏目一版：版头粗线 + 第几版，篇目按栏排开、栏间细线 → 版权栏。
// 每人每天一份，当天不变；从这里点进文章、读完返回，回到原来的位置，读过的盖上“已读”。

import { actions, api, cnDate, esc, fmtDay, icon, local, mastSkeleton, render, rich, skeletons, srcMark, weekday } from "../lib.js?v=212dd6fbae";
import { reasonText } from "../components.js?v=212dd6fbae";
import { primaryTheme, themeTag, tint } from "../themes.js?v=212dd6fbae";

const eraText = (c) => (c < 0 ? `公元前 ${-c} 世纪` : `${c} 世纪`);
const CN = "〇一二三四五六七八九十";
const cnNum = (n) => (n <= 10 ? CN[n] : n < 20 ? "十" + CN[n % 10] : String(n));

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

const MAST_SUB = "The Etymon Daily, Twelve Stories a Day";

/** 日报骨架：报头同真报头（位置和首页一致），下面是报眉和头版的灰条 */
skeletons.paper = () => `${mastSkeleton("词源日报", MAST_SUB)}
  <div class="pp-ear sk-ear"><i class="sk-t" style="width:64px;height:24px;border-radius:999px"></i><i class="sk-t" style="width:200px"></i></div>
  <div class="pp-front-page sk-pp"><div class="sk-lines"><span class="sk" style="height:14px;width:40%"></span><span class="sk" style="height:58px;width:62%"></span><span class="sk" style="height:22px;width:90%"></span><span class="sk" style="height:14px"></span><span class="sk" style="height:14px"></span><span class="sk" style="height:14px;width:70%"></span></div><div class="pp-side"><span class="sk" style="height:120px"></span></div></div>`;

const stamp = (s) => (s.read ? `<span class="pp-stamp" aria-label="已读">已读</span>` : "");

/** 栏目里的一篇：专题眉题 → 斜体词头 → 释义 → 问题（温故给“一句话记住”）→ 推荐理由 */
function story(s, { recall = false } = {}) {
  const theme = primaryTheme(s);
  const body = recall || s.read ? (s.keyline ? rich(s.keyline) : rich(s.teaser || "")) : rich(s.teaser || "");
  const reason = why(s.reason);
  return `<a class="pp-story${s.read ? " read" : ""}${recall ? " recall" : ""}" href="#/w/${esc(s.id)}" style="${tint(s)}">
    <span class="pp-top">${theme ? themeTag(theme) : ""}${stamp(s)}</span>
    <b class="pp-word">${esc(s.headword)}${srcMark(s)}</b>
    <span class="pp-mean">${s.ipa ? `<i class="pp-ipa">/${esc(s.ipa)}/</i>` : ""}${esc(s.meaning ?? "")}</span>
    <span class="pp-body">
      <span class="pp-text">${recall ? `<small>一句话记住</small>` : ""}${body}</span>
      ${reason ? `<span class="pp-why">${icon("spark")}<span>${reason}</span></span>` : ""}
    </span>
  </a>`;
}

/** 头条：整版最大的字，导语是问题，正文开头首字下沉 */
function headline(s) {
  const theme = primaryTheme(s);
  const reason = why(s.reason);
  return `<a class="pp-lead${s.read ? " read" : ""}" href="#/w/${esc(s.id)}" style="${tint(s)}">
    <span class="pp-top"><span class="pp-label">头条 · Headline</span>${theme ? themeTag(theme) : ""}${stamp(s)}</span>
    <b class="pp-lead-word">${esc(s.headword)}${srcMark(s)}</b>
    <span class="pp-lead-mean">${s.ipa ? `<i class="pp-ipa">/${esc(s.ipa)}/</i>` : ""}${esc(s.meaning ?? "")}</span>
    <span class="pp-deck">${rich(s.teaser || "")}</span>
    ${s.gist ? `<span class="pp-lede">${rich(s.gist)}</span>` : ""}
    <span class="pp-lead-foot">${reason ? `<span class="pp-why">${icon("spark")}<span>${reason}</span></span>` : "<span></span>"}<span class="pp-readon">读全文${icon("right")}</span></span>
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
  const minutes = Math.max(3, Math.round(p.total * 1.5));

  // 报眉：返回 · 进度 · 往期。返回按钮放在双线下面：报头位置和首页完全一致，切页时报头不跳
  const back = `<button class="pp-back" data-action="back" aria-label="返回">${icon("left")}<span>今日</span></button>`;
  const issues = p.days.length > 1
    ? `<nav class="pp-issues" aria-label="往期"><span class="pp-issues-l">往期</span>${p.days
        .map((d) => `<a href="#/paper${d === p.days[0] && p.today ? "" : `?day=${d}`}"${d === p.day ? ` aria-current="page"` : ""}>${d === p.days[0] && p.today ? "今天" : fmtDay(d, { weekday: false }).replace(/ /g, "")}</a>`)
        .join("")}</nav>`
    : "";
  const ear = `<div class="pp-ear">
    ${back}
    <div class="pp-progress">
      <span>${p.today ? "今天" : "这一期"} <b>${p.total}</b> 篇 · 已读 <b>${p.read}</b>${p.today && p.read < p.total ? ` · 约 ${minutes} 分钟` : ""}</span>
      <span class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></span>
    </div>
    ${issues}
  </div>`;

  // 右栏：今日一词 + 本期导读
  const front = p.front
    ? `<a class="pp-front${p.front.read ? " read" : ""}" href="#/w/${esc(p.front.id)}" style="${tint(p.front)}">
        <span class="pp-label">今日一词 · Today’s Word</span>
        <b>${esc(p.front.headword)}</b>
        <span class="pp-front-text">${p.front.read ? esc(p.front.meaning) : rich(p.front.teaser ?? "")}</span>
        ${stamp(p.front)}
      </a>`
    : "";
  const toc = p.sections.length
    ? `<nav class="pp-toc" aria-label="本期导读">
        <span class="pp-label">本期导读 · In This Issue</span>
        <ol>${p.sections
          .map((s, i) => {
            const done = s.items.filter((x) => x.read).length;
            return `<li><button data-action="pp-jump" data-to="pp-${esc(s.key)}"><span class="n">${cnNum(i + 2)}</span><span class="t">${esc(s.title)}</span><span class="dots"></span><span class="c">${done ? `${done}/` : ""}${s.items.length}</span></button></li>`;
          })
          .join("")}</ol>
      </nav>`
    : "";

  const sections = p.sections
    .map(
      (s, i) => `<section class="pp-sec pp-${esc(s.key)}" id="pp-${esc(s.key)}">
        <header class="pp-sec-head">
          <h2>${esc(s.title)}<span class="en">${esc(s.en)}</span></h2>
          <span class="pp-page">第${cnNum(i + 2)}版</span>
        </header>
        ${s.note ? `<p class="pp-note">${esc(s.note)}</p>` : ""}
        <div class="pp-cols n${Math.min(s.items.length, 3)}">${s.items.map((x) => story(x, { recall: s.key === "recall" })).join("")}</div>
      </section>`,
    )
    .join("");

  render(`
    <header class="mast pp-mast">
      <div class="mast-meta"><span class="no">No. ${p.issue} · Etymon</span><span class="date">${cnDate(p.day)} · ${weekday(p.day)}</span></div>
      <h1 class="mast-title"><span class="seal"></span>词源日报</h1>
      <p class="mast-sub">${MAST_SUB}</p>
      <div class="mast-rule"></div>
    </header>
    ${ear}
    <div class="pp-front-page${p.lead ? "" : " no-lead"}">
      ${p.lead ? headline(p.lead) : ""}
      ${front || toc ? `<aside class="pp-side">${front}${toc}</aside>` : ""}
    </div>
    ${sections}
    <footer class="pp-end">
      <div class="pp-end-rule"></div>
      <span class="seal"></span>
      <p class="pp-end-t">${p.today ? (p.read >= p.total && p.total ? "今天这一版都读完了" : "今天的日报就到这里") : `这是 ${fmtDay(p.day, { weekday: false })} 的日报`}</p>
      <p class="pp-end-s">${p.today ? "明天早上换新的一版 · 也可以在「账号与安全」里订阅邮件版" : "往期只保留最近七天"}</p>
      <div class="acts"><a class="btn sm" href="#/">回到今日</a><a class="btn sm ghost" href="#/explore">去探索</a></div>
    </footer>`);
}

actions["pp-jump"] = (el) => {
  document.getElementById(el.dataset.to)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
};
