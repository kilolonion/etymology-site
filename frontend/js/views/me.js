// 我的：书架、阅读足迹、专题纹章、语源分布，以及收藏、阅读记录、每日提醒、账号、（管理员）邀请与成员的入口

import { actions, api, empty, esc, fmtDay, icon, local, render, rich, row, toast } from "../lib.js";
import { emblem, primaryTheme, themeOf, themeTag, tint } from "../themes.js";
import { disablePush, enablePush, isStandalone, pushStatus } from "../push.js";

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
      <a href="#/me/reminder">${icon("bell")}<span class="grow">每日提醒</span><span class="val">${reminderVal}</span>${icon("right", "i chev")}</a>
    </nav>
    <nav class="menu">
      <a href="#/me/account">${icon("key")}<span class="grow">账号与安全</span><span class="val">${esc(me.username)}</span>${icon("right", "i chev")}</a>
      ${me.isAdmin ? `<a href="#/me/admin">${icon("users")}<span class="grow">邀请与成员</span>${icon("right", "i chev")}</a>` : ""}
    </nav>
    </div>
    </div>`);
  document.querySelector(".spines")?.scrollTo({ left: 0 });
}

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
  return `<section class="panel-card fp-card">
    <div class="sec-head"><h2>阅读足迹</h2><span>近 ${weeks} 周 · 累计 <b>${totalDays}</b> 天读过</span></div>
    <div class="fp-months" style="--weeks:${weeks}">${labels}</div>
    <div class="fp-grid" style="--weeks:${weeks}">${cells.join("")}</div>
    <p class="fp-legend"><span class="fp"></span>没读<span class="fp on" style="--t:#8a3b2c"></span>读过，颜色是那个词的专题</p>
  </section>`;
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
  return `<section class="panel-card medal-card">
    <div class="sec-head"><h2>专题纹章</h2><span>点亮 <b>${lit}</b> / ${themes.length}</span></div>
    <div class="medals">${items}</div>
  </section>`;
}

/** 词从哪里来：读过的词按语源统计 */
function origins(langs, read) {
  if (!langs.length) return "";
  const max = langs[0].n;
  return `<section class="panel-card origin-card">
    <div class="sec-head"><h2>词从哪里来</h2><span>按语源统计读过的 ${read} 个词</span></div>
    <ul class="origins">${langs
      .map((l) => `<li><span class="lang">${esc(l.lang)}</span><span class="bar"><span style="width:${Math.max(6, (l.n / max) * 100)}%"></span></span><b>${l.n}</b></li>`)
      .join("")}</ul>
    <p class="fine">一个词可能先后经过几种语言，所以加起来会比读过的词多。</p>
  </section>`;
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
          .map(([key, list]) => {
            const [y, m] = key.split("-").map(Number);
            const n = list.reduce((a, d) => a + d.entries.length, 0);
            return `<section class="tl-month">
              <h2><b>${m}</b><span>月</span><small>${y} · 读了 ${n} 个词</small></h2>
              <ol class="timeline">${list.map(item).join("")}</ol>
            </section>`;
          })
          .join("")
      : empty("还没有读过的词，从今天开始", `<a class="btn sm primary" href="#/">读今天的故事</a>`)}`);
}

export async function viewReminder() {
  const [reminder, status, today] = await Promise.all([api("/reminder"), pushStatus(), api("/today")]);
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
    <header class="page-head"><h1>每日提醒</h1><p>${STATUS_TEXT[status]}${reminder.devices ? ` · ${reminder.devices} 台设备已订阅` : ""}</p></header>
    <div class="reminder-grid">
      ${notice(today.entry?.teaser, reminder.time)}
      <nav class="menu">${panel}</nav>
      ${!isStandalone() && status !== "needs-install" ? `<p class="tip">${icon("phone")}<span>把本站添加到手机主屏幕，打开时没有浏览器边框，用起来就像一个 App。</span></p>` : ""}
    </div>`);

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
