// 读取各本词书的词条（data/books.json 列的书目：第一本是 entries.json，其余每本一个文件），叠加后台发布的新词和补写，
// 建立索引；文件变化、后台发布时自动重建。几本书按词头字母混排；同一个词在几本书里都有时互为“别的书里的版本”。

import { createHash } from "node:crypto";
import { existsSync, readFileSync, watchFile } from "node:fs";
import { dirname, join } from "node:path";
import {
  BASE_BOOK, isRedirect, THEMES, type Book, type FullEntry, type Link, type Origin, type RawEntry, type RedirectEntry,
} from "./types.ts";

export type Summary = {
  id: string;
  /** 出自哪本书（后台新增的词没有）；seal 是那本书的一字书签，只有一本书时不给 */
  book?: string;
  seal?: string;
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
  page?: number;
  redirect?: string;
  /** 不在书里的词：ai = AI 整理待核对，ai-ok = AI 整理已核对，edit = 编辑撰写；原书词条没有这个字段 */
  src?: Src;
};

export type Src = "ai" | "ai-ok" | "edit";
export const srcOf = (o?: Origin | null): Src | undefined =>
  !o ? undefined : o.kind === "manual" ? "edit" : o.checked ? "ai-ok" : "ai";

/** 叠加层：后台发布的新词、给原书词条补写的字段，以及核对过的 AI 词条进不进每日推送 */
export type Overlay = {
  added: FullEntry[];
  patches: Map<string, { fields: Partial<FullEntry>; origin: Origin }>;
  aiInDaily: boolean;
};

type Index = {
  all: RawEntry[];
  full: Map<string, FullEntry>;
  redirects: Map<string, RedirectEntry>;
  /** 每日推送顺序：按 hash(id) 排序，数据扩充时已有词条的相对顺序不变；只含能进推送的词 */
  dailyOrder: string[];
  /** 能进每日推送、“接着读”、考考你的词：原书词条，以及（打开开关时）核对过的新词 */
  rotation: Set<string>;
  /** 词条关系，双向：A 记了 B，B 这边也能查到 A */
  kin: Map<string, Link[]>;
  /** 小写的词头和其他拼法 → 词条 id（参见条目指向它跳转到的词条）；几本书都有的词指向书目里靠前的那本 */
  words: Map<string, string>;
  /** 同一个词头在几本书里的版本：归一后的词头 → 词条 id（按书目顺序） */
  twins: Map<string, string[]>;
};

const ORDER_SALT = process.env.ORDER_SALT ?? "etymology-daily";
let index: Index;
let dataPath: string;
/** 各书原样的数据（按书目顺序拼在一起；第一本的词条加载时补上 book） */
let base: RawEntry[] = [];
let bookList: Book[] = [];
const DEFAULT_BOOK: Book = { id: BASE_BOOK, title: "英语词源典故词典", short: "英语词源典故词典", seal: "典", author: "", file: "entries.json", pages: true, note: "正文、释义、例句照原书；钩子、一句话记住、词义演变为编辑补写。" };
let baseIds = new Set<string>();
let overlaySource: () => Overlay = () => ({ added: [], patches: new Map(), aiInDaily: false });

const hashHex = (s: string) => createHash("sha1").update(s).digest("hex");

/** 叠加层从哪里来（数据库打开以后由 main.ts 设好；校验脚本、命令行不设就只有原书） */
export function setOverlay(fn: () => Overlay): void {
  overlaySource = fn;
}

const registryPath = () => join(dirname(dataPath), "books.json");
const bookFile = (b: Book) => (b.id === BASE_BOOK ? dataPath : join(dirname(dataPath), b.file));

export function loadEntries(path: string): void {
  dataPath = path;
  readBase();
  rebuild();
  const reload = () => {
    try {
      readBase();
      rebuild();
      console.log(`[entries] 已重新加载 ${index.full.size} 条（${bookList.length} 本书）`);
    } catch (err) {
      console.error(`[entries] 重新加载失败，继续使用旧数据: ${(err as Error).message}`);
    }
  };
  for (const f of new Set([registryPath(), ...bookList.map(bookFile)])) watchFile(f, { interval: 2000 }, reload);
}

function readBase(): void {
  const list = existsSync(registryPath()) ? (JSON.parse(readFileSync(registryPath(), "utf8")) as Book[]) : [];
  if (!list.some((b) => b.id === BASE_BOOK)) list.unshift(DEFAULT_BOOK);
  const next: RawEntry[] = [];
  const loaded: Book[] = [];
  for (const b of list) {
    if (!existsSync(bookFile(b))) {
      console.warn(`[entries] 书目里的《${b.short}》没有数据文件 ${bookFile(b)}，先跳过`);
      continue;
    }
    for (const e of JSON.parse(readFileSync(bookFile(b), "utf8")) as RawEntry[]) next.push({ ...e, book: e.book ?? b.id });
    loaded.push(b);
  }
  base = next;
  bookList = loaded;
  baseIds = new Set(base.map((e) => e.id));
}

/** 书目（只含有数据的书），按 books.json 的顺序 */
export const books = () => bookList;
export const getBook = (id?: string) => bookList.find((b) => b.id === (id ?? BASE_BOOK));
const bookRank = (id?: string) => {
  const i = bookList.findIndex((b) => b.id === id);
  return i < 0 ? bookList.length : i;
};
/** 归一后的词头：同一个词在不同书里写法略有出入（大小写、the） */
export const headKey = (w: string) => sortHead(w.toLowerCase().replace(/’/g, "'")).trim();

