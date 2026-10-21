// 管理后台 · 词条页签，分四块：审核（稿子队列）、加词（查重 → 复制上下文给别的 AI → 粘回 JSON）、读者报错、设置（推送、并回仓库、MCP 令牌）。
// 审稿页用 #/me/admin?tab=entries&d=<id> 打开，一轮审完是 &round=end；完整预览走真实的文章页 #/w/<id>?draft=1。
//
// 审核的顺序：列表按建稿时间排，发布、修改都不会改变它；处理完的稿子从“待处理”移到“已完成”，不会被顶到最前。
// 从列表点进一份稿子时，把当时的列表冻结成这一轮的队列（存在 sessionStorage，刷新也还在），
// 发布或跳过后自动打开队列里下一份没处理的；回到列表时顶上有“继续审核”。

import { actions, api, empty, esc, fmtDay, icon, local, rich, toast } from "../lib.js?v=212dd6fbae";
import { copy, redraw } from "./admin.js?v=212dd6fbae";
import { THEMES } from "../themes.js?v=212dd6fbae";

const fresh = (p) => api(p, { fresh: true, detached: true });
const pad = (n) => String(n).padStart(2, "0");
/** 本地时区的日期 YYYY-MM-DD（库里存的是 UTC 的 ISO 时间） */
const dayKey = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const hm = (iso) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const when = (iso) => (iso ? `${fmtDay(dayKey(iso), { weekday: false })} ${hm(iso)}` : "—");
/** 列表里的短时间：刚刚 / 12 分钟前 / 今天 10:32 / 昨天 21:05 / 10 月 3 日 */
function ago(iso) {
  if (!iso) return "—";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  const today = dayKey(new Date().toISOString());
  if (dayKey(iso) === today) return `今天 ${hm(iso)}`;
  if (dayKey(iso) === dayKey(new Date(Date.now() - 86400_000).toISOString())) return `昨天 ${hm(iso)}`;
  return fmtDay(dayKey(iso), { weekday: false });
}

const STATUS = {
  draft: ["草稿", ""],
  live: ["已发布", "ok"],
  changed: ["已发布 · 有改动未发布", "warn"],
  archived: ["已撤下", "off"],
  merged: ["已并入数据文件", "off"],
};
const LOOKUP = {
  new: ["可以加", "ok"],
  entry: ["已收录", "off"],
  redirect: ["是跳转词条", "off"],
  similar: ["可能已收录", "warn"],
  draft: ["已有稿子", "warn"],
};
const FIELD_NAMES = { teaser: "钩子", keyline: "一句话记住", evolution: "词义演变", links: "词的关系", era: "年代", subtheme: "子专题", langs: "语源" };
const chip = ([text, cls]) => `<span class="ae-chip ${cls}">${esc(text)}</span>`;
const srcChip = (d) =>
  d.kind === "manual" ? chip(["编辑撰写", ""]) : d.checked ? chip(["AI · 已核对", "ok"]) : chip(["AI · 待核对", "warn"]);

// ---------- 稿子分组 ----------

const isLive = (x) => x.status === "live" || x.status === "changed";
/** 稿子还要人看的理由（列表上显示成标签）；一个都没有就算处理完了 */
const TODO = [
  ["errors", (x) => `${x.errors} 个错误`, "err", (x) => x.errors > 0],
  ["reports", (x) => `${x.reports} 条报错`, "err", (x) => x.reports > 0],
  ["draft", () => "没发布", "", (x) => x.status === "draft"],
  ["changed", () => "有改动没发布", "warn", (x) => x.status === "changed"],
  ["pending", () => "发布了待核对", "warn", (x) => isLive(x) && x.kind === "ai" && !x.checked],
];
const TODO_NAMES = { all: "全部", draft: "没发布", changed: "有改动", pending: "待核对", errors: "有错误", reports: "有报错" };
const segOf = (x) => (x.status === "archived" || x.status === "merged" ? "off" : TODO.some((t) => t[3](x)) ? "todo" : "done");
const SEGS = [
  ["todo", "待处理"],
  ["done", "已完成"],
  ["off", "已撤下"],
];
const SORTS = [
  ["batch", "按导入批次"],
  ["old", "最早导入在前"],
  ["az", "按字母"],
];
const PAGE = 40;

const byCreated = (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1);
/** 排序只看建稿时间和词头，发布、修改都不会让一份稿子换位置 */
function sorted(list, sort) {
  if (sort === "az") return [...list].sort((a, b) => a.headword.localeCompare(b.headword, "en", { sensitivity: "base" }) || byCreated(a, b));
  const old = [...list].sort(byCreated);
  if (sort === "old") return old;
  // 按批次：同一天导入的放一组，新的一组在前，组内保持导入时的顺序
  const days = new Map();
  for (const x of old) {
    const k = dayKey(x.createdAt);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(x);
  }
  return [...days.keys()].sort().reverse().flatMap((k) => days.get(k));
}

// 页签里的状态：小节、列表的分组 / 筛选 / 排序 / 搜索、快捷加词的输入和导入结果（切页签回来还在）
const st = {
  sec: local.get("ae-sec", "review"),
  seg: "todo",
  filter: "all",
  sort: local.get("ae-sort", "batch"),
  q: "",
  limit: PAGE,
  reportsAll: false,
  mode: local.get("ae-add-mode", "new"), // 出题方式：new 指定词 / pick 让 AI 选词 / text 从文章找词 / patch 补写原书词条
  cats: { new: "near", pick: "ids", text: "ids", patch: "near", ...local.get("ae-cats", {}) }, // 每种方式附多少已有词条
  pick: { theme: "", hint: "", count: 5, taste: "common" },
  text: "",
  textCount: 5,
  preview: null, // 预览中的提示词
  words: "",
  lookup: null,
  picks: [], // 补写：挑中的原书词条 [{id, headword}]
  fields: ["links"],
  paste: "",
  results: null,
};
if (!["review", "add", "reports", "settings"].includes(st.sec)) st.sec = "review";
if (!["new", "pick", "text", "patch"].includes(st.mode)) st.mode = "new";
let drafts = []; // 最近一次拉到的稿子列表
let shown = null; // 列表上现在这一串（整串，不只是这一页）：点进去时冻结成一轮

// ---------- 一轮审核 ----------

// { key, label, ids, heads: {id: 词头}, done: {id: "ok" 核对通过 | "pub" 先发布 | "skip" 跳过 | "seen" 本来就好的 | "del" 删了}, at }
const ROUND_KEY = "ae-round";
let round = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(ROUND_KEY));
  } catch {
    return null;
  }
})();
function saveRound() {
  try {
    if (round) sessionStorage.setItem(ROUND_KEY, JSON.stringify(round));
    else sessionStorage.removeItem(ROUND_KEY);
  } catch {}
}
function startRound(src) {
  round = { key: src.key, label: src.label, ids: src.ids, heads: src.heads, done: {}, at: null };
  saveRound();
}
const roundLeft = () => (round ? round.ids.filter((id) => !round.done[id]) : []);
/** 这一份之后第一个还没处理的；后面没有就从头找 */
function nextOpen(id) {
  if (!round) return null;
  const i = round.ids.indexOf(id);
  const later = [...round.ids.slice(i + 1), ...round.ids.slice(0, Math.max(i, 0))];
  return later.find((x) => !round.done[x] && x !== id) ?? null;
}
const draftHref = (id) => `#/me/admin?tab=entries&d=${encodeURIComponent(id)}`;
// 一轮里换稿子用 replace：浏览器“返回”直接回到列表，而不是一份份倒回去
const goDraft = (id) => location.replace(draftHref(id));
const goEnd = () => location.replace("#/me/admin?tab=entries&round=end");

