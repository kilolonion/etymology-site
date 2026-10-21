// 管理后台 · 词条页签：快捷加词（查重 → 复制上下文给别的 AI → 粘回 JSON）、稿子列表、单份稿子（核对、编辑、发布、版本）、读者报错。
// 稿子详情用 #/me/admin?tab=entries&d=<id> 打开；预览走真实的文章页 #/w/<id>?draft=1。

import { actions, api, empty, esc, fmtDay, icon, local, toast } from "../lib.js?v=212dd6fbae";
import { copy, redraw } from "./admin.js?v=212dd6fbae";

const fresh = (p) => api(p, { fresh: true, detached: true });
const when = (iso) => (iso ? `${fmtDay(iso.slice(0, 10), { weekday: false })} ${iso.slice(11, 16)}` : "—");

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

// 页签里的状态：快捷加词的输入、导入结果、列表筛选（切页签回来还在）
const st = {
  mode: "new",
  words: "",
  lookup: null,
  picks: [], // 补写：挑中的原书词条 [{id, headword}]
  fields: ["links"],
  paste: "",
  results: null,
  filter: local.get("ae-filter", "all"),
};

/** 词条页签：有 d 参数时是单份稿子，否则是总览 */
export async function entriesTab(query) {
  const id = query?.get("d");
  return id ? draftView(id) : listView();
}

// ---------- 总览 ----------

