// 每日推送：用推荐引擎为每个用户挑选当天的词并锁定（附推荐理由）；读完后提前锁定明天的词，用于“明日预告”。
// 另外负责“旧词重逢”：按间隔重现以前读过的词。所有函数的第一个参数都是用户 id。

import {
  allDaily, getDaily, getDailyReasons, getResurface, readDays, readLog, recentResurfaced, setDaily, setResurface, stateMap,
} from "./db.ts";
import { dailyOrder, getEntry } from "./entries.ts";
import { recommend, type Reason } from "./recommend.ts";

const TZ = process.env.TZ_NAME ?? "Asia/Shanghai";

/** 指定时区下的日期 YYYY-MM-DD */
export function localDay(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** 指定时区下的时刻 HH:MM */
export function localTime(d = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
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

/** 旧词重逢：按间隔挑一个以前读过的词，当天固定 */
export function resurface(uid: number, day = localDay()): { id: string; ago: number } | undefined {
  const log = readLog(uid).filter((r) => r.read_day < day && getEntry(r.id));
  const stored = getResurface(uid, day);
  const storedRow = stored ? log.find((r) => r.id === stored) : undefined;
  if (storedRow) return { id: storedRow.id, ago: daysBetween(storedRow.read_day, day) };

  const recent = recentResurfaced(uid, shiftDay(day, -2));
  const today = new Set(getDaily(uid, day) ?? []);
  const cand = log.filter((r) => !recent.has(r.id) && !today.has(r.id));
  let hit = INTERVALS.map((iv) => cand.find((r) => daysBetween(r.read_day, day) === iv)).find(Boolean);
  // 没有正好落在间隔上的，就挑最早读过、三天以上的
  hit ??= cand.filter((r) => daysBetween(r.read_day, day) >= 3).at(-1);
  if (!hit) return undefined;
  setResurface(uid, day, hit.id);
  return { id: hit.id, ago: daysBetween(hit.read_day, day) };
}

/** 历史上最长的连续阅读天数 */
export function bestStreak(uid: number): number {
  const days = [...readDays(uid)].sort();
  let best = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i && shiftDay(days[i - 1]!, 1) === days[i] ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

/** 连续阅读天数（今天还没读则从昨天算起） */
export function streak(uid: number): number {
  const days = new Set(readDays(uid));
  const cursor = new Date();
  if (!days.has(localDay(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let n = 0;
  while (days.has(localDay(cursor))) {
    n++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return n;
}
