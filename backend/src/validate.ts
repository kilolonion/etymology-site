// 词条校验规则（docs/DATA_FORMAT.md）。部署前校验 entries.json、后台导入、MCP 提交都用这一套。
// 每条只回中文提示（不带“#3 (alcohol)”这种位置前缀），由调用的地方自己拼。

import { AUTO_FIELDS, BASE_BOOK, LANGS, LINK_TYPES, ORIGIN_KINDS, SUBTHEMES, THEMES } from "./types.ts";

/** 第一本书和新增词：abet；其他书的词带书名后缀：abet--laili */
export const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*(--[a-z]+)?$/;
const FULL_FIELDS = ["pos", "meaning", "teaser", "etymology", "examples", "themes"];
/** 其他书（epub 导入）：没有页码，音标、词性、例句看书，有的没有；钩子等编辑字段由程序生成 */
const BOOK_FIELDS = ["teaser", "etymology", "themes"];
const themeSet = new Set<string>(THEMES);
const langSet = new Set<string>(LANGS);

export type Issues = { errors: string[]; warnings: string[] };

export type CheckCtx = {
  /** 这个 id 存不存在（links / seeAlso / redirect 指向用） */
  has: (id: string) => boolean;
  /** 一对关系有没有已经在别处记过（a、b 已排好序）；记过返回 true。没给就不查 */
  pairSeen?: (a: string, b: string) => boolean;
  /** 新增的词：没有页码，必须带 origin */
  added?: boolean;
};

const len = (s: string) => [...s].length;

/** 校验一个词条对象 */
export function checkEntry(e: Record<string, any>, ctx: CheckCtx): Issues {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof e !== "object" || e === null || Array.isArray(e)) return { errors: ["不是对象"], warnings };

  const other = typeof e.book === "string" && e.book !== BASE_BOOK;
  for (const k of other ? ["id", "headword"] : ["id", "headword", "ipa"]) if (!(k in e) || e[k] === "") errors.push(`缺少 ${k}`);
  if (e.id && !ID_RE.test(e.id)) errors.push("id 格式不对（只能 a-z0-9 和 -）");
  if (e.id && other && !String(e.id).endsWith(`--${e.book}`)) errors.push(`${e.book} 这本书的词条 id 要以 --${e.book} 结尾`);
  if (ctx.added || other) {
    if (e.page !== undefined && !Number.isInteger(e.page)) errors.push("page 必须是整数");
  } else if (!Number.isInteger(e.page)) errors.push(e.page === undefined ? "缺少 page" : "page 必须是整数");
  if (String(e.ipa ?? "").startsWith("/")) errors.push("ipa 不要带两侧斜杠");

  if ("redirect" in e) {
    if (!ctx.has(e.redirect)) warnings.push(`redirect 指向的 ${e.redirect} 不存在`);
    return { errors, warnings };
  }

  for (const k of other ? BOOK_FIELDS : FULL_FIELDS) {
    const v = e[k];
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) errors.push(`缺少或为空 ${k}`);
  }
  if (e.themes !== undefined && !Array.isArray(e.themes)) errors.push("themes 必须是数组");
  const themes: string[] = Array.isArray(e.themes) ? e.themes : [];
  for (const t of themes) if (!themeSet.has(t)) errors.push(`themes 不在固定列表里: ${t}`);
  if (themes.length > 3) warnings.push("themes 超过 3 个");
  // 有子专题的专题：词条得归进其中一个，且子专题要属于它所在的某个专题
  const subParents = themes.filter((t) => t in SUBTHEMES);
  if (e.subtheme !== undefined) {
    const ok = subParents.some((t) => SUBTHEMES[t as keyof typeof SUBTHEMES]!.includes(e.subtheme));
    if (!ok) errors.push(`subtheme「${e.subtheme}」不属于它的专题 ${themes.join("、")}`);
  } else if (subParents.length) {
    warnings.push(`属于「${subParents[0]}」，但没有 subtheme`);
  }
  if (e.links !== undefined && !Array.isArray(e.links)) errors.push("links 必须是数组");
  for (const l of Array.isArray(e.links) ? e.links : []) {
    if (!ctx.has(l?.id)) errors.push(`links 指向的 ${l?.id} 不存在`);
    else if (l.id === e.id) errors.push("links 不能指向自己");
    if (!(LINK_TYPES as readonly string[]).includes(l?.type)) errors.push(`links 的 type 只能是 ${LINK_TYPES.join("、")}`);
    if (!l?.why) errors.push(`links → ${l?.id} 缺少 why`);
    else if (len(l.why) > 30) warnings.push(`links → ${l.id} 的 why 超过 30 字`);
    if ((e.seeAlso ?? []).includes(l?.id)) warnings.push(`${l.id} 已经是参见，links 里不用再写`);
    if (ctx.pairSeen && l?.id) {
      const [a, b] = [e.id, l.id].sort() as [string, string];
      if (ctx.pairSeen(a, b)) errors.push(`和 ${l.id} 的关系重复记录了（一对只记一边）`);
    }
  }
  if (e.era !== undefined && (!Number.isInteger(e.era) || e.era === 0 || e.era < -40 || e.era > 21)) {
    errors.push("era 应为 -40…21 之间的非零整数（世纪，公元前为负）");
  }
  if (e.langs !== undefined && !Array.isArray(e.langs)) errors.push("langs 必须是数组");
  for (const l of Array.isArray(e.langs) ? e.langs : []) if (!langSet.has(l)) warnings.push(`langs 不在推荐列表里: ${l}`);
  if (e.teaser && len(e.teaser) > 40) warnings.push("teaser 超过 40 字");
  for (const k of ["phrases", "wordNotes", "auto"]) {
    if (e[k] !== undefined && (!Array.isArray(e[k]) || e[k].some((x: unknown) => typeof x !== "string"))) errors.push(`${k} 必须是字符串数组`);
  }
  for (const f of Array.isArray(e.auto) ? e.auto : []) if (!(AUTO_FIELDS as readonly string[]).includes(f)) errors.push(`auto 里不认识的字段: ${f}`);
  // 其他书的词条：一句话记住、词义演变书里没有，补写之前不算问题
  if (other) {
    if (e.keyline && len(e.keyline) > 40) warnings.push("keyline 超过 40 字");
  } else if (!e.keyline) warnings.push("缺少 keyline");
  else if (len(e.keyline) > 40) warnings.push("keyline 超过 40 字");
  if (!e.evolution) {
    if (!other) warnings.push("缺少 evolution");
  } else if (!Array.isArray(e.evolution) || e.evolution.length < 2 || e.evolution.length > 4) {
    errors.push("evolution 应为 2–4 个字符串");
  }
  if (e.etymology !== undefined && (!Array.isArray(e.etymology) || e.etymology.some((p: unknown) => typeof p !== "string"))) {
    errors.push("etymology 必须是字符串数组");
  }
  if (e.examples !== undefined && !Array.isArray(e.examples)) errors.push("examples 必须是数组");
  for (const ex of Array.isArray(e.examples) ? e.examples : []) if (!ex?.en || !ex?.zh) errors.push("例句需要 en 和 zh");

  const texts: string[] = [
    ...(Array.isArray(e.etymology) ? e.etymology : []),
    ...(Array.isArray(e.examples) ? e.examples : []).map((ex: any) => String(ex?.en ?? "")),
    ...(Array.isArray(e.evolution) ? e.evolution : []),
  ].filter((t) => typeof t === "string");
  for (const t of texts) {
    if ((t.match(/\*/g) ?? []).length % 2) errors.push(`斜体标记 * 不成对: ${t.slice(0, 30)}…`);
    if (t.includes('"') && /[一-鿿]/.test(t)) warnings.push("中文段落里出现 ASCII 双引号，应改为“”");
  }
  for (const ref of e.seeAlso ?? []) if (!ctx.has(ref)) warnings.push(`seeAlso 指向的 ${ref} 尚不存在`);

  if (ctx.added || e.origin !== undefined) {
    const o = checkOrigin(e.origin);
    errors.push(...o.errors);
    warnings.push(...o.warnings);
  }
  return { errors, warnings };
}

