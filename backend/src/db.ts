// 账号、登录会话、邀请码，以及每个用户各自的阅读进度、收藏、每日推送记录，存在 SQLite（node:sqlite）。
// 除了 settings（全站设置，如推送密钥），其余表都按 user_id 隔离。

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;

export function openDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass_hash     TEXT NOT NULL,
      is_admin      INTEGER NOT NULL DEFAULT 0,
      reminder_time TEXT NOT NULL DEFAULT '09:00',
      last_push_day TEXT,
      created_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      code       TEXT PRIMARY KEY,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      is_admin   INTEGER NOT NULL DEFAULT 0,
      note       TEXT,
      used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      used_at    TEXT
    );
    CREATE TABLE IF NOT EXISTS progress (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id         TEXT NOT NULL,
      read_at    TEXT,
      read_day   TEXT,
      starred_at TEXT,
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE IF NOT EXISTS daily (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day     TEXT NOT NULL,
      ids     TEXT NOT NULL,
      reasons TEXT,
      PRIMARY KEY (user_id, day)
    );
    CREATE TABLE IF NOT EXISTS paper (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day     TEXT NOT NULL,
      data    TEXT NOT NULL,
      PRIMARY KEY (user_id, day)
    );
    CREATE TABLE IF NOT EXISTS resurface (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day     TEXT NOT NULL,
      id      TEXT NOT NULL,
      PRIMARY KEY (user_id, day)
    );
    CREATE TABLE IF NOT EXISTS reviews (
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id       TEXT NOT NULL,
      stage    INTEGER NOT NULL,
      due_day  TEXT NOT NULL,
      last_day TEXT NOT NULL,
      last_ok  INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint   TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sub        TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- 后台新增的词（mode=new）和给原书词条补写的编辑字段（mode=patch）。
    -- data 是正在改的稿，live 是已经发布、读者看得到的那一版（没发布过就是 NULL）；两者都是 {"entry":…,"meta":…}
    CREATE TABLE IF NOT EXISTS entry_drafts (
      id           TEXT PRIMARY KEY,
      mode         TEXT NOT NULL,
      data         TEXT NOT NULL,
      live         TEXT,
      archived     INTEGER NOT NULL DEFAULT 0,
      created_by   TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_by   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      published_at TEXT
    );
    -- 每存一次留一版，用来对比和回滚
    CREATE TABLE IF NOT EXISTS entry_revisions (
      id   TEXT NOT NULL,
      ver  INTEGER NOT NULL,
      data TEXT NOT NULL,
      note TEXT,
      by   TEXT NOT NULL,
      at   TEXT NOT NULL,
      PRIMARY KEY (id, ver)
    );
    -- 读者报错
    CREATE TABLE IF NOT EXISTS entry_reports (
      id          INTEGER PRIMARY KEY,
      entry_id    TEXT NOT NULL,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      text        TEXT NOT NULL,
      at          TEXT NOT NULL,
      resolved_by TEXT,
      resolved_at TEXT
    );
    -- 给 MCP 等程序用的令牌（只存散列）；scopes 是逗号分隔的 read / draft
    CREATE TABLE IF NOT EXISTS api_tokens (
      id           INTEGER PRIMARY KEY,
      name         TEXT NOT NULL,
      token_hash   TEXT NOT NULL UNIQUE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scopes       TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      expires_at   TEXT,
      last_used_at TEXT,
      revoked_at   TEXT
    );
    CREATE TABLE IF NOT EXISTS audit (
      id         INTEGER PRIMARY KEY,
      at         TEXT NOT NULL,
      admin_id   INTEGER,
      admin_name TEXT NOT NULL,
      action     TEXT NOT NULL,
      detail     TEXT
    );
    -- 邮件日报的发送记录：每人每种每天一行（day 是收件人自己时区的日期），发过就不再发；失败的隔一阵重试几次
    CREATE TABLE IF NOT EXISTS mail_log (
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind     TEXT NOT NULL,
      day      TEXT NOT NULL,
      issue    TEXT NOT NULL,
      status   TEXT NOT NULL,
      tries    INTEGER NOT NULL DEFAULT 1,
      error    TEXT,
      at       TEXT NOT NULL,
      PRIMARY KEY (user_id, kind, day)
    );
  `);
  // 旧库补字段（加列很快，不锁表太久；回滚到旧代码也不受影响）
  const cols = new Set((db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("disabled")) db.exec("ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("last_seen")) db.exec("ALTER TABLE users ADD COLUMN last_seen TEXT");
  if (!cols.has("on_board")) db.exec("ALTER TABLE users ADD COLUMN on_board INTEGER NOT NULL DEFAULT 1");
  if (!cols.has("daily_goal")) db.exec("ALTER TABLE users ADD COLUMN daily_goal INTEGER NOT NULL DEFAULT 1");
  if (!cols.has("last_recap_day")) db.exec("ALTER TABLE users ADD COLUMN last_recap_day TEXT");
  // 邮件：选填的邮箱、订了哪几种（每日单词 / 日报）、几点发、按哪个时区（空 = 站点时区）
  if (!cols.has("email")) db.exec("ALTER TABLE users ADD COLUMN email TEXT");
  if (!cols.has("mail_word")) db.exec("ALTER TABLE users ADD COLUMN mail_word INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("mail_paper")) db.exec("ALTER TABLE users ADD COLUMN mail_paper INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("mail_time")) db.exec("ALTER TABLE users ADD COLUMN mail_time TEXT NOT NULL DEFAULT '08:00'");
  if (!cols.has("mail_tz")) db.exec("ALTER TABLE users ADD COLUMN mail_tz TEXT");
  // 词书：只推哪几本（JSON 数组，空 = 全部混合推送）
  if (!cols.has("books")) db.exec("ALTER TABLE users ADD COLUMN books TEXT");
  // RSS：订阅地址里的随机钥匙（空 = 没开）；唯一索引允许多个 NULL
  if (!cols.has("feed_key")) db.exec("ALTER TABLE users ADD COLUMN feed_key TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_feed_key ON users(feed_key)");
  // 手动“标为已读”的：书架照常算，排行榜、连续天数、每日目标不算
  const pcols = new Set((db.prepare("PRAGMA table_info(progress)").all() as { name: string }[]).map((c) => c.name));
  if (!pcols.has("manual")) db.exec("ALTER TABLE progress ADD COLUMN manual INTEGER NOT NULL DEFAULT 0");
  dbFile = path;
}

let dbFile = "";
export const dbPath = () => dbFile;

const now = () => new Date().toISOString();

/** 把整个库拷成一个独立文件；服务在跑也能做（VACUUM INTO 读的是一个一致的快照） */
export function backupTo(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  db.prepare("VACUUM INTO ?").run(path);
}

/** 在一个事务里执行 */
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---------- 用户 ----------

export type User = { id: number; username: string; isAdmin: boolean; createdAt: string };
type UserRow = { id: number; username: string; is_admin: number; created_at: string };
const toUser = (r: UserRow): User => ({ id: r.id, username: r.username, isAdmin: !!r.is_admin, createdAt: r.created_at });

export function countUsers(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

export function createUser(username: string, passHash: string, isAdmin: boolean): number {
  const r = db
    .prepare("INSERT INTO users (username, pass_hash, is_admin, created_at) VALUES (?, ?, ?, ?)")
    .run(username, passHash, isAdmin ? 1 : 0, now());
  return Number(r.lastInsertRowid);
}

export function getUser(id: number): User | undefined {
  const r = db.prepare("SELECT id, username, is_admin, created_at FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return r && toUser(r);
}

/** 按用户名找（不区分大小写），附带密码散列用于校验 */
export function findLogin(username: string): (User & { passHash: string; disabled: boolean }) | undefined {
  const r = db
    .prepare("SELECT id, username, is_admin, created_at, pass_hash, disabled FROM users WHERE username = ?")
    .get(username) as (UserRow & { pass_hash: string; disabled: number }) | undefined;
  return r && { ...toUser(r), passHash: r.pass_hash, disabled: !!r.disabled };
}

export function getPassHash(id: number): string | undefined {
  return (db.prepare("SELECT pass_hash FROM users WHERE id = ?").get(id) as { pass_hash: string } | undefined)?.pass_hash;
}

export function setPassHash(id: number, passHash: string): void {
  db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(passHash, id);
}

/** 成员列表（管理页用）：附带读过的词数和最近一次阅读日期 */
export function listUsers(): (User & { read: number; lastRead: string | null })[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.is_admin, u.created_at,
              COUNT(p.read_at) AS read, MAX(p.read_day) AS last_read
         FROM users u LEFT JOIN progress p ON p.user_id = u.id
        GROUP BY u.id ORDER BY u.created_at`,
    )
    .all() as (UserRow & { read: number; last_read: string | null })[];
  return rows.map((r) => ({ ...toUser(r), read: r.read, lastRead: r.last_read }));
}