/** 直接打开某份稿子（链接、刷新）时它不在这一轮里：拿“待处理”现排一轮，还没有就用全部稿子 */
async function ensureRound(id) {
  if (round?.ids.includes(id)) return;
  const o = await fresh("/admin/entries").catch(() => null);
  const all = o?.drafts ?? [];
  let list = sorted(all.filter((x) => segOf(x) === "todo"), st.sort);
  let label = "待处理";
  if (!list.some((x) => x.id === id)) {
    list = sorted(all, st.sort);
    label = "全部稿子";
  }
  if (!list.some((x) => x.id === id)) list = [{ id, headword: cur.headword }];
  startRound({ key: `auto|${label}`, label, ids: list.map((x) => x.id), heads: Object.fromEntries(list.map((x) => [x.id, x.headword])) });
}

/** 词条页签：d = 审一份稿子，round=end = 一轮审完，否则是总览 */
export async function entriesTab(query) {
  const id = query?.get("d");
  if (id) return draftView(id);
  if (query?.get("round") === "end") return roundEnd();
  return overview();
}

// ---------- 总览 ----------

const SECS = [
  ["review", "审核"],
  ["add", "加词"],
  ["reports", "读者报错"],
  ["settings", "设置"],
];

async function overview() {
  const [o, reports] = await Promise.all([fresh("/admin/entries"), st.sec === "reports" ? fresh("/admin/entries/reports") : null]);
  drafts = o.drafts;
  const todo = drafts.filter((x) => segOf(x) === "todo").length;
  const badge = { review: todo, reports: o.reports };
  const body = { review: reviewSec, add: addSec, reports: () => reportsSec(reports), settings: () => settingsSec(o) }[st.sec];
  return `
    <nav class="ae-secs" aria-label="词条">${SECS.map(([k, name]) => `<button data-action="ae-sec" data-sec="${k}" aria-pressed="${k === st.sec}">${name}${badge[k] ? `<i>${badge[k]}</i>` : ""}</button>`).join("")}</nav>
    ${await body()}`;
}

actions["ae-sec"] = (el) => {
  st.sec = el.dataset.sec;
  local.set("ae-sec", st.sec);
  redraw();
};

// ----- 审核 -----

function reviewSec() {
  const live = drafts.filter(isLive);
  return `
    <div class="rv-tools">
      <label class="rv-search">${icon("search")}<input id="rv-q" type="search" placeholder="搜词头、释义或 id" value="${esc(st.q)}" autocomplete="off" spellcheck="false"></label>
      <select id="rv-sort" aria-label="排序">${SORTS.map(([k, name]) => `<option value="${k}" ${k === st.sort ? "selected" : ""}>${name}</option>`).join("")}</select>
    </div>
    <div id="rv-results">${results()}</div>
    <p class="hint rv-foot">线上有 ${live.filter((x) => x.mode === "new").length} 个新词、${live.filter((x) => x.mode === "patch").length} 份补写；一共 ${drafts.length} 份稿子。</p>`;
}

/** 分组、筛选、继续审核的横幅和列表本身（搜索、换分组时只重画这一块，输入框不丢焦点） */
function results() {
  const q = st.q.trim().toLowerCase();
  const hit = q ? drafts.filter((x) => x.headword.toLowerCase().includes(q) || x.id.includes(q) || (x.meaning ?? "").toLowerCase().includes(q)) : drafts;
  const segs = { todo: [], done: [], off: [] };
  for (const x of hit) segs[segOf(x)].push(x);
  let list = segs[st.seg];
  let chips = "";
  if (st.seg === "todo") {
    const n = (k) => (k === "all" ? list.length : list.filter(TODO.find((t) => t[0] === k)[3]).length);
    if (st.filter !== "all" && !n(st.filter)) st.filter = "all";
    chips = `<div class="rv-chips" role="group" aria-label="筛选">${Object.keys(TODO_NAMES)
      .filter((k) => k === "all" || n(k))
      .map((k) => `<button data-action="rv-filter" data-f="${k}" aria-pressed="${k === st.filter}">${TODO_NAMES[k]}<i>${n(k)}</i></button>`)
      .join("")}</div>`;
    if (st.filter !== "all") list = list.filter(TODO.find((t) => t[0] === st.filter)[3]);
  }
  list = sorted(list, st.sort);
  const label = `${SEGS.find((s) => s[0] === st.seg)[1]}${st.seg === "todo" && st.filter !== "all" ? ` · ${TODO_NAMES[st.filter]}` : ""}${q ? ` · 搜“${st.q.trim()}”` : ""}`;
  shown = {
    key: [st.seg, st.filter, st.sort, q].join("|"),
    label,
    ids: list.map((x) => x.id),
    heads: Object.fromEntries(list.map((x) => [x.id, x.headword])),
  };

  // 分天的小标题（按批次排时）
  const perDay = new Map();
  if (st.sort === "batch") for (const x of list) perDay.set(dayKey(x.createdAt), (perDay.get(dayKey(x.createdAt)) ?? 0) + 1);
  let lastDay = "";
  const rows = list
    .slice(0, st.limit)
    .map((x) => {
      let head = "";
      if (st.sort === "batch" && dayKey(x.createdAt) !== lastDay) {
        lastDay = dayKey(x.createdAt);
        head = `<li class="rv-day">${fmtDay(lastDay, { weekday: false })}导入<span>${perDay.get(lastDay)} 份</span></li>`;
      }
      return head + draftRow(x);
    })
    .join("");
  const more = list.length - st.limit;
  const emptyText = q ? "没有搜到" : st.seg === "todo" ? "都处理完了，没有要看的稿子" : st.seg === "done" ? "还没有处理完的稿子" : "没有撤下的稿子";

  const banner = roundBanner();
  return `
    ${banner}
    <div class="rv-segs" role="tablist" aria-label="分组">${SEGS.map(([k, name]) => `<button role="tab" data-action="rv-seg" data-seg="${k}" aria-selected="${k === st.seg}">${name}<i>${segs[k].length}</i></button>`).join("")}</div>
    ${chips}
    ${list.length
      ? `<div class="rv-listhead"><span>${list.length} 份</span><button class="btn sm${st.seg === "todo" && !banner ? " primary" : ""}" data-action="rv-start">${st.seg !== "todo" ? "逐份看" : banner ? "重新从第一份审" : "从第一份开始审"}${icon("arrow")}</button></div>`
      : ""}
    <ul class="rv-list">${rows || `<li class="adm-empty">${emptyText}</li>`}</ul>
    ${more > 0 ? `<button class="btn sm rv-more" data-action="rv-more">再显示 ${Math.min(more, PAGE)} 份<span class="hint">还有 ${more} 份</span></button>` : ""}`;
}

function draftRow(x) {
  const seg = segOf(x);
  const tags =
    seg === "todo"
      ? TODO.filter((t) => t[3](x)).map(([, text, cls]) => chip([text(x), cls])).join("")
      : chip(STATUS[x.status]) + (isLive(x) ? srcChip(x) : "");
  const t = seg === "done" ? `发布于 ${ago(x.publishedAt)}` : seg === "off" ? `${ago(x.updatedAt)}` : `${esc(x.createdBy)} · ${ago(x.createdAt)}`;
  const skipped = round?.done[x.id] === "skip" && roundLeft().length > 0;
  return `<li><a class="rv-row" href="${draftHref(x.id)}" data-action="rv-open" data-id="${esc(x.id)}">
    <span class="hw"><b>${esc(x.headword)}</b>${x.mode === "patch" ? `<small>补写 ${(x.fields ?? []).map((f) => FIELD_NAMES[f] ?? f).join("、")}</small>` : ""}</span>
    <span class="mn">${esc(x.meaning)}</span>
    <span class="tg">${skipped ? chip(["这一轮跳过了", "off"]) : ""}${tags}${x.doubts && seg === "todo" ? `<span class="ae-n">${x.doubts} 处存疑</span>` : ""}${x.warnings && seg === "todo" ? `<span class="ae-n">${x.warnings} 个提醒</span>` : ""}</span>
    <time>${t}</time>
  </a></li>`;
}

