// 管理后台（仅管理员）：总览 / 成员 / 邀请 / 词条 / 工具 五个页签（词条页签在 admin-entries.js）。
// 数据都来自 /api/admin/*。操作后只重画当前页签，不整页刷新。

import { actions, api, empty, esc, fmtDay, icon, render, toast } from "../lib.js?v=212dd6fbae";
import { entriesTab } from "./admin-entries.js?v=212dd6fbae";

const day = (iso) => (iso ? fmtDay(iso.slice(0, 10), { weekday: false }) : "—");
const TABS = [
  ["overview", "总览"],
  ["members", "成员"],
  ["invites", "邀请"],
  ["entries", "词条"],
  ["tools", "工具"],
];
const inviteLink = (code) => `${location.origin}/#/join/${code}`;
const bytes = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const uptime = (s) => (s >= 86400 ? `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时` : s >= 3600 ? `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分` : `${Math.max(1, Math.floor(s / 60))} 分钟`);

/** 多久以前：刚刚 / 12 分钟前 / 3 小时前 / 5 天前 */
function ago(iso) {
  if (!iso) return "从没来过";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return "刚刚在线";
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}
const online = (iso) => !!iso && Date.now() - Date.parse(iso) < 10 * 60_000;

let tab = "overview";
let ctx = { me: null };
/** 地址栏里的参数（词条页签用 d= 打开某份稿子） */
let params = null;

export async function viewAdmin(query) {
  const me = await api("/me");
  if (!me.isAdmin) {
    render(empty("只有管理员能看这一页", `<a class="btn sm" href="#/me">回到我的</a>`));
    return;
  }
  ctx.me = me;
  params = query;
  const t = query?.get("tab");
  if (TABS.some(([k]) => k === t)) tab = t;

  // 审稿页（以及一轮审完的收尾页）只留审核本身：不要大标题和页签，翻下一份时版面不跳
  if (tab === "entries" && (query?.get("d") || query?.get("round"))) {
    render(`<div id="adm-body"></div>`);
    await draw();
    return;
  }

  render(`
    <button class="back" data-action="back">${icon("left")}我的</button>
    <header class="page-head"><h1>管理后台<span class="en">Admin</span></h1><p>看看大家读得怎么样，也在这里管成员、邀请和站点。</p></header>
    <nav class="subs adm-tabs" aria-label="管理页签">${TABS.map(([k, name]) => `<button data-action="adm-tab" data-tab="${k}" aria-pressed="${k === tab}">${name}</button>`).join("")}</nav>
    <div id="adm-body"></div>`);
  await draw();
}

async function draw() {
  const body = document.getElementById("adm-body");
  if (!body) return;
  body.setAttribute("aria-busy", "true");
  try {
    body.innerHTML = await ({ overview, members, invites, entries: () => entriesTab(params), tools }[tab])();
  } catch (err) {
    if (err?.name === "AbortError" || err?.status === 401) return;
    body.innerHTML = empty(`加载失败：${esc(err.message)}`, `<button class="btn sm" data-action="adm-refresh">重试</button>`);
  }
  body.removeAttribute("aria-busy");
}

// 这些请求都是页面画好之后由点击触发的：不跟随导航信号（否则一次切页就会被取消）
const fresh = (p) => api(p, { fresh: true, detached: true });

/** 重画当前页签（别的模块操作完调用） */
export const redraw = () => draw();

actions["adm-tab"] = (el) => {
  tab = el.dataset.tab;
  params = null;
  for (const b of document.querySelectorAll(".adm-tabs button")) b.setAttribute("aria-pressed", String(b === el));
  history.replaceState(history.state, "", `#/me/admin?tab=${tab}`);
  draw();
};
actions["adm-refresh"] = () => draw();

// ---------- 总览 ----------