export function deleteUser(id: number): void {
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

export function getReminderTime(uid: number): string {
  return (db.prepare("SELECT reminder_time FROM users WHERE id = ?").get(uid) as { reminder_time: string }).reminder_time;
}

export function setReminderTime(uid: number, time: string): void {
  db.prepare("UPDATE users SET reminder_time = ? WHERE id = ?").run(time, uid);
}

/** 有推送订阅的用户，以及各自的提醒时间和上次推送日期 */
export function pushTargets(): { id: number; reminderTime: string; lastPushDay: string | null; lastRecapDay: string | null }[] {
  const rows = db
    .prepare(
      `SELECT id, reminder_time, last_push_day, last_recap_day FROM users
        WHERE disabled = 0 AND id IN (SELECT DISTINCT user_id FROM push_subs)`,
    )
    .all() as { id: number; reminder_time: string; last_push_day: string | null; last_recap_day: string | null }[];
  return rows.map((r) => ({ id: r.id, reminderTime: r.reminder_time, lastPushDay: r.last_push_day, lastRecapDay: r.last_recap_day }));
}

export function setLastRecapDay(uid: number, day: string): void {
  db.prepare("UPDATE users SET last_recap_day = ? WHERE id = ?").run(day, uid);
}

export function setLastPushDay(uid: number, day: string): void {
  db.prepare("UPDATE users SET last_push_day = ? WHERE id = ?").run(day, uid);
}

// ---------- 邮件日报 ----------

export type MailKind = "word" | "paper";
export type MailPrefs = { email: string | null; word: boolean; paper: boolean; time: string; tz: string | null };
type MailRow = { email: string | null; mail_word: number; mail_paper: number; mail_time: string; mail_tz: string | null };
const toPrefs = (r: MailRow): MailPrefs => ({ email: r.email, word: !!r.mail_word, paper: !!r.mail_paper, time: r.mail_time, tz: r.mail_tz });

export function getMailPrefs(uid: number): MailPrefs | undefined {
  const r = db.prepare("SELECT email, mail_word, mail_paper, mail_time, mail_tz FROM users WHERE id = ?").get(uid) as MailRow | undefined;
  return r && toPrefs(r);
}

/** 只改传进来的那几项；邮箱清空时两种订阅一起关掉 */
export function setMailPrefs(uid: number, p: Partial<MailPrefs>): void {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (p.email !== undefined) sets.push("email = ?"), args.push(p.email);
  if (p.word !== undefined) sets.push("mail_word = ?"), args.push(p.word ? 1 : 0);
  if (p.paper !== undefined) sets.push("mail_paper = ?"), args.push(p.paper ? 1 : 0);
  if (p.time !== undefined) sets.push("mail_time = ?"), args.push(p.time);
  if (p.tz !== undefined) sets.push("mail_tz = ?"), args.push(p.tz);
  if (p.email === null) sets.push("mail_word = 0", "mail_paper = 0");
  if (!sets.length) return;
  db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...args, uid);
}

