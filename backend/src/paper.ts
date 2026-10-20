// 日报：主页“今天的一个词”之外，每人每天排一份长一点的版面，想多读几篇时直接挑，不用自己去词库里翻。
//
// 版面（当天第一次打开时排好存库，当天不再变；已读只在返回数据时按当前状态标出来）：
//   头条      推荐分最高的一个没读过的词
//   接着读    和你读过的词互为参见、同根、同典故、同专题（推荐理由写明因为哪个词）
//   今日专题  每天轮一个专题，挑其中三个没读过的
//   同时同路  和今天这个词同一个世纪、或走同一条语源之路
//   冷门一篇  你还没碰过的专题
//   温故      读过一阵子的词，只看“一句话记住”
// 同一份里不重复，不和今天、已锁定的明天的词重复；最近三天日报出过、还没读的词尽量不再出现。
// 没读过的词不够时，空位用温故补上。

import { createHash } from "node:crypto";
import { allDaily, getDaily, getPaper, readLog, setPaper, stateMap } from "./db.ts";
import { allFull, getEntry, inRotation, themeGroups } from "./entries.ts";
import { recommend, type Reason } from "./recommend.ts";
import { shiftDay } from "./daily.ts";
import type { FullEntry } from "./types.ts";

export type PaperReason =
  | Reason
  | { type: "era"; word: string; era: number }
  | { type: "road"; word: string; lang: string }
  | { type: "fresh"; theme: string }
  | { type: "recall"; ago: number };

export type PaperSection = { key: string; title: string; en: string; note?: string; items: { id: string; reason: PaperReason }[] };
export type Paper = { day: string; v: number; lead?: string; leadReason?: PaperReason; sections: PaperSection[] };

const VERSION = 1;
const SIZE = 12; // 一份日报的篇数（不含主页今天那个词）
const VAGUE = new Set(["人名", "地名"]);
const primary = (e: FullEntry) => e.themes.find((t) => !VAGUE.has(t)) ?? e.themes[0] ?? "";
const hash = (s: string) => parseInt(createHash("sha1").update(s).digest("hex").slice(0, 8), 16);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** 取当天的日报；没有就排一份存起来。只给今天排新的，过去的日子只读存下来的 */
export function getOrBuildPaper(uid: number, day: string, today: string): Paper | undefined {
  const saved = getPaper(uid, day) as Paper | undefined;
  if (saved && saved.v === VERSION) return saved;
  if (day !== today) return saved;
  const p = buildPaper(uid, day);
  setPaper(uid, day, p);
  return p;
}