async function overview() {
  const o = await fresh("/admin/overview");
  const u = o.users;
  const max = Math.max(1, ...o.trend.map((t) => t.reads));
  const stat = (n, label, sub = "") => `<div class="stat"><b>${n}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const rank = (list) =>
    list.length
      ? `<ol class="rank">${list.map((t) => `<li><a href="#/w/${esc(t.id)}">${esc(t.headword)}</a><span>${t.n}</span></li>`).join("")}</ol>`
      : `<p class="adm-empty">还没有数据</p>`;
  return `
    <div class="stats">
      ${stat(u.total, "成员", `${u.admins} 位管理员${u.disabled ? ` · ${u.disabled} 已停用` : ""}`)}
      ${stat(`${u.readToday}<i>/${u.total - u.disabled}</i>`, "今天已读完", `${Math.round((u.readToday / Math.max(1, u.total - u.disabled)) * 100)}%`)}
      ${stat(u.online24h, "24 小时内活跃", `7 天内 ${u.online7d} 人`)}
      ${stat(u.readers7d, "近 7 天有阅读", `共读过 ${o.reads.words ?? 0} 个不同的词`)}
      ${stat(u.withPush, "开了提醒", "至少绑定一台设备")}
      ${stat(o.reads.reads ?? 0, "累计阅读", `收藏 ${o.reads.starred ?? 0} 次 · 词库 ${o.reads.entries} 个`)}
    </div>

    <div class="admin-grid">
      <section class="panel-card">
        <div class="sec-head"><h2>近 14 天阅读</h2><span>每天读完的词数</span></div>
        <div class="trend" role="img" aria-label="近 14 天阅读趋势">${o.trend
          .map((t) => `<div class="bar${t.day === o.day ? " today" : ""}" title="${fmtDay(t.day, { weekday: false })}：${t.reads} 次，${t.readers} 人">
            <i style="height:${Math.round((t.reads / max) * 100)}%"></i><b>${t.reads || ""}</b><span>${Number(t.day.slice(8))}</span></div>`)
          .join("")}</div>
      </section>

      <section class="panel-card">
        <div class="sec-head"><h2>今天的词</h2><span>${fmtDay(o.day, { weekday: false })} 分发情况</span></div>
        <ul class="dist">${o.today
          .map((t) => `<li><a href="#/w/${esc(t.id)}"><b>${esc(t.headword)}</b></a><span class="m">${esc(t.meaning)}</span>
            <span class="n">${t.done}/${t.users} 读完</span>
            <span class="meter"><span style="width:${Math.round((t.done / Math.max(1, t.users)) * 100)}%"></span></span></li>`)
          .join("") || `<li class="adm-empty">今天还没有人打开过</li>`}</ul>
        <button class="text-btn" data-action="adm-swap-open">换今天的词…</button>
        <div id="swap-box"></div>
      </section>

      <section class="panel-card">
        <div class="sec-head"><h2>读得最多</h2><span>按读完人数</span></div>
        ${rank(o.topRead)}
      </section>

      <section class="panel-card">
        <div class="sec-head"><h2>收藏最多</h2><span>按收藏人数</span></div>
        ${rank(o.topStarred)}
      </section>
    </div>`;
}

// ----- 换今日词 -----
actions["adm-swap-open"] = (el) => {
  const box = document.getElementById("swap-box");
  if (box.innerHTML) return (box.innerHTML = "");
  el.blur();
  box.innerHTML = swapForm();
  const input = box.querySelector("input[name=word]");
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    delete input.dataset.id;
    timer = setTimeout(async () => {
      const q = input.value.trim();
      const hits = q ? await fresh(`/admin/words?q=${encodeURIComponent(q)}`).catch(() => []) : [];
      box.querySelector(".suggest").innerHTML = hits
        .map((h) => `<button type="button" data-action="adm-pick" data-id="${esc(h.id)}" data-name="${esc(h.headword)}"><b>${esc(h.headword)}</b><span>${esc(h.meaning ?? "")}</span></button>`)
        .join("");
    }, 160);
  });
  box.querySelector("form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const id = input.dataset.id;
    if (!id) return toast("先从下面的候选里点一个词");
    const scope = ev.target.scope.value;
    const label = scope === "all" ? "所有人（包括已读完的）" : "今天还没读完的人";
    if (!confirm(`把今天的词换成 ${input.dataset.name}？\n范围：${label}。已读完今天的词的人${scope === "all" ? "也会被换掉" : "不受影响"}。`)) return;
    const r = await api("/admin/today-word", { method: "POST", body: { id, scope } });
    toast(`已换给 ${r.changed} 人${r.skipped ? `，跳过 ${r.skipped} 人（读过或已排到之后）` : ""}`);
    draw();
  });
};
actions["adm-pick"] = (el) => {
  const input = document.querySelector("#swap-box input[name=word]");
  input.value = el.dataset.name;
  input.dataset.id = el.dataset.id;
  input.dataset.name = el.dataset.name;
  document.querySelector("#swap-box .suggest").innerHTML = "";
};
const swapForm = () => `<form class="swap-form">
  <input name="word" placeholder="输入单词，比如 candidate" autocomplete="off" maxlength="40">
  <div class="suggest"></div>
  <label class="opt"><input type="radio" name="scope" value="unread" checked>只换还没读完今天的词的人</label>
  <label class="opt"><input type="radio" name="scope" value="all">所有人（会打断已读完的人）</label>
  <button class="btn sm primary">换词</button>
  <small>读过这个词、或已把它排到之后某天的人会自动跳过，不会重复推送。</small>
</form>`;

// ---------- 成员 ----------

let memberFilter = "";
let memberCache = [];

async function members() {
  memberCache = await fresh("/admin/users");
  return membersHtml();
}

function membersHtml() {
  const q = memberFilter.trim().toLowerCase();
  const list = memberCache.filter((u) => !q || u.username.toLowerCase().includes(q));
  return `
    <section class="panel-card">
      <div class="sec-head"><h2>成员</h2><span>${memberCache.length} 人${memberCache.some((u) => u.disabled) ? ` · ${memberCache.filter((u) => u.disabled).length} 已停用` : ""}</span></div>
      <input class="adm-search" id="member-q" type="search" placeholder="按用户名找" value="${esc(memberFilter)}" autocomplete="off">
      <ul class="members adm-members">${list.map(memberRow).join("") || `<li class="adm-empty">没有匹配的成员</li>`}</ul>
    </section>`;
}

document.addEventListener("input", (ev) => {
  if (ev.target.id !== "member-q") return;
  memberFilter = ev.target.value;
  const pos = ev.target.selectionStart;
  document.getElementById("adm-body").innerHTML = membersHtml();
  const input = document.getElementById("member-q");
  input.focus();
  input.setSelectionRange(pos, pos);
});

function memberRow(u) {
  const self = u.id === ctx.me.id;
  return `<li data-uid="${u.id}" class="${u.disabled ? "off" : ""}">
    <div class="who">
      <span class="dot${online(u.lastSeen) ? " on" : ""}" title="${esc(ago(u.lastSeen))}"></span>
      <b>${esc(u.username)}</b>
      ${u.isAdmin ? `<span class="badge">管理员</span>` : ""}${self ? `<span class="pushed">你</span>` : ""}${u.disabled ? `<span class="badge off">已停用</span>` : ""}
    </div>
    <div class="meta">已读 ${u.read} · 收藏 ${u.starred} · ${u.todayId ? (u.todayDone ? "今天已读完" : "今天还没读") : "今天没打开"} · ${esc(ago(u.lastSeen))}</div>
    <div class="acts"><button class="text-btn" data-action="adm-detail" data-id="${u.id}">详情</button></div>
    <div class="detail" hidden></div>
  </li>`;
}

actions["adm-detail"] = async (el) => {
  const li = el.closest("li");
  const box = li.querySelector(".detail");
  if (!box.hidden) {
    box.hidden = true;
    el.textContent = "详情";
    return;
  }
  el.textContent = "收起";
  box.hidden = false;
  box.innerHTML = `<p class="adm-empty">加载中…</p>`;
  const u = await fresh(`/admin/users/${li.dataset.uid}`);
  const self = u.id === ctx.me.id;
  box.innerHTML = `
    <dl class="kv sm">
      <div><dt>加入</dt><dd>${day(u.createdAt)}</dd></div>
      <div><dt>最近活跃</dt><dd>${esc(ago(u.lastSeen))}</dd></div>
      <div><dt>连续阅读</dt><dd>${u.streak} 天（最长 ${u.best} 天）</dd></div>
      <div><dt>登录设备</dt><dd>${u.sessions} 台${u.sessions ? "" : "（未登录）"}</dd></div>
      <div><dt>提醒</dt><dd>${u.devices ? `${u.reminderTime} · ${u.devices} 台设备` : "未开启"}</dd></div>
      <div><dt>今天的词</dt><dd>${u.todayWord ? `<a href="#/w/${esc(u.todayWord.id)}">${esc(u.todayWord.headword)}</a>` : "—"}</dd></div>
    </dl>
    <div class="week14" aria-label="近 14 天">${u.week
      .map((w) => `<i class="${w.read ? "r" : w.assigned ? "a" : ""}" title="${fmtDay(w.day, { weekday: false })}：${w.read ? `读了 ${esc(w.assigned ?? "")}` : w.assigned ? `${esc(w.assigned)}（没读）` : "没有记录"}"></i>`)
      .join("")}</div>
    ${u.recent.length ? `<p class="recent">最近读过：${u.recent.map((r) => `<a href="#/w/${esc(r.id)}">${esc(r.headword)}</a>`).join(" · ")}</p>` : ""}
    ${self
      ? ""
      : `<div class="btnrow">
          <button class="btn sm" data-action="adm-push-user" data-id="${u.id}" data-name="${esc(u.username)}" ${u.devices ? "" : "disabled title=\"对方没开提醒\""}>发推送</button>
          <button class="btn sm" data-action="adm-swap-user" data-id="${u.id}" data-name="${esc(u.username)}">换今天的词</button>
          <button class="btn sm" data-action="reset-user" data-id="${u.id}" data-name="${esc(u.username)}">重置密码</button>
          <button class="btn sm" data-action="adm-kick" data-id="${u.id}" data-name="${esc(u.username)}" ${u.sessions ? "" : "disabled"}>强制下线</button>
          <button class="btn sm" data-action="adm-admin" data-id="${u.id}" data-name="${esc(u.username)}" data-to="${!u.isAdmin}">${u.isAdmin ? "取消管理员" : "设为管理员"}</button>
          <button class="btn sm" data-action="adm-disable" data-id="${u.id}" data-name="${esc(u.username)}" data-to="${!u.disabled}">${u.disabled ? "恢复账号" : "停用账号"}</button>
          <button class="btn sm danger" data-action="delete-user" data-id="${u.id}" data-name="${esc(u.username)}">删除</button>
        </div>`}`;
};

const refreshMembers = async () => {
  memberCache = await fresh("/admin/users");
  document.getElementById("adm-body").innerHTML = membersHtml();
};

actions["reset-user"] = async (el) => {
  if (!confirm(`重置 ${el.dataset.name} 的密码？对方所有设备都会退出登录。`)) return;
  const { password } = await api(`/admin/users/${el.dataset.id}/reset-password`, { method: "POST" });
  const box = el.closest(".detail");
  box.querySelector(".temp")?.remove();
  box.insertAdjacentHTML("beforeend", `<p class="temp">临时密码 <code>${esc(password)}</code>，只显示这一次。请转告对方，登录后到“账号与安全”里改掉。</p>`);
};

actions["adm-kick"] = async (el) => {
  if (!confirm(`让 ${el.dataset.name} 的所有设备退出登录？对方再登录就行，数据不受影响。`)) return;
  await api(`/admin/users/${el.dataset.id}/kick`, { method: "POST" });
  toast(`${el.dataset.name} 已下线`);
  refreshMembers();
};

actions["adm-disable"] = async (el) => {
  const to = el.dataset.to === "true";
  if (to && !confirm(`停用 ${el.dataset.name}？对方会立刻下线、无法登录，数据保留，之后可以恢复。`)) return;
  await api(`/admin/users/${el.dataset.id}/disable`, { method: "POST", body: { disabled: to } });
  toast(to ? `已停用 ${el.dataset.name}` : `已恢复 ${el.dataset.name}`);
  refreshMembers();
};

actions["adm-admin"] = async (el) => {
  const to = el.dataset.to === "true";
  if (!confirm(to ? `把 ${el.dataset.name} 设为管理员？对方将能管理所有成员和邀请。` : `取消 ${el.dataset.name} 的管理员身份？`)) return;
  await api(`/admin/users/${el.dataset.id}/admin`, { method: "POST", body: { admin: to } });
  toast(to ? `${el.dataset.name} 现在是管理员` : "已取消管理员");
  refreshMembers();
};

actions["delete-user"] = async (el) => {
  if (!confirm(`删除 ${el.dataset.name}？对方的阅读记录、收藏都会一起删掉，不能恢复。\n只是想让对方暂时用不了的话，用“停用账号”。`)) return;
  await api(`/admin/users/${el.dataset.id}`, { method: "DELETE" });
  toast(`已删除 ${el.dataset.name}`);
  refreshMembers();
};

actions["adm-push-user"] = (el) => {
  const text = prompt(`给 ${el.dataset.name} 发一条推送（会出现在对方手机通知栏）：`);
  if (!text?.trim()) return;
  sendPush(text.trim(), Number(el.dataset.id));
};

actions["adm-swap-user"] = async (el) => {
  const word = prompt(`把 ${el.dataset.name} 今天的词换成哪个？输入单词原形，比如 candidate`);
  if (!word?.trim()) return;
  const hits = await fresh(`/admin/words?q=${encodeURIComponent(word.trim())}`);
  const hit = hits.find((h) => h.headword.toLowerCase() === word.trim().toLowerCase()) ?? hits[0];
  if (!hit) return toast("词库里没找到这个词");
  if (!confirm(`把 ${el.dataset.name} 今天的词换成 ${hit.headword}（${hit.meaning}）？`)) return;
  const r = await api("/admin/today-word", { method: "POST", body: { id: hit.id, userId: Number(el.dataset.id) } });
  toast(r.changed ? `已换成 ${hit.headword}` : r.skipped ? "对方读过它或已排到之后，没换" : "已经是这个词");
  refreshMembers();
};

// ---------- 邀请 ----------

async function invites() {
  const list = await fresh("/admin/invites");
  const now = new Date().toISOString();
  const open = list.filter((i) => !i.usedAt && !(i.expiresAt && i.expiresAt <= now));
  const expired = list.filter((i) => !i.usedAt && i.expiresAt && i.expiresAt <= now);
  const used = list.filter((i) => i.usedAt);
  return `
    <div class="admin-grid">
      <section class="panel-card">
        <div class="sec-head"><h2>邀请朋友</h2><span>${open.length ? `${open.length} 个待使用` : ""}</span></div>
        <form class="invite-form" id="invite-form">
          <input name="note" maxlength="40" placeholder="备注（可选），比如“给小王”" autocomplete="off">
          <button class="btn sm primary">生成</button>
        </form>
        <div class="invite-opts">
          <label>数量 <select name="count" form="invite-form">${[1, 2, 3, 5, 10, 20].map((n) => `<option>${n}</option>`).join("")}</select></label>
          <label>有效期 <select name="days" form="invite-form">${[[1, "1 天"], [3, "3 天"], [7, "7 天"], [14, "14 天"], [30, "30 天"], [90, "90 天"]].map(([d, t]) => `<option value="${d}"${d === 7 ? " selected" : ""}>${t}</option>`).join("")}</select></label>
        </div>
        <div id="invite-new"></div>
        <ul class="invites" id="open-invites">${open.map((i) => inviteRow(i, now)).join("")}</ul>
      </section>
      <section class="panel-card">
        <div class="sec-head"><h2>历史</h2><span>已使用 ${used.length} · 已过期 ${expired.length}</span></div>
        ${expired.length ? `<button class="text-btn" data-action="adm-clear-expired">清掉 ${expired.length} 个过期的</button>` : ""}
        <ul class="invites">${used
          .map((i) => `<li><code>${esc(i.code)}</code><span>${[i.note && esc(i.note), esc(i.usedBy ?? ""), day(i.usedAt)].filter(Boolean).join(" · ")}</span></li>`)
          .join("") || `<li class="adm-empty">还没有人用过邀请码</li>`}</ul>
      </section>
    </div>`;
}

function inviteRow(i, now) {
  const expired = i.expiresAt && i.expiresAt <= now;
  return `<li class="${expired ? "expired" : ""}">
    <code>${esc(i.code)}</code>
    <span>${i.note ? `${esc(i.note)} · ` : ""}${expired ? "已过期" : `${day(i.expiresAt)}前有效`}</span>
    <span class="acts">
      ${expired ? "" : `<button class="text-btn" data-action="copy-invite" data-code="${esc(i.code)}">复制链接</button>`}
      <button class="text-btn" data-action="revoke-invite" data-code="${esc(i.code)}">${expired ? "删除" : "撤销"}</button>
    </span>
  </li>`;
}

document.addEventListener("submit", async (ev) => {
  if (ev.target.id !== "invite-form") return;
  ev.preventDefault();
  const f = ev.target;
  const note = f.note.value.trim();
  const count = Number(document.querySelector("select[name=count]").value);
  const days = Number(document.querySelector("select[name=days]").value);
  const r = await api("/admin/invites", { method: "POST", body: { note, count, days } });
  const made = count === 1 ? [r] : r.invites;
  f.reset();
  const links = made.map((i) => inviteLink(i.code)).join("\n");
  document.getElementById("invite-new").innerHTML = `<div class="invite-new">
    <p>${count === 1 ? `把这个链接发给${note ? esc(note.replace(/^给/, "")) : "对方"}，打开就能注册：` : `生成了 ${count} 个邀请链接，每行一个：`}</p>
    ${count === 1
      ? `<div class="link-box"><input readonly value="${esc(links)}"><button class="btn sm" data-action="copy-text" data-text="${esc(links)}">复制</button></div>`
      : `<textarea class="links" readonly rows="${Math.min(count, 6)}">${esc(links)}</textarea><button class="btn sm" data-action="copy-text" data-text="${esc(links)}">全部复制</button>`}
    <small>${days} 天内有效，每个只能注册一个账号</small>
  </div>`;
  document.getElementById("open-invites").insertAdjacentHTML("afterbegin", made.map((i) => inviteRow(i, new Date().toISOString())).join(""));
  copy(links, count === 1 ? "邀请链接已复制" : `${count} 个链接已复制`);
});

actions["copy-text"] = (el) => copy(el.dataset.text, "已复制");
actions["copy-invite"] = (el) => copy(inviteLink(el.dataset.code), "邀请链接已复制");
actions["revoke-invite"] = async (el) => {
  await api(`/admin/invites/${encodeURIComponent(el.dataset.code)}`, { method: "DELETE" });
  el.closest("li")?.remove();
  toast("邀请码已作废");
};
actions["adm-clear-expired"] = async () => {
  const r = await api("/admin/invites/expired", { method: "DELETE" });
  toast(`清掉了 ${r.deleted} 个`);
  draw();
};

// ---------- 工具 ----------

const MAIL_STATUS = { sent: "已寄出", skipped: "跳过", error: "失败", sending: "发送中" };
const MAIL_KIND = { word: "每日单词", paper: "词源日报" };

async function tools() {
  const [o, audit, mail] = await Promise.all([fresh("/admin/overview"), fresh("/admin/audit"), fresh("/admin/mail")]);
  const s = o.system;
  const cfg = mail.config;
  return `
    <div class="admin-grid">
      <section class="panel-card">
        <div class="sec-head"><h2>站点开关</h2></div>
        <div class="adm-opt">
          <div class="txt"><b>暂停注册</b><small>开启后，普通邀请码暂时不能用来注册（已发出的不作废）。管理员邀请码不受影响。</small></div>
          <label class="switch"><input type="checkbox" id="reg-paused" aria-label="暂停注册" ${o.settings.regPaused ? "checked" : ""}><span></span></label>
        </div>
      </section>

      <section class="panel-card">
        <div class="sec-head"><h2>广播推送</h2><span>${o.users.withPush} 人开了提醒</span></div>
        <form class="push-form" id="push-form">
          <input name="title" maxlength="40" placeholder="标题，比如“新词上线”" autocomplete="off" required>
          <input name="text" maxlength="120" placeholder="内容（最多 120 字）" autocomplete="off" required>
          <button class="btn sm primary" ${o.users.withPush ? "" : "disabled"}>发给所有订阅者</button>
        </form>
        <small class="hint">只会发到开了提醒的成员的设备上，会出现在通知栏。慎用，别打扰人。</small>
      </section>

      <section class="panel-card wide adm-mail">
        <div class="sec-head"><h2>邮件日报</h2><span>${mail.counts.withEmail} 人留了邮箱 · 每日单词 ${mail.counts.word} · 日报 ${mail.counts.paper}</span></div>
        <div class="adm-mail-grid">
          <div>
            <dl class="kv sm">
              <div><dt>发信</dt><dd>${mail.configured ? `<span class="ok-dot"></span>已配置` : `<span class="off-dot"></span>未配置（不发信）`}</dd></div>
              ${mail.configured ? `<div><dt>SMTP</dt><dd><code>${esc(cfg.host)}:${cfg.port}</code> · ${esc(cfg.security)}</dd></div>
              <div><dt>发件人</dt><dd>${esc(cfg.from)}</dd></div>` : ""}
              <div><dt>站点地址</dt><dd>${mail.siteUrl ? esc(mail.siteUrl) : `<span class="warn-t">没设 SITE_URL</span>`}</dd></div>
            </dl>
            ${mail.configured ? "" : `<small class="hint">在 <code>.env</code> 里填 <code>SMTP_HOST</code>、<code>SMTP_USER</code>、<code>SMTP_PASS</code>、<code>MAIL_FROM</code>、<code>SITE_URL</code>（见 <code>.env.example</code>），重启服务后生效。没配置时照常可以预览。</small>`}
            <form class="push-form adm-mail-form" id="mail-test-form">
              <div class="adm-mail-kind" role="radiogroup" aria-label="哪一种">
                <label><input type="radio" name="kind" value="word" checked><span>每日单词</span></label>
                <label><input type="radio" name="kind" value="paper"><span>词源日报</span></label>
              </div>
              <input name="to" type="email" placeholder="${esc(mail.me ?? "收件地址")}" autocomplete="off">
              <div class="adm-mail-acts">
                <button class="btn sm primary" ${mail.configured ? "" : "disabled"}>发一封测试信</button>
                <button type="button" class="btn sm" data-action="adm-mail-preview">在下面预览</button>
                <a class="btn sm ghost" id="mail-open" href="/api/me/mail/preview?kind=word" target="_blank" rel="noopener">新窗口打开</a>
              </div>
            </form>
            <small class="hint">测试信和预览用的都是你自己今天的内容；收件地址留空就寄到你账号里的邮箱。</small>
          </div>
          <div>
            <p class="adm-mail-sub">最近的发送</p>
            <ul class="audit adm-mail-log">${mail.recent
              .map((r) => `<li><time>${esc(r.at.slice(5, 16).replace("T", " "))}</time><b>${esc(r.username ?? "已删除")}</b><span>${MAIL_KIND[r.kind] ?? esc(r.kind)}</span><em class="${esc(r.status)}">${MAIL_STATUS[r.status] ?? esc(r.status)}${r.tries > 1 ? ` · 第 ${r.tries} 次` : ""}${r.error ? ` · ${esc(r.error)}` : ""}</em></li>`)
              .join("") || `<li class="adm-empty">还没有发过</li>`}</ul>
          </div>
        </div>
        <div class="adm-mail-frame" id="mail-frame" hidden></div>
      </section>

      <section class="panel-card">
        <div class="sec-head"><h2>系统状态</h2><button class="text-btn" data-action="adm-refresh">刷新</button></div>
        <dl class="kv">
          <div><dt>已运行</dt><dd>${uptime(s.uptime)}</dd></div>
          <div><dt>内存占用</dt><dd>${bytes(s.rss)}</dd></div>
          <div><dt>数据库</dt><dd>${bytes(s.dbSize)}</dd></div>
          ${s.disk ? `<div><dt>磁盘剩余</dt><dd>${bytes(s.disk.free)} / ${bytes(s.disk.total)}</dd></div>` : ""}
          <div><dt>Node</dt><dd>${esc(s.node)}</dd></div>
        </dl>
      </section>

      <section class="panel-card">
        <div class="sec-head"><h2>数据库备份</h2><span>${s.backups.length ? `最近 ${s.backups.length} 份` : "还没有"}</span></div>
        <button class="btn sm" data-action="adm-backup">现在备份一次</button>
        <ul class="invites">${s.backups.map((b) => `<li><code>${esc(b.name)}</code><span>${bytes(b.size)}</span></li>`).join("")}</ul>
        <small class="hint">在线备份，不影响使用。手动备份只保留最近 10 份；部署时自动做的备份单独保留。</small>
      </section>

      <section class="panel-card wide">
        <div class="sec-head"><h2>操作记录</h2><span>最近 ${audit.length} 条</span></div>
        <ul class="audit">${audit
          .map((a) => `<li><time>${esc(a.at.slice(5, 16).replace("T", " "))}</time><b>${esc(a.admin)}</b><span>${esc(a.action)}</span><em>${esc(a.detail)}</em></li>`)
          .join("") || `<li class="adm-empty">还没有记录</li>`}</ul>
      </section>
    </div>`;
}

document.addEventListener("change", async (ev) => {
  if (ev.target.id !== "reg-paused") return;
  const paused = ev.target.checked;
  try {
    await api("/admin/settings", { method: "PUT", body: { regPaused: paused } });
    toast(paused ? "已暂停注册" : "已恢复注册");
  } catch (e) {
    ev.target.checked = !paused;
    toast(e.message);
  }
});

async function sendPush(text, userId) {
  const title = userId === undefined ? text.title : "词源一日";
  const body = userId === undefined ? text.text : text;
  const r = await api("/admin/push", { method: "POST", body: { title, text: body, userId } });
  toast(r.sent ? `已发到 ${r.sent} 台设备` : "没有发出去（对方没有可用的设备）");
}

document.addEventListener("submit", async (ev) => {
  if (ev.target.id !== "push-form") return;
  ev.preventDefault();
  const f = ev.target;
  const title = f.title.value.trim();
  const text = f.text.value.trim();
  if (!confirm(`给所有订阅者发这条推送？\n\n${title}\n${text}`)) return;
  await sendPush({ title, text });
  f.reset();
  draw();
});

// 邮件：切换种类时“新窗口打开”的链接跟着变；预览嵌在一个 iframe 里，宽度可以切手机 / 电脑
const mailKind = () => document.querySelector('#mail-test-form input[name="kind"]:checked')?.value ?? "word";
document.addEventListener("change", (ev) => {
  if (ev.target.name !== "kind" || !ev.target.closest("#mail-test-form")) return;
  const a = document.getElementById("mail-open");
  if (a) a.href = `/api/me/mail/preview?kind=${mailKind()}`;
  if (!document.getElementById("mail-frame")?.hidden) actions["adm-mail-preview"]();
});

// 线上 nginx 给所有响应都加了 X-Frame-Options: DENY，iframe 直接 src 接口会被挡；
// 所以先把 HTML 取回来放进 srcdoc（沙盒里不跑脚本，信里的链接在新标签页打开）
actions["adm-mail-preview"] = async () => {
  const box = document.getElementById("mail-frame");
  if (!box) return;
  const narrow = box.dataset.narrow === "1";
  const kind = mailKind();
  box.hidden = false;
  box.innerHTML = `<div class="adm-mail-bar"><span>${MAIL_KIND[kind]} · 今天</span>
      <button type="button" class="text-btn" data-action="adm-mail-width">${narrow ? "看电脑宽度" : "看手机宽度"}</button>
      <button type="button" class="text-btn" data-action="adm-mail-close">收起</button></div>
    <iframe title="邮件预览" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" style="max-width:${narrow ? "390px" : "100%"}"></iframe>`;
  const res = await fetch(`/api/me/mail/preview?kind=${kind}`, { credentials: "same-origin" });
  const html = await res.text();
  const frame = box.querySelector("iframe");
  if (frame && mailKind() === kind) frame.srcdoc = html.replace(/<head>/i, '<head><base target="_blank">');
};
actions["adm-mail-width"] = () => {
  const box = document.getElementById("mail-frame");
  box.dataset.narrow = box.dataset.narrow === "1" ? "0" : "1";
  actions["adm-mail-preview"]();
};
actions["adm-mail-close"] = () => {
  const box = document.getElementById("mail-frame");
  box.hidden = true;
  box.innerHTML = "";
};

