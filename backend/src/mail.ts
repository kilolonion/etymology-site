// 邮件日报：两种信——“每日单词”（今天推给你的那个词）和“日报”（/api/paper 那一整版），
// 每人选自己要哪几种、几点收、按哪个时区；每天一封，发过记在 mail_log 里不重发，信尾带退订链接。
//
// 邮件 HTML 照邮件客户端的规矩写：表格布局 + 行内样式，<style> 只放手机断点和深色模式（Apple Mail / iOS 认，
// Gmail / Outlook 不认也不影响）；600px 居中，窄屏自动叠成一栏（两栏用 inline-block，不靠媒体查询）；
// Outlook 桌面版用条件注释包一层固定宽度的表格。图片只有报头的印章（PNG，取站点上的图标）。

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as db from "./db.ts";
import { isDone, localDay, localTime, TZ, todayId } from "./daily.ts";
import { getEntry, gist } from "./entries.ts";
import { getOrBuildPaper, type PaperReason } from "./paper.ts";
import { checkTime } from "./push.ts";
import { addrOf, isEmail, mailConfigured, sendMail, type Mail } from "./smtp.ts";
import type { FullEntry } from "./types.ts";

export { isEmail, mailConfigured };
export type MailKind = db.MailKind;
export const KINDS: MailKind[] = ["word", "paper"];
export const KIND_NAME: Record<MailKind, string> = { word: "每日单词", paper: "词源日报" };

/** 设定时间后多久之内还补发（服务器重启、休眠后），超过就等明天 */
const WINDOW_MINUTES = 120;
/** 失败后隔多久重试、最多试几次 */
const RETRY_MS = 15 * 60_000;
const MAX_TRIES = 3;

/** 信里链接指向的站点地址：生产环境务必设 SITE_URL；没设时退回本机地址（只适合本地预览） */
export const siteUrl = (fallback = `http://localhost:${process.env.PORT ?? 8787}`) =>
  (process.env.SITE_URL || fallback).replace(/\/+$/, "");

export function isTz(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------- 退订链接：不用登录，凭 HMAC 签名 ----------

function secret(): string {
  let s = db.getSetting("mailSecret");
  if (!s) {
    s = randomBytes(32).toString("base64url");
    db.setSetting("mailSecret", s);
  }
  return s;
}

export type UnsubKind = MailKind | "all";
const sign = (uid: number, kind: UnsubKind) => createHmac("sha256", secret()).update(`unsub:${uid}:${kind}`).digest("base64url").slice(0, 24);

export function checkUnsub(uid: number, kind: string, token: string): kind is UnsubKind {
  if (!Number.isInteger(uid) || uid <= 0 || !["word", "paper", "all"].includes(kind)) return false;
  const want = Buffer.from(sign(uid, kind as UnsubKind));
  const got = Buffer.from(String(token));
  return want.length === got.length && timingSafeEqual(want, got);
}

export const unsubUrl = (site: string, uid: number, kind: UnsubKind) =>
  `${site}/api/mail/unsubscribe?u=${uid}&k=${kind}&t=${sign(uid, kind)}`;

export function unsubscribe(uid: number, kind: UnsubKind): void {
  db.setMailPrefs(uid, kind === "all" ? { word: false, paper: false } : { [kind]: false });
}

// ---------- 排版用的小工具 ----------

const C = {
  bg: "#f4ede1", surface: "#fbf7ef", ink: "#241e19", ink2: "#4a4037", muted: "#8a7d6e", line: "#ddd2bf",
  accent: "#a3312a", accentInk: "#fbf3e8", gold: "#9c7630",
};
const DARK = { bg: "#17140f", surface: "#221d17", ink: "#efe6d6", ink2: "#cdc1ad", muted: "#988b78", line: "#3a3229", accent: "#df7d68" };

const F = {
  zh: `'Songti SC','Noto Serif SC','Source Han Serif SC','Noto Serif CJK SC',STSong,SimSun,serif`,
  display: `'Playfair Display','Iowan Old Style',Didot,Georgia,'Times New Roman',serif`,
  en: `'EB Garamond','Iowan Old Style',Palatino,Georgia,serif`,
  sans: `-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Segoe UI',Helvetica,Arial,sans-serif`,
};

/** 专题色，和前端 themes.js 保持一致 */
const THEMES: Record<string, { color: string; en: string }> = {
  希腊罗马神话: { color: "#3d5a80", en: "Mythology" },
  圣经与宗教: { color: "#8a6a2f", en: "Scripture" },
  文学与书刊: { color: "#6b4f7a", en: "Letters" },
  历史事件: { color: "#8a3b2c", en: "History" },
  人名: { color: "#56664a", en: "Names" },
  地名: { color: "#2f6f6a", en: "Places" },
  体育与娱乐: { color: "#b0573a", en: "Sport & Play" },
  风俗与生活: { color: "#9a4f68", en: "Customs" },
  动物与自然: { color: "#4a7346", en: "Nature" },
  农牧与狩猎: { color: "#85702f", en: "Field & Hunt" },
  航海与军事: { color: "#2b4766", en: "Sea & Arms" },
  商业与经济: { color: "#9c7424", en: "Commerce" },
  政治与法律: { color: "#4b4f70", en: "Law & Order" },
  新词与构词: { color: "#3b6e8c", en: "New Words" },
};
const FALLBACK = { color: "#7a5a3a", en: "Words" };
const VAGUE = new Set(["人名", "地名"]);
const primary = (e: FullEntry) => e.themes.find((t) => !VAGUE.has(t)) ?? e.themes[0] ?? "";
const themeOf = (e: FullEntry) => ({ name: primary(e), ...(THEMES[primary(e)] ?? FALLBACK) });

/** 两个颜色按比例混合（t 是 a 的占比） */
function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v * t + y[i]! * (1 - t)).toString(16).padStart(2, "0")).join("");
}