/** 来源信息：新增的词必须有；AI 生成的至少一条参考来源 */
export function checkOrigin(o: any): Issues {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!o || typeof o !== "object") return { errors: ["缺少 origin（来源信息）"], warnings };
  if (!(ORIGIN_KINDS as readonly string[]).includes(o.kind)) errors.push(`origin.kind 只能是 ${ORIGIN_KINDS.join("、")}`);
  if (!Array.isArray(o.sources)) errors.push("origin.sources 必须是数组");
  else {
    if (o.kind === "ai" && !o.sources.length) errors.push("AI 生成的内容至少要有一条参考来源（sources）");
    for (const s of o.sources) {
      if (!s?.title) errors.push("每条参考来源都要有 title");
      if (s?.url && !/^https?:\/\//.test(s.url)) errors.push(`参考来源的链接不对：${s.url}`);
    }
  }
  if (!Array.isArray(o.doubts)) errors.push("origin.doubts 必须是数组（没有存疑就写 []）");
  if (o.kind === "ai" && !o.model) warnings.push("没写是哪个模型生成的（model）");
  return { errors, warnings };
}

/** 校验整个 entries.json（部署前跑的那个） */
export function checkAll(entries: Record<string, any>[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const idSet = new Set(entries.map((e) => e?.id));
  const seen = new Set<string>();
  const pairs = new Set<string>();
  entries.forEach((e, i) => {
    const where = `#${i} (${e?.id ?? e?.headword ?? "?"})`;
    if (e?.id && seen.has(e.id)) errors.push(`${where}: id 重复`);
    seen.add(e?.id);
    const r = checkEntry(e, {
      has: (id) => idSet.has(id),
      // 文件里一对关系只记一边：按出现顺序，第二次见到同一对就算重复
      pairSeen: (a, b) => {
        const k = `${a}|${b}`;
        if (pairs.has(k)) return true;
        pairs.add(k);
        return false;
      },
      // 并回仓库的新增词带 origin、没有页码
      added: !!e?.origin,
    });
    errors.push(...r.errors.map((m) => `${where}: ${m}`));
    warnings.push(...r.warnings.map((m) => `${where}: ${m}`));
  });
  return { errors, warnings };
}
