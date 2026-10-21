// 我的：书架、阅读足迹、专题纹章、语源分布，以及收藏、阅读记录、提醒与日报、账号、（管理员）邀请与成员的入口

import { actions, api, empty, esc, fmtDay, getAccent, icon, local, render, rich, row, setAccent, speak, toast } from "../lib.js?v=212dd6fbae";
import { fold, isWide } from "../components.js?v=212dd6fbae";
import { emblem, primaryTheme, themeOf, themeTag, tint } from "../themes.js?v=212dd6fbae";
import { disablePush, enablePush, isStandalone, pushStatus } from "../push.js?v=212dd6fbae";

const STATUS_TEXT = {
  on: "已开启",
  off: "未开启",
  denied: "通知被禁止",
  "needs-install": "需添加到主屏幕",
  unsupported: "当前浏览器不支持",
};

export async function viewMe() {
  const [d, history, reminder, me, status] = await Promise.all([
    api("/shelf"), api("/history"), api("/reminder"), api("/me"), pushStatus(),
  ]);
  const s = d.stats;
  const pct = s.total ? Math.round((s.read / s.total) * 100) : 0;
  const reminderVal = status === "on" ? `每天 ${esc(reminder.time)}` : STATUS_TEXT[status];

  render(`
    <header class="page-head"><h1>我的<span class="en">My Shelf</span></h1><p>${esc(me.username)}${me.isAdmin ? " · 管理员" : ""}</p></header>
    <div class="me-grid">
    <section class="shelf-card">
      <p class="shelf-sum"><b>${s.read}</b><span>${s.read ? "个词的来历，<br>已经住进你的书架" : "本书还没上架，<br>读完一个词就放上一本"}</span></p>
      ${shelf(d.shelf)}
      <div class="shelf-stats">
        <span><b>${s.streak}</b>天连续</span>
        <span><b>${s.best}</b>天最长</span>
        <span><b>${s.starred}</b>个收藏</span>
        <span><b>${pct}%</b>全书</span>
      </div>
      <div class="progress"><span style="width:${pct}%"></span></div>
    </section>
    ${footprints(d.footprints, history.length)}
    ${collection(d.themes)}
    ${origins(d.langs, s.read)}
    <div class="me-side">
    <nav class="menu">
      <a href="#/me/starred">${icon("star")}<span class="grow">我的收藏</span><span class="val">${s.starred}</span>${icon("right", "i chev")}</a>
      <a href="#/me/history">${icon("clock")}<span class="grow">阅读记录</span><span class="val">${history.length ? `${history.length} 天` : ""}</span>${icon("right", "i chev")}</a>
      <a href="#/me/reminder">${icon("bell")}<span class="grow">提醒与日报</span><span class="val">${reminderVal}</span>${icon("right", "i chev")}</a>
      <button class="menu-btn" data-action="accent">${icon("sound")}<span class="grow">发音</span><span class="val accent-val">${ACCENT[getAccent()]}</span><span class="swap">切换</span></button>
      <div class="menu-row">${icon("today")}<span class="grow">每日目标</span><span class="goal-step"><button type="button" class="gs-btn" data-action="goal-minus" aria-label="减少每日目标" ${(me.goal ?? 1) <= 1 ? "disabled" : ""}>−</button><input class="gs-num" id="goal-num" type="number" min="1" max="50" step="1" inputmode="numeric" value="${me.goal ?? 1}" data-cur="${me.goal ?? 1}" aria-label="每日目标个数"><span class="gs-unit">个</span><button type="button" class="gs-btn" data-action="goal-plus" aria-label="增加每日目标" ${(me.goal ?? 1) >= 50 ? "disabled" : ""}>＋</button></span></div>
      <button class="menu-btn" data-action="board-opt" data-on="${!!me.onBoard}">${icon("users")}<span class="grow">参加排行榜</span><span class="val board-val">${me.onBoard ? "参加中" : "已关闭"}</span><span class="swap">${me.onBoard ? "关闭" : "打开"}</span></button>
    </nav>
    <nav class="menu">
      <a href="#/me/account">${icon("key")}<span class="grow">账号与安全</span><span class="val">${esc(me.username)}</span>${icon("right", "i chev")}</a>
      ${me.isAdmin ? `<a href="#/me/admin">${icon("users")}<span class="grow">管理后台</span>${icon("right", "i chev")}</a>` : ""}
    </nav>
    </div>
    </div>`);
  document.querySelector(".spines")?.scrollTo({ left: 0 });
  const gnum = document.getElementById("goal-num");
  gnum?.addEventListener("change", () => {
    const v = Number(gnum.value);
    if (!Number.isInteger(v) || v < GOAL_MIN || v > GOAL_MAX) {
      toast(`目标填 ${GOAL_MIN}–${GOAL_MAX} 之间的整数`);
      return syncGoalUI(Number(gnum.dataset.cur));
    }
    setGoal(v);
  });
  gnum?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") gnum.blur();
  });
}

