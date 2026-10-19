// 多用户登录：用户名 + 密码（scrypt 散列），凭邀请码注册，不开放注册。
// 登录后发一个随机令牌放在 HttpOnly Cookie 里，数据库只存令牌的 SHA-256。
// 第一次启动、还没有任何用户时，自动生成一个管理员邀请码并打印在日志里。

import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as db from "./db.ts";

export type AppEnv = { Variables: { user: db.User; sessionHash: string } };

const COOKIE = "sid";
const DAY = 86_400_000;
const SESSION_DAYS = 180;
/** 剩余有效期少于这个天数时自动续期，常用的设备就一直保持登录 */
const RENEW_BELOW_DAYS = 170;
const INVITE_DAYS = 7;
/** 首次部署时打印在日志里的管理员邀请码，也只留 7 天；重启会重新生成一个 */
const SETUP_INVITE_DAYS = 7;
const SECURE = process.env.COOKIE_SECURE === "1";

// ---------- 密码 ----------

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

// 用户名不存在时也算一次散列，避免靠响应时间猜出哪些用户名存在
const DUMMY_HASH = await hashPassword(randomBytes(12).toString("hex"));

export function checkUsername(name: string): string | null {
  if (!/^[\p{L}\p{N}_.-]{2,20}$/u.test(name)) return "用户名 2–20 个字符，可用中英文、数字和 _ . -";
  return null;
}

export function checkPassword(pw: string): string | null {
  if (pw.length < 8) return "密码至少 8 位";
  if (pw.length > 200) return "密码太长了";
  return null;
}

// ---------- 频率限制 ----------

const buckets = new Map<string, { count: number; resetAt: number }>();

/** 每个 key 每分钟最多 limit 次；超过返回 false */
function allow(key: string, limit: number): boolean {
  const t = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= t) {
    buckets.set(key, { count: 1, resetAt: t + 60_000 });
    return true;
  }
  b.count++;
  return b.count <= limit;
}
setInterval(() => {
  const t = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
}, 60_000).unref();

