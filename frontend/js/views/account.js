// 账号与安全（邮箱与邮件日报、改密码、退出）。管理员后台见 admin.js。

import { actions, api, esc, fmtDay, icon, render, toast } from "../lib.js?v=212dd6fbae";

const day = (iso) => fmtDay(iso.slice(0, 10), { weekday: false });

/** 时区下拉里常见的几个；设备的、已存的不在里面时自动补上 */
const ZONES = [
  ["Asia/Shanghai", "北京 / 上海"], ["Asia/Hong_Kong", "香港"], ["Asia/Taipei", "台北"], ["Asia/Tokyo", "东京"],
  ["Asia/Singapore", "新加坡"], ["Europe/London", "伦敦"], ["Europe/Paris", "巴黎"], ["Europe/Berlin", "柏林"],
  ["America/New_York", "纽约"], ["America/Chicago", "芝加哥"], ["America/Los_Angeles", "洛杉矶"],
  ["America/Vancouver", "温哥华"], ["Australia/Sydney", "悉尼"], ["Pacific/Auckland", "奥克兰"],
];
const deviceTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
};

const KINDS = [
  { key: "word", name: "每日单词", en: "The Daily Word", desc: "今天推给你的那一个词：问题、故事的开头、一句例句，点开读完。", art: (m) => sampleWord(m.sample?.word || "salary") },
  { key: "paper", name: "词源日报", en: "The Etymon Daily", desc: "一整版十二篇：头版、头条、接着读、今日专题、温故……想多读几篇时翻。", art: () => `<small>词源日报</small><i></i><i></i><i class="s"></i>` },
];

/** 信笺上的词：按长度缩字号，长词也一行放下、不在中间折断 */
const sampleWord = (w) => `<small>今日一词</small><em style="font-size:${Math.max(10, Math.min(18, Math.floor(108 / w.length)))}px">${esc(w)}</em>`;

const STATUS = { sent: "已寄出", skipped: "没寄（已读过或没内容）", error: "没寄出，会重试", sending: "正在寄" };

let mail = null;