/** 排序、分字母组时不看开头的冠词：the balloon goes up、a bolt from the blue 排在 B 里（和书里一样） */
const sortHead = (w: string) => w.replace(/^(\(?the\)?|an?)\s+(?=\S)/i, "");
const cmpHead = (a: string, b: string) => sortHead(a).localeCompare(sortHead(b), "en", { sensitivity: "base" });

/** 重建索引：原书 + 补写 + 新词。后台发布、撤下后调用 */
export function rebuild(): void {
  const ov = overlaySource();
  const all: RawEntry[] = base.map((e) => {
    const p = isRedirect(e) ? undefined : ov.patches.get(e.id);
    if (!p || isRedirect(e)) return e;
    const merged: FullEntry = { ...e, ...p.fields, patched: { fields: Object.keys(p.fields), origin: p.origin } };
    // 补写过的字段就不再是“程序生成”的了
    if (e.auto) merged.auto = e.auto.filter((f) => !(f in p.fields));
    // 关系是补充，不是替换：原有的留着，补的追加在后面
    if (p.fields.links) merged.links = [...(e.links ?? []), ...p.fields.links.filter((l) => !(e.links ?? []).some((x) => x.id === l.id))];
    return merged;
  });
  // 只有一本书时保持书中顺序；几本书时按词头字母混排，同一个词按书目顺序
  if (bookList.length > 1) all.sort((a, b) => cmpHead(a.headword, b.headword) || bookRank(a.book) - bookRank(b.book));
  // 新词按字母插进去（书本身就是按字母排的）；已经并回 entries.json 的以文件为准
  for (const e of ov.added) {
    if (baseIds.has(e.id)) continue;
    const at = all.findIndex((x) => cmpHead(x.headword, e.headword) > 0);
    all.splice(at < 0 ? all.length : at, 0, e);
  }

  const full = new Map<string, FullEntry>();
  const redirects = new Map<string, RedirectEntry>();
  for (const e of all) {
    if (isRedirect(e)) redirects.set(e.id, e);
    else full.set(e.id, e);
  }
  const rotation = new Set([...full.values()].filter((e) => !e.origin || (!!e.origin.checked && ov.aiInDaily)).map((e) => e.id));
  const key = (id: string) => hashHex(ORDER_SALT + id);
  const dailyOrder = [...rotation].sort((a, b) => (key(a) < key(b) ? -1 : 1));
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
  // 正文里的词加词卡链接时查这张表：完整词条优先于跳转词条；几本书都有的词，指向书目里靠前的那本
  const words = new Map<string, string>();
  const fromFull = new Set<string>();
  for (const e of [...all].sort((a, b) => bookRank(a.book) - bookRank(b.book))) {
    const target = isRedirect(e) ? e.redirect : e.id;
    for (const w of [e.headword, ...(isRedirect(e) ? [] : (e.variants ?? []))]) {
      const k = w.toLowerCase().replace(/^the /, "");
      if (fromFull.has(k)) continue;
      if (!words.has(k) || !isRedirect(e)) words.set(k, target);
      if (!isRedirect(e)) fromFull.add(k);
    }
  }
  const twins = new Map<string, string[]>();
  for (const e of [...full.values()].sort((a, b) => bookRank(a.book) - bookRank(b.book))) {
    const k = headKey(e.headword);
    twins.set(k, [...(twins.get(k) ?? []), e.id]);
  }
  index = { all, full, redirects, dailyOrder, rotation, kin, words, twins };
}

export const getEntry = (id: string) => index.full.get(id);
export const allFull = () => [...index.full.values()];
export const getRedirect = (id: string) => index.redirects.get(id);
export const dailyOrder = () => index.dailyOrder;
export const totalCount = () => index.full.size;
/** 能不能进每日推送、“接着读”、随手翻一页 */
export const inRotation = (id: string) => index.rotation.has(id);
/** 同一个词在别的书里的版本（不含自己），按书目顺序 */
export const twinsOf = (id: string): string[] => {
  const e = index.full.get(id);
  return e ? (index.twins.get(headKey(e.headword)) ?? []).filter((x) => x !== id) : [];
};
/** 是不是书里的词条（任何一本，含跳转词条）；后台新增的词不是 */
export const isBookId = (id: string) => baseIds.has(id);
/** 原书里的样子（不含补写），补写编辑时对照用 */
export const bookEntry = (id: string): FullEntry | undefined => {
  const e = base.find((x) => x.id === id);
  return e && !isRedirect(e) ? e : undefined;
};
/** 所有词条和跳转词条的 id（校验 links 指向用） */
export const hasId = (id: string) => index.full.has(id) || index.redirects.has(id);
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

const sealOf = (book?: string) => (book && bookList.length > 1 ? getBook(book)?.seal : undefined);

export function summarize(e: RawEntry): Summary {
  const letter = (sortHead(e.headword).match(/[a-z]/i)?.[0] ?? e.headword[0]!).toUpperCase();
  if (isRedirect(e)) {
    return { id: e.id, book: e.book, seal: sealOf(e.book), headword: e.headword, ipa: e.ipa, letter, page: e.page, redirect: e.redirect };
  }
  return {
    id: e.id,
    book: e.book,
    seal: sealOf(e.book),
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
    src: srcOf(e.origin),
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

/** 全部词条摘要，按词头字母（只有一本书时按书中顺序） */
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
    const names = [head, ...(isRedirect(e) ? [] : [...(e.variants ?? []), ...(e.phrases ?? []).map((p) => p.replace(/\s+[\u3400-\u9fff].*$/, ""))].map((v) => v.toLowerCase()))];
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