const ACCENT = { uk: "英音", us: "美音" };

/** 英音 / 美音切换，切完读一个词听听 */
actions.accent = (el) => {
  const next = getAccent() === "uk" ? "us" : "uk";
  setAccent(next);
  el.querySelector(".accent-val").textContent = ACCENT[next];
  speak("etymology", el);
  toast(`发音改为${ACCENT[next]}`);
};

/** 每日目标：行内步进，− / ＋ 点一下改一个，数字也能点开直接输入（1–50）；首页“本周”和读完时的收尾都按它算 */
const GOAL_MIN = 1, GOAL_MAX = 50;
let goalSaving = false;

/** 把步进控件同步到某个值：数字、当前值缓存、两头按钮的可用状态 */
function syncGoalUI(goal) {
  const input = document.getElementById("goal-num");
  if (!input) return;
  input.dataset.cur = String(goal);
  if (document.activeElement !== input) input.value = String(goal);
  const minus = document.querySelector('[data-action="goal-minus"]');
  const plus = document.querySelector('[data-action="goal-plus"]');
  if (minus) minus.disabled = goal <= GOAL_MIN;
  if (plus) plus.disabled = goal >= GOAL_MAX;
}

async function setGoal(next) {
  const input = document.getElementById("goal-num");
  if (!input || goalSaving) return;
  next = Math.min(GOAL_MAX, Math.max(GOAL_MIN, Math.round(next)));
  if (next === Number(input.dataset.cur)) return syncGoalUI(next); // 没变，只把显示拨正
  goalSaving = true;
  try {
    const { goal } = await api("/me/goal", { method: "PUT", body: { goal: next } });
    syncGoalUI(goal);
    toast(`每日目标改为 ${goal} 个`);
  } catch (e) {
    toast(e.message);
    syncGoalUI(Number(input.dataset.cur));
  } finally {
    goalSaving = false;
  }
}

actions["goal-minus"] = () => setGoal(Number(document.getElementById("goal-num")?.dataset.cur ?? 1) - 1);
actions["goal-plus"] = () => setGoal(Number(document.getElementById("goal-num")?.dataset.cur ?? 1) + 1);

/** 排行榜开关：关掉后别人的榜上没有你，你的首页也不显示榜；榜上别人的名字只露第一个字 */
actions["board-opt"] = async (el) => {
  const on = el.dataset.on !== "true";
  el.disabled = true;
  try {
    const { onBoard } = await api("/me/board", { method: "PUT", body: { on } });
    el.dataset.on = String(onBoard);
    el.querySelector(".board-val").textContent = onBoard ? "参加中" : "已关闭";
    el.querySelector(".swap").textContent = onBoard ? "关闭" : "打开";
    toast(onBoard ? "已加入排行榜" : "已退出排行榜：别人看不到你，你的首页也不再显示排名");
  } finally {
    el.disabled = false;
  }
};

/** 可折叠的卡片：标题行就是 sec-head */
const foldCard = (key, cls, title, meta, body, open = true) =>
  fold(`<div class="sec-head"><h2>${title}</h2><span>${meta}</span></div>`, body, { key, open, cls: `panel-card ${cls}` });

/** 字符串散列成 0~1，让书脊高矮错落但每次一样 */
const hash01 = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 1000 / 1000;

/** 书架：最近读过的词是一本本书脊，最新的在最左边 */
function shelf(items) {
  if (!items.length) {
    return `<div class="spines empty-shelf"><a href="#/">书架还空着，读完今天的故事就放上第一本 ${icon("arrow")}</a></div>`;
  }
  const books = items
    .map((x) => {
      const h = 92 + Math.round(hash01(x.id) * 34);
      const w = Math.min(40, 24 + Math.round(x.headword.length * 0.9));
      return `<a class="spine${x.starred ? " starred" : ""}" href="#/w/${esc(x.id)}" style="${tint(x)};--h:${h}px;--w:${w}px" title="${esc(x.headword)} · ${esc(x.meaning)}"><span>${esc(x.headword)}</span></a>`;
    })
    .join("");
  return `<div class="spines" role="list" aria-label="最近读过的词">${books}</div>`;
}

