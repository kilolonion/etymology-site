// 后端：只提供 /api。前端是独立的静态站点，生产环境由 nginx 托管并把 /api 转发到这里。
// 本地开发时设置 FRONTEND_DIR，后端顺便托管前端文件，一个进程就能跑起来。

import { readdirSync, statSync, statfsSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { compress } from "hono/compress";
import { secureHeaders } from "hono/secure-headers";
import {
  allow, changePassword, checkInvite, currentUser, ensureSetupInvite, login, logout, newInvite, normalizeCode, register,
  requireAdmin, requireAuth, resetPassword, type AppEnv,
} from "./auth.ts";
import {
  bestStreak, futureAssigned, isDone, localDay, resurface, review, shiftDay, streak, todayId, todayProgress, todayReason, tomorrowId,
  TZ, weekDays,
} from "./daily.ts";
import { recommend } from "./recommend.ts";
import { getOrBuildPaper } from "./paper.ts";
import * as db from "./db.ts";
import { entriesAdmin } from "./admin-entries.ts";
import { initAuthoring, previewEntry, publicOrigin } from "./authoring.ts";
import { mcp, tokensAdmin } from "./mcp.ts";
import {
  allSummaries, findWord, getEntry, getRedirect, gist, kinOf, loadEntries, related, search, summarize,
  themeGroups, totalCount, type Summary,
} from "./entries.ts";
import type { FullEntry } from "./types.ts";
import { checkTime, initPush, isValidSub, sendToUser, vapidPublicKey } from "./push.ts";
import { cleanSpeech, gloss, initSpeech, speech, type Accent } from "./speech.ts";
import {
  checkUnsub, compose, initMail, isEmail, isTz, KIND_NAME, KINDS, sendNow, siteUrl, unsubPage, unsubscribe, unsubUrl,
  type MailKind,
} from "./mail.ts";
import { mailConfigInfo, mailConfigured } from "./smtp.ts";
import { buildFeed, FEED_KINDS, feedUrl, newFeedKey, type FeedKind } from "./feed.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const FRONTEND_DIR = process.env.FRONTEND_DIR ? resolve(process.env.FRONTEND_DIR) : "";

const STATE_DB = process.env.STATE_DB ?? resolve(ROOT, "var/app.db");
db.openDb(STATE_DB);
db.purgeExpiredSessions();
// 原书词条 + 后台发布的新词和补写（存在数据库里），所以要先开库
initAuthoring();
loadEntries(process.env.ENTRIES_PATH ?? resolve(ROOT, "data/entries.json"));
initPush();
initMail();
// 发音缓存放在数据库旁边，部署时不会被覆盖
initSpeech(process.env.AUDIO_CACHE ?? resolve(dirname(STATE_DB), "audio"));

const app = new Hono<AppEnv>();
app.use(secureHeaders());
app.use(compress());

// 改动数据的请求必须是 JSON：浏览器跨站提交表单发不出 JSON，配合 SameSite Cookie 防 CSRF
// 例外是邮件退订：邮件客户端的“一键退订”和退订页的按钮都是普通表单提交，靠链接里的签名认人，不靠 Cookie
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/mail/unsubscribe") return next();
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !c.req.header("content-type")?.includes("application/json")) {
    return c.json({ error: "请求格式不对" }, 415);
  }
  await next();
});

const body = <T>(c: Context) => c.req.json<T>().catch(() => ({}) as T);

// ---------- 登录、注册（不需要登录） ----------

app.get("/api/auth", (c) => {
  const cur = currentUser(c);
  return c.json({ loggedIn: !!cur, user: cur?.user ?? null });
});

app.post("/api/login", async (c) => {
  const { username = "", password = "" } = await body<{ username?: string; password?: string }>(c);
  const err = await login(c, String(username), String(password));
  return err ? c.json({ error: err }, 400) : c.json({ ok: true });
});

app.get("/api/invites/:code", (c) => c.json(checkInvite(c, c.req.param("code"))));

app.post("/api/register", async (c) => {
  const { code = "", username = "", password = "", email = "", mail = false, tz = "" } =
    await body<{ code?: string; username?: string; password?: string; email?: string; mail?: boolean; tz?: string }>(c);
  const err = await register(c, String(code), String(username), String(password), { email: String(email), mail: mail === true, tz: String(tz) });
  return err ? c.json({ error: err }, 400) : c.json({ ok: true });
});

app.post("/api/logout", (c) => {
  logout(c);
  return c.json({ ok: true });
});

// 邮件退订：GET 先出一张确认页（免得邮件网关预取链接就把人退订了），POST 才真退订；
// 邮件客户端的一键退订（RFC 8058）直接 POST 到同一个地址
const mailSite = (c: Context) => {
  const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
  return siteUrl(host ? `${proto}://${host}` : undefined);
};
app.on(["GET", "POST"], "/api/mail/unsubscribe", (c) => {
  const uid = Number(c.req.query("u"));
  const kind = c.req.query("k") ?? "";
  const site = mailSite(c);
  if (!checkUnsub(uid, kind, c.req.query("t") ?? "") || !db.getUser(uid)) {
    return c.html(unsubPage({ site, title: "链接不对", text: "这个退订链接不完整或已经失效。可以登录后在「我的 → 账号与安全」里关掉邮件。" }), 400);
  }
  const what = kind === "all" ? "所有邮件" : `「${KIND_NAME[kind as MailKind]}」邮件`;
  if (c.req.method === "GET") {
    return c.html(unsubPage({ site, title: `退订${what}？`, text: `确认之后，就不会再收到词源一日发来的${what}。以后想收，随时可以在账号设置里再打开。`, form: { action: unsubUrl(site, uid, kind), label: "确认退订" } }));
  }
  unsubscribe(uid, kind);
  return c.html(unsubPage({ site, title: "已退订", text: `以后不会再收到${what}了。` }));
});

