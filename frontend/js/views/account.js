// 账号与安全（改密码、退出），以及管理员的“邀请与成员”。

import { actions, api, empty, esc, fmtDay, icon, render, toast } from "../lib.js";

const day = (iso) => fmtDay(iso.slice(0, 10), { weekday: false });

export async function viewAccount() {
  const me = await api("/me");
  render(`
    <button class="back" data-action="back">${icon("left")}我的</button>
    <header class="page-head"><h1>账号与安全<span class="en">Account</span></h1></header>
    <div class="account-grid">
      <section class="panel-card">
        <div class="sec-head"><h2>账号</h2></div>
        <dl class="kv">
          <div><dt>用户名</dt><dd>${esc(me.username)}</dd></div>
          <div><dt>身份</dt><dd>${me.isAdmin ? "管理员" : "成员"}</dd></div>
          <div><dt>注册于</dt><dd>${day(me.createdAt)}</dd></div>
        </dl>
        <button class="btn sm ghost logout-btn" data-action="logout">${icon("logout")}退出登录</button>
      </section>
      <form class="panel-card form" id="pw-form" novalidate>
        <div class="sec-head"><h2>修改密码</h2><span>改完后其他设备需要重新登录</span></div>
        <label><span>原密码</span><input type="password" name="old" autocomplete="current-password" required></label>
        <label><span>新密码</span><input type="password" name="password" autocomplete="new-password" placeholder="至少 8 位" required></label>
        <label><span>再输一次</span><input type="password" name="confirm" autocomplete="new-password" required></label>
        <p class="err" role="alert"></p>
        <button class="btn sm primary">保存新密码</button>
      </form>
    </div>`);

  const form = document.getElementById("pw-form");
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const err = form.querySelector(".err");
    if (f.password.length < 8) return (err.textContent = "新密码至少 8 位");
    if (f.password !== f.confirm) return (err.textContent = "两次输入的新密码不一样");
    try {
      await api("/me/password", { method: "PUT", body: { old: f.old, password: f.password } });
      form.reset();
      err.textContent = "";
      toast("密码已修改");
    } catch (e) {
      err.textContent = e.message;
    }
  });
}

// ---------- 邀请与成员（管理员） ----------

const inviteLink = (code) => `${location.origin}/#/join/${code}`;

export async function viewAdmin() {
  const me = await api("/me");
  if (!me.isAdmin) {
    render(empty("只有管理员能看这一页", `<a class="btn sm" href="#/me">回到我的</a>`));
    return;
  }
  const [invites, users] = await Promise.all([api("/admin/invites"), api("/admin/users")]);
  const open = invites.filter((i) => !i.usedAt);
  const used = invites.filter((i) => i.usedAt);
  const now = new Date().toISOString();

  render(`
    <button class="back" data-action="back">${icon("left")}我的</button>
    <header class="page-head"><h1>邀请与成员<span class="en">Members</span></h1><p>书有版权，只邀请自己人。每个邀请码只能注册一个账号，7 天内有效。</p></header>
    <div class="admin-grid">
      <section class="panel-card">
        <div class="sec-head"><h2>邀请朋友</h2><span>${open.length ? `${open.length} 个待使用` : ""}</span></div>
        <form class="invite-form" id="invite-form">
          <input name="note" maxlength="40" placeholder="备注（可选），比如“给小王”" autocomplete="off">
          <button class="btn sm primary">生成邀请链接</button>
        </form>
        <div id="invite-new"></div>
        <ul class="invites" id="open-invites">${open.map((i) => inviteRow(i, now)).join("")}</ul>
        ${used.length
          ? `<details class="used"><summary>已使用 ${used.length}</summary><ul class="invites">${used
              .map((i) => `<li><code>${esc(i.code)}</code><span>${esc(i.usedBy ?? "")} · ${day(i.usedAt)}</span></li>`)
              .join("")}</ul></details>`
          : ""}
      </section>
      <section class="panel-card">
        <div class="sec-head"><h2>成员</h2><span>${users.length} 人</span></div>
        <ul class="members">${users.map((u) => memberRow(u, me)).join("")}</ul>
      </section>
    </div>`);

  document.getElementById("invite-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const note = ev.target.note.value.trim();
    const inv = await api("/admin/invites", { method: "POST", body: { note } });
    ev.target.reset();
    document.getElementById("invite-new").innerHTML = `<div class="invite-new">
      <p>把这个链接发给${note ? esc(note.replace(/^给/, "")) : "对方"}，打开就能注册：</p>
      <div class="link-box"><input readonly value="${esc(inviteLink(inv.code))}"><button class="btn sm" data-action="copy-invite" data-code="${esc(inv.code)}">复制</button></div>
      <small>邀请码 <code>${esc(inv.code)}</code>，7 天内有效</small>
    </div>`;
    document.getElementById("open-invites").insertAdjacentHTML("afterbegin", inviteRow(inv, new Date().toISOString()));
    copy(inviteLink(inv.code), "邀请链接已复制");
  });
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

function memberRow(u, me) {
  const self = u.id === me.id;
  return `<li>
    <div class="who"><b>${esc(u.username)}</b>${u.isAdmin ? `<span class="badge">管理员</span>` : ""}${self ? `<span class="pushed">你</span>` : ""}</div>
    <div class="meta">已读 ${u.read} 个 · ${u.lastRead ? `最近 ${fmtDay(u.lastRead, { weekday: false })}` : "还没读过"} · ${day(u.createdAt)}加入</div>
    ${self
      ? ""
      : `<div class="acts">
          <button class="text-btn" data-action="reset-user" data-id="${u.id}" data-name="${esc(u.username)}">重置密码</button>
          <button class="text-btn danger" data-action="delete-user" data-id="${u.id}" data-name="${esc(u.username)}">删除</button>
        </div>`}
  </li>`;
}

/**
 * 复制链接。Safari 在 await 之后可能已经没有“用户手势”，Clipboard API 会被拒；
 * 这时退回 execCommand，再不行就把页面上的链接选中，让人自己按 ⌘C。
 */
async function copy(text, done) {
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

  const input = [...document.querySelectorAll("input")].find((i) => i.value === text);
  if (input) {
    input.focus();
    input.select();
  }
  toast("已选中，按 ⌘C / Ctrl+C 复制");
}

actions["copy-invite"] = (el) => copy(inviteLink(el.dataset.code), "邀请链接已复制");

actions["revoke-invite"] = async (el) => {
  await api(`/admin/invites/${encodeURIComponent(el.dataset.code)}`, { method: "DELETE" });
  el.closest("li")?.remove();
  toast("邀请码已作废");
};

actions["reset-user"] = async (el) => {
  if (!confirm(`重置 ${el.dataset.name} 的密码？对方所有设备都会退出登录。`)) return;
  const { password } = await api(`/admin/users/${el.dataset.id}/reset-password`, { method: "POST" });
  const li = el.closest("li");
  li.querySelector(".temp")?.remove();
  li.insertAdjacentHTML(
    "beforeend",
    `<p class="temp">临时密码 <code>${esc(password)}</code>，只显示这一次。请转告对方，登录后到“账号与安全”里改掉。</p>`,
  );
};

actions["delete-user"] = async (el) => {
  if (!confirm(`删除 ${el.dataset.name}？对方的阅读记录、收藏都会一起删掉，不能恢复。`)) return;
  await api(`/admin/users/${el.dataset.id}`, { method: "DELETE" });
  el.closest("li")?.remove();
  toast(`已删除 ${el.dataset.name}`);
};
