// 登录与凭邀请码注册。登录 / 注册成功后整页刷新，清掉上一个账号留在内存里的数据。
// 版式和首页同一套报头：No. 行 → 印章 + 刊名 → 双线；下面左边一栏“本报启事”，右边是表单（手机上表单在前）。

import { actions, api, cnDate, esc, icon, render, weekday } from "../lib.js?v=212dd6fbae";
import { clearOfflineData } from "../offline.js?v=212dd6fbae";

const today = () => new Date().toLocaleDateString("en-CA");

/** 报头 + 两栏版面；form 是右栏的卡片 */
function page(form, { side = true } = {}) {
  const d = today();
  return `<div class="auth">
    <header class="auth-mast">
      <div class="auth-meta"><span class="no">Vol. ${d.slice(0, 4)} · Etymon</span><span class="date">${cnDate(d)}<span class="wd"> · ${weekday(d)}</span></span></div>
      <h1 class="auth-title"><span class="seal"></span>词源一日</h1>
      <p class="auth-sub">A word, and its story, every day.</p>
      <div class="mast-rule"></div>
    </header>
    <div class="auth-body${side ? "" : " solo"}">
      ${form}
      ${side ? notice() : ""}
    </div>
  </div>`;
}

/** 本报启事：这里每天有什么 */
const notice = () => `<aside class="auth-side" aria-label="关于词源一日">
  <p class="auth-kicker">本报启事<span class="en">Notice</span></p>
  <h2>每天一个英文词，<br>和它背后的故事。</h2>
  <ol class="auth-feats">
    <li><b>今日一词</b><span>每天早上一个词、一个问题，读完记进书架和连续天数。</span></li>
    <li><b>词源日报</b><span>想多读几篇时，一整版十二篇：接着读、今日专题、冷门一篇、温故。</span></li>
    <li><b>邮件送达</b><span>留个邮箱，就把今天的词或日报，排好版送进你的收件箱。</span></li>
  </ol>
  <figure class="auth-quote">
    <blockquote><em>salary</em> 原是古罗马士兵领来买盐的钱。</blockquote>
    <figcaption>—— 摘自本报 · 商业与经济</figcaption>
  </figure>
</aside>`;

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

const field = (label, input, extra = "") =>
  `<label class="fld"><span class="fld-l">${label}${extra}</span>${input}</label>`;

const eye = (name) =>
  `<button type="button" class="fld-eye" data-action="auth-eye" data-for="${name}" aria-label="显示密码" aria-pressed="false">${icon("eye")}</button>`;

export function renderLogin(message = "") {
  lock();
  render(page(`
    <form class="auth-card" id="auth-form" novalidate>
      <div class="auth-card-head"><h2>登录</h2><span class="en">Sign in</span></div>
      ${field("用户名", `<input name="username" autocomplete="username" autocapitalize="off" spellcheck="false" required>`)}
      ${field("密码", `<span class="fld-pw"><input type="password" name="password" autocomplete="current-password" required>${eye("password")}</span>`)}
      <p class="err" role="alert">${esc(message)}</p>
      <button class="btn primary auth-go">登录</button>
      <p class="switch-auth">有邀请码？<a href="#/join">注册账号</a></p>
      <p class="hint-auth">忘记密码？请管理员在「我的 → 邀请与成员」里重置。</p>
    </form>`));
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

const deviceTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
};