/**
 * If-None-Match 按弱比较（RFC 9110）：nginx 开 gzip 时会把 ETag 改写成 W/"…"，阅读器回传的就是改写后的值；
 * 也可能一次带好几个（逗号分隔），或者是 *
 */
const etagMatches = (header: string | undefined, etag: string) =>
  !!header && header.split(",").some((t) => {
    const v = t.trim();
    return v === "*" || v.replace(/^W\//, "") === etag;
  });

// RSS：阅读器带不了 Cookie，凭订阅地址里的钥匙认人；只读，只有这个人自己的每日单词和日报。
// private：Cloudflare 等中间缓存不存（每人内容不同、地址就是凭证）；noindex：万一地址被贴出去也别被收录
app.get("/api/feed/:key/:file", (c) => {
  const kind = c.req.param("file").replace(/\.xml$/, "") as FeedKind;
  const u = FEED_KINDS.includes(kind) ? db.feedOwner(c.req.param("key")) : undefined;
  if (!u) return c.text("没有这个订阅（地址不对，或已经重置、关闭）", 404);
  if (!allow(`feed:${u.id}`, 30)) return c.text("拉取太频繁了，一分钟后再试", 429);
  const site = mailSite(c);
  const { xml, etag } = buildFeed(kind, u.id, site, feedUrl(site, c.req.param("key"), kind));
  c.header("ETag", etag);
  c.header("Cache-Control", "private, max-age=900");
  c.header("X-Robots-Tag", "noindex, nofollow");
  if (etagMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304);
  return c.body(xml, 200, { "Content-Type": "application/rss+xml; charset=utf-8" });
});

// MCP：给别的 AI 程序用，凭令牌（Authorization: Bearer）而不是登录 Cookie
app.route("/api/mcp", mcp);

// ---------- 以下接口需要登录，数据都属于当前用户 ----------
const api = new Hono<AppEnv>();
api.use(requireAuth);

const uidOf = (c: Context<AppEnv>) => c.get("user").id;

/** 给摘要附上当前用户的阅读 / 收藏状态 */
function withState<T extends { id: string }>(uid: number, items: T[]) {
  const state = db.stateMap(uid);
  return items.map((s) => ({ ...s, read: !!state.get(s.id)?.read, starred: !!state.get(s.id)?.starred }));
}

const summariesOf = (ids: string[]): Summary[] =>
  ids.flatMap((id) => {
    const e = getEntry(id);
    return e ? [summarize(e)] : [];
  });

/** 当前不该被推荐的词：今天的、已锁定的明日、以及额外指定的 */
function busy(uid: number, day: string, ...more: string[]): Set<string> {
  const set = futureAssigned(uid, day);
  for (const x of db.getDaily(uid, day) ?? []) set.add(x);
  for (const x of more) set.add(x);
  return set;
}

/** 文章页的数据；preview 是后台预览的稿子（还没进索引） */
function detail(uid: number, id: string, preview?: FullEntry) {
  const e = preview ?? getEntry(id);
  if (!e) return undefined;
  const day = localDay();
  const seeAlso = withState(uid, summariesOf(e.seeAlso ?? []));
  // 书外整理的关系：同根 / 同典故 / 衍生，附上一句理由（预览时稿子里的关系还没进索引，自己补上）
  const kinAll = preview
    ? [...(preview.links ?? []), ...kinOf(id).filter((l) => !(preview.links ?? []).some((x) => x.id === l.id))]
    : kinOf(id);
  const kin = kinAll.filter((l) => !(e.seeAlso ?? []).includes(l.id) && getEntry(l.id));
  const kinSum = withState(uid, summariesOf(kin.map((l) => l.id))).map((s, i) => ({ ...s, rel: kin[i]!.type, why: kin[i]!.why }));
  // 接着读：和这篇相关、又没读过的词
  const upNext = recommend({ uid, day, seed: day + id, anchor: id, exclude: busy(uid, day, id), limit: 2 }).map((p) => ({
    ...withState(uid, summariesOf([p.id]))[0]!,
    reason: p.reason,
  }));
  return {
    ...e,
    ...db.getState(uid, id),
    // 来源：不在书里的词、补写过的原书词条才有（核对人的名字不给读者）
    origin: publicOrigin(e.origin),
    patched: e.patched ? { fields: e.patched.fields, origin: publicOrigin(e.patched.origin) } : null,
    src: summarize(e).src ?? null,
    preview: !!preview,
    seeAlso,
    kin: kinSum,
    related: withState(uid, related(id)),
    upNext: preview ? [] : upNext,
  };
}

function stats(uid: number) {
  let read = 0;
  let starred = 0;
  for (const [id, s] of db.stateMap(uid)) {
    if (!getEntry(id)) continue;
    if (s.read) read++;
    if (s.starred) starred++;
  }
  return { total: totalCount(), read, starred, streak: streak(uid) };
}

api.get("/today", (c) => {
  const uid = uidOf(c);
  const day = localDay();
  const id = todayId(uid, day);
  const done = isDone(uid, day);
  const tomorrow = done ? getEntry(tomorrowId(uid, day) ?? "") : undefined;
  return c.json({
    day,
    // 第几期：到今天为止有推送的天数
    issue: db.allDaily(uid).filter((d) => d.day <= day).length,
    entry: id ? detail(uid, id) : null,
    reason: todayReason(uid, day),
    done,
    // 明日预告只显示问题（单词不显示），点开可提前读
    tomorrow: tomorrow ? { id: tomorrow.id, teaser: tomorrow.teaser } : null,
    stats: stats(uid),
    // 今天读了几个 / 目标几个；昨天漏了时怎么补
    progress: todayProgress(uid, db.getGoal(uid), day),
    // 本周七天：每天推送的词（今天之后的不透露）
    week: weekDays(day).map((d) => {
      const wid = d <= day ? db.getDaily(uid, d)?.find((x) => getEntry(x)) : undefined;
      return { day: d, entry: wid ? withState(uid, summariesOf([wid]))[0] : null };
    }),
    // 旧词重逢：按间隔重现一个以前读过的词
    resurface: (() => {
      const r = resurface(uid, day);
      // reviewed：今天已经点过“记得 / 忘了”的结果，刷新后按钮也显示成点过的样子
      const reviewed = r?.review?.lastDay === day ? (r.review.lastOk ? "ok" : "no") : null;
      return r ? { ...withState(uid, summariesOf([r.id]))[0], ago: r.ago, stage: r.stage, reviewed, due: r.review?.dueDay ?? null } : null;
    })(),
  });
});

/** 日报：?day=YYYY-MM-DD 看过去的（只有当时打开过、存下来的）；不带就是今天 */
api.get("/paper", (c) => {
  const uid = uidOf(c);
  const today = localDay();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("day") ?? "") ? c.req.query("day")! : today;
  if (day > today) return c.json({ error: "还没出版" }, 404);
  // 今天的词要先锁定，日报才能避开它
  if (day === today) todayId(uid, day);
  const p = getOrBuildPaper(uid, day, today);
  if (!p) return c.json({ error: "那天没有日报" }, 404);
  const state = db.stateMap(uid);
  const item = (id: string, reason: unknown) => {
    const s = withState(uid, summariesOf([id]))[0];
    return s ? { ...s, reason } : null;
  };
  const sections = p.sections
    .map((s) => ({ ...s, items: s.items.map((it) => item(it.id, it.reason)).filter(Boolean) }))
    .filter((s) => s.items.length);
  // 头条多给一段正文开头，版面上排成导语
  const leadItem = p.lead ? item(p.lead, p.leadReason ?? null) : null;
  const lead = leadItem ? { ...leadItem, gist: gist(getEntry(p.lead!)!, 140) } : null;
  const todayWordId = (db.getDaily(uid, day) ?? []).find((id) => getEntry(id));
  const ids = [p.lead, ...p.sections.flatMap((s) => s.items.map((it) => it.id))].filter((x): x is string => !!x && !!getEntry(x));
  return c.json({
    day,
    today: day === today,
    issue: db.allDaily(uid).filter((d) => d.day <= day).length,
    // 头版：主页上今天的那个词
    front: todayWordId ? withState(uid, summariesOf([todayWordId]))[0] ?? null : null,
    lead,
    sections,
    total: ids.length,
    read: ids.filter((id) => state.get(id)?.read).length,
    // 往期：最近七天存下的日报
    days: db.paperDays(uid, 7),
  });
});

