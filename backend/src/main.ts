// 后端：只提供 /api。前端是独立的静态站点，生产环境由 nginx 托管并把 /api 转发到这里。
// 本地开发时设置 FRONTEND_DIR，后端顺便托管前端文件，一个进程就能跑起来。

import { relative, resolve } from "node:path";
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
  bestStreak, futureAssigned, isDone, localDay, resurface, shiftDay, streak, todayId, todayReason, tomorrowId, weekDays,
} from "./daily.ts";
import { recommend } from "./recommend.ts";
import * as db from "./db.ts";
import {
  allSummaries, getEntry, getRedirect, loadEntries, related, search, summarize,
  themeGroups, totalCount, type Summary,
} from "./entries.ts";
import { checkTime, initPush, isValidSub, sendToUser, vapidPublicKey } from "./push.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const FRONTEND_DIR = process.env.FRONTEND_DIR ? resolve(process.env.FRONTEND_DIR) : "";

loadEntries(process.env.ENTRIES_PATH ?? resolve(ROOT, "data/entries.json"));
db.openDb(process.env.STATE_DB ?? resolve(ROOT, "var/app.db"));
db.purgeExpiredSessions();
initPush();

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
  // 接着读：和这篇相关、又没读过的词
  const upNext = recommend({ uid, day, seed: day + id, anchor: id, exclude: busy(uid, day, id), limit: 2 }).map((p) => ({
    ...withState(uid, summariesOf([p.id]))[0]!,
    reason: p.reason,
  }));
  return {
    ...e,
    ...db.getState(uid, id),
    seeAlso,
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
    // 本周七天：每天推送的词（今天之后的不透露）
    week: weekDays(day).map((d) => {
      const wid = d <= day ? db.getDaily(uid, d)?.find((x) => getEntry(x)) : undefined;
      return { day: d, entry: wid ? withState(uid, summariesOf([wid]))[0] : null };
    }),
    // 旧词重逢：按间隔重现一个以前读过的词
    resurface: (() => {
      const r = resurface(uid, day);
      return r ? { ...withState(uid, summariesOf([r.id]))[0], ago: r.ago } : null;
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
  const { read = true } = await body<{ read?: boolean }>(c);
  if (read) db.markRead(uid, id, localDay());
  else db.markUnread(uid, id);
  return c.json({ ...db.getState(uid, id), stats: stats(uid) });
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

api.get("/stats", (c) => c.json(stats(uidOf(c))));

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

api.get("/me", (c) => c.json(c.get("user")));

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

admin.get("/invites", (c) => c.json(db.listInvites().filter((i) => !i.isAdmin || i.usedAt)));

admin.post("/invites", async (c) => {
  const { note = "" } = await body<{ note?: string }>(c);
  const code = newInvite(uidOf(c), String(note).trim());
  return c.json(db.getInvite(code));
});

admin.delete("/invites/:code", (c) => {
  db.deleteInvite(normalizeCode(c.req.param("code")));
  return c.json({ ok: true });
});

admin.get("/users", (c) => c.json(db.listUsers()));

admin.post("/users/:id/reset-password", async (c) => {
  const id = Number(c.req.param("id"));
  if (!db.getUser(id)) return c.json({ error: "没有这个用户" }, 404);
  if (id === uidOf(c)) return c.json({ error: "修改自己的密码请到“账号与安全”" }, 400);
  return c.json({ password: await resetPassword(id) });
});

admin.delete("/users/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (id === uidOf(c)) return c.json({ error: "不能删除自己" }, 400);
  db.deleteUser(id);
  return c.json({ ok: true });
});

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