/** 这一轮还没审完：回到列表时给一条“继续审核” */
function roundBanner() {
  if (!round) return "";
  const done = round.ids.length - roundLeft().length;
  const left = roundLeft().length;
  if (!done || !left) return "";
  return `<div class="rv-banner">
    <div><b>这一轮还剩 ${left} 份</b><small>${esc(round.label)} · 已处理 ${done} / ${round.ids.length}</small></div>
    <button class="btn sm ghost" data-action="rv-drop">结束这一轮</button>
    <button class="btn sm primary" data-action="rv-resume">继续审核${icon("arrow")}</button>
  </div>`;
}

const drawResults = () => {
  const box = document.getElementById("rv-results");
  if (box) box.innerHTML = results();
};

let qTimer;
document.addEventListener("input", (ev) => {
  if (ev.target.id !== "rv-q") return;
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    st.q = ev.target.value;
    st.limit = PAGE;
    drawResults();
  }, 120);
});
document.addEventListener("change", (ev) => {
  if (ev.target.id !== "rv-sort") return;
  st.sort = ev.target.value;
  local.set("ae-sort", st.sort);
  drawResults();
});
actions["rv-seg"] = (el) => {
  st.seg = el.dataset.seg;
  st.filter = "all";
  st.limit = PAGE;
  drawResults();
};
actions["rv-filter"] = (el) => {
  st.filter = el.dataset.f;
  st.limit = PAGE;
  drawResults();
};
actions["rv-more"] = () => {
  st.limit += PAGE;
  drawResults();
};
/** 点进一份：还在同一串列表的这一轮里就接着用，否则把现在的列表冻结成新的一轮 */
actions["rv-open"] = (el) => {
  const id = el.dataset.id;
  if (!(round && round.key === shown?.key && round.ids.includes(id))) startRound(shown);
  location.hash = draftHref(id);
};
actions["rv-start"] = () => {
  if (!shown?.ids.length) return;
  startRound(shown);
  location.hash = draftHref(shown.ids[0]);
};
actions["rv-resume"] = () => {
  const id = round && (round.at && !round.done[round.at] ? round.at : nextOpen(round.at));
  if (id) location.hash = draftHref(id);
};
actions["rv-drop"] = () => {
  round = null;
  saveRound();
  drawResults();
};

// ----- 一轮审完 -----

function roundEnd() {
  if (!round) return empty("没有正在进行的审核", `<a class="btn sm" href="#/me/admin?tab=entries">回到稿子</a>`);
  const n = (v) => Object.values(round.done).filter((x) => x === v).length;
  const left = roundLeft().length;
  const parts = [
    n("ok") && `核对通过 <b>${n("ok")}</b>`,
    n("pub") && `先发布 <b>${n("pub")}</b>`,
    n("skip") && `跳过 <b>${n("skip")}</b>`,
    n("del") && `删除 <b>${n("del")}</b>`,
    n("seen") && `本来就好的 <b>${n("seen")}</b>`,
    left && `没看 <b>${left}</b>`,
  ].filter(Boolean);
  return `<section class="rv-end panel-card">
    <span class="rv-end-mark">${icon("check")}</span>
    <h2>${left ? "这一轮先到这里" : "这一轮审完了"}</h2>
    <p>${esc(round.label)} · 共 ${round.ids.length} 份</p>
    <p class="rv-end-sum">${parts.join("<span>·</span>") || "什么也没做"}</p>
    <div class="btnrow">
      ${n("skip") ? `<button class="btn sm" data-action="rv-again">回头看跳过的 ${n("skip")} 份</button>` : ""}
      ${left ? `<button class="btn sm" data-action="rv-resume">接着审剩下的 ${left} 份</button>` : ""}
      <a class="btn sm primary" href="#/me/admin?tab=entries">回到稿子</a>
    </div>
  </section>`;
}

actions["rv-again"] = () => {
  for (const [id, v] of Object.entries(round.done)) if (v === "skip") delete round.done[id];
  saveRound();
  const id = round.ids.find((x) => !round.done[x]);
  if (id) goDraft(id);
};

// ----- 加词：给别的 AI 出题（指定词 / 让它选词 / 从文章找词 / 补写原书词条），再把结果粘回来 -----

const MODES = [
  ["new", "指定词", "填想写的词，可以附要求"],
  ["pick", "让 AI 选词", "给方向和数量，它来挑"],
  ["text", "从文章找词", "粘一段英文，从里面挑"],
  ["patch", "补写原书词条", "给书里的词补字段"],
];
/** 附多少已有词条：全部清单一万多字，只写一两个词时没必要全带 */
const CATALOGS = {
  near: ["只附相关的", "只附和要写的词拼写、内容相近的几十个已有词条。提示词最短，“词的关系”也还能写。"],
  ids: ["只列 id", "列出全部已有词条的 id（几千字），够用来避开已收录的词、写“词的关系”。"],
  full: ["完整清单", "全部已有词条连同释义（一万多字）。写“词的关系”最准，提示词也最长。"],
  none: ["不附", "不附清单，提示词最短；“词的关系”留空，查重交给导入时的校验。"],
};
const CATALOG_FOR = { new: ["near", "ids", "full", "none"], pick: ["ids", "full", "none"], text: ["ids", "full", "none"], patch: ["near", "ids", "full", "none"] };
const TASTES = [
  ["common", "常用词"],
  ["rare", "冷门有趣"],
  ["any", "不限"],
];

function addSec() {
  return `<div class="admin-grid">
    <section class="panel-card wide">
      <div class="sec-head"><h2>给 AI 出题</h2><span>生成提示词，交给别的 AI 写，再粘回来</span></div>
      <div class="ae-modes" role="tablist" aria-label="怎么出题">${MODES.map(([k, name, sub]) => `<button role="tab" data-action="ae-mode" data-mode="${k}" aria-selected="${k === st.mode}"><b>${name}</b><small>${sub}</small></button>`).join("")}</div>
      <div id="ae-quick">${quickBody()}</div>
    </section>

    <section class="panel-card wide">
      <div class="sec-head"><h2>导回 AI 的结果</h2><span>粘贴它返回的 JSON</span></div>
      <textarea id="ae-paste" class="ae-text" rows="6" placeholder='把 AI 的整段回复粘进来就行，会自动找出里面的 JSON。&#10;格式：{"format":"ety-entry/1","entries":[…]}' spellcheck="false">${esc(st.paste)}</textarea>
      <div class="btnrow"><button class="btn sm primary" data-action="ae-import">校验并存为草稿</button><small class="hint">有错误也会先存下来，改好才能发布。也可以用 MCP 让 AI 直接提交，见“设置”。</small></div>
      <div id="ae-results">${st.results ? importResults(st.results) : ""}</div>
    </section>
  </div>`;
}

const pills = (key, opts, cur) =>
  `<div class="ae-pills" role="group">${opts.map(([v, name]) => `<button data-action="ae-set" data-k="${key}" data-v="${v}" aria-pressed="${String(v) === String(cur)}">${name}</button>`).join("")}</div>`;
const field = (label, html) => `<div class="ae-field"><span class="ae-flabel">${label}</span>${html}</div>`;

/** 出题卡片的主体：各方式自己的输入 + 附多少已有词条 + 生成按钮 + 预览 */
function quickBody() {
  const inputs = { new: quickNew, pick: quickPick, text: quickText, patch: quickPatch }[st.mode]();
  const ready = st.mode === "patch" ? st.picks.length > 0 : true;
  const cat = st.cats[st.mode];
  return `${inputs}
    ${field("附上已有词条", `${pills("cat", CATALOG_FOR[st.mode].map((k) => [k, CATALOGS[k][0]]), cat)}<small class="hint">${CATALOGS[cat][1]}</small>`)}
    <div class="btnrow ae-gen">
      ${st.mode === "new" ? `<button class="btn sm" data-action="ae-lookup">查重</button>` : ""}
      <button class="btn sm primary" data-action="ae-context" data-kind="copy" ${ready ? "" : "disabled"}>${icon("copy")}复制提示词</button>
      <button class="btn sm" data-action="ae-context" data-kind="preview" ${ready ? "" : "disabled"}>${icon("eye")}预览</button>
      <button class="btn sm ghost" data-action="ae-context" data-kind="download" ${ready ? "" : "disabled"}>${icon("down")}.md</button>
    </div>
    <div id="ae-preview">${previewBox()}</div>`;
}