const MONTH_CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];

/** 阅读足迹：每天一格，读过的那天印上那个词的专题色；宽屏显示半年，手机显示 16 周 */
function footprints(f, totalDays) {
  const weeks = innerWidth >= 640 ? 26 : 16;
  const days = new Map(f.days.map((x) => [x.day, x]));
  const [y, m, d] = f.start.split("-").map(Number);
  const d0 = d + (26 - weeks) * 7;
  const cells = [];
  const months = [];
  for (let i = 0; i < weeks * 7; i++) {
    const day = new Date(Date.UTC(y, m - 1, d0 + i)).toISOString().slice(0, 10);
    const col = Math.floor(i / 7);
    const mon = Number(day.slice(5, 7));
    if (i % 7 === 0 && (col === 0 || months.at(-1)?.mon !== mon)) months.push({ col, mon });
    const x = days.get(day);
    if (day > f.today) cells.push(`<span class="fp future"></span>`);
    else if (x) {
      cells.push(`<a class="fp on${x.n > 1 ? " more" : ""}" href="#/w/${esc(x.entry.id)}" style="${tint(x.entry)}" title="${fmtDay(day)} · ${esc(x.entry.headword)}${x.n > 1 ? ` 等 ${x.n} 个` : ""}"></a>`);
    } else cells.push(`<span class="fp${day === f.today ? " today" : ""}" title="${fmtDay(day)}"></span>`);
  }
  // 两个月份标签挨得太近时只留后一个
  const labels = months
    .filter((x, i) => !months[i + 1] || months[i + 1].col - x.col >= 3)
    .map((x) => `<span style="grid-column:${x.col + 1}">${MONTH_CN[x.mon - 1]}月</span>`)
    .join("");
  return foldCard("me.footprints", "fp-card", "阅读足迹", `近 ${weeks} 周 · 累计 <b>${totalDays}</b> 天读过`,
    `<div class="fp-months" style="--weeks:${weeks}">${labels}</div>
    <div class="fp-grid" style="--weeks:${weeks}">${cells.join("")}</div>
    <p class="fp-legend"><span class="fp"></span>没读<span class="fp on" style="--t:#8a3b2c"></span>读过，颜色是那个词的专题</p>`);
}

/** 专题收集：每个专题一枚纹章，外圈是这个专题的阅读进度 */
function collection(themes) {
  const vague = (t) => (t.theme === "人名" || t.theme === "地名" ? 1 : 0);
  const sorted = [...themes].sort((a, b) => vague(a) - vague(b) || b.read / b.count - a.read / a.count || b.count - a.count);
  const lit = themes.filter((t) => t.read).length;
  const items = sorted
    .map((t) => {
      const pct = Math.round((t.read / t.count) * 100);
      return `<a class="medal${t.read ? " lit" : ""}${t.read === t.count ? " full" : ""}" href="#/explore/t/${encodeURIComponent(t.theme)}" style="--t:${themeOf(t.theme).color};--p:${pct}%">
        <span class="ring">${emblem(t.theme)}</span>
        <b>${esc(t.theme)}</b><small>${t.read} / ${t.count}</small>
      </a>`;
    })
    .join("");
  return foldCard("me.medals", "medal-card", "专题纹章", `点亮 <b>${lit}</b> / ${themes.length}`, `<div class="medals">${items}</div>`, isWide());
}

/** 词从哪里来：读过的词按语源统计 */
function origins(langs, read) {
  if (!langs.length) return "";
  const max = langs[0].n;
  const li = (l) => `<li><span class="lang">${esc(l.lang)}</span><span class="bar"><span style="width:${Math.max(6, (l.n / max) * 100)}%"></span></span><b>${l.n}</b></li>`;
  // 前 5 种语言直接看，其余的收起来
  const rest = langs.slice(5);
  return foldCard("me.origins", "origin-card", "词从哪里来", `按语源统计读过的 ${read} 个词`,
    `<ul class="origins">${langs.slice(0, 5).map(li).join("")}</ul>
    ${rest.length ? `<details class="more-q origins-more"><summary>其余 ${rest.length} 种语言</summary><ul class="origins">${rest.map(li).join("")}</ul></details>` : ""}
    <p class="fine">一个词可能先后经过几种语言，所以加起来会比读过的词多。</p>`, isWide());
}

