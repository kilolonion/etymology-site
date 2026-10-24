// 推荐：让每天的新词“既有关联，又有变化”。每个用户按自己的阅读记录单独计算。
//
// 对每个没读过的词打分：
//   + 和读过的词互为“参见”，或同根、同典故、互相衍生（最强的记忆挂钩）
//   + 和最近 7 天读过的词同专题（把新词挂到刚建立的记忆上；风俗与生活按子专题算）
//   + 和当前文章相关（文章末尾“接着读”时）
//   + 收藏过的专题（个人兴趣）
//   + 读得少的专题（覆盖面）
//   − 和昨天、今天同一个主专题（避免单调）
//   − 和最近几次推送首字母相同（避免 A、A、A……）
//   ± 几本书的占比往目标上拉：目标 = 每本书的档位（关 / 少 / 适中 / 多）× 阅读习惯微调，
//     和最近两周推过、读过的实际占比相比，少了就加分、多了就减分（见 bookPlan）
//   − 同一个词在别的书里已经读过（换个讲法再读一遍不算新词，排到后面）
//   + 一点按种子固定的随机扰动（同一天结果稳定，不同天有变化）
// 后台新增、还没核对的词不参与推荐（见 entries.ts 的 inRotation）；关掉的书不推（bookFilter）。

import { createHash } from "node:crypto";
import { allDaily, getBookPrefs, readLog, stateMap, type BookPrefs } from "./db.ts";
import { allFull, books, getEntry, headKey, inRotation, kinOf } from "./entries.ts";
import { SUBTHEMES, type FullEntry } from "./types.ts";

export type Reason =
  | { type: "link"; word: string } // 和你读过的 X 互为参见
  | { type: "kin"; word: string; rel: string } // 和你读过的 X 同根 / 同典故 / 衍生
  | { type: "theme"; word: string; theme: string } // 你读过的 X 也属于这个专题
  | { type: "anchor"; word: string; theme?: string; rel?: string } // 正在读的 X 的参见词 / 有关系的词 / 同专题
  | { type: "taste"; theme: string } // 你收藏过同专题的词
  | { type: "new"; theme: string } // 还没读过的专题
  | null;

export type Pick = { id: string; reason: Reason; score: number };

const VAGUE = new Set(["人名", "地名"]);
const primary = (e: FullEntry) => e.themes.find((t) => !VAGUE.has(t)) ?? e.themes[0] ?? "";
const concrete = (e: FullEntry) => e.themes.filter((t) => !VAGUE.has(t));
/** 判断“同专题”用的粒度：分了子专题的大专题（风俗与生活）细到子专题，不然一半的词都算同专题 */
const topics = (e: FullEntry) =>
  concrete(e).map((t) => (t in SUBTHEMES && e.subtheme ? `${t}·${e.subtheme}` : t));
const initial = (e: FullEntry) => e.headword[0]!.toLowerCase();
const jitter = (seed: string, id: string) =>
  parseInt(createHash("sha1").update(seed + id).digest("hex").slice(0, 6), 16) / 0xffffff;

