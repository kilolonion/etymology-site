// 登录与凭邀请码注册。登录 / 注册成功后整页刷新，清掉上一个账号留在内存里的数据。

import { actions, api, esc, render } from "../lib.js";
import { clearOfflineData } from "../offline.js";

const brand = (sub) => `
  <span class="seal"></span>
  <h1>词源一日</h1>
  <p class="en">${sub}</p>`;

function lock() {
  document.body.classList.add("locked");
  document.body.classList.remove("bleed", "home");
}

/** 进入应用：清掉上一个账号的离线缓存，带着当前的地址刷新（注册页则回到今日） */
async function enter() {
  await clearOfflineData();
  if (location.hash.startsWith("#/join")) location.replace("#/");
  location.reload();
}

export function renderLogin(message = "") {
  lock();
  render(`
    <form class="login" id="auth-form" novalidate>
      ${brand("A word, and its story, every day.")}
      <input name="username" placeholder="用户名" autocomplete="username" autocapitalize="off" spellcheck="false" required>
      <input type="password" name="password" placeholder="密码" autocomplete="current-password" required>
      <button class="btn primary">登录</button>
      <p class="err" role="alert">${esc(message)}</p>
      <p class="switch-auth">有邀请码？<a href="#/join">注册账号</a></p>
      <p class="hint-auth">忘记密码？请管理员在「我的 → 邀请与成员」里重置。</p>
    </form>`);
  const form = document.getElementById("auth-form");
  form.username.focus();
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = new FormData(form);
    if (!f.get("username") || !f.get("password")) return showError(form, "请填写用户名和密码");
    busy(form, true);
    try {
      await api("/login", { method: "POST", body: { username: f.get("username"), password: f.get("password") } });
      enter();
    } catch (err) {
      busy(form, false);
      form.password.value = ""; // 免得上一个人留下的密码还留在框里
      form.password.focus();
      showError(form, err.message);
    }
  });
}

export async function renderJoin(code = "") {
  lock();
  let hint = "";
  const typed = String(code).trim();

  // 带码进来的先把状态问清楚：用过的、过期的就别再摆一个必然失败的表单了
  if (typed) {
    const res = await api(`/invites/${encodeURIComponent(typed)}`, { fresh: true })
      .catch((err) => ({ ok: false, error: err.message }));
    if (!res.ok) {
      const tooMany = /太多/.test(res.error ?? "");
      render(`<div class="empty">
        <span class="seal"></span>
        <div><b>${tooMany ? "稍等一下再试" : "这个邀请码不能用了"}</b><br>
          <code>${esc(typed)}</code>${tooMany ? "" : ` · ${esc(res.error ?? "邀请码不对")}`}</div>
        <div class="empty-acts">
          ${tooMany
            ? `<button class="btn sm" data-action="join-reload">再试一次</button>`
            : `<a class="btn sm" href="#/">已有账号，去登录</a>
               <button class="btn sm ghost" data-action="join-form">换一个邀请码</button>`}
        </div>
      </div>`);
      return;
    }
  }
  render(`
    <form class="login" id="auth-form" novalidate>
      ${brand("凭邀请码注册")}
      <input name="code" placeholder="邀请码，如 K7QM-2XPA" value="${esc(typed)}" autocomplete="off" autocapitalize="characters" spellcheck="false" required>
      <input name="username" placeholder="用户名（2–20 个字符）" autocomplete="username" autocapitalize="off" spellcheck="false" required>
      <input type="password" name="password" placeholder="密码（至少 8 位）" autocomplete="new-password" required>
      <input type="password" name="confirm" placeholder="再输一次密码" autocomplete="new-password" required>
      <button class="btn primary">注册并进入</button>
      <p class="err" role="alert">${esc(hint)}</p>
      <p class="switch-auth">已有账号？<a href="#/">登录</a></p>
    </form>`);
  const form = document.getElementById("auth-form");
  (typed ? form.username : form.code).focus();
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    if (!f.code || !f.username || !f.password) return showError(form, "请把每一项都填上");
    if (f.password.length < 8) return showError(form, "密码至少 8 位");
    if (f.password !== f.confirm) return showError(form, "两次输入的密码不一样");
    busy(form, true);
    try {
      await api("/register", { method: "POST", body: { code: f.code, username: f.username, password: f.password } });
      enter();
    } catch (err) {
      // 注册失败多半是邀请码或用户名的问题：密码和确认都留着，方便改了再提交
      busy(form, false);
      showError(form, err.message);
    }
  });
}

actions["join-form"] = () => {
  location.hash = "#/join"; // 回到不带码的注册页，可以粘另一个邀请码
};

actions["join-reload"] = () => location.reload();

/** 已登录时打开了别人发来的邀请链接 */
export function renderJoinWhileLoggedIn(user) {
  render(`
    <div class="empty">
      <span class="seal"></span>
      <div>你已经以 <b>${esc(user.username)}</b> 的身份登录。<br>要用这个邀请码注册新账号，请先退出。</div>
      <div class="empty-acts"><a class="btn sm" href="#/">回到今日</a><button class="btn sm ghost" data-action="logout">退出登录</button></div>
    </div>`);
}

function showError(form, msg) {
  form.querySelector(".err").textContent = msg;
}

function busy(form, on) {
  form.querySelector("button").disabled = on;
}
