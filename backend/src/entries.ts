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
  /** 原书词条里由 AI 补写的字段（导入后批量补的 keyline / links，后台 AI 补写的字段）；用户屏蔽 AI 内容时去掉 */
  ai?: string[];
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
  /** 每本书按原书顺序的词条 id（不含跳转词条、后台新增的词） */
  order: Map<string, string[]>;
  /** 词条在自己那本书里排第几（从 0 数） */
  pos: Map<string, number>;
  /** 由 AI 补写的关系（两个 id 排序后用 | 连起来） */
  aiLinks: Set<string>;
  /** 原书词条里由 AI 补写的标量字段（keyline 等；links 单独用 aiLinks 标） */
  aiFields: Map<string, Set<string>>;
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
  // 原书里的本来样子（不含后台补写）：判断某个字段/关系是不是 AI 补写时要用它
  const baseById = new Map<string, FullEntry>();
  for (const e of base) if (!isRedirect(e)) baseById.set(e.id, e);

  const kin = new Map<string, Link[]>();
  const aiLinks = new Set<string>();
  const aiFields = new Map<string, Set<string>>();
  const push = (from: string, l: Link) => {
    if (!full.has(l.id)) return;
    if (!kin.has(from)) kin.set(from, []);
    if (!kin.get(from)!.some((x) => x.id === l.id)) kin.get(from)!.push(l);
  };
  for (const e of full.values()) {
    const fields = new Set<string>();
    if (e.origin?.kind === "ai") {
      // 整篇 AI 整理的新词：它的关系也都是 AI 的
      for (const l of e.links ?? []) aiLinks.add(pairKey(e.id, l.id));
    } else {
      const raw = baseById.get(e.id);
      const patch = e.origin ? undefined : ov.patches.get(e.id);
      if (raw) {
        const baseAuto = new Set(raw.auto ?? []);
        // 导入时 AI 批量补的字段（keyline 等）
        for (const f of baseAuto) if (AUTO_AI.has(f) && f !== "links") fields.add(f);
        // 后台补写：AI 写的算 AI；人工写的覆盖掉原书的 AI 版本，就不算 AI 了
        for (const f of Object.keys(patch?.fields ?? {})) {
          if (f === "links") continue;
          if (patch!.origin.kind === "ai") fields.add(f);
          else fields.delete(f);
        }
        // 关系是追加不是替换：原书数据里的 AI 关系 + 这次 AI 追加的都算 AI，人工追加的除外
        if (baseAuto.has("links")) for (const l of raw.links ?? []) aiLinks.add(pairKey(e.id, l.id));
        if (patch?.origin.kind === "ai") for (const l of patch.fields.links ?? []) aiLinks.add(pairKey(e.id, l.id));
      }
    }
    aiFields.set(e.id, fields);
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
  // 原书顺序就是数据文件里的顺序（三本书都是按 A–Z 分章编排的）
  const order = new Map<string, string[]>();
  const pos = new Map<string, number>();
  for (const e of base) {
    if (isRedirect(e) || !e.book || !full.has(e.id)) continue;
    const list = order.get(e.book) ?? [];
    pos.set(e.id, list.length);
    list.push(e.id);
    order.set(e.book, list);
  }
  index = { all, full, redirects, dailyOrder, rotation, kin, words, twins, order, pos, aiLinks, aiFields };
}

export const getEntry = (id: string) => index.full.get(id);
export const allFull = () => [...index.full.values()];
export const getRedirect = (id: string) => index.redirects.get(id);
export const dailyOrder = () => index.dailyOrder;
export const totalCount = (hideAi = false) =>
  hideAi ? [...index.full.values()].filter((e) => e.origin?.kind !== "ai").length : index.full.size;
/** 能不能进每日推送、“接着读”、随手翻一页 */
export const inRotation = (id: string) => index.rotation.has(id);
/** 同一个词在别的书里的版本（不含自己），按书目顺序 */
export const twinsOf = (id: string): string[] => {
  const e = index.full.get(id);
  return e ? (index.twins.get(headKey(e.headword)) ?? []).filter((x) => x !== id) : [];
};
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
/** 这条关系是不是 AI 补写的 */
export const isAiLink = (a: string, b: string) => index.aiLinks.has(pairKey(a, b));

/** 导入后由 AI 批量补写、记在 auto 里的字段 */
const AUTO_AI = new Set(["keyline", "links"]);
/** 其中会出现在列表摘要里、需要单独处理的标量字段（links 走关系表） */
const AUTO_AI_FIELDS = new Set([...AUTO_AI].filter((f) => f !== "links"));