function quickNew() {
  return `
    <textarea id="ae-words" class="ae-text" rows="5" placeholder="每行一个词，冒号后面可以写要求，比如&#10;serendipity：重点讲 Walpole 那封信&#10;petrichor&#10;quarantine：讲清楚和“40 天”的关系" spellcheck="false">${esc(st.words)}</textarea>
    <small class="hint">一个词也行，十几个也行；没写要求的照通用规范写。已收录的词会自动跳过。</small>
    <div id="ae-lookup">${st.lookup ? lookupList(st.lookup) : ""}</div>`;
}

function quickPick() {
  const p = st.pick;
  return `
    <div class="ae-fgrid">
      ${field("专题", `<select id="ae-theme" class="ae-input"><option value="">不限</option>${Object.keys(THEMES).map((t) => `<option ${t === p.theme ? "selected" : ""}>${t}</option>`).join("")}</select>`)}
      ${field("方向（可选）", `<input id="ae-hint" class="ae-input" maxlength="200" placeholder="比如：来自航海的词、和食物有关、法语借词" value="${esc(p.hint)}" autocomplete="off">`)}
    </div>
    <div class="ae-fgrid">
      ${field("挑几个", pills("count", [3, 5, 10, 20].map((n) => [n, `${n} 个`]), p.count))}
      ${field("偏好", pills("taste", TASTES, p.taste))}
    </div>`;
}

function quickText() {
  return `
    <textarea id="ae-article" class="ae-text" rows="7" maxlength="8000" placeholder="粘一段英文：新闻、小说片段、课文都行（不超过 8000 字）。AI 会从里面挑来历有故事、还没收录的词，第一条例句用原文的句子。" spellcheck="false">${esc(st.text)}</textarea>
    ${field("挑几个", pills("textCount", [3, 5, 10].map((n) => [n, `最多 ${n} 个`]), st.textCount))}`;
}

function quickPatch() {
  return `
    <div class="ae-pick">
      <input id="ae-book" type="search" placeholder="搜原书词条，比如 alcohol" autocomplete="off" maxlength="40">
      <div class="suggest" id="ae-book-hits"></div>
    </div>
    <div class="ae-picked">${st.picks.map((p) => `<button class="ae-chip" data-action="ae-unpick" data-id="${esc(p.id)}" title="移除">${esc(p.headword)} ✕</button>`).join("") || `<span class="hint">还没挑词。可以一次挑好几个。</span>`}</div>
    <fieldset class="ae-fields"><legend>补写哪些字段</legend>${Object.entries(FIELD_NAMES)
      .map(([k, name]) => `<label><input type="checkbox" name="ae-field" value="${k}" ${st.fields.includes(k) ? "checked" : ""}>${name}</label>`)
      .join("")}</fieldset>
    <small class="hint">原书的正文、释义、例句不能改，只能补这些编辑字段；“词的关系”是追加，不会删掉原有的。补写的内容在文章页会标明来源。</small>`;
}

/** 提示词预览：可以直接在框里改，再复制改过的 */
const previewBox = () =>
  st.preview
    ? `<div class="ae-preview">
        <div class="ae-preview-head"><b>提示词预览</b><span>${st.preview.length.toLocaleString()} 字 · 可以直接改</span><button class="text-btn" data-action="ae-preview-close">收起</button></div>
        <textarea id="ae-preview-text" class="ae-text ae-code" rows="14" spellcheck="false">${esc(st.preview)}</textarea>
        <div class="btnrow"><button class="btn sm primary" data-action="ae-preview-copy">${icon("copy")}复制这段</button></div>
      </div>`
    : "";

const lookupList = (rows) =>
  `<ul class="ae-lookup">${rows
    .map((l) => `<li>${chip(LOOKUP[l.status])}<b>${esc(l.word)}</b>${l.target
      ? `<span>→ <a href="#/w/${esc(l.target.id)}">${esc(l.target.headword)}</a>${l.target.meaning ? ` ${esc(l.target.meaning)}` : ""}</span>`
      : `<span class="m">id：${esc(l.id)}</span>`}${l.draft ? ` <a class="text-btn" href="${draftHref(l.draft.id)}">看稿子</a>` : ""}</li>`)
    .join("")}</ul>`;

let bookTimer;
document.addEventListener("input", (ev) => {
  const t = ev.target;
  if (t.id === "ae-words") st.words = t.value;
  if (t.id === "ae-paste") st.paste = t.value;
  if (t.id === "ae-hint") st.pick.hint = t.value;
  if (t.id === "ae-article") st.text = t.value;
  if (t.id === "ae-preview-text") st.preview = t.value;
  if (t.id === "ae-book") {
    clearTimeout(bookTimer);
    bookTimer = setTimeout(async () => {
      const q = t.value.trim();
      const hits = q ? await fresh(`/admin/entries/book?q=${encodeURIComponent(q)}`).catch(() => []) : [];
      const box = document.getElementById("ae-book-hits");
      if (box) box.innerHTML = hits.map((h) => `<button type="button" data-action="ae-pick" data-id="${esc(h.id)}" data-name="${esc(h.headword)}"><b>${esc(h.headword)}</b><span>${esc(h.meaning ?? "")}</span></button>`).join("");
    }, 160);
  }
});
document.addEventListener("change", async (ev) => {
  const t = ev.target;
  if (t.name === "ae-field") st.fields = [...document.querySelectorAll("input[name=ae-field]:checked")].map((x) => x.value);
  if (t.id === "ae-theme") st.pick.theme = t.value;
  if (t.id === "ae-daily") {
    try {
      const r = await api("/admin/entries/settings", { method: "PUT", body: { aiInDaily: t.checked } });
      toast(r.aiInDaily ? "核对过的新词会进入每日推送" : "新词不再进入每日推送");
    } catch (e) {
      t.checked = !t.checked;
      toast(e.message);
    }
  }
});

const redrawQuick = () => {
  const box = document.getElementById("ae-quick");
  if (box) box.innerHTML = quickBody();
};
actions["ae-mode"] = (el) => {
  st.mode = el.dataset.mode;
  st.preview = null;
  local.set("ae-add-mode", st.mode);
  for (const b of document.querySelectorAll(".ae-modes button")) b.setAttribute("aria-selected", String(b === el));
  redrawQuick();
};
/** 出题卡片里的小选项：附多少已有词条、挑几个、偏好 */
actions["ae-set"] = (el) => {
  const { k, v } = el.dataset;
  if (k === "cat") {
    st.cats[st.mode] = v;
    local.set("ae-cats", st.cats);
  } else if (k === "count") st.pick.count = Number(v);
  else if (k === "taste") st.pick.taste = v;
  else if (k === "textCount") st.textCount = Number(v);
  st.preview = null;
  redrawQuick();
};
actions["ae-pick"] = (el) => {
  if (!st.picks.some((p) => p.id === el.dataset.id)) st.picks.push({ id: el.dataset.id, headword: el.dataset.name });
  redrawQuick();
  document.getElementById("ae-book")?.focus();
};
actions["ae-unpick"] = (el) => {
  st.picks = st.picks.filter((p) => p.id !== el.dataset.id);
  redrawQuick();
};

actions["ae-lookup"] = async () => {
  if (!st.words.trim()) return toast("先写几个词，每行一个");
  st.lookup = await api("/admin/entries/lookup", { method: "POST", body: { words: st.words } });
  document.getElementById("ae-lookup").innerHTML = lookupList(st.lookup);
};

/** 现在这个出题方式要发给后台的参数 */
function contextBody() {
  const catalog = st.cats[st.mode];
  if (st.mode === "patch") return { mode: "patch", ids: st.picks.map((p) => p.id), fields: st.fields, catalog };
  if (st.mode === "pick") return { mode: "pick", ...st.pick, catalog };
  if (st.mode === "text") return { mode: "text", text: st.text, count: st.textCount, catalog };
  return { mode: "new", words: st.words, catalog };
}