async function listView() {
  const [o, reports] = await Promise.all([fresh("/admin/entries"), fresh("/admin/entries/reports")]);
  const d = o.drafts;
  const count = (f) => d.filter(f).length;
  const FILTERS = [
    ["all", "全部", () => true],
    ["draft", "草稿", (x) => x.status === "draft"],
    ["live", "已发布", (x) => x.status === "live" || x.status === "changed"],
    ["pending", "待核对", (x) => (x.status === "live" || x.status === "changed") && !x.checked && x.kind === "ai"],
    ["errors", "有错误", (x) => x.errors > 0],
    ["archived", "已撤下", (x) => x.status === "archived" || x.status === "merged"],
  ];
  const filter = FILTERS.find((f) => f[0] === st.filter) ?? FILTERS[0];
  const list = d.filter(filter[2]);
  const openReports = reports.filter((r) => !r.resolvedAt);
  return `
    <div class="stats ae-stats">
      ${stat(count((x) => x.mode === "new" && (x.status === "live" || x.status === "changed")), "已发布新词", `补写 ${count((x) => x.mode === "patch" && (x.status === "live" || x.status === "changed"))} 条`)}
      ${stat(count((x) => x.status === "draft"), "草稿", `${count((x) => x.errors)} 份有错误`)}
      ${stat(count((x) => (x.status === "live" || x.status === "changed") && !x.checked && x.kind === "ai"), "发布了但待核对", "读者看到琥珀色标签")}
      ${stat(openReports.length, "读者报错", "没处理的")}
    </div>

    <div class="admin-grid">
      <section class="panel-card">
        <div class="sec-head"><h2>快捷加词</h2><span>交给别的 AI 写，再粘回来</span></div>
        <div class="subs ae-mode" role="group" aria-label="加什么">
          <button data-action="ae-mode" data-mode="new" aria-pressed="${st.mode === "new"}">新词</button>
          <button data-action="ae-mode" data-mode="patch" aria-pressed="${st.mode === "patch"}">补写原书词条</button>
        </div>
        <div id="ae-quick">${st.mode === "new" ? quickNew() : quickPatch()}</div>
      </section>

      <section class="panel-card">
        <div class="sec-head"><h2>导回 AI 的结果</h2><span>粘贴它返回的 JSON</span></div>
        <textarea id="ae-paste" class="ae-text" rows="7" placeholder='把 AI 的整段回复粘进来就行，会自动找出里面的 JSON。&#10;格式：{"format":"ety-entry/1","entries":[…]}' spellcheck="false">${esc(st.paste)}</textarea>
        <div class="btnrow"><button class="btn sm primary" data-action="ae-import">校验并存为草稿</button><small class="hint">有错误也会先存下来，改好才能发布。</small></div>
        <div id="ae-results">${st.results ? importResults(st.results) : ""}</div>
      </section>

      <section class="panel-card wide">
        <div class="sec-head"><h2>稿子</h2><span>${d.length} 份</span></div>
        <div class="subs ae-filter" role="group" aria-label="筛选">${FILTERS.map(([k, name, f]) => `<button data-action="ae-filter" data-f="${k}" aria-pressed="${k === filter[0]}">${name}<i>${count(f)}</i></button>`).join("")}</div>
        <ul class="ae-list">${list.map(draftRow).join("") || `<li class="adm-empty">${d.length ? "这一类还没有" : "还没有稿子。先在上面写几个词，把上下文复制给 AI。"}</li>`}</ul>
      </section>

      <section class="panel-card">
        <div class="sec-head"><h2>读者报错</h2><span>${openReports.length ? `${openReports.length} 条没处理` : "都处理完了"}</span></div>
        <ul class="ae-reports">${reports.slice(0, 30).map(reportRow).join("") || `<li class="adm-empty">还没有人报错</li>`}</ul>
      </section>

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

const stat = (n, label, sub = "") => `<div class="stat"><b>${n}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;

function draftRow(x) {
  const issues = [
    x.errors ? `<span class="ae-n err">${x.errors} 错误</span>` : "",
    x.warnings ? `<span class="ae-n">${x.warnings} 提醒</span>` : "",
    x.doubts ? `<span class="ae-n">${x.doubts} 存疑</span>` : "",
    x.reports ? `<span class="ae-n err">${x.reports} 报错</span>` : "",
  ].join("");
  return `<li>
    <a href="#/me/admin?tab=entries&d=${encodeURIComponent(x.id)}">
      <b>${esc(x.headword)}</b>
      ${x.mode === "patch" ? chip([`补写 ${(x.fields ?? []).map((f) => FIELD_NAMES[f] ?? f).join("、")}`, ""]) : ""}
      ${chip(STATUS[x.status])}${x.status === "live" || x.status === "changed" ? srcChip(x) : ""}
      <span class="m">${esc(x.meaning)}</span>
      <span class="ae-meta">${issues}<time>${esc(x.updatedBy)} · ${when(x.updatedAt)}</time></span>
    </a>
  </li>`;
}

function reportRow(r) {
  return `<li class="${r.resolvedAt ? "done" : ""}">
    <div><a href="#/w/${esc(r.entryId)}">${esc(r.headword)}</a>${r.book ? chip(["原书", ""]) : ""}<time>${esc(r.user ?? "已删除的成员")} · ${when(r.at)}</time></div>
    <p>${esc(r.text)}</p>
    <div class="acts">
      ${r.draft ? `<a class="text-btn" href="#/me/admin?tab=entries&d=${encodeURIComponent(r.entryId)}">去改稿子</a>` : ""}
      <button class="text-btn" data-action="ae-report" data-id="${r.id}" data-reopen="${!!r.resolvedAt}">${r.resolvedAt ? "重新打开" : "处理完了"}</button>
    </div>
  </li>`;
}

// ----- 快捷加词：新词 -----

function quickNew() {
  return `
    <textarea id="ae-words" class="ae-text" rows="4" placeholder="每行一个词，比如&#10;serendipity&#10;petrichor" spellcheck="false">${esc(st.words)}</textarea>
    <div class="btnrow">
      <button class="btn sm" data-action="ae-lookup">查重</button>
      <button class="btn sm primary" data-action="ae-context" data-kind="copy">${icon("copy")}复制给 AI 的上下文</button>
      <button class="btn sm" data-action="ae-context" data-kind="download">下载 .md</button>
    </div>
    <div id="ae-lookup">${st.lookup ? lookupList(st.lookup) : ""}</div>
    <small class="hint">上下文里有写作规范、固定列表、示范和全部已有词条的清单（写“词的关系”用），已收录的词会自动跳过。也可以用 MCP 让 AI 直接提交，见下方“MCP 令牌”。</small>`;
}

const lookupList = (rows) =>
  `<ul class="ae-lookup">${rows
    .map((l) => `<li>${chip(LOOKUP[l.status])}<b>${esc(l.word)}</b>${l.target
      ? `<span>→ <a href="#/w/${esc(l.target.id)}">${esc(l.target.headword)}</a>${l.target.meaning ? ` ${esc(l.target.meaning)}` : ""}</span>`
      : `<span class="m">id：${esc(l.id)}</span>`}${l.draft ? ` <a class="text-btn" href="#/me/admin?tab=entries&d=${encodeURIComponent(l.draft.id)}">看稿子</a>` : ""}</li>`)
    .join("")}</ul>`;

// ----- 快捷加词：补写原书词条 -----

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
    <div class="btnrow">
      <button class="btn sm primary" data-action="ae-context" data-kind="copy" ${st.picks.length ? "" : "disabled"}>${icon("copy")}复制给 AI 的上下文</button>
      <button class="btn sm" data-action="ae-context" data-kind="download" ${st.picks.length ? "" : "disabled"}>下载 .md</button>
    </div>
    <small class="hint">原书的正文、释义、例句不能改，只能补这些编辑字段；“词的关系”是追加，不会删掉原有的。补写的内容在文章页会标明来源。</small>`;
}

let bookTimer;
document.addEventListener("input", (ev) => {
  const t = ev.target;
  if (t.id === "ae-words") st.words = t.value;
  if (t.id === "ae-paste") st.paste = t.value;
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
  if (box) box.innerHTML = st.mode === "new" ? quickNew() : quickPatch();
};
actions["ae-mode"] = (el) => {
  st.mode = el.dataset.mode;
  for (const b of document.querySelectorAll(".ae-mode button")) b.setAttribute("aria-pressed", String(b === el));
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

/** 复制或下载给别的 AI 的上下文（新词 / 补写 / 修改一份稿子） */
actions["ae-context"] = async (el) => {
  const body =
    el.dataset.mode === "revise"
      ? { mode: "revise", id: el.dataset.id, notes: document.getElementById("ae-notes")?.value ?? "" }
      : st.mode === "patch"
        ? { mode: "patch", ids: st.picks.map((p) => p.id), fields: st.fields }
        : { mode: "new", words: st.words };
  if (body.mode === "new" && !st.words.trim()) return toast("先写几个要加的词");
  el.disabled = true;
  try {
    const { text } = await api("/admin/entries/context", { method: "POST", body });
    if (el.dataset.kind === "download") {
      const name = body.mode === "revise" ? `修改-${body.id}` : body.mode === "patch" ? "补写原书词条" : "新词";
      const a = Object.assign(document.createElement("a"), {
        href: URL.createObjectURL(new Blob([text], { type: "text/markdown" })),
        download: `词源一日-${name}-${new Date().toISOString().slice(0, 10)}.md`,
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } else {
      await copy(text, `已复制（${Math.round(text.length / 1000)}K 字），粘给 AI 就行`);
    }
  } catch (e) {
    toast(e.message);
  } finally {
    el.disabled = false;
  }
};

// ----- 导入 -----

function importResults(rows) {
  return `<ul class="ae-results">${rows
    .map((r) => {
      const errs = r.issues?.errors ?? [];
      const warns = r.issues?.warnings ?? [];
      const state = r.error ? chip(["没存", "err"]) : r.unchanged ? chip(["没有变化", "off"]) : errs.length ? chip(["已存 · 有错误", "warn"]) : chip(["已存", "ok"]);
      return `<li>
        <div>${state}<b>${esc(r.headword || r.id || "")}</b>${r.mode === "patch" ? chip(["补写", ""]) : ""}
          ${r.id && !r.error ? `<a class="text-btn" href="#/me/admin?tab=entries&d=${encodeURIComponent(r.id)}">打开</a>` : ""}</div>
        ${r.error ? `<p class="err">${esc(r.error)}</p>` : ""}
        ${(r.fixes ?? []).length ? `<p class="fix">自动修正：${r.fixes.map(esc).join("；")}</p>` : ""}
        ${errs.length ? `<p class="err">${errs.map(esc).join("；")}</p>` : ""}
        ${warns.length ? `<p class="warn">${warns.map(esc).join("；")}</p>` : ""}
      </li>`;
    })
    .join("")}</ul>`;
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

actions["ae-filter"] = (el) => {
  st.filter = el.dataset.f;
  local.set("ae-filter", st.filter);
  redraw();
};

actions["ae-report"] = async (el) => {
  await api(`/admin/entries/reports/${el.dataset.id}/resolve`, { method: "POST", body: { reopen: el.dataset.reopen === "true" } });
  redraw();
};

// 详情页翻页用的筛选，口径和总览 listView 的 FILTERS 一致
const NAV_FILTERS = {
  all: () => true,
  draft: (x) => x.status === "draft",
  live: (x) => x.status === "live" || x.status === "changed",
  pending: (x) => (x.status === "live" || x.status === "changed") && !x.checked && x.kind === "ai",
  errors: (x) => x.errors > 0,
  archived: (x) => x.status === "archived" || x.status === "merged",
};

/** 稿子详情页的上一个/下一个：顺序和总览列表一致；当前筛选里没有这份时退回全部 */
async function navFor(id) {
  const o = await fresh("/admin/entries").catch(() => null);
  if (!o?.drafts?.length) return "";
  let list = o.drafts.filter(NAV_FILTERS[st.filter] ?? NAV_FILTERS.all);
  if (!list.some((x) => x.id === id)) list = o.drafts;
  const i = list.findIndex((x) => x.id === id);
  if (i < 0 || list.length < 2) return "";
  const btn = (x, label) =>
    x
      ? `<a class="btn sm${label === "下一个" ? " next" : ""}" href="#/me/admin?tab=entries&d=${encodeURIComponent(x.id)}">${label === "上一个" ? icon("left") : ""}<span class="w">${label}：${esc(x.headword)}</span>${label === "下一个" ? icon("right") : ""}</a>`
      : `<span class="btn sm dis" aria-disabled="true"><span class="w">${label}</span></span>`;
  return `<div class="ae-nav">${btn(list[i - 1], "上一个")}<span class="hint pos">第 ${i + 1} / ${list.length} 份</span>${btn(list[i + 1], "下一个")}</div>`;
}

// ---------- 单份稿子 ----------

let cur = null; // 正在看的稿子
let compare = null; // { ver, data }：正在对比的历史版本

async function draftView(id) {
  cur = await fresh(`/admin/entries/d/${encodeURIComponent(id)}`).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
  if (!cur) return empty("没有这份稿子（可能已经删掉了）", `<a class="btn sm" href="#/me/admin?tab=entries">回到词条</a>`);
  if (compare?.id !== id) compare = null;
  const d = cur.data;
  const m = d.meta;
  const { errors, warnings } = cur.issues;
  const live = cur.status === "live" || cur.status === "changed";
  const reports = cur.reports.filter((r) => !r.resolvedAt);
  const nav = await navFor(id);
  return `
    <a class="back ae-back" href="#/me/admin?tab=entries">${icon("left")}全部稿子</a>
    ${nav}
    <header class="ae-head">
      <h2>${esc(cur.headword)}</h2>
      ${cur.mode === "patch" ? chip(["补写原书词条", ""]) : chip(["新词", ""])}${chip(STATUS[cur.status])}${live ? srcChip({ kind: cur.live.meta.kind, checked: !!cur.live.meta.checked }) : ""}
      <p class="hint">${esc(cur.createdBy)} 建于 ${when(cur.createdAt)} · 最近由 ${esc(cur.updatedBy)} 修改于 ${when(cur.updatedAt)}${cur.publishedAt ? ` · 发布于 ${when(cur.publishedAt)}` : ""}</p>
    </header>
    <div class="btnrow ae-acts">
      <a class="btn sm" href="#/w/${encodeURIComponent(cur.id)}?draft=1">${icon("eye")}预览</a>
      ${live ? `<a class="btn sm" href="#/w/${encodeURIComponent(cur.id)}">看线上版本</a>` : ""}
      ${live ? `<button class="btn sm" data-action="ae-unpublish">撤下</button>` : ""}
      ${live ? "" : `<button class="btn sm danger" data-action="ae-delete">删除</button>`}
    </div>

    <div class="admin-grid">
      <section class="panel-card">
        <div class="sec-head"><h2>核对与发布</h2><span>${errors.length ? `${errors.length} 个错误，改好才能发布` : cur.status === "live" ? "线上就是这一版" : "可以发布"}</span></div>
        ${m.doubts.length
          ? `<p class="ae-label">AI 说它拿不准的地方（逐条核对后打勾）</p><ul class="ae-doubts">${m.doubts.map((x, i) => `<li><label><input type="checkbox" name="ae-doubt" value="${i}">${esc(x)}</label></li>`).join("")}</ul>`
          : `<p class="hint">AI 没有列出存疑之处。</p>`}
        <p class="ae-label">参考来源</p>
        <ul class="ae-sources">${m.sources.map((s) => `<li>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>` : esc(s.title)}</li>`).join("") || `<li class="err">没有参考来源</li>`}</ul>
        <p class="hint">${m.kind === "manual" ? "编辑撰写" : `AI 生成${m.model ? `（${esc(m.model)}）` : ""}`} · ${({ import: "后台导入", mcp: "MCP 提交", manual: "后台编辑" })[m.via] ?? ""}</p>
        <label class="ae-check"><input type="checkbox" id="ae-checked" ${m.doubts.length ? "disabled" : ""}>我已对照来源核对过内容${m.doubts.length ? "（先勾完上面的存疑）" : ""}</label>
        <div class="btnrow">
          <button class="btn sm primary" data-action="ae-publish" ${errors.length ? "disabled" : ""}>${live ? (cur.status === "changed" ? "发布这次修改" : "重新发布") : "发布"}</button>
        </div>
        <small class="hint">不勾“已核对”也能发布，读者会看到琥珀色的“待核对”标签，而且不会被推送、推荐和出题。内容一改，核对状态就会清掉。</small>
      </section>

      <section class="panel-card">
        <div class="sec-head"><h2>问题</h2><span>${errors.length} 错误 · ${warnings.length} 提醒</span></div>
        ${errors.length || warnings.length
          ? `<ul class="ae-issues">${errors.map((x) => `<li class="err">${esc(x)}</li>`).join("")}${warnings.map((x) => `<li class="warn">${esc(x)}</li>`).join("")}</ul>`
          : `<p class="hint">没有发现问题。</p>`}
        ${reports.length ? `<p class="ae-label">读者报错</p><ul class="ae-issues">${reports.map((r) => `<li class="err">${esc(r.text)}<button class="text-btn" data-action="ae-report" data-id="${r.id}" data-reopen="false">处理完了</button></li>`).join("")}</ul>` : ""}
        <p class="ae-label">让 AI 改</p>
        <textarea id="ae-notes" class="ae-text" rows="3" placeholder="写给 AI 的修改意见（可选），比如“例句再加一条”。上面的问题和读者报错会自动带上。"></textarea>
        <div class="btnrow">
          <button class="btn sm" data-action="ae-context" data-mode="revise" data-kind="copy" data-id="${esc(cur.id)}">${icon("copy")}复制修改上下文</button>
        </div>
        <small class="hint">AI 改好后，把结果粘到“词条”页签的“导回 AI 的结果”里，会更新这份稿子并留下历史版本。</small>
      </section>

      ${cur.mode === "patch" ? patchCompare() : ""}

      <section class="panel-card wide">
        <div class="sec-head"><h2>直接编辑</h2><span>JSON；id 不能改</span></div>
        <textarea id="ae-json" class="ae-text ae-code" rows="18" spellcheck="false">${esc(JSON.stringify({ entry: d.entry, meta: { kind: m.kind, model: m.model, sources: m.sources, doubts: m.doubts } }, null, 2))}</textarea>
        <div class="btnrow"><button class="btn sm primary" data-action="ae-save">保存</button><small class="hint">保存会留一个历史版本；已发布的词要再点“发布”才会更新线上。</small></div>
      </section>

      <section class="panel-card wide">
        <div class="sec-head"><h2>版本</h2><span>${cur.revisions.length} 个</span></div>
        <ul class="ae-revs">${cur.revisions
          .map((r) => `<li class="${compare?.ver === r.ver ? "on" : ""}"><b>第 ${r.ver} 版</b><span>${esc(r.note)}</span><time>${esc(r.by)} · ${when(r.at)}</time>
            <span class="acts"><button class="text-btn" data-action="ae-diff" data-ver="${r.ver}">${compare?.ver === r.ver ? "收起" : "和现在对比"}</button><button class="text-btn" data-action="ae-rollback" data-ver="${r.ver}">回滚到这版</button></span></li>`)
          .join("")}</ul>
        <div id="ae-diff">${compare ? diffView(compare) : ""}</div>
      </section>
    </div>
    ${nav}`;
}

/** 补写：原书原来的样子 vs 补写的 */
function patchCompare() {
  const e = cur.data.entry;
  const show = (v) => (v === undefined ? `<span class="hint">（没有）</span>` : `<pre>${esc(typeof v === "string" ? v : JSON.stringify(v, null, 1))}</pre>`);
  const rows = Object.keys(FIELD_NAMES).filter((k) => e[k] !== undefined);
  return `<section class="panel-card wide">
    <div class="sec-head"><h2>和原书对照</h2><span>${esc(cur.book?.headword ?? "")} · ${esc(cur.book?.meaning ?? "")}</span></div>
    <table class="ae-cmp"><thead><tr><th></th><th>原来</th><th>补写</th></tr></thead><tbody>${rows
      .map((k) => `<tr><th>${FIELD_NAMES[k]}</th><td>${show(cur.book?.[k])}</td><td>${show(k === "links" ? e.links : e[k])}${k === "links" ? `<small class="hint">追加在原有关系后面</small>` : ""}</td></tr>`)
      .join("")}</tbody></table>
  </section>`;
}

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

function diffView(c) {
  const text = (d) => JSON.stringify({ entry: d.entry, meta: { kind: d.meta.kind, model: d.meta.model, sources: d.meta.sources, doubts: d.meta.doubts } }, null, 2).split("\n");
  const rows = diffLines(text(c.data), text(cur.data));
  const changed = rows.filter((r) => r[0] !== " ").length;
  if (!changed) return `<p class="hint">第 ${c.ver} 版和现在的内容一样。</p>`;
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
  return `<p class="hint">− 第 ${c.ver} 版　＋ 现在</p><ol class="ae-diff">${html}</ol>`;
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
  document.getElementById("ae-diff").innerHTML = compare ? diffView(compare) : "";
};

actions["ae-rollback"] = async (el) => {
  if (!confirm(`把稿子回滚到第 ${el.dataset.ver} 版？会存成一个新版本，不会自动发布。`)) return;
  await api(`/admin/entries/d/${encodeURIComponent(cur.id)}/rollback`, { method: "POST", body: { ver: Number(el.dataset.ver) } });
  compare = null;
  toast(`已回滚到第 ${el.dataset.ver} 版`);
  redraw();
};

// 勾完所有存疑，才能勾“已核对”
document.addEventListener("change", (ev) => {
  if (ev.target.name !== "ae-doubt") return;
  const all = [...document.querySelectorAll("input[name=ae-doubt]")];
  const box = document.getElementById("ae-checked");
  if (!box) return;
  box.disabled = !all.every((x) => x.checked);
  if (box.disabled) box.checked = false;
});

actions["ae-publish"] = async (el) => {
  const checked = !!document.getElementById("ae-checked")?.checked;
  const what = cur.mode === "patch" ? `${cur.headword} 的补写内容` : cur.headword;
  if (!confirm(checked ? `发布 ${what}，标为“已核对”？` : `发布 ${what}？\n没有勾“已核对”，读者会看到“AI 整理 · 待核对”，而且它不会被推送、推荐和出题。`)) return;
  el.disabled = true;
  try {
    await api(`/admin/entries/d/${encodeURIComponent(cur.id)}/publish`, { method: "POST", body: { checked } });
    toast(checked ? "已发布（已核对）" : "已发布（待核对）");
    redraw();
  } catch (e) {
    toast(e.message);
    el.disabled = false;
  }
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
  location.hash = "#/me/admin?tab=entries";
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
        <span>${t.scopes.includes("draft") ? "读 + 交草稿" : "只读"} · ${t.revokedAt ? `已吊销` : t.expiresAt ? `${when(t.expiresAt).split(" ")[0]}前有效` : "不过期"} · ${t.lastUsedAt ? `最近使用 ${when(t.lastUsedAt)}` : "还没用过"}</span>
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
