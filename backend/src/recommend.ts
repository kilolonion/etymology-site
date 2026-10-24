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
//   − 和最近两次推送出自同一本书（混合推送时几本书轮着来）
//   − 同一个词在别的书里已经读过（换个讲法再读一遍不算新词，排到后面）
//   + 一点按种子固定的随机扰动（同一天结果稳定，不同天有变化）
// 后台新增、还没核对的词不参与推荐（见 entries.ts 的 inRotation）；用户只选了几本书时，别的书的词也不推（bookFilter）。

import { createHash } from "node:crypto";
import { allDaily, getBooks, readLog, stateMap } from "./db.ts";
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

/**
 * 这个用户的推送范围：没选（默认）就是全部书混合；选过的话只推选中的书。
 * 后台新增的词不属于哪本书，照常参与（它们另有 inRotation 把关）；书目里已经没有的书 id 忽略，全被忽略时退回全部
 */
export function bookFilter(uid: number): (e: { book?: string }) => boolean {
  const known = new Set(books().map((b) => b.id));
  const mine = (getBooks(uid) ?? []).filter((id) => known.has(id));
  if (!mine.length) return () => true;
  const set = new Set(mine);
  return (e) => !e.book || set.has(e.book);
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
    if (picks.slice(0, 2).some((x) => x.book && x.book === e.book)) score -= 0.6;
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
