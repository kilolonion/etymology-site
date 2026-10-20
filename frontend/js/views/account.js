// 账号与安全（改密码、退出）。管理员后台见 admin.js。

import { api, esc, fmtDay, icon, render, toast } from "../lib.js?v=212dd6fbae";

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