/** “随手翻一页”：推荐一个没读过的词；shuffle=1 时在前几名里随机换（skip 为当前显示的词） */
api.get("/next", (c) => {
  const uid = uidOf(c);
  const day = localDay();
  const skip = c.req.query("skip") ?? "";
  const top = recommend({ uid, day, seed: day + "discover", exclude: busy(uid, day, skip), limit: 6 });
  const p = c.req.query("shuffle") ? top[Math.floor(Math.random() * top.length)] : top[0];
  return c.json({ entry: p ? { ...withState(uid, summariesOf([p.id]))[0], reason: p.reason } : null });
});

api.get("/entries", (c) => c.json(withState(uidOf(c), allSummaries())));

api.get("/entries/:id", (c) => {
  const id = c.req.param("id");
  // 管理员预览稿子：?draft=1
  if (c.req.query("draft") && c.get("user").isAdmin) {
    const p = previewEntry(id);
    return p ? c.json(detail(uidOf(c), id, p)) : c.json({ error: "没有这份稿子" }, 404);
  }
  const r = getRedirect(id);
  if (r) return c.json({ redirect: r.redirect });
  const d = detail(uidOf(c), id);
  return d ? c.json(d) : c.json({ error: "not found" }, 404);
});

/** 读者报错：每人每天最多 10 条 */
api.post("/entries/:id/report", async (c) => {
  const uid = uidOf(c);
  const id = c.req.param("id");
  if (!getEntry(id)) return c.json({ error: "not found" }, 404);
  const { text = "" } = await body<{ text?: string }>(c);
  const t = String(text).trim().slice(0, 500);
  if (t.length < 4) return c.json({ error: "多写几个字，说说哪里不对" }, 400);
  if (db.reportsToday(uid, new Date(Date.now() - 86_400_000).toISOString()) >= 10) return c.json({ error: "今天报得太多了，明天再来" }, 429);
  db.addReport(id, uid, t);
  return c.json({ ok: true });
});

api.post("/entries/:id/read", async (c) => {
  const uid = uidOf(c);
  const id = c.req.param("id");
  if (!getEntry(id)) return c.json({ error: "not found" }, 404);
  const { read = true, manual = false } = await body<{ read?: boolean; manual?: boolean }>(c);
  const day = localDay();
  const before = db.getState(uid, id).read;
  if (read) db.markRead(uid, id, day, !!manual);
  else db.markUnread(uid, id);
  return c.json({ ...db.getState(uid, id), stats: stats(uid), finish: read && !manual && !before ? finishInfo(uid, id, day) : null });
});

/** 读完一篇时的收尾：连续天数、今日目标、补签、名次、（读的是今天的词时）明日预告 */
function finishInfo(uid: number, id: string, day: string) {
  const goal = db.getGoal(uid);
  const p = todayProgress(uid, goal, day);
  const isToday = todayId(uid, day) === id;
  const t = isToday ? getEntry(tomorrowId(uid, day) ?? "") : undefined;
  let rank = null;
  if (db.getOnBoard(uid)) {
    const rows = boardRows(uid, day, day);
    const me = rows.find((r) => r.me);
    if (me && rows.length > 1) rank = { rank: me.rank, of: rows.length };
  }
  return {
    streak: streak(uid, day),
    best: bestStreak(uid),
    today: p.today,
    goal,
    repair: p.repair,
    isToday,
    tomorrow: t ? { id: t.id, teaser: t.teaser } : null,
    rank,
  };
}

