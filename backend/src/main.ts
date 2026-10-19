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
  changePassword, checkInvite, currentUser, ensureSetupInvite, login, logout, newInvite, normalizeCode, register,
  requireAdmin, requireAuth, resetPassword, type AppEnv,
} from "./auth.ts";
import {
  bestStreak, futureAssigned, isDone, localDay, resurface, review, shiftDay, streak, todayId, todayProgress, todayReason, tomorrowId,
  weekDays,
} from "./daily.ts";
import { recommend } from "./recommend.ts";
import * as db from "./db.ts";
import {
  allSummaries, findWord, getEntry, getRedirect, gist, kinOf, loadEntries, related, search, summarize,
  themeGroups, totalCount, type Summary,
} from "./entries.ts";
import { checkTime, initPush, isValidSub, sendToUser, vapidPublicKey } from "./push.ts";
import { cleanSpeech, gloss, initSpeech, speech, type Accent } from "./speech.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const FRONTEND_DIR = process.env.FRONTEND_DIR ? resolve(process.env.FRONTEND_DIR) : "";

loadEntries(process.env.ENTRIES_PATH ?? resolve(ROOT, "data/entries.json"));
const STATE_DB = process.env.STATE_DB ?? resolve(ROOT, "var/app.db");
db.openDb(STATE_DB);
db.purgeExpiredSessions();
initPush();
// 发音缓存放在数据库旁边，部署时不会被覆盖
initSpeech(process.env.AUDIO_CACHE ?? resolve(dirname(STATE_DB), "audio"));

const app = new Hono<AppEnv>();
app.use(secureHeaders());
app.use(compress());

// 改动数据的请求必须是 JSON：浏览器跨站提交表单发不出 JSON，配合 SameSite Cookie 防 CSRF
app.use("/api/*", async (c, next) => {
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
  const { code = "", username = "", password = "" } = await body<{ code?: string; username?: string; password?: string }>(c);
  const err = await register(c, String(code), String(username), String(password));
  return err ? c.json({ error: err }, 400) : c.json({ ok: true });
});

app.post("/api/logout", (c) => {
  logout(c);
  return c.json({ ok: true });
});

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

function detail(uid: number, id: string) {
  const e = getEntry(id);
  if (!e) return undefined;
  const day = localDay();
  const seeAlso = withState(uid, summariesOf(e.seeAlso ?? []));
  // 书外整理的关系：同根 / 同典故 / 衍生，附上一句理由
  const kin = kinOf(id).filter((l) => !(e.seeAlso ?? []).includes(l.id));
  const kinSum = withState(uid, summariesOf(kin.map((l) => l.id))).map((s, i) => ({ ...s, rel: kin[i]!.type, why: kin[i]!.why }));
  // 接着读：和这篇相关、又没读过的词
  const upNext = recommend({ uid, day, seed: day + id, anchor: id, exclude: busy(uid, day, id), limit: 2 }).map((p) => ({
    ...withState(uid, summariesOf([p.id]))[0]!,
    reason: p.reason,
  }));
  return {
    ...e,
    ...db.getState(uid, id),
    seeAlso,
    kin: kinSum,
    related: withState(uid, related(id)),
    upNext,
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
  const r = getRedirect(id);
  if (r) return c.json({ redirect: r.redirect });
  const d = detail(uidOf(c), id);
  return d ? c.json(d) : c.json({ error: "not found" }, 404);
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

/** 每日目标只能选这几个 */
const GOALS = [1, 2, 3, 5];
api.put("/me/goal", async (c) => {
  const { goal } = await body<{ goal?: number }>(c);
  if (!GOALS.includes(Number(goal))) return c.json({ error: `目标只能是 ${GOALS.join(" / ")} 个` }, 400);
  db.setGoal(uidOf(c), Number(goal));
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
    settings: { regPaused: db.getSetting("regPaused") === "1" },
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