/** 有邮箱、订了至少一种、没停用的成员 */
export function mailTargets(): ({ id: number; username: string } & MailPrefs)[] {
  const rows = db
    .prepare(
      `SELECT id, username, email, mail_word, mail_paper, mail_time, mail_tz FROM users
        WHERE disabled = 0 AND email IS NOT NULL AND email != '' AND (mail_word = 1 OR mail_paper = 1)`,
    )
    .all() as ({ id: number; username: string } & MailRow)[];
  return rows.map((r) => ({ id: r.id, username: r.username, ...toPrefs(r) }));
}

// ---------- 词书：推送用哪几本 ----------

/** null = 全部混合（默认）；否则只推这几本 */
export function getBooks(uid: number): string[] | null {
  const raw = (db.prepare("SELECT books FROM users WHERE id = ?").get(uid) as { books: string | null } | undefined)?.books;
  if (!raw) return null;
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) && list.length ? list.map(String) : null;
  } catch {
    return null;
  }
}

export function setBooks(uid: number, books: string[] | null): void {
  db.prepare("UPDATE users SET books = ? WHERE id = ?").run(books?.length ? JSON.stringify(books) : null, uid);
}

// ---------- RSS 订阅 ----------

export function getFeedKey(uid: number): string | null {
  return (db.prepare("SELECT feed_key FROM users WHERE id = ?").get(uid) as { feed_key: string | null } | undefined)?.feed_key ?? null;
}

/** 换一把新钥匙（旧地址立刻失效）；传 null 关掉订阅 */
export function setFeedKey(uid: number, key: string | null): void {
  db.prepare("UPDATE users SET feed_key = ? WHERE id = ?").run(key, uid);
}

/** 凭钥匙找订阅的主人；停用的账号不给 */
export function feedOwner(key: string): User | undefined {
  if (!key) return undefined;
  const r = db.prepare("SELECT id, username, is_admin, created_at FROM users WHERE feed_key = ? AND disabled = 0").get(key) as UserRow | undefined;
  return r && toUser(r);
}

export type MailLog = { userId: number; kind: MailKind; day: string; issue: string; status: "sending" | "sent" | "error" | "skipped"; tries: number; error: string | null; at: string };
type MailLogRow = { user_id: number; kind: MailKind; day: string; issue: string; status: MailLog["status"]; tries: number; error: string | null; at: string };
const toLog = (r: MailLogRow): MailLog => ({ userId: r.user_id, kind: r.kind, day: r.day, issue: r.issue, status: r.status, tries: r.tries, error: r.error, at: r.at });

export function getMailLog(uid: number, kind: MailKind, day: string): MailLog | undefined {
  const r = db.prepare("SELECT * FROM mail_log WHERE user_id = ? AND kind = ? AND day = ?").get(uid, kind, day) as MailLogRow | undefined;
  return r && toLog(r);
}

/**
 * 占一个发送名额：这一天还没记录、或上次失败且已过了 retryAfter 毫秒、没超过 maxTries 次，才返回 true。
 * 先写“sending”再真去发，两个进程 / 两次 tick 撞在一起也不会发两封；发到一半进程没了的“sending”也按失败算。
 */
export function claimMail(uid: number, kind: MailKind, day: string, issue: string, retryAfter: number, maxTries: number): boolean {
  const t = now();
  const before = new Date(Date.now() - retryAfter).toISOString();
  const r = db
    .prepare(
      `INSERT INTO mail_log (user_id, kind, day, issue, status, tries, at) VALUES (?, ?, ?, ?, 'sending', 1, ?)
       ON CONFLICT (user_id, kind, day) DO UPDATE SET status = 'sending', tries = tries + 1, issue = excluded.issue, at = excluded.at
        WHERE mail_log.status IN ('error', 'sending') AND mail_log.tries < ? AND mail_log.at <= ?`,
    )
    .run(uid, kind, day, issue, t, maxTries, before);
  return r.changes === 1;
}

export function finishMail(uid: number, kind: MailKind, day: string, status: "sent" | "error" | "skipped", error = ""): void {
  db.prepare("UPDATE mail_log SET status = ?, error = ?, at = ? WHERE user_id = ? AND kind = ? AND day = ?").run(
    status, error ? error.slice(0, 300) : null, now(), uid, kind, day,
  );
}

/** 最近的发送记录（后台看） */
export function recentMail(limit = 30, uid?: number): (MailLog & { username: string | null })[] {
  const rows = db
    .prepare(
      `SELECT m.*, u.username FROM mail_log m LEFT JOIN users u ON u.id = m.user_id
        ${uid === undefined ? "" : "WHERE m.user_id = ?"} ORDER BY m.at DESC LIMIT ?`,
    )
    .all(...((uid === undefined ? [limit] : [uid, limit]) as number[])) as (MailLogRow & { username: string | null })[];
  return rows.map((r) => ({ ...toLog(r), username: r.username }));
}

/** 订阅人数（后台总览用） */
export function mailCounts(): { withEmail: number; word: number; paper: number } {
  const r = db
    .prepare(
      `SELECT SUM(email IS NOT NULL AND email != '') AS withEmail,
              SUM(email IS NOT NULL AND email != '' AND mail_word = 1) AS word,
              SUM(email IS NOT NULL AND email != '' AND mail_paper = 1) AS paper
         FROM users WHERE disabled = 0`,
    )
    .get() as { withEmail: number | null; word: number | null; paper: number | null };
  return { withEmail: r.withEmail ?? 0, word: r.word ?? 0, paper: r.paper ?? 0 };
}