/** 复制、预览或下载给别的 AI 的提示词（出题卡片里的四种方式，以及审稿页的“修改一份稿子”） */
actions["ae-context"] = async (el) => {
  const body = el.dataset.mode === "revise" ? { mode: "revise", id: el.dataset.id, notes: document.getElementById("ae-notes")?.value ?? "" } : contextBody();
  if (body.mode === "new" && !st.words.trim()) return toast("先写几个要加的词");
  if (body.mode === "text" && !st.text.trim()) return toast("先粘一段英文");
  el.disabled = true;
  try {
    const { text } = await api("/admin/entries/context", { method: "POST", body });
    if (el.dataset.kind === "preview") {
      st.preview = text;
      document.getElementById("ae-preview").innerHTML = previewBox();
    } else if (el.dataset.kind === "download") {
      const name = { revise: `修改-${body.id}`, patch: "补写原书词条", pick: "AI选词", text: "文章找词" }[body.mode] ?? "新词";
      const a = Object.assign(document.createElement("a"), {
        href: URL.createObjectURL(new Blob([text], { type: "text/markdown" })),
        download: `词源一日-${name}-${new Date().toISOString().slice(0, 10)}.md`,
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } else {
      await copy(text, `已复制（${text.length.toLocaleString()} 字），粘给 AI 就行`);
    }
  } catch (e) {
    toast(e.message);
  } finally {
    el.disabled = false;
  }
};
actions["ae-preview-close"] = () => {
  st.preview = null;
  document.getElementById("ae-preview").innerHTML = "";
};
actions["ae-preview-copy"] = () => copy(st.preview ?? "", `已复制（${(st.preview ?? "").length.toLocaleString()} 字），粘给 AI 就行`);

function importResults(rows) {
  const saved = rows.filter((r) => r.saved).length;
  return `<ul class="ae-results">${rows
    .map((r) => {
      const errs = r.issues?.errors ?? [];
      const warns = r.issues?.warnings ?? [];
      const state = r.error ? chip(["没存", "err"]) : r.unchanged ? chip(["没有变化", "off"]) : errs.length ? chip(["已存 · 有错误", "warn"]) : chip(["已存", "ok"]);
      return `<li>
        <div>${state}<b>${esc(r.headword || r.id || "")}</b>${r.mode === "patch" ? chip(["补写", ""]) : ""}
          ${r.id && !r.error ? `<a class="text-btn" href="${draftHref(r.id)}">打开</a>` : ""}</div>
        ${r.error ? `<p class="err">${esc(r.error)}</p>` : ""}
        ${(r.fixes ?? []).length ? `<p class="fix">自动修正：${r.fixes.map(esc).join("；")}</p>` : ""}
        ${errs.length ? `<p class="err">${errs.map(esc).join("；")}</p>` : ""}
        ${warns.length ? `<p class="warn">${warns.map(esc).join("；")}</p>` : ""}
      </li>`;
    })
    .join("")}</ul>
    ${saved ? `<div class="btnrow"><button class="btn sm primary" data-action="ae-review-batch">去审核这 ${saved} 份${icon("arrow")}</button></div>` : ""}`;
}

actions["ae-import"] = async (el) => {
  if (!st.paste.trim()) return toast("先把 AI 返回的内容粘进来");
  el.disabled = true;
  try {
    const { results } = await api("/admin/entries/import", { method: "POST", body: { text: st.paste } });
    st.results = results;
    const saved = results.filter((r) => r.saved).length;
    toast(saved ? `存了 ${saved} 份稿子` : "没有新的改动");
    if (saved) st.paste = "";
    await redraw();
  } catch (e) {
    st.results = [{ error: e.message, headword: "导入" }];
    document.getElementById("ae-results").innerHTML = importResults(st.results);
  } finally {
    el.disabled = false;
  }
};

/** 刚导入的这批直接排成一轮来审 */
actions["ae-review-batch"] = () => {
  const ids = [...new Set((st.results ?? []).filter((r) => r.saved && r.id).map((r) => r.id))];
  if (!ids.length) return;
  startRound({ key: "import", label: "刚导入的一批", ids, heads: Object.fromEntries(st.results.filter((r) => r.id).map((r) => [r.id, r.headword || r.id])) });
  st.results = null;
  st.sec = "review";
  local.set("ae-sec", st.sec);
  location.hash = draftHref(ids[0]);
};

// ----- 读者报错 -----

function reportsSec(reports) {
  const open = reports.filter((r) => !r.resolvedAt);
  const list = st.reportsAll ? reports : open;
  return `<section class="panel-card">
    <div class="sec-head"><h2>读者报错</h2><span>${open.length ? `${open.length} 条没处理` : "都处理完了"}</span></div>
    <div class="subs" role="group" aria-label="显示">
      <button data-action="ae-reports-all" data-all="false" aria-pressed="${!st.reportsAll}">没处理的<span>${open.length}</span></button>
      <button data-action="ae-reports-all" data-all="true" aria-pressed="${st.reportsAll}">全部<span>${reports.length}</span></button>
    </div>
    <ul class="ae-reports">${list.map(reportRow).join("") || `<li class="adm-empty">${reports.length ? "没有要处理的报错" : "还没有人报错"}</li>`}</ul>
  </section>`;
}

function reportRow(r) {
  return `<li class="${r.resolvedAt ? "done" : ""}">
    <div><a href="#/w/${esc(r.entryId)}">${esc(r.headword)}</a>${r.book ? chip(["原书", ""]) : ""}<time>${esc(r.user ?? "已删除的成员")} · ${when(r.at)}</time></div>
    <p>${esc(r.text)}</p>
    <div class="acts">
      ${r.draft ? `<a class="text-btn" href="${draftHref(r.entryId)}">去改稿子</a>` : ""}
      <button class="text-btn" data-action="ae-report" data-id="${r.id}" data-reopen="${!!r.resolvedAt}">${r.resolvedAt ? "重新打开" : "处理完了"}</button>
    </div>
  </li>`;
}

actions["ae-reports-all"] = (el) => {
  st.reportsAll = el.dataset.all === "true";
  redraw();
};
actions["ae-report"] = async (el) => {
  await api(`/admin/entries/reports/${el.dataset.id}/resolve`, { method: "POST", body: { reopen: el.dataset.reopen === "true" } });
  redraw();
};

// ----- 设置 -----

async function settingsSec(o) {
  return `<div class="admin-grid">
    <section class="panel-card">
      <div class="sec-head"><h2>推送与并回仓库</h2></div>
      <div class="adm-opt">
        <div class="txt"><b>核对过的新词进入每日推送</b><small>关着时新词只出现在探索和搜索里；打开后，标为“已核对”的新词也会被推送、推荐和出题。待核对的始终不进。</small></div>
        <label class="switch"><input type="checkbox" id="ae-daily" aria-label="核对过的新词进入每日推送" ${o.aiInDaily ? "checked" : ""}><span></span></label>
      </div>
      <p class="hint">新词存在数据库里，部署不会覆盖。想把它们写进仓库的 entries.json（随代码备份、进版本管理），先下载，再在本机运行：</p>
      <pre class="ae-cmd">npm run admin -- merge-added 下载的文件.json</pre>
      <a class="btn sm" href="/api/admin/entries/export" download>${icon("down")}下载已发布的新词</a>
    </section>
    ${await tokensCard()}
  </div>`;
}

// ---------- 审一份稿子 ----------

let cur = null; // 正在看的稿子
let compare = null; // { id, ver, data }：正在对比的历史版本

async function draftView(id) {
  cur = await fresh(`/admin/entries/d/${encodeURIComponent(id)}`).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
  if (!cur) {
    if (round?.ids.includes(id)) {
      round.done[id] = "del";
      saveRound();
    }
    return empty("没有这份稿子（可能已经删掉了）", `<a class="btn sm" href="#/me/admin?tab=entries">回到稿子</a>`);
  }
  if (compare?.id !== id) compare = null;
  await ensureRound(id);
  round.at = id;
  round.heads[id] = cur.headword;
  saveRound();

  const d = cur.data;
  const m = d.meta;
  const e = d.entry;
  const live = isLive(cur);
  const head = cur.mode === "patch" ? cur.book ?? {} : e;
  return `<div class="rv">
    ${reviewBar(id)}
    <header class="rv-head">
      <div class="rv-tags">${cur.mode === "patch" ? chip(["补写原书词条", ""]) : chip(["新词", ""])}${chip(STATUS[cur.status])}${live ? srcChip({ kind: cur.live.meta.kind, checked: !!cur.live.meta.checked }) : ""}</div>
      <h2>${esc(cur.headword)}${head.ipa ? `<span class="ipa">/${esc(head.ipa)}/</span>` : ""}${head.pos ? `<span class="pos">${esc(head.pos)}</span>` : ""}</h2>
      ${head.meaning ? `<p class="rv-meaning">${esc(head.meaning)}</p>` : ""}
      <p class="rv-by">${esc(cur.createdBy)} 建于 ${when(cur.createdAt)} · ${esc(cur.updatedBy)} 改于 ${when(cur.updatedAt)}${cur.publishedAt ? ` · 发布于 ${when(cur.publishedAt)}` : ""}</p>
      <div class="rv-links">
        <a class="btn sm" href="#/w/${encodeURIComponent(cur.id)}?draft=1">${icon("eye")}按文章页预览</a>
        ${live ? `<a class="btn sm ghost" href="#/w/${encodeURIComponent(cur.id)}">看线上版本</a>` : ""}
      </div>
    </header>

    <div class="rv-main">
      <section class="panel-card rv-doc">
        ${cur.status === "changed" && cur.live ? `<details class="rv-fold rv-changed" open><summary>和线上版本比，这次改了什么</summary>${diffView(cur.live, cur.data, "线上", "这次")}</details>` : ""}
        ${cur.mode === "patch" ? patchCompare() : docView(e)}
      </section>
      <aside class="rv-side">${checkCard(m)}</aside>
    </div>

    <div class="rv-folds">
      <details class="rv-fold">
        <summary>让 AI 改</summary>
        <textarea id="ae-notes" class="ae-text" rows="3" placeholder="写给 AI 的修改意见（可选），比如“例句再加一条”。格式问题和读者报错会自动带上。"></textarea>
        <div class="btnrow"><button class="btn sm" data-action="ae-context" data-mode="revise" data-kind="copy" data-id="${esc(cur.id)}">${icon("copy")}复制修改上下文</button></div>
        <small class="hint">AI 改好后，把结果粘到“加词”里的“导回 AI 的结果”，会更新这份稿子并留下历史版本。</small>
      </details>
      <details class="rv-fold">
        <summary>直接编辑 JSON<span>id 不能改</span></summary>
        <textarea id="ae-json" class="ae-text ae-code" rows="18" spellcheck="false">${esc(JSON.stringify({ entry: d.entry, meta: { kind: m.kind, model: m.model, sources: m.sources, doubts: m.doubts } }, null, 2))}</textarea>
        <div class="btnrow"><button class="btn sm primary" data-action="ae-save">保存</button><small class="hint">⌘/Ctrl + 回车也能保存。保存会留一个历史版本；已发布的词要再发布一次才会更新线上。</small></div>
      </details>
      <details class="rv-fold" ${compare ? "open" : ""}>
        <summary>版本历史<span>${cur.revisions.length} 个</span></summary>
        <ul class="ae-revs">${cur.revisions
          .map((r) => `<li class="${compare?.ver === r.ver ? "on" : ""}"><b>第 ${r.ver} 版</b><span>${esc(r.note)}</span><time>${esc(r.by)} · ${when(r.at)}</time>
            <span class="acts"><button class="text-btn" data-action="ae-diff" data-ver="${r.ver}">${compare?.ver === r.ver ? "收起" : "和现在对比"}</button><button class="text-btn" data-action="ae-rollback" data-ver="${r.ver}">回滚到这版</button></span></li>`)
          .join("")}</ul>
        <div id="ae-diff">${compare ? diffView(compare.data, cur.data, `第 ${compare.ver} 版`, "现在") : ""}</div>
      </details>
      <details class="rv-fold">
        <summary>${live ? "撤下" : "删除"}这份稿子</summary>
        ${live
          ? `<p class="hint">撤下后读者就看不到了（读过、收藏的记录还在），稿子保留，随时可以再发布。</p><button class="btn sm danger" data-action="ae-unpublish">撤下 ${esc(cur.headword)}</button>`
          : `<p class="hint">删除稿子和所有历史版本，不能恢复。</p><button class="btn sm danger" data-action="ae-delete">删除 ${esc(cur.headword)}</button>`}
      </details>
    </div>

    ${dock()}
  </div>`;
}

/** 顶上的审核条：回到列表、这一轮的进度、上一份 / 下一份 */
function reviewBar(id) {
  const i = round.ids.indexOf(id);
  const total = round.ids.length;
  const done = total - roundLeft().length;
  const nav = (j, dir) => {
    const x = round.ids[j];
    const name = dir === "left" ? "上一份" : "下一份";
    return x
      ? `<a class="icon-btn rv-step" href="${draftHref(x)}" data-action="rv-go" data-id="${esc(x)}" data-key="${dir}" title="${name}：${esc(round.heads[x] ?? x)}（${dir === "left" ? "←" : "→"}）" aria-label="${name}">${icon(dir)}</a>`
      : `<span class="icon-btn rv-step off" aria-hidden="true">${icon(dir)}</span>`;
  };
  return `<div class="rv-bar">
    <a class="rv-back" href="#/me/admin?tab=entries">${icon("left")}<span>稿子</span></a>
    <div class="rv-prog" title="${esc(round.label)}">
      <span><b>${i + 1}</b> / ${total}<small>${esc(round.label)} · 已处理 ${done}</small></span>
      <i><span style="width:${total ? (done / total) * 100 : 0}%"></span></i>
    </div>
    ${nav(i - 1, "left")}${nav(i + 1, "right")}
  </div>`;
}

/** 正文：按文章页的顺序把内容摆出来，不用跳去预览也能读完 */
function docView(e) {
  const era = e.era == null ? "" : e.era < 0 ? `公元前 ${-e.era} 世纪` : `${e.era} 世纪`;
  const meta = [
    ["专题", [(e.themes ?? []).join("、"), e.subtheme].filter(Boolean).join(" · ")],
    ["语源", (e.langs ?? []).join(" · ")],
    ["年代", era],
    ["亦作", (e.variants ?? []).join(", ")],
    ["参见", (e.seeAlso ?? []).join(", ")],
  ].filter((r) => r[1]);
  const part = (name, html) => `<h3 class="rv-h">${name}</h3>${html}`;
  return `
    ${e.teaser ? `<p class="rv-teaser">${rich(e.teaser)}</p>` : ""}
    ${part("词源", (e.etymology ?? []).map((p) => `<p>${rich(p)}</p>`).join("") || `<p class="hint">（没有正文）</p>`)}
    ${e.evolution?.length ? part("词义演变", `<ol class="rv-evo">${e.evolution.map((x) => `<li>${rich(x)}</li>`).join("")}</ol>`) : ""}
    ${e.keyline ? part("一句话记住", `<blockquote class="rv-key">${rich(e.keyline)}</blockquote>`) : ""}
    ${e.examples?.length ? part("例句", `<ul class="rv-ex">${e.examples.map((x) => `<li><span lang="en">${rich(x.en)}</span><span>${esc(x.zh)}</span></li>`).join("")}</ul>`) : ""}
    ${e.links?.length ? part("词的关系", `<ul class="rv-rel">${e.links.map((l) => `<li><b>${esc(l.type)}</b><a href="#/w/${encodeURIComponent(l.id)}">${esc(l.id)}</a><span>${esc(l.why)}</span></li>`).join("")}</ul>`) : ""}
    ${meta.length ? `<dl class="rv-dl">${meta.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}`;
}

/** 补写：原书原来的样子 vs 补写的 */
function patchCompare() {
  const e = cur.data.entry;
  const show = (v) => (v === undefined ? `<span class="hint">（没有）</span>` : `<pre>${esc(typeof v === "string" ? v : JSON.stringify(v, null, 1))}</pre>`);
  const rows = Object.keys(FIELD_NAMES).filter((k) => e[k] !== undefined);
  return `<h3 class="rv-h">补写的内容 · 和原书对照</h3>
    <table class="ae-cmp"><thead><tr><th></th><th>原来</th><th>补写</th></tr></thead><tbody>${rows
      .map((k) => `<tr><th>${FIELD_NAMES[k]}</th><td>${show(cur.book?.[k])}</td><td>${show(e[k])}${k === "links" ? `<small class="hint">追加在原有关系后面</small>` : ""}</td></tr>`)
      .join("")}</tbody></table>`;
}

/** 右栏：逐项核对（格式问题、读者报错、AI 的存疑、参考来源） */
function checkCard(m) {
  const { errors, warnings } = cur.issues;
  const reports = cur.reports.filter((r) => !r.resolvedAt);
  return `<section class="panel-card rv-check">
    <h3 class="rv-h">核对</h3>
    ${errors.length || warnings.length
      ? `<ul class="ae-issues">${errors.map((x) => `<li class="err">${esc(x)}</li>`).join("")}${warnings.map((x) => `<li class="warn">${esc(x)}</li>`).join("")}</ul>`
      : `<p class="rv-pass">${icon("check")}格式检查通过</p>`}
    ${reports.length ? `<p class="ae-label">读者报错</p><ul class="ae-issues">${reports.map((r) => `<li class="err">${esc(r.text)}<button class="text-btn" data-action="ae-report" data-id="${r.id}" data-reopen="false">处理完了</button></li>`).join("")}</ul>` : ""}
    <p class="ae-label">${m.doubts.length ? `AI 拿不准的地方 · 核对后逐条打勾` : "AI 拿不准的地方"}</p>
    ${m.doubts.length
      ? `<ul class="ae-doubts">${m.doubts.map((x, i) => `<li><label><input type="checkbox" name="ae-doubt" value="${i}">${esc(x)}</label></li>`).join("")}</ul>`
      : `<p class="hint">AI 没有列出存疑之处。</p>`}
    <p class="ae-label">参考来源</p>
    <ul class="ae-sources">${m.sources.map((s) => `<li>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>` : esc(s.title)}</li>`).join("") || `<li class="err">没有参考来源</li>`}</ul>
    <p class="hint">${m.kind === "manual" ? "编辑撰写" : `AI 生成${m.model ? `（${esc(m.model)}）` : ""}`}${({ import: " · 后台导入", mcp: " · MCP 提交", manual: " · 后台编辑" })[m.via] ?? ""}</p>
  </section>`;
}

/** 底部的决定栏：这一份现在能做什么。要“核对通过”的按钮，得先把存疑逐条勾完 */
function dock() {
  const errs = cur.issues.errors.length;
  const manual = cur.data.meta.kind === "manual";
  const liveChecked = !!cur.live?.meta.checked;
  const doubts = cur.data.meta.doubts.length; // 刚打开时一条都没勾
  const next = nextOpen(cur.id);
  const say = (text, tone = "") => `<p class="rv-say ${tone}">${text}</p>`;
  const pass = (label) => `<button class="btn sm primary" data-action="rv-publish" data-checked="true" data-needs-doubts ${doubts ? "disabled" : ""}>${icon("check")}${label}</button>`;
  const later = `<button class="btn sm" data-action="rv-publish" data-checked="false">先发布（待核对）</button>`;
  let text;
  let acts = "";
  if (cur.status === "merged") text = say("已并入数据文件，以文件为准", "off");
  else if (errs) text = say(`还有 ${errs} 个错误，改好才能发布`, "err");
  else if (cur.status === "live" && (liveChecked || manual)) text = say(`${icon("check")}已发布${manual ? "" : "，也核对过了"}`, "ok");
  else if (cur.status === "live") {
    text = say("已发布，还没核对");
    acts = pass("核对通过");
  } else {
    text = say({ draft: "草稿 · 读者还看不到", changed: "线上还是旧版，这次的改动没发布", archived: "已撤下 · 读者看不到" }[cur.status] ?? "");
    acts = manual ? pass("发布") : later + pass("核对通过并发布");
  }
  // 没有可做的事时，“下一份”就是主按钮；本来就处理好了的（已发布已核对）记成“看过”，有错误发不了的记成跳过
  const mark = errs ? "skip" : acts ? "skip" : "seen";
  const step = `<button class="btn sm${acts ? " ghost" : " primary"}" data-action="rv-step" data-mark="${mark}">${next ? `${acts ? "跳过" : "下一份"}${icon("arrow")}` : acts ? "跳过，结束这一轮" : "结束这一轮"}</button>`;
  const tip = doubts && acts.includes("data-needs-doubts");
  return `<div class="rv-dock" role="region" aria-label="审核决定">
    <div class="rv-dock-in">
      <div class="rv-says">${text}<p class="rv-say rv-doubt-left warn" ${tip ? "" : "hidden"}>还有 ${doubts} 条存疑没勾</p></div>
      <div class="rv-acts">${step}${acts}</div>
    </div>
  </div>`;
}

/** 存疑没勾完时，要“核对通过”的按钮不能点，并说还差几条 */
function syncDoubts() {
  const all = [...document.querySelectorAll("input[name=ae-doubt]")];
  const left = all.filter((x) => !x.checked).length;
  for (const b of document.querySelectorAll("[data-needs-doubts]")) b.disabled = left > 0;
  const tip = document.querySelector(".rv-doubt-left");
  if (tip) {
    tip.hidden = !left || !document.querySelector("[data-needs-doubts]");
    tip.textContent = `还有 ${left} 条存疑没勾`;
  }
}
document.addEventListener("change", (ev) => {
  if (ev.target.name === "ae-doubt") syncDoubts();
});

/** 处理完一份：记进这一轮，打开下一份没处理的；都处理完了就是收尾页 */
function advance(mark) {
  if (round && cur) {
    round.done[cur.id] = mark;
    saveRound();
  }
  const next = nextOpen(cur?.id);
  if (next) goDraft(next);
  else goEnd();
}

actions["rv-publish"] = async (el) => {
  const checked = el.dataset.checked === "true";
  const btns = [...document.querySelectorAll(".rv-dock button")];
  for (const b of btns) b.disabled = true;
  try {
    await api(`/admin/entries/d/${encodeURIComponent(cur.id)}/publish`, { method: "POST", body: { checked } });
    toast(`${cur.headword} ${checked ? "已发布 · 已核对" : "已发布 · 待核对"}`);
    advance(checked ? "ok" : "pub");
  } catch (e) {
    toast(e.message);
    for (const b of btns) b.disabled = false;
    syncDoubts();
  }
};
actions["rv-step"] = (el) => advance(el.dataset.mark);
actions["rv-go"] = (el) => goDraft(el.dataset.id);

// 键盘：← → 翻上一份 / 下一份，⌘/Ctrl + 回车 = 决定栏的主按钮（在 JSON 编辑器里是保存）
document.addEventListener("keydown", (ev) => {
  if (!document.querySelector(".rv")) return;
  const t = ev.target;
  if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
    const btn = t.id === "ae-json" ? document.querySelector("[data-action=ae-save]") : document.querySelector(".rv-dock .btn.primary");
    if (btn && !btn.disabled) {
      ev.preventDefault();
      btn.click();
    }
    return;
  }
  if (ev.metaKey || ev.ctrlKey || ev.altKey || t.closest?.("input, textarea, select, [contenteditable]")) return;
  const dir = ev.key === "ArrowLeft" ? "left" : ev.key === "ArrowRight" ? "right" : null;
  const a = dir && document.querySelector(`.rv-bar [data-key=${dir}]`);
  if (a) {
    ev.preventDefault();
    a.click();
  }
});

/** 两段文本的逐行对比（最长公共子序列；词条不大，直接算） */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push([" ", a[i++]]), j++;
    else if (L[i + 1][j] >= L[i][j + 1]) out.push(["-", a[i++]]);
    else out.push(["+", b[j++]]);
  }
  while (i < n) out.push(["-", a[i++]]);
  while (j < m) out.push(["+", b[j++]]);
  return out;
}