/** 复习一次：旧词重逢的“记得 / 忘了”、考考你的对错，决定这个词下次多久后再出现 */
api.post("/entries/:id/review", async (c) => {
  const uid = uidOf(c);
  const id = c.req.param("id");
  if (!getEntry(id)) return c.json({ error: "not found" }, 404);
  const { ok = true } = await body<{ ok?: boolean }>(c);
  const r = review(uid, id, !!ok);
  return r ? c.json(r) : c.json({ error: "还没读过这个词" }, 400);
});

api.post("/entries/:id/star", async (c) => {
  const uid = uidOf(c);
  const id = c.req.param("id");
  if (!getEntry(id)) return c.json({ error: "not found" }, 404);
  const { starred = true } = await body<{ starred?: boolean }>(c);
  db.setStarred(uid, id, starred);
  return c.json(db.getState(uid, id));
});

api.get("/search", (c) => c.json(withState(uidOf(c), search(c.req.query("q") ?? ""))));

api.get("/themes", (c) => {
  const state = db.stateMap(uidOf(c));
  return c.json(
    themeGroups().map((g) => ({
      theme: g.theme,
      count: g.ids.length,
      read: g.ids.filter((id) => state.get(id)?.read).length,
      sample: g.ids.slice(0, 3).map((id) => getEntry(id)!.headword),
    })),
  );
});

api.get("/themes/:name", (c) => {
  const name = c.req.param("name");
  const g = themeGroups().find((x) => x.theme === name);
  return g ? c.json(withState(uidOf(c), summariesOf(g.ids))) : c.json({ error: "not found" }, 404);
});

/** 收藏：附上收藏的日期 */
api.get("/starred", (c) => {
  const uid = uidOf(c);
  const log = db.starredLog(uid).filter((r) => getEntry(r.id));
  const when = new Map(log.map((r) => [r.id, localDay(new Date(r.starred_at))]));
  return c.json(withState(uid, summariesOf(log.map((r) => r.id))).map((s) => ({ ...s, starredDay: when.get(s.id) })));
});

/** 阅读记录：按阅读日期分组列出所有读过的词，并标出哪个是当天的推送 */
api.get("/history", (c) => {
  const uid = uidOf(c);
  const groups = new Map<string, string[]>();
  for (const r of db.readLog(uid)) {
    if (!getEntry(r.id)) continue;
    if (!groups.has(r.read_day)) groups.set(r.read_day, []);
    groups.get(r.read_day)!.push(r.id);
  }
  return c.json(
    [...groups].sort(([a], [b]) => (a < b ? 1 : -1)).map(([day, ids]) => {
      const daily = new Set(db.getDaily(uid, day) ?? []);
      return { day, entries: withState(uid, summariesOf(ids)).map((s) => ({ ...s, daily: daily.has(s.id) })) };
    }),
  );
});

// ---------- 发音与词卡 ----------

/** 发音：真人录音优先，取不到返回 404，页面改用浏览器朗读 */
api.get("/say", async (c) => {
  const text = cleanSpeech(c.req.query("q") ?? "");
  const accent: Accent = c.req.query("accent") === "us" ? "us" : "uk";
  if (!text || !/[a-z]/i.test(text)) return c.json({ error: "没有可读的内容" }, 400);
  const clip = await speech(text, accent);
  if (!clip) return c.json({ error: "暂时取不到发音" }, 404);
  return c.body(new Uint8Array(clip.audio), 200, {
    "content-type": "audio/mpeg",
    // 同一段话的发音不会变
    "cache-control": "private, max-age=31536000, immutable",
    "x-audio-source": clip.source,
  });
});

/** 词卡：点正文里的词弹出的小卡片 */
function card(uid: number, id: string) {
  const e = getEntry(id);
  if (!e) return undefined;
  return { ...withState(uid, [summarize(e)])[0]!, gist: gist(e) };
}

api.get("/card/:id", (c) => {
  const d = card(uidOf(c), c.req.param("id"));
  return d ? c.json(d) : c.json({ error: "not found" }, 404);
});