/** 收藏：一面卡片墙，可以按专题筛选 */
export async function viewStarred() {
  const items = await api("/starred");
  const themes = [...new Set(items.map(primaryTheme))];
  render(`
    <button class="back" data-action="back">${icon("left")}我的</button>
    <header class="page-head"><h1>我的收藏<span class="en">Favorites</span></h1><p>${items.length ? `${items.length} 个让你停下来的词` : ""}</p></header>
    ${themes.length > 1
      ? `<div class="filters" role="group" aria-label="按专题筛选">
          <button class="filter" data-action="filter-starred" data-theme="" aria-pressed="true">全部 ${items.length}</button>
          ${themes.map((t) => `<button class="filter" data-action="filter-starred" data-theme="${esc(t)}" aria-pressed="false" style="--t:${themeOf(t).color}">${esc(t)} ${items.filter((x) => primaryTheme(x) === t).length}</button>`).join("")}
        </div>`
      : ""}
    ${items.length
      ? `<div class="wall">${items.map(favCard).join("")}</div>`
      : empty("读到喜欢的词，点右上角的星星收进这里", `<a class="btn sm" href="#/explore">去探索翻翻</a>`)}`);
}

const favCard = (x) => {
  const theme = primaryTheme(x);
  return `<a class="fav" href="#/w/${esc(x.id)}" style="${tint(x)}" data-theme="${esc(theme)}">
    ${emblem(theme)}
    ${themeTag(theme)}
    <b>${esc(x.headword)}</b>
    <span class="m">${esc(x.meaning)}</span>
    ${x.read ? (x.keyline ? `<p>${rich(x.keyline)}</p>` : "") : `<p class="q">${rich(x.teaser)}<i>还没读完</i></p>`}
    ${x.starredDay ? `<small>收藏于 ${fmtDay(x.starredDay, { weekday: false })}</small>` : ""}
  </a>`;
};

actions["filter-starred"] = (el) => {
  const theme = el.dataset.theme;
  for (const b of document.querySelectorAll(".filter")) b.setAttribute("aria-pressed", String(b === el));
  for (const c of document.querySelectorAll(".fav")) c.hidden = !!theme && c.dataset.theme !== theme;
};