/** 两版稿子逐行对比（只比内容，不比核对信息） */
function diffView(from, to, fromName, toName) {
  const text = (d) => JSON.stringify({ entry: d.entry, meta: { kind: d.meta.kind, model: d.meta.model, sources: d.meta.sources, doubts: d.meta.doubts } }, null, 2).split("\n");
  const rows = diffLines(text(from), text(to));
  const changed = rows.filter((r) => r[0] !== " ").length;
  if (!changed) return `<p class="hint">${fromName}和${toName}的内容一样。</p>`;
  // 没变的行只留改动前后各 2 行
  const keep = rows.map((r, i) => r[0] !== " " || rows.slice(Math.max(0, i - 2), i + 3).some((x) => x[0] !== " "));
  let html = "";
  let skipped = false;
  rows.forEach((r, i) => {
    if (!keep[i]) {
      if (!skipped) html += `<li class="skip">…</li>`;
      skipped = true;
      return;
    }
    skipped = false;
    html += `<li class="${r[0] === "+" ? "add" : r[0] === "-" ? "del" : ""}"><i>${r[0]}</i>${esc(r[1])}</li>`;
  });
  return `<p class="hint">− ${fromName}　＋ ${toName}</p><ol class="ae-diff">${html}</ol>`;
}

actions["ae-diff"] = async (el) => {
  const ver = Number(el.dataset.ver);
  if (compare?.ver === ver) compare = null;
  else compare = { id: cur.id, ver, data: await fresh(`/admin/entries/d/${encodeURIComponent(cur.id)}/v/${ver}`) };
  for (const li of document.querySelectorAll(".ae-revs li")) {
    const on = compare && li.querySelector("[data-ver]")?.dataset.ver === String(compare.ver);
    li.classList.toggle("on", !!on);
    li.querySelector("[data-action=ae-diff]").textContent = on ? "收起" : "和现在对比";
  }
  document.getElementById("ae-diff").innerHTML = compare ? diffView(compare.data, cur.data, `第 ${compare.ver} 版`, "现在") : "";
};