// ---------- 登录会话（只存令牌的散列） ----------

export function createSession(tokenHash: string, uid: number, expiresAt: string): void {
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    tokenHash, uid, now(), expiresAt,
  );
}

export function getSession(tokenHash: string): { user: User; expiresAt: string } | undefined {
  const r = db
    .prepare(
      `SELECT u.id, u.username, u.is_admin, u.created_at, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`,
    )
    .get(tokenHash, now()) as (UserRow & { expires_at: string }) | undefined;
  return r && { user: toUser(r), expiresAt: r.expires_at };
}

export function extendSession(tokenHash: string, expiresAt: string): void {
  db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(expiresAt, tokenHash);
}

export function deleteSession(tokenHash: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

/** 退出某个用户的所有设备（可保留当前这一个） */
export function deleteUserSessions(uid: number, keepHash = ""): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(uid, keepHash);
}

export function purgeExpiredSessions(): void {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
}

// ---------- 邀请码 ----------

export type Invite = {
  code: string;
  createdAt: string;
  expiresAt: string | null;
  isAdmin: boolean;
  note: string | null;
  usedBy: string | null;
  usedAt: string | null;
};
type InviteRow = {
  code: string;
  created_at: string;
  expires_at: string | null;
  is_admin: number;
  note: string | null;
  used_by: number | null;
  used_name: string | null;
  used_at: string | null;
};
const toInvite = (r: InviteRow): Invite => ({
  code: r.code,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  isAdmin: !!r.is_admin,
  note: r.note,
  usedBy: r.used_name ?? (r.used_by ? "已删除的用户" : null),
  usedAt: r.used_at,
});
const INVITE_SELECT = `SELECT i.*, u.username AS used_name FROM invites i LEFT JOIN users u ON u.id = i.used_by`;

export function createInvite(code: string, opts: { createdBy?: number; expiresAt?: string; isAdmin?: boolean; note?: string }): void {
  db.prepare("INSERT INTO invites (code, created_by, created_at, expires_at, is_admin, note) VALUES (?, ?, ?, ?, ?, ?)").run(
    code, opts.createdBy ?? null, now(), opts.expiresAt ?? null, opts.isAdmin ? 1 : 0, opts.note ?? null,
  );
}

export function getInvite(code: string): Invite | undefined {
  const r = db.prepare(`${INVITE_SELECT} WHERE i.code = ?`).get(code) as InviteRow | undefined;
  return r && toInvite(r);
}

export function listInvites(): Invite[] {
  return (db.prepare(`${INVITE_SELECT} ORDER BY i.created_at DESC`).all() as InviteRow[]).map(toInvite);
}

/** 把邀请码标记为已用；返回 false 表示已经被别人用掉了 */
export function useInvite(code: string, uid: number): boolean {
  const r = db.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_at IS NULL").run(uid, now(), code);
  return r.changes === 1;
}

export function deleteInvite(code: string): void {
  db.prepare("DELETE FROM invites WHERE code = ? AND used_at IS NULL").run(code);
}

/** 还没用掉、也没过期的管理员邀请码（首次启动用） */
export function openAdminInvite(): string | undefined {
  const r = db
    .prepare("SELECT code FROM invites WHERE is_admin = 1 AND used_at IS NULL AND (expires_at IS NULL OR expires_at > ?) LIMIT 1")
    .get(now()) as { code: string } | undefined;
  return r?.code;
}

// ---------- 阅读进度与收藏 ----------

export type EntryState = { read: boolean; starred: boolean };

export function stateMap(uid: number): Map<string, EntryState> {
  const rows = db.prepare("SELECT id, read_at, starred_at FROM progress WHERE user_id = ?").all(uid) as {
    id: string;
    read_at: string | null;
    starred_at: string | null;
  }[];
  return new Map(rows.map((r) => [r.id, { read: !!r.read_at, starred: !!r.starred_at }]));
}

export function getState(uid: number, id: string): EntryState {
  return stateMap(uid).get(id) ?? { read: false, starred: false };
}

/** 记为已读；manual 是在文章页手动点的“标为已读”。已经读过的不改（第一次读的那天和方式为准） */
export function markRead(uid: number, id: string, day: string, manual = false): void {
  db.prepare(
    `INSERT INTO progress (user_id, id, read_at, read_day, manual) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET read_at = COALESCE(read_at, excluded.read_at),
                                            read_day = COALESCE(read_day, excluded.read_day),
                                            manual = CASE WHEN read_at IS NULL THEN excluded.manual ELSE manual END`,
  ).run(uid, id, now(), day, manual ? 1 : 0);
}

/** 每日目标：一天想读几个词（默认 1） */
export function getGoal(uid: number): number {
  const r = db.prepare("SELECT daily_goal FROM users WHERE id = ?").get(uid) as { daily_goal: number } | undefined;
  return r?.daily_goal ?? 1;
}

export function setGoal(uid: number, goal: number): void {
  db.prepare("UPDATE users SET daily_goal = ? WHERE id = ?").run(goal, uid);
}

/** 只认真读完（非手动标记）的那几天，每天几个 */
export function readDayCounts(uid: number): Map<string, number> {
  const rows = db
    .prepare("SELECT read_day AS day, COUNT(*) AS n FROM progress WHERE user_id = ? AND read_at IS NOT NULL AND manual = 0 GROUP BY read_day")
    .all(uid) as { day: string; n: number }[];
  return new Map(rows.map((r) => [r.day, r.n]));
}

export type Review = { id: string; stage: number; dueDay: string; lastDay: string; lastOk: boolean };