function daysBefore(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

const levelOf = (p: BookPrefs, id: string) => p.weights[id] ?? p.fallback;

/**
 * 这个用户的推送范围：档位是“关”的书不推。后台新增的词不属于哪本书，照常参与（它们另有 inRotation 把关）；
 * 书目里已经没有的书忽略，万一全关了就退回全部
 */
export function bookFilter(uid: number): (e: { book?: string }) => boolean {
  const prefs = getBookPrefs(uid);
  const on = new Set(books().map((b) => b.id).filter((id) => levelOf(prefs, id) > 0));
  if (!on.size || on.size === books().length) return () => true;
  return (e) => !e.book || on.has(e.book);
}

/** 一本书在推送里的安排：档位、习惯系数、目标占比、最近两周的实际占比，以及系数是怎么来的 */
export type BookPlan = {
  id: string;
  level: number;
  /** 阅读习惯微调系数（没开微调就是 1），0.7～1.35 */
  factor: number;
  /** 目标占比（0～1），没有没读过的词了就是 0 */
  target: number;
  /** 最近两周推过、读过的词里这本书占多少 */
  recent: number;
  unread: number;
  /** 微调的依据，给“词书”页解释用 */
  why: string;
};

/** 统计最近两周的占比；习惯看最近 60 天 */
const MIX_WINDOW = 14;
const HABIT_WINDOW = 60;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * 混合比例。习惯微调看三个信号，都做了平滑（数据少时系数接近 1）：
 * - 推给你的词读完了多少（和你所有书的平均读完率比）——最主要
 * - 读过的词里收藏了多少
 * - 没推也主动去读了多少（翻书、搜索、接着读）
 */
export function bookPlan(uid: number, day: string): BookPlan[] {
  const prefs = getBookPrefs(uid);
  const list = books();
  const state = stateMap(uid);
  const log = readLog(uid);
  const daily = allDaily(uid).filter((d) => d.day <= day);
  const mixSince = daysBefore(day, MIX_WINDOW);
  const habitSince = daysBefore(day, HABIT_WINDOW);

  type Tally = { unread: number; pushed: number; done: number; reads: number; stars: number; own: number; seen: number };
  const per = new Map<string, Tally>(list.map((b) => [b.id, { unread: 0, pushed: 0, done: 0, reads: 0, stars: 0, own: 0, seen: 0 }]));
  const tally = (id: string) => {
    const b = getEntry(id)?.book;
    return b ? per.get(b) : undefined;
  };
  for (const e of allFull()) {
    const t = e.book ? per.get(e.book) : undefined;
    if (t && !state.get(e.id)?.read && inRotation(e.id)) t.unread++;
  }
  // 推过的（不算今天：今天的还没来得及读）
  const pushed = new Set(daily.filter((d) => d.day < day && d.day >= habitSince).flatMap((d) => d.ids));
  for (const id of pushed) {
    const t = tally(id);
    if (!t) continue;
    t.pushed++;
    if (state.get(id)?.read) t.done++;
  }
  for (const r of log) {
    if (!r.read_day || r.read_day < habitSince) continue;
    const t = tally(r.id);
    if (!t) continue;
    t.reads++;
    if (state.get(r.id)?.starred) t.stars++;
    if (!pushed.has(r.id) && !r.manual) t.own++;
  }
  // 最近两周的曝光：推过的、读过的（去重）
  const seen = new Set(daily.filter((d) => d.day >= mixSince).flatMap((d) => d.ids));
  for (const r of log) if (r.read_day && r.read_day >= mixSince && r.read_day <= day) seen.add(r.id);
  for (const id of seen) {
    const t = tally(id);
    if (t) t.seen++;
  }

  const sum = (f: (t: Tally) => number) => [...per.values()].reduce((n, t) => n + f(t), 0);
  const pushedAll = sum((t) => t.pushed);
  const finishAll = pushedAll >= 5 ? sum((t) => t.done) / pushedAll : 0.75;
  const readsAll = sum((t) => t.reads);
  const starAll = readsAll >= 5 ? sum((t) => t.stars) / readsAll : 0.1;
  const ownAll = sum((t) => t.own);
  const n = list.length;

  const plans = list.map((b) => {
    const t = per.get(b.id)!;
    const level = levelOf(prefs, b.id);
    let factor = 1;
    let why = "";
    if (prefs.auto && n > 1) {
      const finish = (t.done + 4 * finishAll) / (t.pushed + 4);
      const fFinish = finish / Math.max(finishAll, 0.05);
      const star = (t.stars + 5 * starAll) / (t.reads + 5);
      const fStar = 1 + clamp((star - starAll) * 1.5, -0.1, 0.15);
      const own = ((t.own + 2) / (ownAll + 2 * n)) * n;
      const fOwn = clamp(Math.pow(own, 0.2), 0.88, 1.15);
      factor = Math.round(clamp(fFinish * fStar * fOwn, 0.7, 1.35) * 100) / 100;
      // 说明挑影响最大的那个信号
      const signs = [
        { d: fFinish - 1, up: `推给你的 ${t.pushed} 个读完了 ${t.done} 个`, down: `推给你的 ${t.pushed} 个只读完 ${t.done} 个` },
        { d: fStar - 1, up: `读过的里收藏了 ${t.stars} 个`, down: "读过的很少收藏" },
        { d: fOwn - 1, up: `没推也主动读了 ${t.own} 个`, down: "很少主动翻这本" },
      ].sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
      if (Math.abs(factor - 1) >= 0.03 && Math.abs(signs[0]!.d) >= 0.02) why = signs[0]!.d > 0 ? signs[0]!.up : signs[0]!.down;
    }
    return { id: b.id, level, factor, weight: t.unread ? level * factor : 0, unread: t.unread, seen: t.seen, why };
  });
  const total = plans.reduce((x, p) => x + p.weight, 0) || 1;
  const seenAll = plans.reduce((x, p) => x + p.seen, 0);
  return plans.map(({ weight, seen: s, ...p }) => ({
    ...p,
    target: Math.round((weight / total) * 1000) / 1000,
    recent: seenAll ? Math.round((s / seenAll) * 1000) / 1000 : 0,
  }));
}

/** 两个词是否互为“参见” */
const linked = (a: FullEntry, b: FullEntry) => (a.seeAlso ?? []).includes(b.id) || (b.seeAlso ?? []).includes(a.id);
/** 书外整理的关系（双向），返回关系类型 */
const kinType = (a: FullEntry, b: FullEntry) => kinOf(a.id).find((l) => l.id === b.id)?.type;

export function recommend(opts: {
  uid: number;
  day: string;
  seed: string;
  exclude?: Set<string>;
  anchor?: string;
  limit?: number;
}): Pick[] {
  const { uid, day, seed, exclude = new Set(), anchor, limit = 1 } = opts;
  const state = stateMap(uid);
  const all = allFull();
  const log = readLog(uid).filter((r) => getEntry(r.id));
  const readEntries = log.map((r) => getEntry(r.id)!);
  const recent = log.filter((r) => r.read_day >= daysBefore(day, 7)).map((r) => getEntry(r.id)!);

  // 最近三次推送（含今天），用于避免单调
  const daily = allDaily(uid);
  const picks = daily
    .filter((d) => d.day <= day)
    .slice(0, 3)
    .flatMap((d) => d.ids.map((id) => getEntry(id)).filter((e): e is FullEntry => !!e));
  const assignedPast = new Set(daily.filter((d) => d.day < day).flatMap((d) => d.ids));

  // 收藏偏好与各专题阅读进度
  const tasteCount = new Map<string, number>();
  const themeTotal = new Map<string, number>();
  const themeRead = new Map<string, number>();
  for (const e of all) {
    const p = primary(e);
    themeTotal.set(p, (themeTotal.get(p) ?? 0) + 1);
    const s = state.get(e.id);
    if (s?.read) themeRead.set(p, (themeRead.get(p) ?? 0) + 1);
    if (s?.starred) tasteCount.set(p, (tasteCount.get(p) ?? 0) + 1);
  }

  const anchorEntry = anchor ? getEntry(anchor) : undefined;
  const scored: Pick[] = [];
  const allowed = bookFilter(uid);
  // 几本书的占比：最近两周曝光太少（刚开始用）时只看目标，不算差额
  const plan = new Map(bookPlan(uid, day).map((p) => [p.id, p]));
  const enoughHistory = [...plan.values()].some((p) => p.recent > 0) && allDaily(uid).filter((d) => d.day >= daysBefore(day, MIX_WINDOW)).length >= 3;
  // 读过的词头（任何一本书）：别的书里同一个词往后排
  const readHeads = new Set(readEntries.map((r) => headKey(r.headword)));

  for (const e of all) {
    // 待核对的新词（以及没打开开关时核对过的新词）只在探索、搜索里出现，不主动推荐
    if (exclude.has(e.id) || state.get(e.id)?.read || !inRotation(e.id) || !allowed(e)) continue;
    let score = jitter(seed, e.id) * 1.2;
    let reason: Reason = null;
    const p = primary(e);

    if (anchorEntry) {
      const anchorTopics = topics(anchorEntry);
      const shared = topics(e).find((t) => anchorTopics.includes(t));
      const rel = kinType(e, anchorEntry);
      if (linked(e, anchorEntry)) {
        score += 4;
        reason = { type: "anchor", word: anchorEntry.headword };
      } else if (rel) {
        score += 3.5;
        reason = { type: "anchor", word: anchorEntry.headword, rel };
      } else if (shared) {
        score += 2;
        reason = { type: "anchor", word: anchorEntry.headword, theme: shared };
      } else score -= 1;
    }

    const link = readEntries.find((r) => linked(e, r));
    if (link) {
      score += 3;
      reason ??= { type: "link", word: link.headword };
    } else {
      const kin = readEntries.find((r) => kinType(e, r));
      if (kin) {
        score += 2.5;
        reason ??= { type: "kin", word: kin.headword, rel: kinType(e, kin)! };
      }
    }

    const mine = topics(e);
    const near = recent.find((r) => topics(r).some((t) => mine.includes(t)));
    if (near) {
      score += 1.5;
      reason ??= { type: "theme", word: near.headword, theme: mine.find((t) => topics(near).includes(t))! };
    }

    if (picks[0] && primary(picks[0]) === p) score -= 2;
    if (picks[1] && primary(picks[1]) === p) score -= 1;
    if (picks.some((x) => initial(x) === initial(e))) score -= 0.8;
    const bp = e.book ? plan.get(e.book) : undefined;
    if (bp) {
      // 差额拉回目标占比；再按目标本身给一点（档位“多”的书平时就更容易轮到）
      if (enoughHistory) score += 3.5 * (bp.target - bp.recent);
      score += 1.2 * (bp.target - 1 / plan.size);
      if (picks[0]?.book === e.book) score -= 0.3; // 连着两天同一本书稍微压一压
    }
    if (readHeads.has(headKey(e.headword))) score -= 3;

    const taste = tasteCount.get(p) ?? 0;
    if (taste) {
      score += Math.min(2, taste * 0.8);
      reason ??= { type: "taste", theme: p };
    }

    const coverage = (themeRead.get(p) ?? 0) / (themeTotal.get(p) ?? 1);
    score += (1 - coverage) * 0.8;
    if (!themeRead.get(p) && log.length) reason ??= { type: "new", theme: p };

    if (assignedPast.has(e.id)) score += 0.4; // 之前推过但漏读的

    scored.push({ id: e.id, reason, score });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