function clientIp(c: Context): string {
  return c.req.header("x-real-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

const TOO_MANY = "尝试次数太多，请一分钟后再试";

// ---------- 会话 ----------

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const daysFromNow = (d: number) => new Date(Date.now() + d * DAY).toISOString();

function startSession(c: Context, uid: number): void {
  const token = randomBytes(32).toString("base64url");
  db.createSession(sha256(token), uid, daysFromNow(SESSION_DAYS));
  setSessionCookie(c, token);
}

function setSessionCookie(c: Context, token: string): void {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: SECURE,
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

/** 当前请求对应的用户（顺便给快到期的会话续期） */
export function currentUser(c: Context): { user: db.User; hash: string } | undefined {
  const token = getCookie(c, COOKIE);
  if (!token) return undefined;
  const hash = sha256(token);
  const s = db.getSession(hash);
  if (!s) return undefined;
  if (Date.parse(s.expiresAt) - Date.now() < RENEW_BELOW_DAYS * DAY) {
    db.extendSession(hash, daysFromNow(SESSION_DAYS));
    setSessionCookie(c, token);
  }
  return { user: s.user, hash };
}

/** 记“最近活跃”：同一个人 5 分钟内只写一次库 */
const lastTouch = new Map<number, number>();
function touchSeen(uid: number): void {
  const t = Date.now();
  if (t - (lastTouch.get(uid) ?? 0) < 5 * 60_000) return;
  lastTouch.set(uid, t);
  db.touchSeen(uid);
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const cur = currentUser(c);
  if (!cur) return c.json({ error: "unauthorized" }, 401);
  touchSeen(cur.user.id);
  c.set("user", cur.user);
  c.set("sessionHash", cur.hash);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("user")?.isAdmin) return c.json({ error: "只有管理员可以这样做" }, 403);
  await next();
};

// ---------- 登录 / 注册 / 退出 ----------

/** 返回 null 表示成功，否则为错误信息 */
export async function login(c: Context, username: string, password: string): Promise<string | null> {
  const name = username.trim();
  // 登录 / 注册 / 查邀请码各自一个桶：不然点几下邀请链接就把自己锁在门外面
  if (!allow(`login:ip:${clientIp(c)}`, 10) || !allow(`login:user:${name.toLowerCase()}`, 5)) return TOO_MANY;
  const u = db.findLogin(name);
  const ok = await verifyPassword(password, u?.passHash ?? DUMMY_HASH);
  if (!u || !ok) return "用户名或密码不对";
  if (u.disabled) return "这个账号已被停用，请联系管理员";
  startSession(c, u.id);
  return null;
}

/** 凭邀请码注册并直接登录 */
export async function register(c: Context, code: string, username: string, password: string): Promise<string | null> {
  if (!allow(`register:ip:${clientIp(c)}`, 10)) return TOO_MANY;
  const name = username.trim();
  const err = checkUsername(name) ?? checkPassword(password);
  if (err) return err;
  const inv = inviteStatus(code);
  if (!inv.ok) return inv.error;
  if (db.findLogin(name)) return "这个用户名已经有人用了";

  const passHash = await hashPassword(password);
  let uid: number;
  try {
    uid = db.tx(() => {
      const id = db.createUser(name, passHash, inv.isAdmin);
      if (!db.useInvite(inv.code, id)) throw new Error("邀请码已经被用过了");
      return id;
    });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.includes("UNIQUE")) return "这个用户名已经有人用了";
    if (msg.includes("邀请码")) return msg; // 事务里自己抛的那句，可以照实说
    console.error("注册失败：", e); // 其余（比如并发写锁）只留日志，不把 SQLite 文案丢给前端
    return "注册没成功，请稍后再试";
  }
  startSession(c, uid);
  return null;
}

export function logout(c: Context): void {
  const token = getCookie(c, COOKIE);
  if (token) db.deleteSession(sha256(token));
  deleteCookie(c, COOKIE, { path: "/" });
}

/** 修改自己的密码；其他设备上的登录随之失效 */
export async function changePassword(uid: number, keepHash: string, oldPw: string, newPw: string): Promise<string | null> {
  const err = checkPassword(newPw);
  if (err) return err;
  if (!(await verifyPassword(oldPw, db.getPassHash(uid) ?? DUMMY_HASH))) return "原密码不对";
  db.setPassHash(uid, await hashPassword(newPw));
  db.deleteUserSessions(uid, keepHash);
  return null;
}

/** 管理员重置某人的密码：生成一个临时密码，对方所有设备都要重新登录 */
export async function resetPassword(uid: number): Promise<string> {
  const temp = inviteCode().replace("-", "").toLowerCase() + randomInt(10, 99);
  db.setPassHash(uid, await hashPassword(temp));
  db.deleteUserSessions(uid);
  return temp;
}

// ---------- 邀请码 ----------

// 去掉容易看错的 0/O、1/I/L
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const inviteCode = () => {
  const s = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
};

/** 统一大小写和分隔符：k7qm2xpa → K7QM-2XPA */
export function normalizeCode(code: string): string {
  const s = code.toUpperCase().replace(/[^0-9A-Z]/g, "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

export function inviteStatus(code: string):
  | { ok: true; code: string; isAdmin: boolean }
  | { ok: false; error: string } {
  const inv = db.getInvite(normalizeCode(code));
  if (!inv) return { ok: false, error: "邀请码不对" };
  if (!inv.isAdmin && db.getSetting("regPaused") === "1") return { ok: false, error: "暂时不开放注册，请稍后再来" };
  if (inv.usedAt) return { ok: false, error: "邀请码已经被用过了" };
  if (inv.expiresAt && inv.expiresAt <= new Date().toISOString()) return { ok: false, error: "邀请码已过期，请找管理员要一个新的" };
  return { ok: true, code: inv.code, isAdmin: inv.isAdmin };
}

/** 查邀请码是否可用（注册页先校验一下）；同样受频率限制，防止穷举 */
export function checkInvite(c: Context, code: string): { ok: boolean; error?: string } {
  if (!allow(`invite:ip:${clientIp(c)}`, 30)) return { ok: false, error: TOO_MANY };
  const s = inviteStatus(code);
  return s.ok ? { ok: true } : { ok: false, error: s.error };
}

export function newInvite(createdBy: number | undefined, note = "", days = INVITE_DAYS): string {
  const code = inviteCode();
  db.createInvite(code, { createdBy, expiresAt: daysFromNow(days), note: note.slice(0, 40) || undefined });
  return code;
}

/** 管理员邀请码（命令行用）：24 小时有效 */
export function newAdminInvite(): string {
  const code = inviteCode();
  db.createInvite(code, { isAdmin: true, expiresAt: daysFromNow(1), note: "命令行生成的管理员邀请" });
  return code;
}

/** 还没有任何用户时，确保有一个管理员邀请码，并返回它（用于打印到日志） */
export function ensureSetupInvite(): string | undefined {
  if (db.countUsers() > 0) return undefined;
  const existing = db.openAdminInvite();
  if (existing) return existing;
  const code = inviteCode();
  db.createInvite(code, { isAdmin: true, note: "首个管理员", expiresAt: daysFromNow(SETUP_INVITE_DAYS) });
  return code;
}