/** 原书词条里由 AI 补写的标量字段（列表/文章要藏掉的） */
export function aiFieldsOf(e: FullEntry): string[] {
  const known = index?.aiFields.get(e.id);
  if (known) return [...known];
  // 不在索引里的词条（后台预览等）没有 provenance，退回按数据里的标记粗算
  const out = new Set((e.auto ?? []).filter((f) => AUTO_AI_FIELDS.has(f)));
  if (e.patched?.origin.kind === "ai") for (const f of e.patched.fields) if (AUTO_AI_FIELDS.has(f)) out.add(f);
  return [...out];
}

/** 原书词条里被 AI 补写、用户又屏蔽了的内容（字段名 + links），给文章页“已隐藏什么”用 */
export function aiHiddenOf(e: FullEntry): string[] {
  if (e.origin) return [];
  const out = aiFieldsOf(e);
  if ((e.links ?? []).some((l) => isAiLink(e.id, l.id))) out.push("links");
  return out;
}

/**
 * 屏蔽 AI 内容时看到的原书词条：
 * - auto 里由 AI 批量补的 keyline 等字段去掉；
 * - 后台 AI 补写的字段：原书本来就有（且不是 AI 生成的）就换回原书内容，否则去掉；
 * - AI 补写的关系去掉，人工补写的关系保留；
 * - 整篇是 AI 整理的新词不在这里处理（列表里不出现，文章页另做拦截）。
 */
export function withoutAi(e: FullEntry): FullEntry {
  if (e.origin) return e;
  const fields = aiFieldsOf(e);
  const hiddenLinks = new Set((e.links ?? []).filter((l) => isAiLink(e.id, l.id)).map((l) => l.id));
  if (!fields.length && !hiddenLinks.size) return e;
  const orig = bookEntry(e.id) as Record<string, unknown> | undefined;
  const origAuto = new Set((orig?.auto as string[] | undefined) ?? []);
  const out: Record<string, unknown> = { ...e };
  for (const f of fields) {
    const patchedByAi = e.patched?.origin.kind === "ai" && e.patched.fields.includes(f);
    // 原书里这一项要是本来就有、而且不是 AI 生成的，才换回原书内容；否则整项去掉
    const restorable = patchedByAi && orig && f in orig && !(origAuto.has(f) && AUTO_AI.has(f));
    if (restorable) out[f] = orig![f];
    else delete out[f];
  }
  if (hiddenLinks.size) {
    const kept = (e.links ?? []).filter((l) => !hiddenLinks.has(l.id));
    if (kept.length) out.links = kept;
    else delete out.links;
  }
  if (e.patched?.origin.kind === "ai") delete out.patched;
  out.auto = (e.auto ?? []).filter((f) => !AUTO_AI.has(f));
  return out as FullEntry;
}

/** 按用户设置取词条：屏蔽 AI 内容时给 withoutAi 之后的样子（AI 新词原样返回，由调用方决定过滤/拦截） */
export const entryFor = (hideAi: boolean) => (id: string): FullEntry | undefined => {
  const e = index.full.get(id);
  return e && hideAi ? withoutAi(e) : e;
};

/** 列表摘要：屏蔽 AI 内容时 AI 整理的新词不出现，原书词条用 withoutAi 之后的样子 */
export function summaryFor(id: string, hideAi = false): Summary | undefined {
  const e = index.full.get(id);
  if (!e) return undefined;
  if (hideAi && e.origin?.kind === "ai") return undefined;
  return summarize(hideAi ? withoutAi(e) : e);
}

/** 历史（书架 / 阅读记录 / 收藏）摘要：读过的 AI 新词照常保留，原书词条的 AI 补写字段仍然藏掉 */
export function historySummaryFor(id: string, hideAi = false): Summary | undefined {
  const e = index.full.get(id);
  if (!e) return undefined;
  return summarize(hideAi && !e.origin ? withoutAi(e) : e);
}

