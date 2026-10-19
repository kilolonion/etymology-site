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
    CREATE TABLE IF NOT EXISTS resurface (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day     TEXT NOT NULL,
      id      TEXT NOT NULL,
      PRIMARY KEY (user_id, day)
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
    CREATE TABLE IF NOT EXISTS audit (
      id         INTEGER PRIMARY KEY,
      at         TEXT NOT NULL,
      admin_id   INTEGER,
      admin_name TEXT NOT NULL,
      action     TEXT NOT NULL,
      detail     TEXT
    );
  `);
  // 旧库补字段（加列很快，不锁表太久；回滚到旧代码也不受影响）
  const cols = new Set((db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("disabled")) db.exec("ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("last_seen")) db.exec("ALTER TABLE users ADD COLUMN last_seen TEXT");
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
export function pushTargets(): { id: number; reminderTime: string; lastPushDay: string | null }[] {
  const rows = db
    .prepare(
      `SELECT id, reminder_time, last_push_day FROM users
        WHERE id IN (SELECT DISTINCT user_id FROM push_subs)`,
    )
    .all() as { id: number; reminder_time: string; last_push_day: string | null }[];
  return rows.map((r) => ({ id: r.id, reminderTime: r.reminder_time, lastPushDay: r.last_push_day }));
}

export function setLastPushDay(uid: number, day: string): void {
  db.prepare("UPDATE users SET last_push_day = ? WHERE id = ?").run(day, uid);
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

export function markRead(uid: number, id: string, day: string): void {
  db.prepare(
    `INSERT INTO progress (user_id, id, read_at, read_day) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET read_at = COALESCE(read_at, excluded.read_at),
                                            read_day = COALESCE(read_day, excluded.read_day)`,
  ).run(uid, id, now(), day);
}

/** 排行榜用：每个没停用的成员，以及他在 [since, day] 这几天读完的词条（一行一个；一个没读的也有一行，entry 为 null） */
export function boardRows(since: string, day: string): { id: number; username: string; entry: string | null }[] {
  return db
    .prepare(
      `SELECT u.id, u.username, p.id AS entry FROM users u
       LEFT JOIN progress p ON p.user_id = u.id AND p.read_at IS NOT NULL AND p.read_day >= ? AND p.read_day <= ?
       WHERE u.disabled = 0`,
    )
    .all(since, day) as { id: number; username: string; entry: string | null }[];
}

/** 某人从 since 起每天读完几个（只列有读的那几天） */
export function dailyCounts(uid: number, since: string): { day: string; n: number }[] {
  return db
    .prepare("SELECT read_day AS day, COUNT(*) AS n FROM progress WHERE user_id = ? AND read_at IS NOT NULL AND read_day >= ? GROUP BY read_day")
    .all(uid, since) as { day: string; n: number }[];
}

export function markUnread(uid: number, id: string): void {
  db.prepare("UPDATE progress SET read_at = NULL, read_day = NULL WHERE user_id = ? AND id = ?").run(uid, id);
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

export type ReadRow = { id: string; read_at: string; read_day: string };

/** 所有读过的记录，新的在前 */
export function readLog(uid: number): ReadRow[] {
  return db
    .prepare("SELECT id, read_at, read_day FROM progress WHERE user_id = ? AND read_at IS NOT NULL ORDER BY read_at DESC")
    .all(uid) as ReadRow[];
}

export function readDays(uid: number): string[] {
  const rows = db
    .prepare("SELECT DISTINCT read_day FROM progress WHERE user_id = ? AND read_day IS NOT NULL ORDER BY read_day DESC")
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
