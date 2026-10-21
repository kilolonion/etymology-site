// 每日推送：用推荐引擎为每个用户挑选当天的词并锁定（附推荐理由）；读完后提前锁定明天的词，用于“明日预告”。
// 另外负责“旧词重逢”：按间隔重现以前读过的词。所有函数的第一个参数都是用户 id。

import {
  allDaily, getDaily, getDailyReasons, getResurface, getReview, listReviews, readDayCounts, readLog, recentResurfaced, saveReview,
  setDaily, setResurface, stateMap, type Review,
} from "./db.ts";
import { dailyOrder, getEntry } from "./entries.ts";
import { recommend, type Reason } from "./recommend.ts";

export const TZ = process.env.TZ_NAME ?? "Asia/Shanghai";

/** 指定时区下的日期 YYYY-MM-DD（默认站点时区；邮件按收件人自己的时区算） */
export function localDay(d = new Date(), tz = TZ): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** 指定时区下的时刻 HH:MM */
export function localTime(d = new Date(), tz = TZ): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}
const nextDay = (day: string) => shiftDay(day, 1);

/** 本周（周一到周日）的七个日期 */
export function weekDays(day = localDay()): string[] {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const fromMonday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, i) => shiftDay(day, i - fromMonday));
}

/** 今天之后已经锁定的词条（明日预告），挑“再读一个”时要避开 */
export function futureAssigned(uid: number, day = localDay()): Set<string> {
  return new Set(allDaily(uid).filter((d) => d.day > day).flatMap((d) => d.ids));
}

/** 挑出 n 个推荐词（附理由）；全部读完后随机挑已读的 */
export function pick(uid: number, n: number, exclude: Set<string>, day: string, seed = day): { id: string; reason: Reason }[] {
  const picks = recommend({ uid, day, seed, exclude, limit: n }).map(({ id, reason }) => ({ id, reason }));
  if (picks.length >= n) return picks;
  const rest = dailyOrder().filter((id) => !exclude.has(id) && !picks.some((p) => p.id === id));
  while (picks.length < n && rest.length) {
    picks.push({ id: rest.splice(Math.floor(Math.random() * rest.length), 1)[0]!, reason: null });
  }
  return picks;
}

const readDayOf = (uid: number, id: string) => readLog(uid).find((r) => r.id === id)?.read_day;

/** 锁定某天的词；已锁定的词如果在那天之前就被读掉了（比如在探索里提前读了），重新挑 */
function lockDay(uid: number, day: string, exclude: Set<string>, seed: string): string | undefined {
  const existing = getDaily(uid, day)?.find((id) => getEntry(id));
  if (existing) {
    const readOn = readDayOf(uid, existing);
    if (!readOn || readOn >= day) return existing;
    exclude.add(existing);
  }
  const [p] = pick(uid, 1, exclude, day, seed);
  if (p) setDaily(uid, day, [p.id], { [p.id]: p.reason });
  return p?.id;
}

/** 今天的词条 id（第一次访问时挑选并锁定） */
export function todayId(uid: number, day = localDay()): string | undefined {
  return lockDay(uid, day, futureAssigned(uid, day), day);
}

export const todayReason = (uid: number, day = localDay()): Reason =>
  (getDailyReasons(uid, day)[todayId(uid, day) ?? ""] as Reason) ?? null;

export function isDone(uid: number, day = localDay()): boolean {
  const id = todayId(uid, day);
  return !!id && !!stateMap(uid).get(id)?.read;
}

