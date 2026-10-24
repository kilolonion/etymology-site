// RSS 订阅：和邮件日报同样两种——“每日单词”（每天推给你的那个词，全文）和“词源日报”（每天一整版的目录）。
// 阅读器带不了登录 Cookie，所以每人一把随机钥匙放在订阅地址里：/api/feed/<钥匙>/word.xml、paper.xml。
// 钥匙只能读这两个源，重置就换一把、旧地址立刻失效；关掉就清空。站点只对受邀成员开放，地址别公开分享。
//
// 正文给阅读器看，不带行内样式（大多数阅读器会剥掉），只用 p / h3 / blockquote / ul 这些通用标签。
// 内容按天固定：同一天重复拉取结果一样（ETag 不变，阅读器不会反复标“有更新”），所以不标已读。

import { createHash, randomBytes } from "node:crypto";
import * as db from "./db.ts";
import { localDay, todayId, TZ } from "./daily.ts";
import { books, getEntry, gist } from "./entries.ts";
import { cnDate, esc, plain, primary, reasonPlain, shortDate, weekday } from "./mail.ts";
import { getOrBuildPaper, type PaperReason } from "./paper.ts";
import type { FullEntry } from "./types.ts";

export type FeedKind = "word" | "paper";
export const FEED_KINDS: FeedKind[] = ["word", "paper"];

/** 每日单词留最近多少天、日报留最近多少期 */
const WORD_DAYS = 30;
const PAPER_DAYS = 14;

export const newFeedKey = () => randomBytes(18).toString("base64url");
export const feedUrl = (site: string, key: string, kind: FeedKind) => `${site}/api/feed/${key}/${kind}.xml`;

// ---------- 小工具 ----------

/** XML 文本 / 属性转义 */
const x = (s = "") => esc(s);
/** 正文 HTML 放进 CDATA；正文里万一有 ]]> 就拆成两段 */
const cdata = (s: string) => `<![CDATA[${s.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
/** *斜体* → <em> */
const rich = (s = "") => esc(s).replace(/\*([^*]+)\*/g, "<em>$1</em>");

/** 某个时区里 day 那天 0 点的时刻（RSS 的 pubDate） */
function dayStart(day: string, tz = TZ): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(new Date(guess)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const o = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  const offset = o ? (o[1] === "-" ? -1 : 1) * (Number(o[2]) * 60 + Number(o[3] ?? 0)) : 0;
  return new Date(guess - offset * 60_000);
}

const entryUrl = (site: string, id: string) => `${site}/#/w/${encodeURIComponent(id)}`;

type Item = { title: string; link: string; guid: string; day: string; description: string; html: string; categories: string[] };

