// 读取 data/entries.json，建立索引；文件变化时自动重新加载。

import { createHash } from "node:crypto";
import { readFileSync, watchFile } from "node:fs";
import { isRedirect, THEMES, type FullEntry, type Link, type RawEntry, type RedirectEntry } from "./types.ts";

export type Summary = {
  id: string;
  headword: string;
  /** 其他拼法，页面上自动给词加链接时也认 */
  variants?: string[];
  ipa: string;
  pos?: string;
  meaning?: string;
  teaser?: string;
  keyline?: string;
  themes?: string[];
  subtheme?: string;
  /** 故事起点所在的世纪，公元前为负 */
  era?: number;
  /** 词源涉及的语言，按大致的先后排好（数据里的顺序不一定是路线） */
  langs?: string[];
  letter: string;
  page: number;
  redirect?: string;
};

type Index = {
  all: RawEntry[];
  full: Map<string, FullEntry>;
  redirects: Map<string, RedirectEntry>;
  /** 每日推送顺序：按 hash(id) 排序，数据扩充时已有词条的相对顺序不变 */
  dailyOrder: string[];
  /** 词条关系，双向：A 记了 B，B 这边也能查到 A */
  kin: Map<string, Link[]>;
  /** 小写的词头和其他拼法 → 词条 id（参见条目指向它跳转到的词条） */
  words: Map<string, string>;
};

const ORDER_SALT = process.env.ORDER_SALT ?? "etymology-daily";
let index: Index;
let dataPath: string;

const hashHex = (s: string) => createHash("sha1").update(s).digest("hex");

export function loadEntries(path: string): void {
  dataPath = path;
  reload();
  watchFile(path, { interval: 2000 }, () => {
    try {
      reload();
      console.log(`[entries] 已重新加载 ${index.full.size} 条`);
    } catch (err) {
      console.error(`[entries] 重新加载失败，继续使用旧数据: ${(err as Error).message}`);
    }
  });
}

function reload(): void {
  const all = JSON.parse(readFileSync(dataPath, "utf8")) as RawEntry[];
  const full = new Map<string, FullEntry>();
  const redirects = new Map<string, RedirectEntry>();
  for (const e of all) {
    if (isRedirect(e)) redirects.set(e.id, e);
    else full.set(e.id, e);
  }
  const key = (id: string) => hashHex(ORDER_SALT + id);
  const dailyOrder = [...full.keys()].sort((a, b) => (key(a) < key(b) ? -1 : 1));
  const kin = new Map<string, Link[]>();
  const push = (from: string, l: Link) => {
    if (!full.has(l.id)) return;
    if (!kin.has(from)) kin.set(from, []);
    if (!kin.get(from)!.some((x) => x.id === l.id)) kin.get(from)!.push(l);
  };
  for (const e of full.values()) {
    for (const l of e.links ?? []) {
      push(e.id, l);
      push(l.id, { ...l, id: e.id });
    }
  }
  const words = new Map<string, string>();
  for (const e of all) {
    const target = isRedirect(e) ? e.redirect : e.id;
    for (const w of [e.headword, ...(isRedirect(e) ? [] : (e.variants ?? []))]) {
      const k = w.toLowerCase().replace(/^the /, "");
      if (!words.has(k) || !isRedirect(e)) words.set(k, target);
    }
  }
  index = { all, full, redirects, dailyOrder, kin, words };
}

export const getEntry = (id: string) => index.full.get(id);
export const allFull = () => [...index.full.values()];
export const getRedirect = (id: string) => index.redirects.get(id);
export const dailyOrder = () => index.dailyOrder;
export const totalCount = () => index.full.size;
/** 和这个词有关系的词（同根 / 同典故 / 衍生），双向 */
export const kinOf = (id: string): Link[] => index.kin.get(id) ?? [];