/** 查一个英文词：书里有就给词卡，没有就给有道的简明释义 */
api.get("/lookup", async (c) => {
  const word = (c.req.query("w") ?? "").trim().slice(0, 40);
  if (!/^[a-z][a-z'’-]*$/i.test(word)) return c.json({ error: "只能查英文单词" }, 400);
  // 首字母大写的词条（May、March）只认大写的写法，免得情态动词 may 也弹出五月
  const e = findWord(word);
  if (e && !(/^[A-Z]/.test(e.headword) && /^[a-z]/.test(word))) return c.json({ word, card: card(uidOf(c), e.id) });
  return c.json({ word, gloss: await gloss(word) });
});

api.get("/stats", (c) => c.json(stats(uidOf(c))));

/** 别人的名字只给第一个字，后面用星号（最多三个），全名不出服务器 */
const maskName = (name: string) => {
  const [first = "", ...rest] = [...name];
  return first + "*".repeat(Math.min(3, Math.max(1, rest.length)));
};

/** 排行：[since, day] 里每人认真读完几个词（手动标记的不算）；一样多的并列，同名次按连续天数排；别人的名字打码 */
function boardRows(uid: number, since: string, day: string) {
  const by = new Map<number, { name: string; n: number }>();
  for (const r of db.boardRows(since, day)) {
    let u = by.get(r.id);
    if (!u) by.set(r.id, (u = { name: r.username, n: 0 }));
    if (r.entry && getEntry(r.entry)) u.n++;
  }
  const rows = [...by]
    .map(([id, u]) => ({ ...u, streak: streak(id), me: id === uid, rank: 0 }))
    .sort((a, b) => b.n - a.n || b.streak - a.streak || a.name.localeCompare(b.name))
    .map((r) => (r.me ? r : { ...r, name: maskName(r.name) }));
  rows.forEach((r, i) => (r.rank = i && r.n === rows[i - 1]!.n ? rows[i - 1]!.rank : i + 1));
  return rows;
}

/** 排行榜：今天（range=week 时是这周一到今天）。自己关掉了排行榜就只回 off */
api.get("/board", (c) => {
  const uid = uidOf(c);
  if (!db.getOnBoard(uid)) return c.json({ off: true });
  const day = localDay();
  const range = c.req.query("range") === "week" ? "week" : "day";
  const rows = boardRows(uid, range === "week" ? weekDays(day)[0]! : day, day);
  // 自己近 7 天每天读了几个，大号排行榜底下画成小柱子
  const counts = new Map(db.dailyCounts(uid, shiftDay(day, -6)).map((x) => [x.day, x.n]));
  const mine = Array.from({ length: 7 }, (_, i) => shiftDay(day, i - 6)).map((d) => ({ day: d, n: counts.get(d) ?? 0 }));
  return c.json({ range, day, rows, mine });
});

/** “我的”页：书架（最近读过的）、阅读足迹（近 26 周，窄屏只显示后 16 周）、专题收集、语源分布 */
api.get("/shelf", (c) => {
  const uid = uidOf(c);
  const day = localDay();
  const log = db.readLog(uid).filter((r) => getEntry(r.id));
  const byDay = new Map<string, string[]>();
  for (const r of log) {
    if (!byDay.has(r.read_day)) byDay.set(r.read_day, []);
    byDay.get(r.read_day)!.push(r.id);
  }
  const start = shiftDay(weekDays(day)[0]!, -7 * 25);
  const footprints = [...byDay]
    .filter(([d]) => d >= start)
    .map(([d, ids]) => ({ day: d, n: ids.length, entry: summariesOf(ids.slice(-1))[0] }));

  const state = db.stateMap(uid);
  const langs = new Map<string, number>();
  for (const r of log) for (const l of getEntry(r.id)!.langs ?? []) if (l !== "其他") langs.set(l, (langs.get(l) ?? 0) + 1);

  return c.json({
    stats: { ...stats(uid), best: bestStreak(uid) },
    shelf: withState(uid, summariesOf(log.slice(0, 40).map((r) => r.id))),
    footprints: { start, today: day, days: footprints },
    themes: themeGroups().map((g) => ({
      theme: g.theme,
      count: g.ids.length,
      read: g.ids.filter((id) => state.get(id)?.read).length,
    })),
    langs: [...langs].sort((a, b) => b[1] - a[1]).map(([lang, n]) => ({ lang, n })),
  });
});

// ---------- 账号 ----------

api.get("/me", (c) => c.json({ ...c.get("user"), onBoard: db.getOnBoard(uidOf(c)), goal: db.getGoal(uidOf(c)) }));

/** 每日目标：常用档位之外也可以自己填，1–50 之间的整数 */
api.put("/me/goal", async (c) => {
  const { goal } = await body<{ goal?: number }>(c);
  const n = Number(goal);
  if (!Number.isInteger(n) || n < 1 || n > 50) return c.json({ error: "目标填 1–50 之间的整数" }, 400);
  db.setGoal(uidOf(c), n);
  return c.json({ goal: db.getGoal(uidOf(c)) });
});

api.put("/me/board", async (c) => {
  const { on } = await body<{ on?: boolean }>(c);
  db.setOnBoard(uidOf(c), on !== false);
  return c.json({ onBoard: db.getOnBoard(uidOf(c)) });
});

api.put("/me/password", async (c) => {
  const { old = "", password = "" } = await body<{ old?: string; password?: string }>(c);
  const err = await changePassword(uidOf(c), c.get("sessionHash"), String(old), String(password));
  return err ? c.json({ error: err }, 400) : c.json({ ok: true });
});

// ---------- 邮件日报：邮箱选填，两种信各自开关，几点收、按哪个时区 ----------

const mailState = (uid: number) => {
  const p = db.getMailPrefs(uid)!;
  return {
    ...p,
    siteTz: TZ,
    configured: mailConfigured(),
    recent: db.recentMail(6, uid).map(({ kind, day, status, at, error }) => ({ kind, day, status, at, error: status === "error" ? "没发出去，稍后会重试" : error })),
  };
};

api.get("/me/mail", (c) => c.json(mailState(uidOf(c))));

api.put("/me/mail", async (c) => {
  const uid = uidOf(c);
  const b = await body<{ email?: string | null; word?: boolean; paper?: boolean; time?: string; tz?: string | null }>(c);
  const next: Partial<db.MailPrefs> = {};
  if (b.email !== undefined) {
    const email = String(b.email ?? "").trim();
    if (email && !isEmail(email)) return c.json({ error: "邮箱格式不对" }, 400);
    next.email = email || null;
  }
  if (b.time !== undefined) {
    if (!checkTime(String(b.time))) return c.json({ error: "时间格式应为 HH:MM" }, 400);
    next.time = String(b.time);
  }
  if (b.tz !== undefined) {
    const tz = String(b.tz ?? "").trim();
    if (tz && !isTz(tz)) return c.json({ error: "不认识这个时区" }, 400);
    next.tz = tz && tz !== TZ ? tz : null;
  }
  if (typeof b.word === "boolean") next.word = b.word;
  if (typeof b.paper === "boolean") next.paper = b.paper;
  const email = next.email !== undefined ? next.email : db.getMailPrefs(uid)?.email;
  if ((next.word || next.paper) && !email) return c.json({ error: "先填一个邮箱" }, 400);
  db.setMailPrefs(uid, next);
  return c.json(mailState(uid));
});

const kindOf = (s: unknown): MailKind => (KINDS.includes(s as MailKind) ? (s as MailKind) : "word");

/** 预览自己今天的信（浏览器里直接打开就是邮件的样子）；?format=text 看纯文本版 */
api.get("/me/mail/preview", (c) => {
  const uid = uidOf(c);
  const out = compose(kindOf(c.req.query("kind")), uid, localDay(), mailSite(c));
  if (!out) return c.html(unsubPage({ site: mailSite(c), title: "还没有内容", text: "今天还没有可以发的内容。" }), 404);
  if (c.req.query("format") === "text") return c.text(out.text);
  return c.html(out.html);
});

/** 给自己发一封试试：一分钟最多两封 */
api.post("/me/mail/test", async (c) => {
  const uid = uidOf(c);
  const { kind } = await body<{ kind?: string }>(c);
  const email = db.getMailPrefs(uid)?.email;
  if (!email) return c.json({ error: "先填一个邮箱" }, 400);
  if (!mailConfigured()) return c.json({ error: "站点还没配置发信服务，暂时发不了" }, 503);
  if (!allow(`mail-test:${uid}`, 2)) return c.json({ error: "发得太快了，一分钟后再试" }, 429);
  try {
    await sendNow(kindOf(kind), uid, email, mailSite(c));
    return c.json({ ok: true, to: email });
  } catch (err) {
    console.error("[mail] 测试信发送失败：", err);
    return c.json({ error: `没发出去：${(err as Error).message}` }, 502);
  }
});

// ---------- RSS 订阅：开 / 重置（换钥匙，旧地址作废）/ 关 ----------

const feedState = (c: Context<AppEnv>) => {
  const key = db.getFeedKey(uidOf(c));
  const site = mailSite(c);
  return { on: !!key, word: key ? feedUrl(site, key, "word") : null, paper: key ? feedUrl(site, key, "paper") : null };
};

api.get("/me/feed", (c) => c.json(feedState(c)));

api.put("/me/feed", async (c) => {
  const uid = uidOf(c);
  const { on = true, reset = false } = await body<{ on?: boolean; reset?: boolean }>(c);
  if (!on) db.setFeedKey(uid, null);
  else if (reset || !db.getFeedKey(uid)) db.setFeedKey(uid, newFeedKey());
  return c.json(feedState(c));
});

// ---------- 推送提醒（提醒时间每个用户一份，订阅按设备） ----------

api.get("/reminder", (c) => {
  const uid = uidOf(c);
  return c.json({ time: db.getReminderTime(uid), publicKey: vapidPublicKey(), devices: db.userPushSubs(uid).length });
});

api.put("/reminder", async (c) => {
  const { time = "" } = await body<{ time?: string }>(c);
  if (!checkTime(time)) return c.json({ error: "时间格式应为 HH:MM" }, 400);
  db.setReminderTime(uidOf(c), time);
  return c.json({ time });
});

api.post("/push/subscribe", async (c) => {
  const { subscription } = await body<{ subscription?: unknown }>(c);
  if (!isValidSub(subscription)) return c.json({ error: "订阅信息无效" }, 400);
  db.addPushSub(uidOf(c), subscription);
  return c.json({ ok: true });
});

api.post("/push/unsubscribe", async (c) => {
  const { endpoint = "" } = await body<{ endpoint?: string }>(c);
  db.removePushSub(endpoint, uidOf(c));
  return c.json({ ok: true });
});

api.post("/push/test", async (c) => {
  const uid = uidOf(c);
  const e = getEntry(todayId(uid) ?? "");
  const sent = await sendToUser(uid, {
    title: "提醒已开启",
    body: e?.teaser.replace(/\*/g, "") ?? "每天这个时间，给你一个单词的故事。",
    url: "/#/",
  });
  return c.json({ sent });
});

// ---------- 管理：邀请码与成员（仅管理员） ----------
const admin = new Hono<AppEnv>();
admin.use(requireAdmin);

const adminLog = (c: Context<AppEnv>, action: string, detail = "") => db.logAudit(uidOf(c), c.get("user").username, action, detail);
const idParam = (c: Context<AppEnv>) => Number(c.req.param("id"));
const headOf = (id: string) => getEntry(id)?.headword ?? id;
const backupDir = () => join(dirname(db.dbPath()), "backups");

// ----- 总览：数字、趋势、热门词、今天分发、系统状态 -----
admin.get("/overview", (c) => {
  const day = localDay();
  const users = db.listUsersAdmin(day);
  const weekAgo = shiftDay(day, -6);
  const trend = new Map(db.readTrend(shiftDay(day, -13)).map((t) => [t.day, t]));
  const days = Array.from({ length: 14 }, (_, i) => shiftDay(day, i - 13)).map((d) => ({
    day: d, reads: trend.get(d)?.reads ?? 0, readers: trend.get(d)?.readers ?? 0,
  }));
  const seenSince = (ms: number) => users.filter((u) => u.lastSeen && Date.parse(u.lastSeen) > Date.now() - ms).length;
  const totals = db.readTotals();
  let disk: { free: number; total: number } | null = null;
  try {
    const f = statfsSync(dirname(db.dbPath()));
    disk = { free: f.bavail * f.bsize, total: f.blocks * f.bsize };
  } catch {}
  return c.json({
    day,
    users: {
      total: users.length,
      admins: users.filter((u) => u.isAdmin).length,
      disabled: users.filter((u) => u.disabled).length,
      online24h: seenSince(86_400_000),
      online7d: seenSince(7 * 86_400_000),
      readToday: users.filter((u) => u.todayDone).length,
      readers7d: db.readersSince(weekAgo),
      withPush: users.filter((u) => u.devices > 0).length,
    },
    reads: { ...totals, entries: totalCount() },
    trend: days,
    topRead: db.topEntries("read").map((t) => ({ ...t, headword: headOf(t.id) })),
    topStarred: db.topEntries("starred").map((t) => ({ ...t, headword: headOf(t.id) })),
    today: db.dailyDistribution(day).map((t) => ({ ...t, headword: headOf(t.id), meaning: getEntry(t.id)?.meaning ?? "" })),
    invites: db.inviteCounts(),
    settings: { regPaused: db.getSetting("regPaused") === "1", aiInDaily: db.getSetting("aiInDaily") === "1" },
    system: {
      uptime: Math.round(process.uptime()),
      rss: process.memoryUsage().rss,
      node: process.version,
      // WAL 模式下新写入的数据先在 -wal 里，只看主文件会严重低估
      dbSize: [".", "-wal"].reduce((n, ext) => { try { return n + statSync(db.dbPath() + (ext === "." ? "" : ext)).size; } catch { return n; } }, 0),
      disk,
      backups: (() => {
        try {
          return readdirSync(backupDir()).filter((f) => f.endsWith(".db")).sort().reverse().slice(0, 6)
            .map((f) => ({ name: f, size: statSync(join(backupDir(), f)).size }));
        } catch { return []; }
      })(),
    },
  });
});

// ----- 邀请码 -----
admin.get("/invites", (c) => c.json(db.listInvites().filter((i) => !i.isAdmin || i.usedAt)));

admin.post("/invites", async (c) => {
  const { note = "", count = 1, days = 7 } = await body<{ note?: string; count?: number; days?: number }>(c);
  const n = Math.min(Math.max(Math.floor(Number(count)) || 1, 1), 20);
  const d = Math.min(Math.max(Math.floor(Number(days)) || 7, 1), 90);
  const codes = Array.from({ length: n }, () => newInvite(uidOf(c), String(note).trim(), d));
  adminLog(c, "生成邀请码", `${n} 个，${d} 天有效${note ? `，备注“${String(note).trim().slice(0, 20)}”` : ""}`);
  const list = codes.map((code) => db.getInvite(code));
  return c.json(n === 1 ? list[0] : { invites: list });
});

admin.delete("/invites/expired", (c) => {
  const n = db.deleteExpiredInvites();
  if (n) adminLog(c, "清理过期邀请码", `${n} 个`);
  return c.json({ deleted: n });
});

admin.delete("/invites/:code", (c) => {
  const code = normalizeCode(c.req.param("code"));
  db.deleteInvite(code);
  adminLog(c, "撤销邀请码", code);
  return c.json({ ok: true });
});

// ----- 成员 -----
admin.get("/users", (c) => c.json(db.listUsersAdmin(localDay())));

/** 某个成员的详情：最近读过的词、收藏、近 14 天足迹 */
admin.get("/users/:id", (c) => {
  const id = idParam(c);
  const day = localDay();
  const [u] = db.listUsersAdmin(day, id);
  if (!u) return c.json({ error: "没有这个用户" }, 404);
  const recent = db.readLog(id).slice(0, 12).map((r) => ({ id: r.id, headword: headOf(r.id), day: r.read_day }));
  const dailyMap = new Map(db.allDaily(id).map((d) => [d.day, d.ids[0] ?? ""]));
  const doneDays = new Set(db.readDays(id));
  const week = Array.from({ length: 14 }, (_, i) => shiftDay(day, i - 13)).map((d) => ({
    day: d, assigned: dailyMap.has(d) ? headOf(dailyMap.get(d)!) : null, read: doneDays.has(d),
  }));
  return c.json({
    ...u,
    streak: streak(id),
    best: bestStreak(id),
    todayWord: u.todayId ? { id: u.todayId, headword: headOf(u.todayId) } : null,
    recent,
    week,
  });
});

admin.post("/users/:id/reset-password", async (c) => {
  const id = idParam(c);
  const u = db.getUser(id);
  if (!u) return c.json({ error: "没有这个用户" }, 404);
  if (id === uidOf(c)) return c.json({ error: "修改自己的密码请到“账号与安全”" }, 400);
  const password = await resetPassword(id);
  adminLog(c, "重置密码", u.username);
  return c.json({ password });
});

/** 停用 / 恢复：停用后立即下线，并且不能再登录；数据保留 */
admin.post("/users/:id/disable", async (c) => {
  const id = idParam(c);
  const { disabled = true } = await body<{ disabled?: boolean }>(c);
  const u = db.getUser(id);
  if (!u) return c.json({ error: "没有这个用户" }, 404);
  if (id === uidOf(c)) return c.json({ error: "不能停用自己" }, 400);
  db.setDisabled(id, !!disabled);
  if (disabled) db.deleteUserSessions(id);
  adminLog(c, disabled ? "停用账号" : "恢复账号", u.username);
  return c.json({ ok: true });
});

/** 设为 / 取消管理员；至少留一个管理员，也不能动自己 */
admin.post("/users/:id/admin", async (c) => {
  const id = idParam(c);
  const { admin: makeAdmin = false } = await body<{ admin?: boolean }>(c);
  const u = db.getUser(id);
  if (!u) return c.json({ error: "没有这个用户" }, 404);
  if (id === uidOf(c)) return c.json({ error: "不能改自己的身份" }, 400);
  db.setAdmin(id, !!makeAdmin);
  adminLog(c, makeAdmin ? "设为管理员" : "取消管理员", u.username);
  return c.json({ ok: true });
});

/** 让对方所有设备退出登录（不改密码） */
admin.post("/users/:id/kick", (c) => {
  const id = idParam(c);
  const u = db.getUser(id);
  if (!u) return c.json({ error: "没有这个用户" }, 404);
  if (id === uidOf(c)) return c.json({ error: "想退出自己请用“账号与安全”" }, 400);
  db.deleteUserSessions(id);
  adminLog(c, "强制下线", u.username);
  return c.json({ ok: true });
});

admin.delete("/users/:id", (c) => {
  const id = idParam(c);
  if (id === uidOf(c)) return c.json({ error: "不能删除自己" }, 400);
  const u = db.getUser(id);
  db.deleteUser(id);
  adminLog(c, "删除成员", u?.username ?? String(id));
  return c.json({ ok: true });
});

// ----- 换今日词：给一个人，或给“今天还没读”的所有人 -----
admin.post("/today-word", async (c) => {
  const { id = "", userId, scope = "unread" } = await body<{ id?: string; userId?: number; scope?: "unread" | "all" }>(c);
  const e = getEntry(String(id));
  if (!e) return c.json({ error: "没有这个词条" }, 404);
  const day = localDay();
  const targets = db.listUsersAdmin(day).filter((u) => (userId === undefined ? !u.disabled && (scope === "all" || !u.todayDone) : u.id === Number(userId)));
  let changed = 0;
  let skipped = 0;
  db.tx(() => {
    for (const u of targets) {
      if (u.todayId === e.id) continue;
      const readNew = db.getState(u.id, e.id).read;
      const future = futureAssigned(u.id, day).has(e.id);
      if (readNew || future) { skipped++; continue; } // 读过的、已排到以后的，换了会重复
      db.setDaily(u.id, day, [e.id], { [e.id]: null });
      changed++;
    }
  });
  adminLog(c, "换今日词", `${e.headword}：${userId === undefined ? (scope === "all" ? "所有人" : "未读者") : targets[0]?.username ?? userId}，改 ${changed} 人，跳过 ${skipped} 人`);
  return c.json({ changed, skipped, headword: e.headword });
});

/** 联想补全：输入几个字母，列出匹配的词条（换今日词时用） */
admin.get("/words", (c) => c.json(search(c.req.query("q") ?? "", 8).map((h) => ({ id: h.id, headword: h.headword, meaning: h.meaning }))));

// ----- 推送 -----
admin.post("/push", async (c) => {
  const { title = "", text = "", userId } = await body<{ title?: string; text?: string; userId?: number }>(c);
  const t = String(title).trim().slice(0, 40);
  const b = String(text).trim().slice(0, 120);
  if (!t || !b) return c.json({ error: "标题和内容都要写" }, 400);
  const ids = userId === undefined
    ? db.listUsersAdmin(localDay()).filter((u) => u.devices > 0 && !u.disabled).map((u) => u.id)
    : [Number(userId)];
  let sent = 0;
  for (const id of ids) sent += await sendToUser(id, { title: t, body: b, url: "/#/" });
  adminLog(c, "发送推送", `${userId === undefined ? "所有订阅者" : db.getUser(Number(userId))?.username ?? userId}：${t}（成功 ${sent} 台设备）`);
  return c.json({ users: ids.length, sent });
});

// ----- 邮件日报：发信配置、订阅人数、最近的发送记录、发一封测试信 -----
admin.get("/mail", (c) => c.json({
  configured: mailConfigured(),
  config: mailConfigInfo(),
  siteUrl: process.env.SITE_URL ?? null,
  counts: db.mailCounts(),
  me: db.getMailPrefs(uidOf(c))?.email ?? null,
  recent: db.recentMail(30),
}));

admin.post("/mail/test", async (c) => {
  const { kind, to = "" } = await body<{ kind?: string; to?: string }>(c);
  const addr = String(to).trim() || db.getMailPrefs(uidOf(c))?.email || "";
  if (!isEmail(addr)) return c.json({ error: "填一个收件地址（或先在账号里填好自己的邮箱）" }, 400);
  if (!mailConfigured()) return c.json({ error: "还没有配置 SMTP：在 .env 里填 SMTP_HOST、MAIL_FROM 等，重启服务" }, 503);
  if (!allow(`mail-test:${uidOf(c)}`, 5)) return c.json({ error: "发得太快了，一分钟后再试" }, 429);
  const k = kindOf(kind);
  try {
    const receipt = await sendNow(k, uidOf(c), addr, mailSite(c));
    adminLog(c, "发测试邮件", `${KIND_NAME[k]} → ${addr}`);
    return c.json({ ok: true, to: addr, receipt });
  } catch (err) {
    return c.json({ error: `没发出去：${(err as Error).message}` }, 502);
  }
});

// ----- 全站设置 -----
admin.put("/settings", async (c) => {
  const { regPaused } = await body<{ regPaused?: boolean }>(c);
  if (typeof regPaused === "boolean") {
    db.setSetting("regPaused", regPaused ? "1" : "0");
    adminLog(c, regPaused ? "暂停注册" : "恢复注册");
  }
  return c.json({ regPaused: db.getSetting("regPaused") === "1" });
});

// ----- 备份：VACUUM INTO，在线做，不锁写；手动备份只留最近 10 份 -----
admin.post("/backup", (c) => {
  const name = `manual-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.db`;
  db.backupTo(join(backupDir(), name));
  const old = readdirSync(backupDir()).filter((f) => f.startsWith("manual-")).sort().reverse().slice(10);
  for (const f of old) try { unlinkSync(join(backupDir(), f)); } catch {}
  adminLog(c, "手动备份", name);
  return c.json({ name, size: statSync(join(backupDir(), name)).size });
});

admin.get("/audit", (c) => c.json(db.listAudit(40)));

admin.route("/entries", entriesAdmin);
admin.route("/tokens", tokensAdmin);
api.route("/admin", admin);
app.route("/api", api);
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

// ---------- 本地开发：顺便托管前端 ----------
if (FRONTEND_DIR) {
  app.use("/*", async (c, next) => {
    await next();
    const long = /^\/(fonts|icons)\//.test(c.req.path);
    c.header("Cache-Control", long ? "public, max-age=2592000" : "no-cache");
  });
  app.use("/*", serveStatic({ root: relative(process.cwd(), FRONTEND_DIR) }));
}

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  const base = `http://${info.address}:${info.port}`;
  console.log(`词源一日 API 已启动：${base}/api${FRONTEND_DIR ? `（同时托管前端 ${FRONTEND_DIR}）` : ""}`);
  const setup = ensureSetupInvite();
  if (setup) {
    console.log("\n还没有任何账号。用下面的管理员邀请码注册第一个账号：");
    console.log(`  邀请码：${setup}`);
    console.log(`  注册链接：<你的网址>/#/join/${setup}${FRONTEND_DIR ? `（本地：${base}/#/join/${setup}）` : ""}\n`);
  }
});