export async function viewAccount() {
  const [me, m, today] = await Promise.all([api("/me"), api("/me/mail"), api("/today").catch(() => null)]);
  mail = { ...m, sample: { word: today?.entry?.headword } };
  render(`
    <button class="back" data-action="back">${icon("left")}我的</button>
    <header class="page-head"><h1>账号与安全<span class="en">Account</span></h1></header>
    <div class="account-grid">
      <section class="panel-card">
        <div class="sec-head"><h2>账号</h2></div>
        <dl class="kv">
          <div><dt>用户名</dt><dd>${esc(me.username)}</dd></div>
          <div><dt>身份</dt><dd>${me.isAdmin ? "管理员" : "成员"}</dd></div>
          <div><dt>邮箱</dt><dd id="kv-email">${m.email ? esc(m.email) : `<span class="muted">没填</span>`}</dd></div>
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
      <section class="panel-card wide mail-card" id="mail-card">${mailCard()}</section>
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

// ---------- 邮件日报 ----------

function mailCard() {
  const m = mail;
  const tz = m.tz || m.siteTz;
  const dev = deviceTz();
  const zones = [...ZONES];
  for (const z of [tz, dev, m.siteTz]) if (z && !zones.some(([k]) => k === z)) zones.unshift([z, z]);
  const has = !!m.email;
  return `
    <div class="sec-head"><h2>邮件日报</h2><span>每天一封，排好版送进收件箱</span></div>
    ${m.configured ? "" : `<p class="mail-off">${icon("clock")}站点还没开通发信。设置会先存着，开通后按时寄出。</p>`}
    <form class="mail-email" id="mail-email" novalidate>
      <label for="mail-addr">邮箱<i class="opt">选填</i></label>
      <div class="mail-email-row">
        <input id="mail-addr" type="email" name="email" value="${esc(m.email ?? "")}" placeholder="you@example.com" autocomplete="email" autocapitalize="off" spellcheck="false" inputmode="email">
        <button class="btn sm primary">${has ? "保存" : "填好了"}</button>
      </div>
      <p class="err" role="alert"></p>
      ${has ? `<button type="button" class="text-btn" data-action="mail-clear">清空邮箱（同时停掉所有邮件）</button>` : `<small class="hint">只用来寄邮件日报，不会给别人看。</small>`}
    </form>
    <div class="mail-kinds${has ? "" : " off"}">
      ${KINDS.map((k) => `
        <div class="mail-kind${m[k.key] && has ? " on" : ""}">
          <div class="mk-art ${k.key}" aria-hidden="true">${k.art(m)}</div>
          <div class="mk-txt">
            <b>${k.name}<span class="en">${k.en}</span></b>
            <small>${k.desc}</small>
            <span class="mk-acts">
              <a href="/api/me/mail/preview?kind=${k.key}" target="_blank" rel="noopener">预览今天这封</a>
              ${has && m.configured ? `<button type="button" class="text-btn" data-action="mail-test" data-kind="${k.key}">给我发一封试试</button>` : ""}
            </span>
          </div>
          <label class="switch"><input type="checkbox" data-mail-kind="${k.key}" aria-label="订阅${k.name}" ${m[k.key] && has ? "checked" : ""} ${has ? "" : "disabled"}><span></span></label>
        </div>`).join("")}
    </div>
    <div class="mail-when${has ? "" : " off"}">
      <label><span>几点寄</span><input type="time" id="mail-time" value="${esc(m.time)}" step="300" ${has ? "" : "disabled"}></label>
      <label><span>按哪个时区</span><select id="mail-tz" ${has ? "" : "disabled"}>${zones
        .map(([k, name]) => `<option value="${esc(k)}"${k === tz ? " selected" : ""}>${esc(name)}${k === dev ? "（这台设备）" : ""}${k === m.siteTz ? "（站点）" : ""}</option>`)
        .join("")}</select></label>
    </div>
    ${m.recent.length ? `<details class="mail-log"><summary>最近寄出的 ${m.recent.length} 封</summary><ul>${m.recent
      .map((r) => `<li><time>${esc(fmtDay(r.day, { weekday: false }))}</time><span>${r.kind === "word" ? "每日单词" : "词源日报"}</span><em class="${esc(r.status)}">${STATUS[r.status] ?? esc(r.status)}</em></li>`)
      .join("")}</ul></details>` : ""}`;
}

function redrawMail() {
  const el = document.getElementById("mail-card");
  if (el) el.innerHTML = mailCard();
  const kv = document.getElementById("kv-email");
  if (kv) kv.innerHTML = mail.email ? esc(mail.email) : `<span class="muted">没填</span>`;
}

async function saveMail(body, msg) {
  mail = { ...mail, ...(await api("/me/mail", { method: "PUT", body })) }; // sample 留着
  redrawMail();
  if (msg) toast(msg);
}

document.addEventListener("submit", async (ev) => {
  if (ev.target.id !== "mail-email") return;
  ev.preventDefault();
  const input = ev.target.email;
  const err = ev.target.querySelector(".err");
  const email = input.value.trim();
  if (email && !input.checkValidity()) return (err.textContent = "邮箱格式不对");
  if (!email && !mail.email) return (err.textContent = "先填一个邮箱");
  const first = !mail.email && email;
  try {
    // 第一次填邮箱时顺手订上每日单词，用户马上能看到开关是开着的
    await saveMail(first ? { email, word: true, tz: mail.tz ?? deviceTz() } : { email }, first ? "已保存，每天早上寄「每日单词」" : email ? "邮箱已更新" : "已清空邮箱");
  } catch (e) {
    err.textContent = e.message;
  }
});

document.addEventListener("change", async (ev) => {
  const t = ev.target;
  if (!mail || !t.closest?.("#mail-card")) return;
  try {
    if (t.dataset.mailKind) {
      const k = KINDS.find((x) => x.key === t.dataset.mailKind);
      await saveMail({ [k.key]: t.checked }, t.checked ? `已订阅「${k.name}」` : `已退订「${k.name}」`);
    } else if (t.id === "mail-time" && t.value) {
      await saveMail({ time: t.value }, `以后每天 ${t.value} 寄出`);
    } else if (t.id === "mail-tz") {
      await saveMail({ tz: t.value }, "时区已更新");
    }
  } catch (e) {
    toast(e.message);
    redrawMail();
  }
});

actions["mail-clear"] = async () => {
  if (!confirm("清空邮箱后，所有邮件日报都会停掉。确定吗？")) return;
  await saveMail({ email: null }, "已清空邮箱");
};

actions["mail-test"] = async (el) => {
  el.disabled = true;
  try {
    const r = await api("/me/mail/test", { method: "POST", body: { kind: el.dataset.kind } });
    toast(`已寄到 ${r.to}，看看收件箱`);
  } finally {
    el.disabled = false;
  }
};