export async function renderJoin(code = "") {
  lock();
  const typed = String(code).trim();

  // 带码进来的先把状态问清楚：用过的、过期的就别再摆一个必然失败的表单了
  if (typed) {
    const res = await api(`/invites/${encodeURIComponent(typed)}`, { fresh: true })
      .catch((err) => ({ ok: false, error: err.message }));
    if (!res.ok) {
      const tooMany = /太多/.test(res.error ?? "");
      render(page(`<div class="auth-card auth-msg">
        <div class="auth-card-head"><h2>${tooMany ? "稍等一下再试" : "这个邀请码不能用了"}</h2><span class="en">${tooMany ? "Slow down" : "Invalid invite"}</span></div>
        <p class="auth-ticket bad"><code>${esc(typed)}</code></p>
        ${tooMany ? "" : `<p class="auth-why">${esc(res.error ?? "邀请码不对")}</p>`}
        <div class="auth-acts">
          ${tooMany
            ? `<button class="btn primary" data-action="join-reload">再试一次</button>`
            : `<button class="btn primary" data-action="join-form">换一个邀请码</button>
               <a class="btn" href="#/">已有账号，去登录</a>`}
        </div>
      </div>`));
      return;
    }
  }
  const tz = deviceTz();
  render(page(`
    <form class="auth-card" id="auth-form" novalidate>
      <div class="auth-card-head"><h2>凭邀请码注册</h2><span class="en">Join</span></div>
      <label class="fld auth-ticket${typed ? " ok" : ""}">
        <span class="fld-l">邀请码${typed ? `<i class="ok-mark">${icon("check")}可以使用</i>` : ""}</span>
        <input name="code" placeholder="K7QM-2XPA" value="${esc(typed)}" autocomplete="off" autocapitalize="characters" spellcheck="false" required>
      </label>
      ${field("用户名", `<input name="username" placeholder="2–20 个字符，中英文、数字都行" autocomplete="username" autocapitalize="off" spellcheck="false" required>`)}
      <div class="fld-row">
        ${field("密码", `<span class="fld-pw"><input type="password" name="password" placeholder="至少 8 位" autocomplete="new-password" required>${eye("password")}</span>`)}
        ${field("再输一次", `<input type="password" name="confirm" autocomplete="new-password" required>`)}
      </div>
      ${field("邮箱", `<input type="email" name="email" placeholder="you@example.com" autocomplete="email" autocapitalize="off" spellcheck="false" inputmode="email">`, `<i class="opt">选填</i>`)}
      <div class="auth-mail" id="auth-mail" hidden>
        <label class="auth-check">
          <input type="checkbox" name="mail" checked>
          <span><b>每天早上 8 点，把「今日一词」发到这个邮箱</b>
          <small>${tz ? `按你设备的时区（${esc(tz)}）。` : ""}之后可以在「我的 → 账号与安全」改时间、加订日报，或随时退订。</small></span>
        </label>
      </div>
      <p class="fld-note" id="mail-note">留了邮箱才能收邮件日报；不填也不影响使用，以后可以再补。</p>
      <p class="err" role="alert"></p>
      <button class="btn primary auth-go">注册并进入</button>
      <p class="switch-auth">已有账号？<a href="#/">登录</a></p>
    </form>`));
  const form = document.getElementById("auth-form");
  (typed ? form.username : form.code).focus();
  // 填了邮箱才出现“要不要订邮件”的勾选
  const mailBox = document.getElementById("auth-mail");
  const note = document.getElementById("mail-note");
  form.email.addEventListener("input", () => {
    const has = !!form.email.value.trim();
    mailBox.hidden = !has;
    note.hidden = has;
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const email = String(f.email ?? "").trim();
    if (!f.code || !f.username || !f.password) return showError(form, "邀请码、用户名、密码都要填");
    if (f.password.length < 8) return showError(form, "密码至少 8 位");
    if (f.password !== f.confirm) return showError(form, "两次输入的密码不一样");
    if (email && !form.email.checkValidity()) return showError(form, "邮箱格式不对，不想填可以留空");
    busy(form, true);
    try {
      await api("/register", {
        method: "POST",
        body: { code: f.code, username: f.username, password: f.password, email, mail: !!email && f.mail === "on", tz },
      });
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

/** 显示 / 隐藏密码 */
actions["auth-eye"] = (el) => {
  const input = el.closest("form")?.elements[el.dataset.for];
  if (!input) return;
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  el.setAttribute("aria-pressed", String(show));
  el.setAttribute("aria-label", show ? "隐藏密码" : "显示密码");
  input.focus();
};

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
  form.querySelector(".auth-go").disabled = on;
}