/** 复习记录：每个读过的词在间隔复习里走到第几站、哪天该再见 */
export function getReview(uid: number, id: string): Review | undefined {
  const r = db.prepare("SELECT id, stage, due_day, last_day, last_ok FROM reviews WHERE user_id = ? AND id = ?").get(uid, id) as
    | { id: string; stage: number; due_day: string; last_day: string; last_ok: number }
    | undefined;
  return r && { id: r.id, stage: r.stage, dueDay: r.due_day, lastDay: r.last_day, lastOk: !!r.last_ok };
}

export function listReviews(uid: number): Review[] {
  return (db.prepare("SELECT id, stage, due_day, last_day, last_ok FROM reviews WHERE user_id = ?").all(uid) as {
    id: string; stage: number; due_day: string; last_day: string; last_ok: number;
  }[]).map((r) => ({ id: r.id, stage: r.stage, dueDay: r.due_day, lastDay: r.last_day, lastOk: !!r.last_ok }));
}

export function saveReview(uid: number, r: Review): void {
  db.prepare(
    `INSERT INTO reviews (user_id, id, stage, due_day, last_day, last_ok) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET stage = excluded.stage, due_day = excluded.due_day, last_day = excluded.last_day, last_ok = excluded.last_ok`,
  ).run(uid, r.id, r.stage, r.dueDay, r.lastDay, r.lastOk ? 1 : 0);
}

/** 参不参加排行榜（默认参加）；关掉后自己不出现在别人的榜上，也看不到榜 */
export function getOnBoard(uid: number): boolean {
  const r = db.prepare("SELECT on_board FROM users WHERE id = ?").get(uid) as { on_board: number } | undefined;
  return !!r?.on_board;
}

export function setOnBoard(uid: number, on: boolean): void {
  db.prepare("UPDATE users SET on_board = ? WHERE id = ?").run(on ? 1 : 0, uid);
}

/** 排行榜用：每个没停用、没关掉排行榜的成员，以及他在 [since, day] 这几天读完的词条（一行一个；一个没读的也有一行，entry 为 null） */
export function boardRows(since: string, day: string): { id: number; username: string; entry: string | null }[] {
  return db
    .prepare(
      `SELECT u.id, u.username, p.id AS entry FROM users u
       LEFT JOIN progress p ON p.user_id = u.id AND p.read_at IS NOT NULL AND p.manual = 0 AND p.read_day >= ? AND p.read_day <= ?
       WHERE u.disabled = 0 AND u.on_board = 1`,
    )
    .all(since, day) as { id: number; username: string; entry: string | null }[];
}

/** 某人从 since 起每天读完几个（只列有读的那几天） */
export function dailyCounts(uid: number, since: string): { day: string; n: number }[] {
  return db
    .prepare("SELECT read_day AS day, COUNT(*) AS n FROM progress WHERE user_id = ? AND read_at IS NOT NULL AND manual = 0 AND read_day >= ? GROUP BY read_day")
    .all(uid, since) as { day: string; n: number }[];
}

export function markUnread(uid: number, id: string): void {
  db.prepare("UPDATE progress SET read_at = NULL, read_day = NULL, manual = 0 WHERE user_id = ? AND id = ?").run(uid, id);
}

export function setStarred(uid: number, id: string, starred: boolean): void {
  db.prepare(
    `INSERT INTO progress (user_id, id, starred_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET starred_at = excluded.starred_at`,
  ).run(uid, id, starred ? now() : null);
}

/** 收藏过的词条和收藏时间，新的在前 */
export function starredLog(uid: number): { id: string; starred_at: string }[] {
  return db
    .prepare("SELECT id, starred_at FROM progress WHERE user_id = ? AND starred_at IS NOT NULL ORDER BY starred_at DESC")
    .all(uid) as { id: string; starred_at: string }[];
}

/** manual：1 是手动“标为已读”的 */
export type ReadRow = { id: string; read_at: string; read_day: string; manual: number };

/** 所有读过的记录，新的在前 */
export function readLog(uid: number): ReadRow[] {
  return db
    .prepare("SELECT id, read_at, read_day, manual FROM progress WHERE user_id = ? AND read_at IS NOT NULL ORDER BY read_at DESC")
    .all(uid) as ReadRow[];
}

export function readDays(uid: number): string[] {
  const rows = db
    .prepare("SELECT DISTINCT read_day FROM progress WHERE user_id = ? AND read_day IS NOT NULL AND manual = 0 ORDER BY read_day DESC")
    .all(uid) as { read_day: string }[];
  return rows.map((r) => r.read_day);
}

// ---------- 每日推送与旧词重逢 ----------

export function getDaily(uid: number, day: string): string[] | undefined {
  const row = db.prepare("SELECT ids FROM daily WHERE user_id = ? AND day = ?").get(uid, day) as { ids: string } | undefined;
  return row ? (JSON.parse(row.ids) as string[]) : undefined;
}

/** 推荐理由：{ 词条 id: 理由 } */
export function getDailyReasons(uid: number, day: string): Record<string, unknown> {
  const row = db.prepare("SELECT reasons FROM daily WHERE user_id = ? AND day = ?").get(uid, day) as
    | { reasons: string | null }
    | undefined;
  return row?.reasons ? (JSON.parse(row.reasons) as Record<string, unknown>) : {};
}

export function setDaily(uid: number, day: string, ids: string[], reasons: Record<string, unknown> = {}): void {
  db.prepare(
    `INSERT INTO daily (user_id, day, ids, reasons) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, day) DO UPDATE SET ids = excluded.ids, reasons = excluded.reasons`,
  ).run(uid, day, JSON.stringify(ids), JSON.stringify(reasons));
}