actions["ae-rollback"] = async (el) => {
  if (!confirm(`把稿子回滚到第 ${el.dataset.ver} 版？会存成一个新版本，不会自动发布。`)) return;
  await api(`/admin/entries/d/${encodeURIComponent(cur.id)}/rollback`, { method: "POST", body: { ver: Number(el.dataset.ver) } });
  compare = null;
  toast(`已回滚到第 ${el.dataset.ver} 版`);
  redraw();
};

actions["ae-unpublish"] = async () => {
  if (!confirm(`撤下 ${cur.headword}？读者就看不到了（读过、收藏的记录还在），稿子保留，随时可以再发布。`)) return;
  await api(`/admin/entries/d/${encodeURIComponent(cur.id)}/unpublish`, { method: "POST" });
  toast("已撤下");
  redraw();
};

actions["ae-delete"] = async () => {
  if (!confirm(`删除 ${cur.headword} 的稿子和所有历史版本？不能恢复。`)) return;
  await api(`/admin/entries/d/${encodeURIComponent(cur.id)}`, { method: "DELETE" });
  toast("已删除");
  advance("del");
};

actions["ae-save"] = async (el) => {
  let data;
  try {
    data = JSON.parse(document.getElementById("ae-json").value);
  } catch (e) {
    return toast(`JSON 格式不对：${e.message}`);
  }
  el.disabled = true;
  try {
    const r = await api(`/admin/entries/d/${encodeURIComponent(cur.id)}`, { method: "PUT", body: data });
    toast(r.unchanged ? "没有改动" : r.issues.errors.length ? `已保存，还有 ${r.issues.errors.length} 个错误` : "已保存");
    redraw();
  } catch (e) {
    toast(e.message);
    el.disabled = false;
  }
};