/** 明天的词条 id：今天读完后才挑选并锁定 */
export function tomorrowId(uid: number, day = localDay()): string | undefined {
  const tomorrow = nextDay(day);
  const exclude = new Set(getDaily(uid, day) ?? []);
  const existing = getDaily(uid, tomorrow)?.find((id) => getEntry(id));
  // 明天的词如果今天已经被读掉了，换一个
  if (existing && stateMap(uid).get(existing)?.read) {
    exclude.add(existing);
    const [p] = pick(uid, 1, exclude, day, tomorrow);
    if (p) setDaily(uid, tomorrow, [p.id], { [p.id]: p.reason });
    return p?.id;
  }
  return lockDay(uid, tomorrow, exclude, tomorrow);
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** 旧词重逢的间隔（天）：越久远的记忆越优先；昨天读的还新鲜，不重现 */
const INTERVALS = [240, 120, 60, 30, 14, 7, 3];
/** 间隔复习的各站（天），从短到长；记得就往后走一站，忘了回到起点、明天再见 */
export const STEPS = [3, 7, 14, 30, 60, 120, 240];

/** 还没复习过的词：按读过多少天，算它现在大概在第几站 */
const stageFromAgo = (ago: number) => Math.max(0, STEPS.findLastIndex((s) => s <= ago));

/**
 * 旧词重逢：当天固定一个。先挑复习到期的（忘过的会很快回来），没有到期的再按读过的天数正好落在间隔上的挑；
 * 已经排了以后复习日期的词，没到日子不提前出来。
 */
export function resurface(uid: number, day = localDay()): { id: string; ago: number; stage: number; review: Review | null } | undefined {
  const log = readLog(uid).filter((r) => r.read_day < day && getEntry(r.id));
  const info = (id: string, readDay: string) => {
    const review = getReview(uid, id) ?? null;
    const ago = daysBetween(readDay, day);
    return { id, ago, stage: review?.stage ?? stageFromAgo(ago), review };
  };
  const stored = getResurface(uid, day);
  const storedRow = stored ? log.find((r) => r.id === stored) : undefined;
  if (storedRow) return info(storedRow.id, storedRow.read_day);

  const recent = recentResurfaced(uid, shiftDay(day, -2));
  const today = new Set(getDaily(uid, day) ?? []);
  const reviews = new Map(listReviews(uid).map((r) => [r.id, r]));
  const cand = log.filter((r) => !recent.has(r.id) && !today.has(r.id));
  // 到期的复习：最早到期的先来
  let hit: (typeof log)[number] | undefined = cand
    .filter((r) => reviews.get(r.id) && reviews.get(r.id)!.dueDay <= day && reviews.get(r.id)!.lastDay < day)
    .sort((a, b) => reviews.get(a.id)!.dueDay.localeCompare(reviews.get(b.id)!.dueDay))[0];
  const fresh = cand.filter((r) => !reviews.has(r.id));
  hit ??= INTERVALS.map((iv) => fresh.find((r) => daysBetween(r.read_day, day) === iv)).find(Boolean);
  // 没有正好落在间隔上的，就挑最早读过、三天以上的
  hit ??= fresh.filter((r) => daysBetween(r.read_day, day) >= 3).at(-1);
  if (!hit) return undefined;
  setResurface(uid, day, hit.id);
  return info(hit.id, hit.read_day);
}

/** 记一次复习（旧词重逢点“记得 / 忘了”，或考考你答对 / 答错） */
export function review(uid: number, id: string, ok: boolean, day = localDay()): Review | undefined {
  const row = readLog(uid).find((r) => r.id === id);
  if (!row) return undefined;
  const prev = getReview(uid, id);
  // 同一天对同一个词只记第一次，免得来回点刷进度
  if (prev?.lastDay === day) return prev;
  // 记得：从现在这一站往后走一站；忘了：回到第一站，明天再见
  const now = prev?.stage ?? stageFromAgo(daysBetween(row.read_day, day));
  const stage = ok ? Math.min(STEPS.length - 1, now + 1) : 0;
  const next: Review = { id, stage, dueDay: shiftDay(day, ok ? STEPS[stage]! : 1), lastDay: day, lastOk: ok };
  saveReview(uid, next);
  return next;
}

/** 漏了一天，第二天读满这么多个就能补上 */
export const REPAIR_NEED = 2;

/**
 * 算连续天数用的“有效阅读日”：真读过的日子，加上补签的日子。
 * 补签：某天没读，但前一天读过、后一天读了不少于 REPAIR_NEED 个，这一天就算接上了（只补单独漏掉的一天）。
 * 手动“标为已读”的不算。
 */
export function streakDays(uid: number): { days: Set<string>; patched: Set<string>; counts: Map<string, number> } {
  const counts = readDayCounts(uid);
  const days = new Set(counts.keys());
  const patched = new Set<string>();
  for (const [d, n] of counts) {
    const gap = shiftDay(d, -1);
    if (n >= REPAIR_NEED && !days.has(gap) && days.has(shiftDay(d, -2))) patched.add(gap);
  }
  for (const d of patched) days.add(d);
  return { days, patched, counts };
}

/** 历史上最长的连续阅读天数 */
export function bestStreak(uid: number): number {
  const days = [...streakDays(uid).days].sort();
  let best = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i && shiftDay(days[i - 1]!, 1) === days[i] ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

/** 连续阅读天数（今天还没读则从昨天算起；昨天漏了但今天补上的也接着算） */
export function streak(uid: number, day = localDay()): number {
  const { days } = streakDays(uid);
  let cursor = days.has(day) ? day : shiftDay(day, -1);
  let n = 0;
  while (days.has(cursor)) {
    n++;
    cursor = shiftDay(cursor, -1);
  }
  return n;
}

/**
 * 今天的打卡情况：今天读了几个、目标几个；昨天漏了而前天读过时，提示今天读满几个能补上
 */
export function todayProgress(uid: number, goal: number, day = localDay()) {
  const { days, patched, counts } = streakDays(uid);
  const have = counts.get(day) ?? 0;
  const yesterday = shiftDay(day, -1);
  const canRepair = !counts.has(yesterday) && counts.has(shiftDay(day, -2));
  return {
    today: have,
    goal,
    // need：还差几个能补上昨天；repaired：已经补上了
    repair: canRepair ? { day: yesterday, need: REPAIR_NEED, have, repaired: patched.has(yesterday) } : null,
    patched: [...patched].filter((d) => d >= shiftDay(day, -7)),
    streakToday: days.has(day),
  };
}