export function buildPaper(uid: number, day: string): Paper {
  const seed = `${uid}:${day}:paper`;
  const state = stateMap(uid);
  const todayIds = getDaily(uid, day) ?? [];
  const todayEntry = todayIds.map((id) => getEntry(id)).find(Boolean);
  // 今天和以后锁定的词不上日报
  const used = new Set<string>([...todayIds, ...allDaily(uid).filter((d) => d.day > day).flatMap((d) => d.ids)]);
  // 最近三天日报里出过、还没读的：尽量不再出现（不够时再放开）
  const recentPaper = new Set<string>();
  for (let i = 1; i <= 3; i++) {
    const p = getPaper(uid, shiftDay(day, -i)) as Paper | undefined;
    for (const s of p?.sections ?? []) for (const it of s.items) if (!state.get(it.id)?.read) recentPaper.add(it.id);
  }

  // 所有没读过的候选，按推荐分排好（分数里已经含“和你读过的词有关”“避免单调”“覆盖面”等）
  const ranked = recommend({ uid, day, seed, exclude: used, limit: 10_000 });
  const fresh = ranked.filter((p) => !recentPaper.has(p.id));
  const pool = fresh.length >= SIZE ? fresh : ranked;
  const scoreOf = new Map(pool.map((p) => [p.id, p.score]));
  const take = (ids: string[], n: number) => {
    const out: string[] = [];
    for (const id of ids) {
      if (out.length >= n) break;
      if (used.has(id) || !scoreOf.has(id)) continue;
      used.add(id);
      out.push(id);
    }
    return out;
  };
  const byScore = (ids: string[]) => [...ids].sort((a, b) => (scoreOf.get(b) ?? -99) - (scoreOf.get(a) ?? -99));
  const sections: PaperSection[] = [];
  const reasonOf = new Map(pool.map((p) => [p.id, p.reason as PaperReason]));

  // 头条
  const [lead] = take(pool.map((p) => p.id), 1);

  // 接着读：推荐理由是“和你读过的某个词有关”的
  const follow = take(
    pool.filter((p) => p.reason && ["link", "kin", "theme"].includes(p.reason.type)).map((p) => p.id),
    3,
  );
  if (follow.length) sections.push({ key: "follow", title: "接着读", en: "Follow-ups", note: "和你读过的词连着", items: follow.map((id) => ({ id, reason: reasonOf.get(id) ?? null })) });

  // 今日专题：还剩至少三个没读过的专题里，按日期轮换（收藏过的、读得少的更容易轮到）
  const unreadIn = (ids: string[]) => ids.filter((id) => scoreOf.has(id) && !used.has(id) && inRotation(id));
  const groups = themeGroups()
    .filter((g) => !VAGUE.has(g.theme))
    .map((g) => ({ ...g, left: unreadIn(g.ids) }))
    .filter((g) => g.left.length >= 3);
  if (groups.length) {
    const g = groups[hash(seed + "theme") % groups.length]!;
    const picked = take(byScore(g.left), 3);
    if (picked.length) {
      sections.push({ key: "theme", title: `今日专题 · ${g.theme}`, en: "Theme of the Day", note: `这个专题还有 ${g.left.length} 个没读`, items: picked.map((id) => ({ id, reason: null })) });
    }
  }

  // 同时同路：和今天这个词同一个世纪、同一条语源之路
  if (todayEntry) {
    const items: PaperSection["items"] = [];
    if (todayEntry.era) {
      const [id] = take(byScore(allFull().filter((e) => e.era === todayEntry.era).map((e) => e.id)), 1);
      if (id) items.push({ id, reason: { type: "era", word: todayEntry.headword, era: todayEntry.era } });
    }
    const key = todayEntry.langs?.join("|");
    if (key) {
      const same = allFull().filter((e) => e.langs?.join("|") === key).map((e) => e.id);
      const first = allFull().filter((e) => e.langs?.[0] === todayEntry.langs![0]).map((e) => e.id);
      const got = take(byScore(same), 1)[0] ?? take(byScore(first), 1)[0];
      if (got) items.push({ id: got, reason: { type: "road", word: todayEntry.headword, lang: todayEntry.langs![0]! } });
    }
    if (items.length) sections.push({ key: "kin", title: "同一时代 · 同一条路", en: "Same Era, Same Road", items });
  }

  // 冷门一篇：一个都没读过的专题
  const readThemes = new Set(
    [...state].filter(([, s]) => s.read).map(([id]) => getEntry(id)).filter((e): e is FullEntry => !!e).map(primary),
  );
  const coldGroups = themeGroups().filter((g) => !VAGUE.has(g.theme) && !readThemes.has(g.theme) && unreadIn(g.ids).length);
  if (coldGroups.length) {
    const g = coldGroups[hash(seed + "cold") % coldGroups.length]!;
    const left = unreadIn(g.ids);
    const [id] = take([left[hash(seed + "coldpick") % left.length]!], 1);
    if (id) sections.push({ key: "wild", title: "冷门一篇", en: "Off the Beaten Path", items: [{ id, reason: { type: "fresh", theme: g.theme } }] });
  }

  // 温故的候选：读过三天以上的词
  const count = () => sections.reduce((n, s) => n + s.items.length, 0) + (lead ? 1 : 0);
  const log = readLog(uid).filter((r) => r.read_day && r.read_day <= shiftDay(day, -3) && getEntry(r.id) && !used.has(r.id));
  const recallWant = Math.min(2, log.length);

  // 剩下的空位：按推荐分补满“还值得一读”，给温故留两格（读过的词不够就不留）
  const more = take(pool.map((p) => p.id), Math.max(0, SIZE - recallWant - count()));
  if (more.length) sections.push({ key: "more", title: "还值得一读", en: "More to Read", items: more.map((id) => ({ id, reason: reasonOf.get(id) ?? null })) });

  // 温故：随机挑一些，读得越早越靠前；没读过的词不够时多放几个补位
  const recallN = Math.max(recallWant, SIZE - count());
  const recallPool = [...log].sort((a, b) => hash(seed + a.id) - hash(seed + b.id)).slice(0, Math.max(recallN * 3, 6));
  recallPool.sort((a, b) => a.read_day.localeCompare(b.read_day));
  const recall = recallPool.slice(0, recallN);
  for (const r of recall) used.add(r.id);
  if (recall.length) {
    sections.push({ key: "recall", title: "温故", en: "Revisit", note: "读过的词，看一眼还记不记得", items: recall.map((r) => ({ id: r.id, reason: { type: "recall", ago: daysBetween(r.read_day, day) } })) });
  }

  return { day, v: VERSION, lead, leadReason: lead ? reasonOf.get(lead) ?? null : undefined, sections };
}