/** 深色模式下每个专题的字色、浅底：按用到的专题生成几条 class（只有支持的客户端会用） */
function themeCss(colors: Set<string>): string {
  return [...colors].map((c) => {
    const k = c.slice(1);
    return `.ti-${k}{color:${mix(c, "#ffffff", 0.5)}!important}.ts-${k}{background:${mix(c, DARK.surface, 0.16)}!important;border-left-color:${mix(c, DARK.line, 0.4)}!important;border-right-color:${mix(c, DARK.line, 0.4)}!important;border-bottom-color:${mix(c, DARK.line, 0.4)}!important}`;
  }).join("");
}

const esc = (s = "") =>
  String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** *斜体* → 英文衬线斜体 */
const rich = (s = "", color = "inherit") =>
  esc(s).replace(/\*([^*]+)\*/g, `<em style="font-family:${F.en};font-style:italic;color:${color};">$1</em>`);
const plain = (s = "") => s.replace(/\*/g, "");

const CN = "〇一二三四五六七八九";
const cnSmall = (n: number) => (n <= 10 ? (n === 10 ? "十" : CN[n]!) : n < 20 ? "十" + CN[n % 10] : CN[Math.floor(n / 10)] + "十" + (n % 10 ? CN[n % 10] : ""));
const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const parts = (day: string) => day.split("-").map(Number) as [number, number, number];
const cnDate = (day: string) => {
  const [y, m, d] = parts(day);
  return `${String(y).replace(/\d/g, (c) => CN[Number(c)]!)}年${cnSmall(m)}月${cnSmall(d)}日`;
};
const weekday = (day: string) => {
  const [y, m, d] = parts(day);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
};
const shortDate = (day: string) => {
  const [, m, d] = parts(day);
  return `${m} 月 ${d} 日`;
};
const eraText = (c: number) => (c < 0 ? `公元前 ${-c} 世纪` : `${c} 世纪`);

const REL_PHRASE: Record<string, string> = { 同根: "同根", 同典故: "出自同一典故", 衍生: "一脉相承" };

/** 推荐理由，和前端 reasonText + 日报的 why 一个说法 */
function reasonText(r: PaperReason | undefined): string {
  if (!r) return "";
  const w = (x: string) => `<em class="ink2" style="font-family:${F.display};font-style:italic;color:${C.ink2};">${esc(x)}</em>`;
  switch (r.type) {
    case "link": return `和你读过的 ${w(r.word)} 互为参见`;
    case "kin": return `和你读过的 ${w(r.word)} ${REL_PHRASE[r.rel] ?? "有关"}`;
    case "theme": return `你读过的 ${w(r.word)} 也属于「${esc(r.theme)}」`;
    case "anchor": return r.rel ? `和 ${w(r.word)} ${REL_PHRASE[r.rel] ?? "有关"}` : r.theme ? `和 ${w(r.word)} 同属「${esc(r.theme)}」` : `${w(r.word)} 的参见词条`;
    case "taste": return `你收藏过「${esc(r.theme)}」的词`;
    case "new": return `新专题：${esc(r.theme)}`;
    case "era": return `和今天的 ${w(r.word)} 同在${eraText(r.era)}`;
    case "road": return `和今天的 ${w(r.word)} 一样从${esc(r.lang)}出发`;
    case "fresh": return `你还没读过「${esc(r.theme)}」`;
    case "recall": return `${r.ago} 天前读过`;
    default: return "";
  }
}
const reasonPlain = (r: PaperReason | undefined) => reasonText(r).replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

// ---------- 版式零件 ----------

/** 一封信的上下文：站点地址、收件人、哪一种；colors 收集用到的专题色，给深色模式生成 class */
type Ctx = { site: string; uid: number; kind: MailKind; colors: Set<string>; other: boolean };
const ctxOf = (site: string, uid: number, kind: MailKind): Ctx => {
  const p = db.getMailPrefs(uid);
  return { site, uid, kind, colors: new Set(), other: !!(kind === "word" ? p?.paper : p?.word) };
};

const entryUrl = (x: Ctx, id: string) => `${x.site}/#/w/${encodeURIComponent(id)}`;

