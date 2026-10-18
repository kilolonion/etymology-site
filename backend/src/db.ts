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
  `);
}

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
export function findLogin(username: string): (User & { passHash: string }) | undefined {
  const r = db
    .prepare("SELECT id, username, is_admin, created_at, pass_hash FROM users WHERE username = ?")
    .get(username) as (UserRow & { pass_hash: string }) | undefined;
  return r && { ...toUser(r), passHash: r.pass_hash };
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
        WHERE s.token_hash = ? AND s.expires_at > ?`,
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