const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 阅读记录：按月分组的时间线，每天一格，写着那天读的词和“一句话记住” */
export async function viewHistory() {
  const days = await api("/history");
  const words = days.reduce((n, d) => n + d.entries.length, 0);
  const months = new Map();
  for (const d of days) {
    const key = d.day.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(d);
  }
  const item = (d) => {
    const [y, m, dd] = d.day.split("-").map(Number);
    const wd = WD[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
    return `<li class="tl-day" style="${tint(d.entries[0])}">
      <div class="tl-date"><b>${dd}</b><span>${wd}</span></div>
      <div class="tl-entries">${d.entries
        .map(
          (x) => `<a class="tl-entry" href="#/w/${esc(x.id)}" style="${tint(x)}">
            <span class="tl-head"><b>${esc(x.headword)}</b>${x.daily ? `<span class="pushed">当日推送</span>` : ""}${x.starred ? icon("star", "star-s") : ""}</span>
            <span class="tl-key">${rich(x.keyline || x.meaning)}</span>
          </a>`,
        )
        .join("")}</div>
    </li>`;
  };
  render(`
    <button class="back" data-action="back">${icon("left")}我的</button>
    <header class="page-head"><h1>阅读记录<span class="en">Reading Log</span></h1><p>${days.length ? `${days.length} 天，${words} 个词。含每日推送和你主动读的` : "每读完一个词，这里就多一行"}</p></header>
    ${days.length
      ? [...months]
          .map(([key, list], i) => {
            const [y, m] = key.split("-").map(Number);
            const n = list.reduce((a, d) => a + d.entries.length, 0);
            const head = `<h2><b>${m}</b><span>月</span><small>${y} · 读了 ${n} 个词</small></h2>`;
            const body = `<ol class="timeline">${list.map(item).join("")}</ol>`;
            // 宽屏左边月份停靠、右边时间线，本来就不长；手机上最近两个月展开，更早的收起来，点月份再看
            return isWide() ? `<section class="tl-month">${head}${body}</section>` : fold(head, body, { open: i < 2, cls: "tl-month" });
          })
          .join("")
      : empty("还没有读过的词，从今天开始", `<a class="btn sm primary" href="#/">读今天的故事</a>`)}`);
}

export async function viewReminder() {
  const [reminder, status, today, m] = await Promise.all([api("/reminder"), pushStatus(), api("/today"), api("/me/mail")]);
  mail = { ...m, sample: { word: today?.entry?.headword } };
  let panel;
  if (status === "needs-install") {
    panel = `<div class="panel">
      <p>iPhone / iPad 上，网页推送只对“添加到主屏幕”的网站开放（需 iOS 16.4 及以上）。</p>
      <ol class="steps-help">
        <li>用 <b>Safari</b> 打开本站</li>
        <li>点底部的“分享”按钮，选择“添加到主屏幕”</li>
        <li>从主屏幕的图标打开，再回到这一页开启提醒</li>
      </ol>
    </div>`;
  } else if (status === "unsupported") {
    panel = `<div class="panel"><p>当前浏览器不支持网页推送。可以换用 Chrome、Edge、Safari（macOS / iOS 16.4+），或把本站安装为应用后再试。</p></div>`;
  } else if (status === "denied") {
    panel = `<div class="panel"><p>本站的通知权限已被浏览器禁止。请在浏览器的网站设置里允许“通知”，然后刷新这一页。</p></div>`;
  } else {
    panel = `<div class="panel">
      <label class="field"><span>在这台设备上提醒我</span>
        <span class="switch"><input type="checkbox" id="push-on" ${status === "on" ? "checked" : ""}><span></span></span>
      </label>
      <label class="field"><span>提醒时间</span><input type="time" id="push-time" value="${esc(reminder.time)}"></label>
      <p>到点时，如果今天的故事还没读，就把今天的问题推送给你；已经读完就不打扰。提醒时间对所有设备生效。</p>
      ${status === "on" ? `<button class="btn sm" data-action="push-test">发一条测试通知</button>` : ""}
    </div>`;
  }

  render(`
    <button class="back" data-action="back">${icon("left")}我的</button>
    <header class="page-head"><h1>提醒与日报</h1><p>${STATUS_TEXT[status]}${reminder.devices ? ` · ${reminder.devices} 台设备已订阅` : ""}</p></header>
    <div class="sec-head"><h2>每日提醒</h2><span>网页推送</span></div>
    <div class="reminder-grid">
      ${notice(today.entry?.teaser, reminder.time)}
      <nav class="menu">${panel}</nav>
      ${!isStandalone() && status !== "needs-install" ? `<p class="tip">${icon("phone")}<span>把本站添加到手机主屏幕，打开时没有浏览器边框，用起来就像一个 App。</span></p>` : ""}
    </div>
    <section class="panel-card mail-card reminder-mail" id="mail-card">${mailCard()}</section>`);

  document.getElementById("push-on")?.addEventListener("change", async (ev) => {
    const box = ev.target;
    box.disabled = true;
    try {
      if (box.checked) {
        await enablePush();
        local.set("reminder-dismissed", true);
        toast("提醒已开启，发了一条测试通知");
      } else {
        await disablePush();
        toast("已关闭这台设备的提醒");
      }
    } catch (err) {
      box.checked = !box.checked;
      toast(err.message);
    }
    viewReminder();
  });

  document.getElementById("push-time")?.addEventListener("change", async (ev) => {
    if (!ev.target.value) return;
    await api("/reminder", { method: "PUT", body: { time: ev.target.value } });
    toast(`每天 ${ev.target.value} 提醒`);
  });
}

/** 通知预览：到点时收到的就是这样一条 */
const notice = (teaser, time) =>
  teaser
    ? `<figure class="notice-demo">
        <figcaption>每天 ${esc(time)}，如果还没读，你会收到：</figcaption>
        <div class="notice">
          <span class="seal"></span>
          <div><p class="n-top"><b>词源一日</b><span>${esc(time)}</span></p><p class="n-title">今天的问题</p><p class="n-body">${esc(teaser.replace(/\*/g, ""))}</p></div>
        </div>
      </figure>`
    : "";

actions["push-test"] = async () => {
  const { sent } = await api("/push/test", { method: "POST" });
  toast(sent ? "已发送，留意通知栏" : "没有可用的订阅，试试关掉再打开");
};

// ---------- 邮件日报（原在账号与安全页，2026-10-21 起与每日提醒合并到本页） ----------

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

const MAIL_STATUS = { sent: "已寄出", skipped: "没寄（已读过或没内容）", error: "没寄出，会重试", sending: "正在寄" };

let mail = null;

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
      .map((r) => `<li><time>${esc(fmtDay(r.day, { weekday: false }))}</time><span>${r.kind === "word" ? "每日单词" : "词源日报"}</span><em class="${esc(r.status)}">${MAIL_STATUS[r.status] ?? esc(r.status)}</em></li>`)
      .join("")}</ul></details>` : ""}`;
}

function redrawMail() {
  const el = document.getElementById("mail-card");
  if (el) el.innerHTML = mailCard();
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