/** 一本书按原书顺序的词条 id */
export const bookOrder = (book: string): string[] => index.order.get(book) ?? [];
/** 词条在原书里的位置：第几篇（从 0 数）、全书几篇 */
export function bookPos(id: string): { book: string; i: number; n: number } | undefined {
  const e = index.full.get(id);
  const i = index.pos.get(id);
  return e?.book && i !== undefined ? { book: e.book, i, n: index.order.get(e.book)?.length ?? 0 } : undefined;
}
/** 几本书都讲过的词：每组按书目顺序，组按词头字母；hideAi 时不算 AI 整理的新词 */
export const twinGroups = (hideAi = false): string[][] =>
  [...index.twins.values()]
    .map((ids) => (hideAi ? ids.filter((id) => index.full.get(id)?.origin?.kind !== "ai") : ids))
    .filter((ids) => ids.length > 1)
    .sort((a, b) => cmpHead(index.full.get(a[0]!)!.headword, index.full.get(b[0]!)!.headword));
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
  const ai = aiHiddenOf(e);
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
    ai: ai.length ? ai : undefined,
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

/** 全部词条摘要，按词头字母（只有一本书时按书中顺序）；hideAi 时去掉 AI 整理的新词和 AI 补写字段 */
export const allSummaries = (hideAi = false) =>
  index.all.flatMap((e) => {
    if (isRedirect(e)) return [summarize(e)];
    if (hideAi && e.origin?.kind === "ai") return [];
    return [summarize(hideAi ? withoutAi(e) : e)];
  });

const VAGUE_THEMES = new Set(["人名", "地名"]);

/** 同题材的其他词条，主题材相同的排前面；hideAi 时不算 AI 整理的新词、不算 AI 补写的字段 */
export function related(id: string, limit = 4, hideAi = false): Summary[] {
  const e = getEntry(id);
  if (!e) return [];
  const self = hideAi ? withoutAi(e) : e;
  const scored: { score: number; e: FullEntry }[] = [];
  for (const other of index.full.values()) {
    if (other.id === id) continue;
    if (hideAi && other.origin?.kind === "ai") continue;
    let score = 0;
    if (other.themes[0] === self.themes[0]) score += 2;
    if (self.subtheme && other.subtheme === self.subtheme) score += 2;
    score += other.themes.filter((t) => self.themes.includes(t) && !VAGUE_THEMES.has(t)).length;
    if (score) scored.push({ score, e: other });
  }
  return scored
    .sort((a, b) => b.score - a.score || (hashHex(id + a.e.id) < hashHex(id + b.e.id) ? -1 : 1))
    .slice(0, limit)
    .map((x) => summarize(hideAi ? withoutAi(x.e) : x.e));
}

/** 每个题材下的词条 id，按书中顺序；只返回有词条的题材；hideAi 时不算 AI 整理的新词 */
export function themeGroups(hideAi = false): { theme: string; ids: string[] }[] {
  return THEMES.map((theme) => ({
    theme,
    ids: [...index.full.values()]
      .filter((e) => (!hideAi || e.origin?.kind !== "ai") && e.themes.includes(theme))
      .map((e) => e.id),
  })).filter((g) => g.ids.length);
}

export type SearchHit = Summary & { snippet?: string };

export function search(q: string, limit = 50, hideAi = false): SearchHit[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const hits: { score: number; hit: SearchHit }[] = [];

  for (const e of index.all) {
    // 屏蔽 AI 内容的人：AI 整理的新词不搜出来；原书词条按去掉 AI 补写字段后的样子搜
    if (hideAi && !isRedirect(e) && e.origin?.kind === "ai") continue;
    const shown: RawEntry = hideAi && !isRedirect(e) ? withoutAi(e) : e;
    const head = shown.headword.toLowerCase();
    const names = [head, ...(isRedirect(shown) ? [] : [...(shown.variants ?? []), ...(shown.phrases ?? []).map((p) => p.replace(/\s+[\u3400-\u9fff].*$/, ""))].map((v) => v.toLowerCase()))];
    let score = 0;
    let snippet: string | undefined;

    if (names.some((n) => n === needle)) score = 100;
    else if (names.some((n) => n.startsWith(needle))) score = 80;
    else if (names.some((n) => n.includes(needle))) score = 60;

    if (!isRedirect(shown)) {
      if (!score && shown.meaning.toLowerCase().includes(needle)) score = 50;
      if (!score) {
        const body = [shown.keyline ?? "", ...shown.etymology, ...shown.examples.flatMap((x) => [x.en, x.zh])].map((p) =>
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
    if (score) hits.push({ score, hit: { ...summarize(shown), snippet } });
  }
  // 先按分数过滤再截断：hideAi 时 AI 新词的命中不会占掉名额
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((h) => h.hit);
}