function channel(o: { site: string; self: string; title: string; description: string; items: Item[] }): string {
  const updated = o.items[0] ? dayStart(o.items[0].day) : new Date(0);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
<title>${x(o.title)}</title>
<link>${x(o.site)}/#/</link>
<atom:link href="${x(o.self)}" rel="self" type="application/rss+xml"/>
<description>${x(o.description)}</description>
<language>zh-CN</language>
<copyright>词条内容整理自${books().map((b) => `《${b.short}》`).join("、")}，权利归原书权利人所有；仅限个人学习使用，请勿转发订阅地址。</copyright>
<lastBuildDate>${updated.toUTCString()}</lastBuildDate>
<ttl>60</ttl>
<image><url>${x(o.site)}/icons/icon-180.png</url><title>${x(o.title)}</title><link>${x(o.site)}/#/</link></image>
${o.items.map((it) => `<item>
<title>${x(it.title)}</title>
<link>${x(it.link)}</link>
<guid isPermaLink="false">${x(it.guid)}</guid>
<pubDate>${dayStart(it.day).toUTCString()}</pubDate>
${it.categories.map((c) => `<category>${x(c)}</category>`).join("")}
<description>${x(it.description)}</description>
<content:encoded>${cdata(it.html)}</content:encoded>
</item>`).join("\n")}
</channel>
</rss>
`;
}

// ---------- 每日单词：一天一条，全文 ----------

function wordHtml(site: string, e: FullEntry): string {
  return [
    `<p><strong>${esc(e.headword)}</strong>${e.ipa ? ` /${esc(e.ipa)}/` : ""}${e.pos ? ` <em>${esc(e.pos)}.</em>` : ""} ${esc(e.meaning)}</p>`,
    `<h3>今天的问题</h3>`,
    `<p><strong>${rich(e.teaser)}</strong></p>`,
    ...e.etymology.map((p) => `<p>${rich(p)}</p>`),
    ...(e.keyline ? [`<h3>一句话记住</h3>`, `<p>${rich(e.keyline)}</p>`] : []),
    ...(e.examples.length ? [`<h3>例句</h3>`, ...e.examples.map((ex) => `<blockquote><p>${rich(ex.en)}</p><p>${esc(ex.zh)}</p></blockquote>`)] : []),
    `<p><a href="${esc(entryUrl(site, e.id))}">在词源一日打开这篇 →</a>（在站里读完才记进书架和连续天数）</p>`,
  ].join("\n");
}

function wordFeed(uid: number, site: string, self: string): string {
  const today = localDay();
  todayId(uid, today); // 今天的词第一次被要到时才锁定
  const days = db.allDaily(uid).filter((d) => d.day <= today);
  const items = days.slice(0, WORD_DAYS).flatMap((d, i): Item[] => {
    const e = d.ids.map((id) => getEntry(id)).find(Boolean);
    if (!e) return [];
    const theme = primary(e);
    return [{
      title: `${e.headword} · ${e.meaning}`,
      link: entryUrl(site, e.id),
      guid: `etymon-word-${d.day}-${e.id}`,
      day: d.day,
      description: `No. ${days.length - i} · ${shortDate(d.day)}　${plain(e.teaser)}`,
      html: wordHtml(site, e),
      categories: theme ? [theme] : [],
    }];
  });
  return channel({ site, self, title: "词源一日 · 每日单词", description: "每天推给你的那一个词：问题、词源故事、一句话记住和例句。", items });
}

// ---------- 词源日报：一天一期，整版目录 ----------

const why = (r: PaperReason | undefined) => {
  const s = reasonPlain(r);
  return s ? `<br><small>✦ ${esc(s)}</small>` : "";
};

function paperItem(uid: number, day: string, today: string, site: string): Item | undefined {
  const p = getOrBuildPaper(uid, day, today);
  if (!p) return undefined;
  const front = (db.getDaily(uid, day) ?? []).map((id) => getEntry(id)).find(Boolean);
  const lead = getEntry(p.lead ?? "");
  const sections = p.sections
    .map((s) => ({ ...s, items: s.items.map((it) => ({ e: getEntry(it.id), reason: it.reason })).filter((it): it is { e: FullEntry; reason: PaperReason } => !!it.e) }))
    .filter((s) => s.items.length);
  const all = [lead, ...sections.flatMap((s) => s.items.map((it) => it.e))].filter((e): e is FullEntry => !!e);
  if (!all.length && !front) return undefined;
  const minutes = Math.max(3, Math.round(all.length * 1.5));
  const link = (e: FullEntry) => `<a href="${esc(entryUrl(site, e.id))}"><strong>${esc(e.headword)}</strong></a>`;
  const paperUrl = `${site}/#/paper?day=${day}`; // 带上日期：过了这天点进去还是这一期

  const html = [
    `<p>${cnDate(day)} · ${weekday(day)}　本期 ${all.length} 篇 · 约 ${minutes} 分钟读完</p>`,
    ...(front ? [`<h3>头版 · 今天的词</h3>`, `<p>${link(front)}（${esc(front.meaning)}）<br>${rich(front.teaser)}</p>`] : []),
    ...(lead ? [
      `<h3>头条</h3>`,
      `<p>${link(lead)}${lead.ipa ? ` /${esc(lead.ipa)}/` : ""} ${esc(lead.meaning)}</p>`,
      `<p><strong>${rich(lead.teaser)}</strong></p>`,
      `<p>${rich(gist(lead, 110))}${why(p.leadReason)}</p>`,
    ] : []),
    ...sections.flatMap((s) => [
      `<h3>${esc(s.title)} <small>${esc(s.en)}</small></h3>`,
      ...(s.note ? [`<p><small>${esc(s.note)}</small></p>`] : []),
      `<ul>${s.items.map((it) => `<li>${link(it.e)}（${esc(it.e.meaning)}）${s.key === "recall" ? `一句话记住：${rich(it.e.keyline || it.e.teaser)}` : rich(it.e.teaser)}${why(it.reason)}</li>`).join("")}</ul>`,
    ]),
    `<p><a href="${esc(paperUrl)}">打开这一期日报 →</a></p>`,
  ].join("\n");

  return {
    title: `词源日报 · ${shortDate(day)}${lead ? ` · 头条 ${lead.headword}` : ""}`,
    link: paperUrl,
    guid: `etymon-paper-${day}`,
    day,
    description: `本期 ${all.length} 篇：${all.slice(0, 6).map((e) => e.headword).join("、")}${all.length > 6 ? "……" : ""}`,
    html,
    categories: [],
  };
}

function paperFeed(uid: number, site: string, self: string): string {
  const today = localDay();
  todayId(uid, today); // 今天的词要先锁定，日报才能避开它
  getOrBuildPaper(uid, today, today);
  const items = db.paperDays(uid, PAPER_DAYS).filter((d) => d <= today).flatMap((d) => paperItem(uid, d, today, site) ?? []);
  return channel({ site, self, title: "词源一日 · 词源日报", description: "每天一整版十二篇：头版、头条、接着读、今日专题、冷门一篇、温故。", items });
}

/** 生成订阅源；etag 按内容算，阅读器带 If-None-Match 来时可以直接回 304 */
export function buildFeed(kind: FeedKind, uid: number, site: string, self: string): { xml: string; etag: string } {
  const xml = kind === "word" ? wordFeed(uid, site, self) : paperFeed(uid, site, self);
  return { xml, etag: `"${createHash("sha1").update(xml).digest("base64url").slice(0, 20)}"` };
}
