// 多个页面共用的片段

import { actions, api, esc, icon, local, rich, toast } from "./lib.js";
import { enablePush, pushStatus } from "./push.js";
import { emblem, primaryTheme, tint } from "./themes.js";

export const starBtn = (e) =>
  `<button class="icon-btn star" data-action="star" data-id="${esc(e.id)}" aria-pressed="${!!e.starred}" aria-label="收藏">${icon("star")}</button>`;

export const sayBtn = (text, cls = "icon-btn") =>
  `<button class="${cls}" data-action="say" data-text="${esc(text)}" aria-label="朗读">${icon("sound")}</button>`;

export const prose = (paras, cls = "") =>
  `<div class="prose ${cls}">${paras.map((p) => `<p>${rich(p)}</p>`).join("")}</div>`;

/** 词源之路：首尾节点标“源”“今” */
export function route(e) {
  if (!e.evolution?.length) return "";
  const n = e.evolution.length;
  const label = (i) => (i === 0 ? "源" : i === n - 1 ? "今" : String(i));
  return `<h3 class="kicker">词源之路 <span class="en">The Journey</span></h3>
    <ol class="route">${e.evolution
      .map((s, i) => `<li><span class="node">${label(i)}</span><span class="txt">${rich(s)}</span></li>`)
      .join("")}</ol>`;
}

/** 一句话记住（大号引文） */
export const pull = (e) =>
  e.keyline ? `<blockquote class="pull">${rich(e.keyline)}<small>一句话记住</small></blockquote>` : "";

/** 例句：默认显示前 show 条，其余折叠 */
export function examples(e, show = 2) {
  const li = (x) => `<li>
    <p class="ex-en"><span>${rich(x.en)}</span>${sayBtn(x.en, "icon-btn sm")}</p>
    <p class="ex-zh">${esc(x.zh)}</p>
  </li>`;
  const head = e.examples.slice(0, show);
  const rest = e.examples.slice(show);
  return `<ol class="examples">${head.map(li).join("")}</ol>${
    rest.length
      ? `<details class="more-ex"><summary>再看 ${rest.length} 个例句</summary><ol class="examples">${rest.map(li).join("")}</ol></details>`
      : ""
  }`;
}

/** 相关词卡片：各自带专题色和纹章；读过的标“已读” */
export const linkCards = (items) =>
  `<div class="links">${items
    .map(
      (s) => `<a class="link-card" href="#/w/${esc(s.id)}" style="${tint(s)}">
        ${emblem(primaryTheme(s))}<b>${esc(s.headword)}</b><span>${esc(s.meaning)}</span>
        ${s.read ? `<i class="seen">已读</i>` : ""}
      </a>`,
    )
    .join("")}</div>`;

/** 推荐理由，一句话说明“为什么是这个词” */
export function reasonText(r) {
  if (!r) return "";
  const w = (x) => `<em>${esc(x)}</em>`;
  switch (r.type) {
    case "link": return `和你读过的 ${w(r.word)} 互为参见`;
    case "theme": return `你读过的 ${w(r.word)} 也属于「${esc(r.theme)}」`;
    case "anchor": return r.theme ? `和 ${w(r.word)} 同属「${esc(r.theme)}」` : `${w(r.word)} 的参见词条`;
    case "taste": return `你收藏过「${esc(r.theme)}」的词`;
    case "new": return `新专题：${esc(r.theme)}`;
    default: return "";
  }
}

/** 明日预告：一封盖了火漆的信；点开就是提前拆信（明天会换一个新词） */
export const letter = (tomorrow) =>
  tomorrow
    ? `<a class="letter" href="#/w/${esc(tomorrow.id)}">
        <span class="wax" aria-hidden="true">源</span>
        <p class="label">明日预告</p>
        <p class="q">${rich(tomorrow.teaser)}</p>
        <p class="hint">Tomorrow, the answer. <span>等不及？点开提前读 ${icon("arrow")}</span></p>
      </a>`
    : "";

/** 读完之后顺势询问要不要每日提醒（已开启 / 不支持 / 关掉过就不显示） */
export async function reminderPrompt() {
  if (local.get("reminder-dismissed")) return "";
  const status = await pushStatus();
  if (status === "needs-install") {
    return `<section class="prompt">${icon("phone")}<div>
      <h3>想每天收到提醒？</h3>
      <p>iPhone 需要先把本站“添加到主屏幕”，从主屏幕打开后就能开启。</p>
      <div class="acts"><a class="btn sm" href="#/me/reminder">怎么添加</a><button class="btn sm ghost" data-action="push-dismiss">不用了</button></div>
    </div></section>`;
  }
  if (status !== "off") return "";
  const { time } = await api("/reminder");
  return `<section class="prompt">${icon("bell")}<div>
    <h3>每天 ${esc(time)} 提醒你？</h3>
    <p>到点推送当天的问题，读完了就不打扰。</p>
    <div class="acts"><button class="btn sm primary" data-action="push-enable">开启提醒</button><button class="btn sm ghost" data-action="push-dismiss">不用了</button></div>
  </div></section>`;
}

actions["push-enable"] = async (el) => {
  el.disabled = true;
  try {
    await enablePush();
    el.closest(".prompt")?.remove();
    toast("提醒已开启，发了一条测试通知");
  } catch (err) {
    el.disabled = false;
    toast(err.message);
  }
};

actions["push-dismiss"] = (el) => {
  local.set("reminder-dismissed", true);
  el.closest(".prompt")?.remove();
  toast("可以随时在“我的 → 每日提醒”里开启");
};