// ---------- MCP 令牌 ----------

async function tokensCard() {
  const { tokens } = await fresh("/admin/tokens");
  const active = tokens.filter((t) => !t.revokedAt);
  const url = `${location.origin}/api/mcp`;
  return `<section class="panel-card wide">
    <div class="sec-head"><h2>MCP 令牌</h2><span>${active.length} 个可用</span></div>
    <p class="hint">让支持 MCP 的 AI 客户端（Claude Code、Claude Desktop、Cursor 等）直接查已有词条、取写作规范、校验并提交草稿。令牌只能读和交草稿，发布仍要你在这里点。</p>
    <div class="link-box"><input readonly value="${esc(url)}"><button class="btn sm" data-action="copy-text" data-text="${esc(url)}">复制地址</button></div>
    <form class="ae-token-form" id="ae-token-form">
      <input name="name" maxlength="30" placeholder="名字，比如“Claude Desktop”" autocomplete="off" required>
      <select name="scopes" aria-label="权限"><option value="read,draft">读 + 交草稿</option><option value="read">只读</option></select>
      <select name="days" aria-label="有效期"><option value="30">30 天</option><option value="90" selected>90 天</option><option value="365">1 年</option><option value="0">不过期</option></select>
      <button class="btn sm primary">生成令牌</button>
    </form>
    <div id="ae-token-new"></div>
    <ul class="invites ae-tokens">${tokens
      .map((t) => `<li class="${t.revokedAt ? "expired" : ""}"><b>${esc(t.name)}</b>
        <span>${t.scopes.includes("draft") ? "读 + 交草稿" : "只读"} · ${t.revokedAt ? `已吊销` : t.expiresAt ? `${when(t.expiresAt).split(" ").slice(0, -1).join(" ")}前有效` : "不过期"} · ${t.lastUsedAt ? `最近使用 ${when(t.lastUsedAt)}` : "还没用过"}</span>
        <span class="acts">${t.revokedAt ? "" : `<button class="text-btn" data-action="ae-revoke" data-id="${t.id}" data-name="${esc(t.name)}">吊销</button>`}</span></li>`)
      .join("") || `<li class="adm-empty">还没有令牌</li>`}</ul>
  </section>`;
}

document.addEventListener("submit", async (ev) => {
  if (ev.target.id !== "ae-token-form") return;
  ev.preventDefault();
  const f = ev.target;
  try {
    const r = await api("/admin/tokens", { method: "POST", body: { name: f.name.value.trim(), scopes: f.scopes.value.split(","), days: Number(f.days.value) } });
    const url = `${location.origin}/api/mcp`;
    const cmd = `claude mcp add --transport http etymology ${url} --header "Authorization: Bearer ${r.token}"`;
    const json = JSON.stringify({ mcpServers: { etymology: { type: "http", url, headers: { Authorization: `Bearer ${r.token}` } } } }, null, 2);
    document.getElementById("ae-token-new").innerHTML = `<div class="invite-new">
      <p>令牌只显示这一次，请现在保存：</p>
      <div class="link-box"><input readonly value="${esc(r.token)}"><button class="btn sm" data-action="copy-text" data-text="${esc(r.token)}">复制</button></div>
      <p>Claude Code 里运行：</p>
      <div class="link-box"><input readonly value="${esc(cmd)}"><button class="btn sm" data-action="copy-text" data-text="${esc(cmd)}">复制</button></div>
      <p>其他客户端的配置（JSON）：</p>
      <textarea class="links" readonly rows="8">${esc(json)}</textarea><button class="btn sm" data-action="copy-text" data-text="${esc(json)}">复制配置</button>
    </div>`;
    f.reset();
    copy(r.token, "令牌已复制");
  } catch (e) {
    toast(e.message);
  }
});

actions["ae-revoke"] = async (el) => {
  if (!confirm(`吊销令牌“${el.dataset.name}”？用它的 AI 客户端会立刻连不上。`)) return;
  await api(`/admin/tokens/${el.dataset.id}`, { method: "DELETE" });
  toast("已吊销");
  redraw();
};