/** 整封信的外壳：预览文字、背景、600px 居中的纸面 */
function shell(x: Ctx, o: { title: string; preheader: string; body: string }): string {
  return `<!DOCTYPE html>
<html lang="zh-CN" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(o.title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table,td{mso-table-lspace:0;mso-table-rspace:0}
img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
a{text-decoration:none}
a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}
@media screen and (max-width:620px){
.wrap{padding:0!important}
.paper{border-radius:0!important;border-left:0!important;border-right:0!important}
.px{padding-left:20px!important;padding-right:20px!important}
.px2{padding-left:14px!important;padding-right:14px!important}
.mast-t{font-size:34px!important;letter-spacing:8px!important}
.hw{font-size:40px!important}
.hw-l{font-size:32px!important}
.col{max-width:100%!important;width:100%!important}
.hide-sm{display:none!important}
}
@media (prefers-color-scheme:dark){
.bg{background:${DARK.bg}!important}
.paper{background:${DARK.surface}!important;border-color:${DARK.line}!important}
.card{background:${DARK.surface}!important;border-left-color:${DARK.line}!important;border-right-color:${DARK.line}!important;border-bottom-color:${DARK.line}!important}
.ink{color:${DARK.ink}!important}
.ink2{color:${DARK.ink2}!important}
.mut{color:${DARK.muted}!important}
.acc{color:${DARK.accent}!important}
.line{border-color:${DARK.line}!important}
.rule{border-color:${DARK.ink}!important}
.btn{background:${DARK.accent}!important}
.btn a{color:${DARK.bg}!important}
${themeCss(x.colors)}
}
</style>
</head>
<body class="bg" style="margin:0;padding:0;width:100%;background:${C.bg};">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(o.preheader)}${"&#8199;&#65279;&#847; ".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background:${C.bg};">
<tr><td align="center" class="wrap" style="padding:28px 12px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="paper" style="max-width:600px;background:${C.surface};border:1px solid ${C.line};border-radius:18px;">
${o.body}
${footer(x)}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

/** 报头：No. 行 → 印章 + 刊名 → 英文副题 → 双线 */
function masthead(x: Ctx, o: { issue: number; day: string; title: string; sub: string }): string {
  return `<tr><td class="px" style="padding:26px 36px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td class="ink2" style="font-family:${F.display};font-style:italic;font-size:14px;color:${C.ink2};">No. ${o.issue} · Etymon</td>
    <td align="right" class="ink2" style="font-family:${F.zh};font-size:12px;letter-spacing:1px;color:${C.ink2};white-space:nowrap;">${cnDate(o.day)} · ${weekday(o.day)}</td>
  </tr></table>
  <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:22px auto 6px;"><tr>
    <td valign="middle" style="padding-right:14px;"><a href="${x.site}/#/"><img src="${x.site}/icons/icon-180.png" width="40" height="40" alt="词" style="display:block;width:40px;height:40px;border-radius:7px;"></a></td>
    <td valign="middle" class="ink mast-t" style="font-family:${F.zh};font-weight:700;font-size:40px;line-height:1.1;letter-spacing:12px;color:${C.ink};white-space:nowrap;">${esc(o.title)}</td>
  </tr></table>
  <p class="mut" style="margin:0;text-align:center;font-family:${F.display};font-style:italic;font-size:15px;color:${C.muted};">${esc(o.sub)}</p>
  <div class="rule" style="margin-top:18px;border-top:3px double ${C.ink};font-size:0;line-height:0;">&nbsp;</div>
</td></tr>`;
}

/** 栏目标题：中文 + 英文斜体 + 一条细线 */
function kicker(zh: string, en: string, note = ""): string {
  return `<tr><td class="px" style="padding:30px 36px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="white-space:nowrap;padding-right:12px;"><span class="ink" style="font-family:${F.zh};font-weight:700;font-size:15px;letter-spacing:3px;color:${C.ink};">${esc(zh)}</span><span class="mut" style="font-family:${F.display};font-style:italic;font-size:14px;color:${C.muted};padding-left:8px;">${esc(en)}</span></td>
    <td width="100%" style="vertical-align:middle;"><div class="line" style="border-top:1px solid ${C.line};font-size:0;line-height:0;">&nbsp;</div></td>
  </tr></table>
  ${note ? `<p class="mut" style="margin:6px 0 0;font-family:${F.sans};font-size:12.5px;color:${C.muted};">${esc(note)}</p>` : ""}
</td></tr>`;
}

/** 实心按钮（Outlook 下也是一整块可点的色块） */
function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0;"><tr>
  <td class="btn" align="center" bgcolor="${C.accent}" style="border-radius:12px;background:${C.accent};">
    <a href="${href}" style="display:inline-block;padding:13px 26px;font-family:${F.sans};font-size:15px;font-weight:600;letter-spacing:2px;color:${C.accentInk};text-decoration:none;border-radius:12px;">${label}</a>
  </td></tr></table>`;
}