export function allDaily(uid: number): { day: string; ids: string[] }[] {
  const rows = db.prepare("SELECT day, ids FROM daily WHERE user_id = ? ORDER BY day DESC").all(uid) as {
    day: string;
    ids: string;
  }[];
  return rows.map((r) => ({ day: r.day, ids: JSON.parse(r.ids) as string[] }));
}

export function getResurface(uid: number, day: string): string | undefined {
  const row = db.prepare("SELECT id FROM resurface WHERE user_id = ? AND day = ?").get(uid, day) as { id: string } | undefined;
  return row?.id;
}

export function setResurface(uid: number, day: string, id: string): void {
  db.prepare(
    "INSERT INTO resurface (user_id, day, id) VALUES (?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET id = excluded.id",
  ).run(uid, day, id);
}

/** 最近几天重现过的词，避免短期内反复出现 */
export function recentResurfaced(uid: number, sinceDay: string): Set<string> {
  const rows = db.prepare("SELECT id FROM resurface WHERE user_id = ? AND day >= ?").all(uid, sinceDay) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

// ---------- 全站设置 ----------

export function getSetting(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

// ---------- 推送订阅（一台设备只属于一个用户；换账号登录后归新用户） ----------

export type PushSub = { endpoint: string; keys: { p256dh: string; auth: string } };

export function addPushSub(uid: number, sub: PushSub): void {
  db.prepare(
    `INSERT INTO push_subs (endpoint, user_id, sub, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, sub = excluded.sub`,
  ).run(sub.endpoint, uid, JSON.stringify(sub), now());
}

export function removePushSub(endpoint: string, uid?: number): void {
  if (uid === undefined) db.prepare("DELETE FROM push_subs WHERE endpoint = ?").run(endpoint);
  else db.prepare("DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?").run(endpoint, uid);
}

export function userPushSubs(uid: number): PushSub[] {
  const rows = db.prepare("SELECT sub FROM push_subs WHERE user_id = ?").all(uid) as { sub: string }[];
  return rows.map((r) => JSON.parse(r.sub) as PushSub);
}


// ---------- 管理后台：停用、活跃、统计、审计 ----------

export function setDisabled(id: number, v: boolean): void {
  db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(v ? 1 : 0, id);
}

export function setAdmin(id: number, v: boolean): void {
  db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(v ? 1 : 0, id);
}

export function touchSeen(id: number): void {
  db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(now(), id);
}

export type AdminUser = User & {
  disabled: boolean;
  lastSeen: string | null;
  reminderTime: string;
  read: number;
  starred: number;
  lastRead: string | null;
  sessions: number;
  devices: number;
  todayId: string | null;
  todayDone: boolean;
};

/** 成员总览：一次查出管理页要的全部数字；day 是“今天”，onlyId 只查一个人 */
export function listUsersAdmin(day: string, onlyId?: number): AdminUser[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.is_admin, u.created_at, u.disabled, u.last_seen, u.reminder_time,
        (SELECT COUNT(*) FROM progress p WHERE p.user_id = u.id AND p.read_at IS NOT NULL) AS read,
        (SELECT COUNT(*) FROM progress p WHERE p.user_id = u.id AND p.starred_at IS NOT NULL) AS starred,
        (SELECT MAX(p.read_day) FROM progress p WHERE p.user_id = u.id) AS last_read,
        (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions,
        (SELECT COUNT(*) FROM push_subs ps WHERE ps.user_id = u.id) AS devices,
        (SELECT json_extract(d.ids, '$[0]') FROM daily d WHERE d.user_id = u.id AND d.day = ?) AS today_id,
        (SELECT COUNT(*) FROM daily d JOIN progress p ON p.user_id = d.user_id AND p.id = json_extract(d.ids, '$[0]') AND p.read_at IS NOT NULL
          WHERE d.user_id = u.id AND d.day = ?) AS today_done
       FROM users u ${onlyId === undefined ? "" : "WHERE u.id = ?"} ORDER BY u.id`,
    )
    .all(...([now(), day, day, ...(onlyId === undefined ? [] : [onlyId])] as (string | number)[])) as (UserRow & {
    disabled: number; last_seen: string | null; reminder_time: string; read: number; starred: number; last_read: string | null;
    sessions: number; devices: number; today_id: string | null; today_done: number;
  })[];
  return rows.map((r) => ({
    ...toUser(r),
    disabled: !!r.disabled,
    lastSeen: r.last_seen,
    reminderTime: r.reminder_time,
    read: r.read,
    starred: r.starred,
    lastRead: r.last_read,
    sessions: r.sessions,
    devices: r.devices,
    todayId: r.today_id,
    todayDone: r.today_done > 0,
  }));
}

/** 每天读了多少次、多少人读（从 sinceDay 起） */
export function readTrend(sinceDay: string): { day: string; reads: number; readers: number }[] {
  return db
    .prepare(
      `SELECT read_day AS day, COUNT(*) AS reads, COUNT(DISTINCT user_id) AS readers
         FROM progress WHERE read_day >= ? GROUP BY read_day ORDER BY read_day`,
    )
    .all(sinceDay) as { day: string; reads: number; readers: number }[];
}

/** 从 sinceDay 起读过东西的人数 */
export function readersSince(sinceDay: string): number {
  return (db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM progress WHERE read_day >= ?").get(sinceDay) as { n: number }).n;
}

/** 被读得最多 / 被收藏最多的词 */
export function topEntries(kind: "read" | "starred", limit = 8): { id: string; n: number }[] {
  const col = kind === "read" ? "read_at" : "starred_at";
  return db
    .prepare(`SELECT id, COUNT(*) AS n FROM progress WHERE ${col} IS NOT NULL GROUP BY id ORDER BY n DESC, id LIMIT ?`)
    .all(limit) as { id: string; n: number }[];
}

export function readTotals(): { reads: number; words: number; starred: number } {
  return db
    .prepare(
      `SELECT SUM(read_at IS NOT NULL) AS reads, COUNT(DISTINCT CASE WHEN read_at IS NOT NULL THEN id END) AS words,
              SUM(starred_at IS NOT NULL) AS starred FROM progress`,
    )
    .get() as { reads: number; words: number; starred: number };
}

/** 某天每个词被分给了多少人、其中多少人读完了 */
export function dailyDistribution(day: string): { id: string; users: number; done: number }[] {
  return db
    .prepare(
      `SELECT json_extract(d.ids, '$[0]') AS id, COUNT(*) AS users, SUM(p.read_at IS NOT NULL) AS done
         FROM daily d LEFT JOIN progress p ON p.user_id = d.user_id AND p.id = json_extract(d.ids, '$[0]')
        WHERE d.day = ? GROUP BY id ORDER BY users DESC, id`,
    )
    .all(day) as { id: string; users: number; done: number }[];
}

export function inviteCounts(): { open: number; used: number; expired: number } {
  const t = now();
  return db
    .prepare(
      `SELECT SUM(used_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND is_admin = 0) AS open,
              SUM(used_at IS NOT NULL AND is_admin = 0) AS used,
              SUM(used_at IS NULL AND expires_at <= ? AND is_admin = 0) AS expired
         FROM invites`,
    )
    .get(t, t) as { open: number; used: number; expired: number };
}

/** 删掉已过期没用的邀请码 */
export function deleteExpiredInvites(): number {
  return Number(db.prepare("DELETE FROM invites WHERE used_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?").run(now()).changes);
}

export function logAudit(adminId: number, adminName: string, action: string, detail = ""): void {
  db.prepare("INSERT INTO audit (at, admin_id, admin_name, action, detail) VALUES (?, ?, ?, ?, ?)").run(
    now(), adminId, adminName, action, detail.slice(0, 300),
  );
  db.prepare("DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - 500").run(); // 只留最近 500 条
}

export function listAudit(limit = 40): { id: number; at: string; admin: string; action: string; detail: string }[] {
  const rows = db.prepare("SELECT id, at, admin_name, action, detail FROM audit ORDER BY id DESC LIMIT ?").all(limit) as {
    id: number; at: string; admin_name: string; action: string; detail: string | null;
  }[];
  return rows.map((r) => ({ id: r.id, at: r.at, admin: r.admin_name, action: r.action, detail: r.detail ?? "" }));
}

// ---------- 后台新增 / 补写的词条 ----------

export type DraftRow = {
  id: string;
  mode: "new" | "patch";
  data: string;
  live: string | null;
  archived: number;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
  published_at: string | null;
};

export function listDrafts(): DraftRow[] {
  return db.prepare("SELECT * FROM entry_drafts ORDER BY updated_at DESC").all() as DraftRow[];
}

export function getDraft(id: string): DraftRow | undefined {
  return db.prepare("SELECT * FROM entry_drafts WHERE id = ?").get(id) as DraftRow | undefined;
}

/** 已发布、没撤下的：加载词条时叠加到原书数据上 */
export function liveDrafts(): { id: string; mode: "new" | "patch"; live: string }[] {
  return db.prepare("SELECT id, mode, live FROM entry_drafts WHERE live IS NOT NULL AND archived = 0").all() as {
    id: string; mode: "new" | "patch"; live: string;
  }[];
}

/** 存稿：新建或覆盖 data，并留一版历史；返回版本号 */
export function saveDraft(id: string, mode: "new" | "patch", data: string, by: string, note = ""): number {
  return tx(() => {
    const t = now();
    db.prepare(
      `INSERT INTO entry_drafts (id, mode, data, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(id, mode, data, by, t, by, t);
    return addRevision(id, data, by, note);
  });
}

function addRevision(id: string, data: string, by: string, note: string): number {
  const ver = ((db.prepare("SELECT MAX(ver) AS v FROM entry_revisions WHERE id = ?").get(id) as { v: number | null }).v ?? 0) + 1;
  db.prepare("INSERT INTO entry_revisions (id, ver, data, note, by, at) VALUES (?, ?, ?, ?, ?, ?)").run(id, ver, data, note, by, now());
  return ver;
}

/** 发布：把 data 原样拷到 live（data 里已经写好了核对信息） */
export function publishDraft(id: string, data: string, by: string): void {
  tx(() => {
    db.prepare("UPDATE entry_drafts SET data = ?, live = ?, archived = 0, published_at = ?, updated_by = ?, updated_at = ? WHERE id = ?")
      .run(data, data, now(), by, now(), id);
    addRevision(id, data, by, "发布");
  });
}

/** 撤下：读者看不到了，稿子还在 */
export function unpublishDraft(id: string, by: string): void {
  db.prepare("UPDATE entry_drafts SET live = NULL, archived = 1, updated_by = ?, updated_at = ? WHERE id = ?").run(by, now(), id);
}

export function deleteDraft(id: string): void {
  tx(() => {
    db.prepare("DELETE FROM entry_drafts WHERE id = ?").run(id);
    db.prepare("DELETE FROM entry_revisions WHERE id = ?").run(id);
  });
}

export type Revision = { ver: number; data: string; note: string; by: string; at: string };

export function listRevisions(id: string): Revision[] {
  return (db.prepare("SELECT ver, data, note, by, at FROM entry_revisions WHERE id = ? ORDER BY ver DESC").all(id) as
    (Revision & { note: string | null })[]).map((r) => ({ ...r, note: r.note ?? "" }));
}

export function getRevision(id: string, ver: number): Revision | undefined {
  const r = db.prepare("SELECT ver, data, note, by, at FROM entry_revisions WHERE id = ? AND ver = ?").get(id, ver) as
    (Revision & { note: string | null }) | undefined;
  return r && { ...r, note: r.note ?? "" };
}

// ---------- 读者报错 ----------

export type Report = { id: number; entryId: string; user: string | null; text: string; at: string; resolvedBy: string | null; resolvedAt: string | null };

export function addReport(entryId: string, uid: number, text: string): number {
  const r = db.prepare("INSERT INTO entry_reports (entry_id, user_id, text, at) VALUES (?, ?, ?, ?)").run(entryId, uid, text, now());
  return Number(r.lastInsertRowid);
}

/** 同一个人一天内对同一个词报过几次（防刷） */
export function reportsToday(uid: number, sinceIso: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM entry_reports WHERE user_id = ? AND at >= ?").get(uid, sinceIso) as { n: number }).n;
}

export function listReports(opts: { open?: boolean; entryId?: string; limit?: number } = {}): Report[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.open) where.push("r.resolved_at IS NULL");
  if (opts.entryId) where.push("r.entry_id = ?"), args.push(opts.entryId);
  const rows = db.prepare(
    `SELECT r.id, r.entry_id, u.username, r.text, r.at, r.resolved_by, r.resolved_at
       FROM entry_reports r LEFT JOIN users u ON u.id = r.user_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY r.resolved_at IS NOT NULL, r.id DESC LIMIT ?`,
  ).all(...args, opts.limit ?? 100) as {
    id: number; entry_id: string; username: string | null; text: string; at: string; resolved_by: string | null; resolved_at: string | null;
  }[];
  return rows.map((r) => ({ id: r.id, entryId: r.entry_id, user: r.username, text: r.text, at: r.at, resolvedBy: r.resolved_by, resolvedAt: r.resolved_at }));
}

export function resolveReport(id: number, by: string, reopen = false): boolean {
  const r = reopen
    ? db.prepare("UPDATE entry_reports SET resolved_by = NULL, resolved_at = NULL WHERE id = ?").run(id)
    : db.prepare("UPDATE entry_reports SET resolved_by = ?, resolved_at = ? WHERE id = ? AND resolved_at IS NULL").run(by, now(), id);
  return r.changes > 0;
}

export function openReportCounts(): Map<string, number> {
  const rows = db.prepare("SELECT entry_id, COUNT(*) AS n FROM entry_reports WHERE resolved_at IS NULL GROUP BY entry_id").all() as {
    entry_id: string; n: number;
  }[];
  return new Map(rows.map((r) => [r.entry_id, r.n]));
}

// ---------- 程序令牌（MCP） ----------

export type ApiToken = {
  id: number; name: string; userId: number; username: string; isAdmin: boolean; disabled: boolean; scopes: string[];
  createdAt: string; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null;
};
type TokenRow = {
  id: number; name: string; user_id: number; username: string; is_admin: number; disabled: number; scopes: string;
  created_at: string; expires_at: string | null; last_used_at: string | null; revoked_at: string | null;
};
const toToken = (r: TokenRow): ApiToken => ({
  id: r.id, name: r.name, userId: r.user_id, username: r.username, isAdmin: !!r.is_admin, disabled: !!r.disabled,
  scopes: r.scopes.split(",").filter(Boolean), createdAt: r.created_at, expiresAt: r.expires_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at,
});
const TOKEN_SELECT = `SELECT t.id, t.name, t.user_id, u.username, u.is_admin, u.disabled, t.scopes, t.created_at, t.expires_at, t.last_used_at, t.revoked_at
  FROM api_tokens t JOIN users u ON u.id = t.user_id`;

export function createToken(name: string, hash: string, uid: number, scopes: string[], expiresAt: string | null): number {
  const r = db.prepare("INSERT INTO api_tokens (name, token_hash, user_id, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(name, hash, uid, scopes.join(","), now(), expiresAt);
  return Number(r.lastInsertRowid);
}

export function listTokens(): ApiToken[] {
  return (db.prepare(`${TOKEN_SELECT} ORDER BY t.revoked_at IS NOT NULL, t.id DESC`).all() as TokenRow[]).map(toToken);
}

/** 按散列找一个能用的令牌：没吊销、没过期、主人没被停用、仍是管理员 */
export function findToken(hash: string): ApiToken | undefined {
  const r = db.prepare(`${TOKEN_SELECT} WHERE t.token_hash = ?`).get(hash) as TokenRow | undefined;
  if (!r) return undefined;
  const t = toToken(r);
  if (t.revokedAt || t.disabled || !t.isAdmin || (t.expiresAt && Date.parse(t.expiresAt) < Date.now())) return undefined;
  return t;
}

/** 记“最后使用”：一分钟内只写一次 */
export function touchToken(id: number): void {
  db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)")
    .run(now(), id, new Date(Date.now() - 60_000).toISOString());
}

export function revokeToken(id: number): boolean {
  return db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now(), id).changes > 0;
}

// ---------- 日报：每人每天一份，排好就存下，当天不变 ----------

export function getPaper(uid: number, day: string): unknown {
  const row = db.prepare("SELECT data FROM paper WHERE user_id = ? AND day = ?").get(uid, day) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : undefined;
}

export function setPaper(uid: number, day: string, data: unknown): void {
  db.prepare(
    `INSERT INTO paper (user_id, day, data) VALUES (?, ?, ?)
     ON CONFLICT(user_id, day) DO UPDATE SET data = excluded.data`,
  ).run(uid, day, JSON.stringify(data));
}

/** 有日报的日子（新的在前） */
export function paperDays(uid: number, limit = 7): string[] {
  return (db.prepare("SELECT day FROM paper WHERE user_id = ? ORDER BY day DESC LIMIT ?").all(uid, limit) as { day: string }[]).map((r) => r.day);
}