document.addEventListener("submit", async (ev) => {
  if (ev.target.id !== "mail-test-form") return;
  ev.preventDefault();
  const f = ev.target;
  const btn = f.querySelector("button.primary");
  btn.disabled = true;
  try {
    const r = await api("/admin/mail/test", { method: "POST", body: { kind: mailKind(), to: f.to.value.trim() } });
    toast(`已寄到 ${r.to}`);
    draw();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
});

actions["adm-backup"] = async (el) => {
  el.disabled = true;
  try {
    const r = await api("/admin/backup", { method: "POST" });
    toast(`已备份 ${r.name}（${bytes(r.size)}）`);
    draw();
  } finally {
    el.disabled = false;
  }
};

// ---------- 复制 ----------

/**
 * 复制文本。Safari 在 await 之后可能已经没有“用户手势”，Clipboard API 会被拒；
 * 这时退回 execCommand，再不行就把页面上的文本选中，让人自己按 ⌘C。
 */
export async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    return toast(done);
  } catch {}

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  area.remove();
  if (ok) return toast(done);

  const el = [...document.querySelectorAll("input[readonly], textarea.links")].find((i) => i.value === text);
  if (el) {
    el.focus();
    el.select();
  }
  toast("已选中，按 ⌘C / Ctrl+C 复制");
}