/** 专题小标签：色点 + 中文 + 英文 */
function themeTag(e: FullEntry, x: Ctx): string {
  const t = themeOf(e);
  if (!t.name) return "";
  x.colors.add(t.color);
  const k = t.color.slice(1);
  return `<span class="ti-${k}" style="font-family:${F.sans};font-size:11.5px;letter-spacing:2px;color:${mix(t.color, "#000000", 0.9)};">● ${esc(t.name)}<span style="font-family:${F.display};font-style:italic;letter-spacing:0;opacity:.75;"> · ${esc(t.en)}</span></span>`;
}

function footer(x: Ctx): string {
  const other: MailKind = x.kind === "word" ? "paper" : "word";
  return `<tr><td class="px" style="padding:34px 36px 30px;">
  <div class="line" style="border-top:1px solid ${C.line};font-size:0;line-height:0;">&nbsp;</div>
  <p class="mut" style="margin:18px 0 0;text-align:center;font-family:${F.sans};font-size:12px;line-height:1.8;color:${C.muted};">
    你收到这封信，是因为在<a href="${x.site}/#/" class="mut" style="color:${C.muted};text-decoration:underline;">词源一日</a>订阅了「${KIND_NAME[x.kind]}」。<br>
    <a href="${x.site}/#/me/account" class="acc" style="color:${C.accent};">改收信时间或邮箱</a>
    ${x.other ? "" : `&nbsp;·&nbsp; <a href="${x.site}/#/me/account" class="acc" style="color:${C.accent};">也订「${KIND_NAME[other]}」</a>`}
    &nbsp;·&nbsp; <a href="${unsubUrl(x.site, x.uid, x.kind)}" class="acc" style="color:${C.accent};">退订这一种</a>
    &nbsp;·&nbsp; <a href="${unsubUrl(x.site, x.uid, "all")}" class="acc" style="color:${C.accent};">全部退订</a>
  </p>
  <p class="mut" style="margin:10px 0 0;text-align:center;font-family:${F.display};font-style:italic;font-size:13px;color:${C.muted};">A word, and its story, every day.</p>
</td></tr>`;
}

const textFooter = (x: Ctx) =>
  [
    "——",
    `你收到这封信，是因为在词源一日订阅了「${KIND_NAME[x.kind]}」。`,
    `改收信时间或邮箱：${x.site}/#/me/account`,
    `退订这一种：${unsubUrl(x.site, x.uid, x.kind)}`,
    `全部退订：${unsubUrl(x.site, x.uid, "all")}`,
  ].join("\n");

// ---------- 每日单词 ----------

export type Composed = { subject: string; html: string; text: string };