/** 一个英文词是不是书里的词条：先原样查，再试着去掉复数、所有格这些词尾 */
export function findWord(word: string): FullEntry | undefined {
  const w = word.toLowerCase().replace(/’/g, "'").trim();
  const forms = [w, w.replace(/'s$/, ""), w.replace(/s$/, ""), w.replace(/es$/, ""), w.replace(/ies$/, "y")];
  for (const f of forms) {
    const id = index.words.get(f);
    if (id && index.full.has(id)) return index.full.get(id);
  }
  return undefined;
}

/** 词卡上的一小段故事：正文第一段，太长就在句号处截断 */
export function gist(e: FullEntry, max = 120): string {
  const p = e.etymology[0] ?? "";
  if (p.length <= max) return p;
  const cut = p.slice(0, max);
  const end = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"));
  let s = end > 40 ? cut.slice(0, end + 1) : cut + "…";
  if ((s.match(/\*/g)?.length ?? 0) % 2) s = s.replace(/\*([^*]*)$/, "$1"); // 别截断在斜体中间
  return s;
}

export function summarize(e: RawEntry): Summary {
  const letter = e.headword[0]!.toUpperCase();
  if (isRedirect(e)) {
    return { id: e.id, headword: e.headword, ipa: e.ipa, letter, page: e.page, redirect: e.redirect };
  }
  return {
    id: e.id,
    headword: e.headword,
    variants: e.variants?.length ? e.variants : undefined,
    ipa: e.ipa,
    pos: e.pos,
    meaning: e.meaning,
    teaser: e.teaser,
    keyline: e.keyline,
    themes: e.themes,
    subtheme: e.subtheme,
    era: e.era,
    langs: routeOf(e.langs),
    letter,
    page: e.page,
  };
}

/** 语言大致的先后：古典语言 → 中古 → 近代欧洲语言 → 美国英语；“其他”放最后 */
const LANG_ORDER = [
  "希伯来语", "希腊语", "阿拉伯语", "拉丁语", "日耳曼语", "古英语", "古法语",
  "意大利语", "西班牙语", "法语", "荷兰语", "德语", "美国英语", "其他",
];
const routeOf = (langs?: string[]) =>
  langs?.length
    ? [...langs].sort((a, b) => (LANG_ORDER.indexOf(a) + 1 || 99) - (LANG_ORDER.indexOf(b) + 1 || 99))
    : undefined;

/** 全部词条摘要，按书中顺序 */
export const allSummaries = () => index.all.map(summarize);

const VAGUE_THEMES = new Set(["人名", "地名"]);

/** 同题材的其他词条，主题材相同的排前面 */
export function related(id: string, limit = 4): Summary[] {
  const e = getEntry(id);
  if (!e) return [];
  const scored: { score: number; e: FullEntry }[] = [];
  for (const other of index.full.values()) {
    if (other.id === id) continue;
    let score = 0;
    if (other.themes[0] === e.themes[0]) score += 2;
    if (e.subtheme && other.subtheme === e.subtheme) score += 2;
    score += other.themes.filter((t) => e.themes.includes(t) && !VAGUE_THEMES.has(t)).length;
    if (score) scored.push({ score, e: other });
  }
  return scored
    .sort((a, b) => b.score - a.score || (hashHex(id + a.e.id) < hashHex(id + b.e.id) ? -1 : 1))
    .slice(0, limit)
    .map((x) => summarize(x.e));
}

/** 每个题材下的词条 id，按书中顺序；只返回有词条的题材 */
export function themeGroups(): { theme: string; ids: string[] }[] {
  return THEMES.map((theme) => ({
    theme,
    ids: [...index.full.values()].filter((e) => e.themes.includes(theme)).map((e) => e.id),
  })).filter((g) => g.ids.length);
}

export type SearchHit = Summary & { snippet?: string };

export function search(q: string, limit = 50): SearchHit[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const hits: { score: number; hit: SearchHit }[] = [];

  for (const e of index.all) {
    const head = e.headword.toLowerCase();
    const names = [head, ...("variants" in e ? (e.variants ?? []).map((v) => v.toLowerCase()) : [])];
    let score = 0;
    let snippet: string | undefined;

    if (names.some((n) => n === needle)) score = 100;
    else if (names.some((n) => n.startsWith(needle))) score = 80;
    else if (names.some((n) => n.includes(needle))) score = 60;

    if (!isRedirect(e)) {
      if (!score && e.meaning.toLowerCase().includes(needle)) score = 50;
      if (!score) {
        const body = [e.keyline ?? "", ...e.etymology, ...e.examples.flatMap((x) => [x.en, x.zh])].map((p) =>
          p.replace(/\*/g, ""),
        );
        const para = body.find((p) => p.toLowerCase().includes(needle));
        if (para) {
          score = 20;
          const at = para.toLowerCase().indexOf(needle);
          const start = Math.max(0, at - 24);
          snippet = (start > 0 ? "…" : "") + para.slice(start, at + needle.length + 32) + "…";
        }
      }
    }
    if (score) hits.push({ score, hit: { ...summarize(e), snippet } });
  }
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((h) => h.hit);
}