export function composeWord(uid: number, day: string, site: string): Composed | undefined {
  const id = todayId(uid, day);
  const e = getEntry(id ?? "");
  if (!e) return undefined;
  const x = ctxOf(site, uid, "word");
  const t = themeOf(e);
  x.colors.add(t.color);
  const k = t.color.slice(1);
  const tInk = mix(t.color, "#000000", 0.9);
  const tSoft = mix(t.color, C.surface, 0.1);
  const tLine = mix(t.color, C.line, 0.28);
  const issue = db.allDaily(uid).filter((d) => d.day <= day).length;
  const paper = getOrBuildPaper(uid, day, day);
  const more = paper ? paper.sections.reduce((n, s) => n + s.items.length, 0) + (paper.lead ? 1 : 0) : 0;

  const body = `${masthead(x, { issue, day, title: "词源一日", sub: "A word, and its story, every day." })}
${kicker("今天的词", "Today’s Word")}
<tr><td class="px" style="padding:16px 36px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card ts-${k}" style="background:${tSoft};border:1px solid ${tLine};border-top:4px solid ${t.color};border-radius:16px;">
  <tr><td style="padding:22px 24px 24px;">
    ${themeTag(e, x)}
    <h1 class="hw ti-${k}" style="margin:12px 0 0;font-family:${F.display};font-style:italic;font-weight:700;font-size:48px;line-height:1.05;color:${tInk};">${esc(e.headword)}</h1>
    <p class="ink2" style="margin:10px 0 0;font-family:${F.sans};font-size:14px;line-height:1.6;color:${C.ink2};">
      ${e.ipa ? `<span style="font-family:${F.en};font-size:16px;">/${esc(e.ipa)}/</span>&nbsp;&nbsp;` : ""}${e.pos ? `<i style="font-family:${F.en};">${esc(e.pos)}.</i>&nbsp;&nbsp;` : ""}<b class="ink" style="color:${C.ink};">${esc(e.meaning)}</b>
    </p>
  </td></tr>
  </table>
</td></tr>
<tr><td class="px" style="padding:24px 36px 0;">
  <p class="acc" style="margin:0;font-family:${F.sans};font-size:12px;font-weight:600;letter-spacing:3px;color:${C.accent};">今天的问题</p>
  <p class="ink" style="margin:8px 0 0;font-family:${F.zh};font-weight:700;font-size:21px;line-height:1.6;color:${C.ink};">${rich(e.teaser, tInk)}</p>
</td></tr>
<tr><td class="px" style="padding:16px 36px 0;">
  ${e.etymology.map((p, i) => `<p class="ink2" style="margin:${i ? "14px" : "0"} 0 0;font-family:${F.zh};font-size:16px;line-height:1.95;color:${C.ink2};">${rich(p, tInk)}</p>`).join("")}
</td></tr>
${e.keyline ? `<tr><td class="px" style="padding:22px 36px 0;">
  <p class="acc" style="margin:0;font-family:${F.sans};font-size:12px;font-weight:600;letter-spacing:3px;color:${C.accent};">一句话记住</p>
  <p class="ink" style="margin:8px 0 0;font-family:${F.zh};font-weight:700;font-size:17px;line-height:1.7;color:${C.ink};">${rich(e.keyline, tInk)}</p>
</td></tr>` : ""}
${e.examples.map((ex, i) => `<tr><td class="px" style="padding:${i ? 14 : 20}px 36px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td width="3" class="line" style="background:${C.gold};font-size:0;">&nbsp;</td>
    <td style="padding:2px 0 2px 16px;">
      <p class="ink" style="margin:0;font-family:${F.en};font-size:17px;line-height:1.55;color:${C.ink};">${rich(ex.en, tInk)}</p>
      <p class="mut" style="margin:4px 0 0;font-family:${F.zh};font-size:14px;line-height:1.6;color:${C.muted};">${esc(ex.zh)}</p>
    </td>
  </tr></table>
</td></tr>`).join("")}
<tr><td class="px" align="left" style="padding:28px 36px 0;">
  ${button(entryUrl(x, e.id), "打开这篇词条 &rarr;")}
  <p class="mut" style="margin:12px 0 0;font-family:${F.sans};font-size:12.5px;color:${C.muted};">读完会记进你的书架和连续天数。</p>
</td></tr>
${more ? `<tr><td class="px" style="padding:28px 36px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="background:${C.bg};border:1px solid ${C.line};border-radius:14px;"><tr>
    <td style="padding:16px 20px;">
      <p class="ink" style="margin:0;font-family:${F.zh};font-weight:700;font-size:15px;letter-spacing:2px;color:${C.ink};">今天的日报还有 ${more} 篇</p>
      <p class="mut" style="margin:4px 0 0;font-family:${F.sans};font-size:13px;color:${C.muted};">接着读、今日专题、冷门一篇、温故……想多读几个的时候翻一翻。</p>
    </td>
    <td align="right" style="padding:16px 20px 16px 0;white-space:nowrap;"><a href="${site}/#/paper" class="acc" style="font-family:${F.sans};font-size:14px;font-weight:600;color:${C.accent};">翻日报 &rarr;</a></td>
  </tr></table>
</td></tr>` : ""}`;

  const text = [
    `词源一日 · No. ${issue} · ${cnDate(day)} ${weekday(day)}`,
    "",
    `今天的词：${e.headword}${e.ipa ? `  /${e.ipa}/` : ""}  ${e.meaning}`,
    "",
    `今天的问题：${plain(e.teaser)}`,
    "",
    e.etymology.map((p) => plain(p)).join("\n\n"),
    ...(e.keyline ? ["", `一句话记住：${plain(e.keyline)}`] : []),
    ...e.examples.flatMap((ex) => ["", plain(ex.en), ex.zh]),
    "",
    `在网站打开这篇：${entryUrl(x, e.id)}`,
    ...(more ? [`今天的日报还有 ${more} 篇：${site}/#/paper`] : []),
    "",
    textFooter(x),
  ].join("\n");

  return {
    subject: `今日一词 · ${e.headword}`,
    html: shell(x, { title: `今日一词 · ${e.headword}`, preheader: `${plain(e.teaser)} ${e.meaning}`, body }),
    text,
  };
}

// ---------- 日报 ----------

/** 一篇：左边一道专题色，词头 + 释义 + 问题（温故给“一句话记住”）+ 推荐理由 */
function storyBlock(x: Ctx, e: FullEntry, reason: PaperReason | undefined, o: { recall?: boolean; read?: boolean } = {}): string {
  const t = themeOf(e);
  x.colors.add(t.color);
  const k = t.color.slice(1);
  const tInk = mix(t.color, "#000000", 0.9);
  const body = o.recall ? e.keyline || e.teaser : e.teaser;
  const why = reasonText(reason);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="background:${C.surface};border:1px solid ${C.line};border-top:3px ${o.recall ? "dashed" : "solid"} ${t.color};border-radius:14px;">
  <tr><td style="padding:14px 16px 16px;">
    <a href="${entryUrl(x, e.id)}" style="text-decoration:none;color:${C.ink};display:block;">
    ${themeTag(e, x)}${o.read ? `<span class="acc" style="float:right;font-family:${F.zh};font-size:11px;font-weight:700;letter-spacing:2px;color:${C.accent};border:1px solid ${C.accent};border-radius:4px;padding:0 5px;">已读</span>` : ""}
    <p class="ti-${k}" style="margin:8px 0 0;font-family:${F.display};font-style:italic;font-weight:700;font-size:22px;line-height:1.2;color:${tInk};">${esc(e.headword)}</p>
    <p class="mut" style="margin:3px 0 0;font-family:${F.sans};font-size:13px;color:${C.muted};">${esc(e.meaning)}</p>
    ${o.recall ? `<p class="mut" style="margin:10px 0 0;font-family:${F.sans};font-size:10.5px;font-weight:600;letter-spacing:2px;color:${C.muted};">一句话记住</p>` : ""}
    <p class="ink" style="margin:${o.recall ? 2 : 8}px 0 0;font-family:${F.zh};font-size:15px;line-height:1.75;color:${C.ink};">${rich(body, tInk)}</p>
    ${why ? `<p class="mut" style="margin:8px 0 0;font-family:${F.sans};font-size:12px;line-height:1.6;color:${C.muted};">✦ ${why}</p>` : ""}
    </a>
  </td></tr>
</table>`;
}

/** 一组：两栏（每栏 inline-block，窄屏自然叠成一栏；Outlook 用条件注释的表格并排） */
function grid(cells: string[]): string {
  if (cells.length === 1) return `<tr><td class="px" style="padding:12px 36px 0;">${cells[0]}</td></tr>`;
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 2) {
    const pair = cells.slice(i, i + 2);
    // 单数篇时最后一篇占满一行
    if (pair.length === 1) {
      rows.push(`<tr><td class="px" style="padding:12px 36px 0;">${pair[0]}</td></tr>`);
      continue;
    }
    rows.push(`<tr><td class="px2" style="padding:6px 30px 0;font-size:0;text-align:left;">
<!--[if mso]><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="50%" valign="top"><![endif]-->
<div class="col" style="display:inline-block;width:100%;max-width:264px;vertical-align:top;font-size:16px;"><div style="padding:6px;">${pair[0]}</div></div>
<!--[if mso]></td><td width="50%" valign="top"><![endif]-->
<div class="col" style="display:inline-block;width:100%;max-width:264px;vertical-align:top;font-size:16px;"><div style="padding:6px;">${pair[1]}</div></div>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>`);
  }
  return rows.join("\n");
}

export function composePaper(uid: number, day: string, site: string): Composed | undefined {
  todayId(uid, day); // 今天的词要先锁定，日报才能避开它
  const p = getOrBuildPaper(uid, day, day);
  if (!p) return undefined;
  const x = ctxOf(site, uid, "paper");
  const state = db.stateMap(uid);
  const read = (id: string) => !!state.get(id)?.read;
  const issue = db.allDaily(uid).filter((d) => d.day <= day).length;
  const front = (db.getDaily(uid, day) ?? []).map((id) => getEntry(id)).find(Boolean);
  const lead = getEntry(p.lead ?? "");
  const sections = p.sections
    .map((s) => ({ ...s, items: s.items.map((it) => ({ e: getEntry(it.id), reason: it.reason })).filter((it): it is { e: FullEntry; reason: PaperReason } => !!it.e) }))
    .filter((s) => s.items.length);
  const all = [lead, ...sections.flatMap((s) => s.items.map((it) => it.e))].filter((e): e is FullEntry => !!e);
  if (!all.length && !front) return undefined;
  const minutes = Math.max(3, Math.round(all.length * 1.5));

  let frontHtml = "";
  if (front) {
    const t = themeOf(front);
    x.colors.add(t.color);
    const k = t.color.slice(1);
    const tInk = mix(t.color, "#000000", 0.9);
    frontHtml = `<tr><td class="px" style="padding:20px 36px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card ts-${k}" style="background:${mix(t.color, C.surface, 0.1)};border:1px solid ${mix(t.color, C.line, 0.28)};border-radius:14px;">
  <tr><td style="padding:14px 18px 16px;">
    <a href="${entryUrl(x, front.id)}" style="display:block;text-decoration:none;color:${C.ink};">
    <p class="ti-${k}" style="margin:0;font-family:${F.sans};font-size:11px;font-weight:600;letter-spacing:3px;color:${tInk};">头版 · 今天的词${read(front.id) ? "（已读）" : ""}</p>
    <p class="ti-${k}" style="margin:6px 0 0;font-family:${F.display};font-style:italic;font-weight:700;font-size:26px;line-height:1.15;color:${tInk};">${esc(front.headword)}</p>
    <p class="ink2" style="margin:6px 0 0;font-family:${F.zh};font-size:15px;line-height:1.7;color:${C.ink2};">${read(front.id) ? esc(front.meaning) : rich(front.teaser, tInk)}</p>
    </a>
  </td></tr></table>
</td></tr>`;
  }

  let leadHtml = "";
  if (lead) {
    const t = themeOf(lead);
    x.colors.add(t.color);
    const k = t.color.slice(1);
    const tInk = mix(t.color, "#000000", 0.9);
    const why = reasonText(p.leadReason);
    leadHtml = `${kicker("头条", "Headline")}
<tr><td class="px" style="padding:14px 36px 0;">
  <a href="${entryUrl(x, lead.id)}" style="display:block;text-decoration:none;color:${C.ink};">
  ${themeTag(lead, x)}
  <h2 class="hw-l ti-${k}" style="margin:10px 0 0;font-family:${F.display};font-style:italic;font-weight:700;font-size:40px;line-height:1.08;color:${tInk};">${esc(lead.headword)}</h2>
  <p class="mut" style="margin:6px 0 0;font-family:${F.sans};font-size:14px;color:${C.muted};">${lead.ipa ? `<span style="font-family:${F.en};font-size:15px;">/${esc(lead.ipa)}/</span> &nbsp;` : ""}${esc(lead.meaning)}</p>
  <p class="ink" style="margin:12px 0 0;font-family:${F.zh};font-weight:700;font-size:19px;line-height:1.65;color:${C.ink};">${rich(lead.teaser, tInk)}</p>
  <p class="ink2" style="margin:10px 0 0;font-family:${F.zh};font-size:15px;line-height:1.9;color:${C.ink2};">${rich(gist(lead, 110), tInk)}</p>
  ${why ? `<p class="mut" style="margin:10px 0 0;font-family:${F.sans};font-size:12.5px;color:${C.muted};">✦ ${why}</p>` : ""}
  </a>
  <p style="margin:16px 0 0;"><a href="${entryUrl(x, lead.id)}" class="acc" style="font-family:${F.sans};font-size:14px;font-weight:600;color:${C.accent};">读头条 &rarr;</a></p>
</td></tr>`;
  }

  const secHtml = sections
    .map((s) => kicker(s.title, s.en, s.note) + "\n" + grid(s.items.map((it) => storyBlock(x, it.e, it.reason, { recall: s.key === "recall", read: s.key !== "recall" && read(it.e.id) }))))
    .join("\n");

  const heads = all.slice(0, 4).map((e) => e.headword).join("、");
  const body = `${masthead(x, { issue, day, title: "词源日报", sub: "The Etymon Daily, Twelve Stories a Day" })}
<tr><td class="px" style="padding:12px 36px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td class="mut" style="font-family:${F.sans};font-size:12.5px;color:${C.muted};">今天 <b class="acc" style="font-family:${F.display};font-size:15px;color:${C.accent};">${all.length}</b> 篇 · 约 ${minutes} 分钟读完</td>
    <td align="right" class="mut hide-sm" style="font-family:${F.display};font-style:italic;font-size:13px;color:${C.muted};">Vol. ${day.slice(0, 4)} · ${shortDate(day)}</td>
  </tr></table>
</td></tr>
${frontHtml}
${leadHtml}
${secHtml}
<tr><td class="px" align="center" style="padding:34px 36px 0;">
  <p class="mut" style="margin:0 0 14px;font-family:${F.zh};font-size:14px;color:${C.muted};">今天的日报就到这里，明天早上换新的一版</p>
  <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td>${button(`${site}/#/paper`, "打开今天的日报")}</td></tr></table>
</td></tr>`;

  const textItems = (items: { e: FullEntry; reason: PaperReason }[], recall: boolean) =>
    items.map((it) => `· ${it.e.headword}（${it.e.meaning}）${plain(recall ? it.e.keyline || it.e.teaser : it.e.teaser)}${reasonPlain(it.reason) ? ` —— ${reasonPlain(it.reason)}` : ""}\n  ${entryUrl(x, it.e.id)}`);
  const text = [
    `词源日报 · No. ${issue} · ${cnDate(day)} ${weekday(day)}`,
    `今天 ${all.length} 篇 · 约 ${minutes} 分钟`,
    ...(front ? ["", `【头版 · 今天的词】${front.headword}：${plain(front.teaser)}`, `  ${entryUrl(x, front.id)}`] : []),
    ...(lead ? ["", `【头条】${lead.headword}（${lead.meaning}）`, plain(lead.teaser), plain(gist(lead, 110)), `  ${entryUrl(x, lead.id)}`] : []),
    ...sections.flatMap((s) => ["", `【${s.title}】${s.note ? ` ${s.note}` : ""}`, ...textItems(s.items, s.key === "recall")]),
    "",
    `打开今天的日报：${site}/#/paper`,
    "",
    textFooter(x),
  ].join("\n");

  return {
    subject: `词源日报 · ${shortDate(day)}${lead ? ` · 头条 ${lead.headword}` : ""}`,
    html: shell(x, { title: `词源日报 · ${shortDate(day)}`, preheader: `今天 ${all.length} 篇：${heads}……`, body }),
    text,
  };
}

export function compose(kind: MailKind, uid: number, day: string, site: string): Composed | undefined {
  return kind === "word" ? composeWord(uid, day, site) : composePaper(uid, day, site);
}

/** 拼成一封信：带上一键退订的信头（Gmail / Yahoo 要求群发信有） */
export function toMail(c: Composed, to: string, uid: number, kind: MailKind, site: string): Mail {
  return {
    to,
    subject: c.subject,
    html: c.html,
    text: c.text,
    headers: {
      "List-Unsubscribe": `<${unsubUrl(site, uid, kind)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      "List-ID": `Etymon ${kind === "word" ? "Daily Word" : "Daily Paper"} <${kind}.${addrOf(process.env.MAIL_FROM ?? "").split("@")[1] ?? "localhost"}>`,
      "Auto-Submitted": "auto-generated",
    },
  };
}

/** 立刻发一封（测试、后台“发一封试试”）；返回服务器回执 */
export async function sendNow(kind: MailKind, uid: number, to: string, site = siteUrl()): Promise<string> {
  const day = localDay();
  const c = compose(kind, uid, day, site);
  if (!c) throw new Error(kind === "word" ? "今天还没有可推送的词" : "今天的日报还没有内容");
  return sendMail(toMail(c, to, uid, kind, site));
}

// ---------- 定时：每分钟看一遍，到了各人设定的时间就发 ----------

const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
let running = false;

export function initMail(): void {
  if (!mailConfigured()) {
    console.log("[mail] 没有配置 SMTP_HOST / MAIL_FROM，邮件日报不发（后台仍可预览）");
    return;
  }
  if (!process.env.SITE_URL) console.warn("[mail] 没有设置 SITE_URL，信里的链接会指向本机地址");
  setInterval(() => tick().catch((err) => console.error("[mail]", err)), 60_000);
  setTimeout(() => tick().catch((err) => console.error("[mail]", err)), 5_000);
}

export async function tick(at = new Date()): Promise<number> {
  if (running || !mailConfigured()) return 0;
  running = true;
  let sent = 0;
  try {
    const site = siteUrl();
    for (const u of db.mailTargets()) {
      if (!u.email || !isEmail(u.email)) continue;
      const tz = u.tz && isTz(u.tz) ? u.tz : TZ;
      const diff = minutes(localTime(at, tz)) - minutes(checkTime(u.time) ? u.time : "08:00");
      if (diff < 0 || diff > WINDOW_MINUTES) continue;
      // 去重按收件人自己的日期；内容按站点的“今天”（今天的词、日报都按站点日期锁定）
      const myDay = localDay(at, tz);
      const day = localDay(at);
      for (const kind of KINDS) {
        if (!(kind === "word" ? u.word : u.paper)) continue;
        if (!db.claimMail(u.id, kind, myDay, day, RETRY_MS, MAX_TRIES)) continue;
        try {
          if (kind === "word" && isDone(u.id, day)) {
            db.finishMail(u.id, kind, myDay, "skipped", "今天的词已经读过");
            continue;
          }
          const c = compose(kind, u.id, day, site);
          if (!c) {
            db.finishMail(u.id, kind, myDay, "skipped", "没有内容");
            continue;
          }
          await sendMail(toMail(c, u.email, u.id, kind, site));
          db.finishMail(u.id, kind, myDay, "sent");
          sent++;
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          db.finishMail(u.id, kind, myDay, "error", msg);
          console.error(`[mail] 发给 ${u.username} 的${KIND_NAME[kind]}失败：${msg}`);
        }
      }
    }
  } finally {
    running = false;
  }
  return sent;
}

// ---------- 退订页（不需要登录，服务器直接出一张小页面） ----------

export function unsubPage(o: { title: string; text: string; form?: { action: string; label: string }; site: string }): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex">
<title>${esc(o.title)} · 词源一日</title>
<style>
:root{--bg:${C.bg};--surface:${C.surface};--ink:${C.ink};--muted:${C.muted};--line:${C.line};--accent:${C.accent};--accent-ink:${C.accentInk}}
@media (prefers-color-scheme:dark){:root{--bg:${DARK.bg};--surface:${DARK.surface};--ink:${DARK.ink};--muted:${DARK.muted};--line:${DARK.line};--accent:${DARK.accent};--accent-ink:${DARK.bg}}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--ink);font:16px/1.7 ${F.sans}}
.card{width:100%;max-width:420px;padding:32px 28px 28px;border-radius:22px;background:var(--surface);border:1px solid var(--line);text-align:center}
img{width:52px;height:52px;border-radius:9px}
h1{margin:16px 0 6px;font:700 22px/1.4 ${F.zh};letter-spacing:.12em}
p{margin:0;color:var(--muted);font-size:15px}
.rule{margin:20px auto 22px;width:64px;border-top:3px double var(--ink);opacity:.7}
button,a.btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:10px 22px;border-radius:13px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);font:600 15px ${F.sans};letter-spacing:.06em;cursor:pointer;text-decoration:none}
a.link{display:inline-block;margin-top:16px;color:var(--muted);font-size:14px}
</style></head>
<body><main class="card">
<img src="/icons/icon-180.png" alt="">
<h1>${esc(o.title)}</h1>
<p>${o.text}</p>
<div class="rule"></div>
${o.form ? `<form method="post" action="${esc(o.form.action)}"><button>${esc(o.form.label)}</button></form>` : `<a class="btn" href="${esc(o.site)}/#/me/account">管理邮件订阅</a>`}
<br><a class="link" href="${esc(o.site)}/#/">回到词源一日</a>
</main></body></html>`;
}
