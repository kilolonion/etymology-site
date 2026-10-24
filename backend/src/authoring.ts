// 后台加词：新词（mode=new）和给原书词条补写编辑字段（mode=patch）。
// 流程：查重 → 导出上下文交给别的 AI → 把它返回的 JSON 粘回来（或经 MCP 提交）→ 校验、存草稿 → 预览、核对 → 发布。
// 稿子存在数据库（var/app.db），部署不会覆盖；发布后叠加到原书数据上（见 entries.ts 的 rebuild）。

import * as db from "./db.ts";
import {
  allSummaries, bookEntry, books, findWord, getBook, getEntry, getRedirect, hasId, isBookId, kinOf, rebuild, search, setOverlay, type Overlay,
} from "./entries.ts";
import { LANGS, LINK_TYPES, PATCH_FIELDS, SUBTHEMES, THEMES, type FullEntry, type Origin, type Source } from "./types.ts";
import { checkEntry, checkOrigin, ID_RE, type Issues } from "./validate.ts";

export type Mode = "new" | "patch";
export type DraftData = { entry: Record<string, any>; meta: Origin };
export type Status = "draft" | "live" | "changed" | "archived" | "merged";

const parse = (s: string | null): DraftData | undefined => {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as DraftData;
  } catch {
    return undefined;
  }
};
const pickFields = (o: Record<string, any>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

// ---------- 叠加层 ----------

/** 已发布的稿子 → 叠加到原书数据上 */
export function overlay(): Overlay {
  const added: FullEntry[] = [];
  const patches: Overlay["patches"] = new Map();
  for (const r of db.liveDrafts()) {
    const d = parse(r.live);
    if (!d) continue;
    if (r.mode === "new") added.push({ ...(d.entry as FullEntry), origin: d.meta });
    else if (isBookId(r.id)) patches.set(r.id, { fields: pickFields(d.entry, PATCH_FIELDS) as Partial<FullEntry>, origin: d.meta });
  }
  return { added, patches, aiInDaily: db.getSetting("aiInDaily") === "1" };
}

/** 数据库打开以后、加载词条之前调用 */
export function initAuthoring(): void {
  setOverlay(overlay);
}

// ---------- id 与查重 ----------

/** 词头 → id：去重音、去撇号，空格和斜杠变 -（和 DATA_FORMAT.md 的规则一致） */
export const toId = (headword: string) =>
  headword.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/['’]/g, "").replace(/[\s/]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");

export type Lookup = {
  word: string;
  id: string;
  /** new：可以加；entry / redirect：已经有了；similar：可能是同一个词的变形，自己判断；draft：后台已经有稿子 */
  status: "new" | "entry" | "redirect" | "similar" | "draft";
  target?: { id: string; headword: string; meaning?: string; src?: string };
  draft?: { id: string; status: Status };
};

export function lookupWord(word: string): Lookup {
  const w = word.trim();
  const id = toId(w);
  const draftRow = id ? db.getDraft(id) : undefined;
  const draft = draftRow ? { id, status: statusOf(draftRow) } : undefined;
  const exact = getEntry(id);
  if (exact && !(draftRow?.mode === "new")) return { word: w, id, status: "entry", target: brief(exact), draft };
  const r = getRedirect(id);
  if (r) return { word: w, id, status: "redirect", target: { id: r.redirect, headword: getEntry(r.redirect)?.headword ?? r.redirect } };
  if (draftRow?.mode === "new") return { word: w, id, status: "draft", draft, target: exact ? brief(exact) : undefined };
  const near = findWord(w);
  if (near) return { word: w, id, status: "similar", target: brief(near), draft };
  return { word: w, id, status: "new", draft };
}

const brief = (e: FullEntry) => ({ id: e.id, headword: e.headword, meaning: e.meaning, src: e.origin ? (e.origin.checked ? "ai-ok" : "ai") : undefined });

// ---------- 导入：宽松地解析别的 AI 返回的东西 ----------

/**
 * 修 AI 常见的 JSON 毛病：字符串里没转义的 ASCII 引号（中文里写了 "这样"）、字符串里的原始换行、结尾多余的逗号。
 * 字符串里的引号：后面紧跟 , : } ] 或结尾的算收尾，其余的成对换成“”。
 */
export function repairJson(t: string): string {
  const after = /\s*(\S)/y;
  let out = "";
  let inStr = false;
  let inner = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (!inStr) {
      if (ch === '"') {
        inStr = true;
        inner = 0;
      }
      out += ch;
      continue;
    }
    if (ch === "\\") {
      out += ch + (t[i + 1] ?? "");
      i++;
    } else if (ch === '"') {
      after.lastIndex = i + 1;
      const next = after.exec(t)?.[1];
      if (next === undefined || ",:}]".includes(next)) {
        inStr = false;
        out += ch;
      } else out += inner++ % 2 === 0 ? "“" : "”";
    } else if (ch === "\n") out += "\\n";
    else if (ch !== "\r") out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** 从一段文本里取出 JSON：去掉 ``` 代码块、前后的说明文字；接受 {entries:[…]}、数组、单个对象。repaired：是不是修过 */
export function parseImport(text: string): { items: Record<string, any>[]; repaired: boolean } {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fence) t = fence[1]!.trim();
  const start = t.search(/[[{]/);
  if (start < 0) throw new AuthoringError("没找到 JSON");
  const open = t[start]!;
  t = t.slice(start, t.lastIndexOf(open === "{" ? "}" : "]") + 1);
  let data: unknown;
  let repaired = false;
  try {
    data = JSON.parse(t);
  } catch (err) {
    try {
      data = JSON.parse(repairJson(t));
      repaired = true;
    } catch {
      throw new AuthoringError(`JSON 解析失败：${(err as Error).message}`);
    }
  }
  const items = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? Array.isArray((data as any).entries) ? (data as any).entries : Array.isArray((data as any).patches) ? (data as any).patches : [data]
      : null;
  if (!items) throw new AuthoringError("JSON 里没有词条");
  return { items, repaired };
}

/** 新词可以有的字段 */
const NEW_FIELDS = [
  "id", "headword", "variants", "ipa", "pos", "meaning", "teaser", "keyline", "evolution", "etymology", "examples",
  "seeAlso", "links", "themes", "langs", "subtheme", "era", "page",
] as const;
const CJK = /[一-鿿]/;
/** 中文里的 ASCII 引号成对换成全角 */
const fixQuotes = (s: string) => (CJK.test(s) ? s.replace(/"([^"\n]*)"/g, "“$1”") : s);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : v);
const strList = (v: unknown) =>
  v === undefined ? undefined : (Array.isArray(v) ? v : [v]).map((x) => (typeof x === "string" ? x.trim() : x)).filter((x) => x !== "");

/** 来源信息：接受字符串、{title,url}、{name,url} */
function normMeta(raw: any, via: Origin["via"]): Origin {
  const m = raw && typeof raw === "object" ? raw : {};
  const sources: Source[] = (Array.isArray(m.sources) ? m.sources : m.sources ? [m.sources] : []).flatMap((s: any) => {
    if (typeof s === "string") return /^https?:\/\//.test(s.trim()) ? [{ title: s.trim(), url: s.trim() }] : s.trim() ? [{ title: s.trim() }] : [];
    if (s && typeof s === "object") {
      const title = String(s.title ?? s.name ?? s.url ?? "").trim();
      const url = typeof s.url === "string" && s.url.trim() ? s.url.trim() : undefined;
      return title ? [{ title, ...(url ? { url } : {}) }] : [];
    }
    return [];
  });
  const doubts = (Array.isArray(m.doubts) ? m.doubts : m.doubts ? [m.doubts] : []).map((d: unknown) => String(d).trim()).filter(Boolean);
  return {
    kind: m.kind === "manual" ? "manual" : "ai",
    ...(typeof m.model === "string" && m.model.trim() ? { model: m.model.trim().slice(0, 60) } : {}),
    via,
    sources,
    doubts,
    checked: null,
  };
}

export type Normalized = { mode: Mode; id: string; entry: Record<string, any>; meta: Origin; fixes: string[] };

/** 整理一条：补 id、去斜杠、换引号、丢掉不认识的字段；记下自动改了什么 */
export function normalize(raw: unknown, via: Origin["via"]): Normalized {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("不是一个对象");
  const { _meta, origin, patchOf, ...rest } = raw as Record<string, any>;
  const fixes: string[] = [];
  const meta = normMeta(_meta ?? origin, via);
  const mode: Mode = patchOf ? "patch" : "new";
  const allowed: readonly string[] = mode === "patch" ? PATCH_FIELDS : NEW_FIELDS;
  const dropped = Object.keys(rest).filter((k) => !allowed.includes(k) && !(mode === "patch" && k === "id"));
  if (dropped.length) fixes.push(mode === "patch" ? `原书词条只能补写 ${PATCH_FIELDS.join("、")}，忽略了 ${dropped.join("、")}` : `忽略了不认识的字段 ${dropped.join("、")}`);

  const e: Record<string, any> = {};
  for (const k of allowed) if (rest[k] !== undefined) e[k] = rest[k];
  for (const k of ["headword", "ipa", "pos", "meaning", "teaser", "keyline", "subtheme"]) if (e[k] !== undefined) e[k] = str(e[k]);
  for (const k of ["variants", "evolution", "etymology", "seeAlso", "themes", "langs"]) if (e[k] !== undefined) e[k] = strList(e[k]);
  if (typeof e.ipa === "string" && /^\/.*\/$|^\[.*\]$/.test(e.ipa)) {
    e.ipa = e.ipa.slice(1, -1).trim();
    fixes.push("去掉了音标两侧的斜杠");
  }
  if (typeof e.era === "string" && /^-?\d+$/.test(e.era.trim())) e.era = Number(e.era);
  if (e.page !== undefined && !Number.isInteger(e.page)) delete e.page;
  if (Array.isArray(e.examples)) e.examples = e.examples.map((x: any) => ({ en: str(x?.en) ?? "", zh: str(x?.zh) ?? "" }));
  if (Array.isArray(e.links)) e.links = e.links.map((l: any) => ({ id: str(l?.id), type: str(l?.type), why: str(l?.why) }));

  // 中文里的 ASCII 引号
  let quoted = false;
  const fix = (s: unknown) => {
    if (typeof s !== "string") return s;
    const t = fixQuotes(s);
    if (t !== s) quoted = true;
    return t;
  };
  for (const k of ["meaning", "teaser", "keyline"]) e[k] = fix(e[k]);
  for (const k of ["etymology", "evolution"]) if (Array.isArray(e[k])) e[k] = e[k].map(fix);
  if (Array.isArray(e.examples)) e.examples = e.examples.map((x: any) => ({ ...x, zh: fix(x.zh) }));
  if (Array.isArray(e.links)) e.links = e.links.map((l: any) => ({ ...l, why: fix(l.why) }));
  if (quoted) fixes.push("中文里的 ASCII 引号换成了“”");
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];

  let id: string;
  if (mode === "patch") {
    id = String(patchOf).trim();
  } else {
    id = typeof e.id === "string" && e.id.trim() ? e.id.trim() : toId(String(e.headword ?? ""));
    if (!e.id) fixes.push(`按词头生成了 id：${id}`);
    e.id = id;
  }
  if (mode === "new" && e.variants?.length === 0) delete e.variants;
  return { mode, id, entry: mode === "patch" ? e : orderKeys(e), meta, fixes };
}

/** 字段按 DATA_FORMAT.md 的顺序排，导出、对比时好看 */
const orderKeys = (e: Record<string, any>) => Object.fromEntries(NEW_FIELDS.filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));

// ---------- 校验 ----------

/** 一对关系是不是已经由对方记过了（一对只记一边） */
const otherSideHas = (self: string) => (a: string, b: string) => {
  const other = a === self ? b : a;
  return !!getEntry(other)?.links?.some((l) => l.id === self);
};

/** 补写后的样子：原书 + 补写字段（关系是追加） */
export function mergedPatch(id: string, fields: Record<string, any>): FullEntry | undefined {
  const b = bookEntry(id);
  if (!b) return undefined;
  const merged: FullEntry = { ...b, ...(pickFields(fields, PATCH_FIELDS) as Partial<FullEntry>) };
  if (Array.isArray(fields.links)) merged.links = [...(b.links ?? []), ...fields.links.filter((l: any) => !(b.links ?? []).some((x) => x.id === l?.id))];
  return merged;
}

export function checkDraft(mode: Mode, id: string, entry: Record<string, any>, meta: Origin): Issues {
  if (mode === "patch") {
    const errors: string[] = [];
    const warnings: string[] = [];
    const b = bookEntry(id);
    if (!b) return { errors: [`原书里没有 ${id} 这个词条，没法补写`], warnings };
    const fields = Object.keys(pickFields(entry, PATCH_FIELDS));
    if (!fields.length) errors.push(`没有补写任何字段（可以补 ${PATCH_FIELDS.join("、")}）`);
    for (const l of Array.isArray(entry.links) ? entry.links : []) {
      if ((b.links ?? []).some((x) => x.id === l?.id)) warnings.push(`原书数据里已经有和 ${l.id} 的关系，这条会被忽略`);
    }
    const r = checkEntry({ ...mergedPatch(id, entry), links: entry.links }, { has: hasId, pairSeen: otherSideHas(id) });
    const o = checkOrigin(meta);
    return { errors: [...errors, ...r.errors, ...o.errors], warnings: [...warnings, ...r.warnings, ...o.warnings] };
  }
  const r = checkEntry({ ...entry, origin: meta }, { has: (x) => hasId(x) || x === id, added: true, pairSeen: otherSideHas(id) });
  if (id && !ID_RE.test(id)) return r;
  if (isBookId(id)) r.errors.unshift(`原书里已经有 ${id} 这个词条了；要给它补内容请用“补写原书词条”`);
  else {
    const same = typeof entry.headword === "string" ? findWord(entry.headword) : undefined;
    if (same && same.id !== id) r.warnings.unshift(`和已有词条 ${same.headword}（${same.id}）可能是同一个词`);
  }
  return r;
}

// ---------- 稿子的状态 ----------

export function statusOf(r: db.DraftRow): Status {
  if (r.mode === "new" && isBookId(r.id)) return "merged";
  if (r.archived) return "archived";
  if (!r.live) return "draft";
  return r.live === r.data ? "live" : "changed";
}

export const STATUS_TEXT: Record<Status, string> = {
  draft: "草稿", live: "已发布", changed: "已发布 · 有未发布的修改", archived: "已撤下", merged: "已并入数据文件",
};

const headOf = (r: db.DraftRow, d?: DraftData) => (r.mode === "patch" ? bookEntry(r.id)?.headword ?? r.id : d?.entry.headword ?? r.id);

export function listAll() {
  const reports = db.openReportCounts();
  return db.listDrafts().map((r) => {
    const d = parse(r.data);
    const live = parse(r.live);
    const issues = d ? checkDraft(r.mode, r.id, d.entry, d.meta) : { errors: ["稿子损坏了"], warnings: [] };
    return {
      id: r.id,
      mode: r.mode,
      headword: headOf(r, d),
      meaning: r.mode === "patch" ? bookEntry(r.id)?.meaning ?? "" : String(d?.entry.meaning ?? ""),
      fields: r.mode === "patch" && d ? Object.keys(pickFields(d.entry, PATCH_FIELDS)) : undefined,
      status: statusOf(r),
      kind: (live ?? d)?.meta.kind ?? "ai",
      model: d?.meta.model ?? null,
      // 读者现在看到的那一版有没有核对过（工作稿一改就清掉，不算）
      checked: !!live?.meta.checked,
      errors: issues.errors.length,
      warnings: issues.warnings.length,
      doubts: d?.meta.doubts.length ?? 0,
      reports: reports.get(r.id) ?? 0,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
      // 建稿时间不随修改、发布变化，后台列表按它排，审完的稿子不会被顶到最前
      createdAt: r.created_at,
      createdBy: r.created_by,
      publishedAt: r.published_at,
    };
  });
}

export function detailOf(id: string) {
  const r = db.getDraft(id);
  if (!r) return undefined;
  const d = parse(r.data);
  const live = parse(r.live);
  return {
    id,
    mode: r.mode,
    headword: headOf(r, d),
    status: statusOf(r),
    data: d,
    live: live ?? null,
    issues: d ? checkDraft(r.mode, id, d.entry, d.meta) : { errors: ["稿子损坏了"], warnings: [] },
    // 补写时对照原书原来的样子
    book: r.mode === "patch" ? pickFields(bookEntry(id) ?? {}, ["headword", "meaning", ...PATCH_FIELDS]) : null,
    revisions: db.listRevisions(id).map(({ data, ...x }) => x),
    reports: db.listReports({ entryId: id }),
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
    publishedAt: r.published_at,
  };
}

/** 预览用：稿子现在的样子（新词是完整词条，补写是合并后的原书词条） */
export function previewEntry(id: string): FullEntry | undefined {
  const r = db.getDraft(id);
  const d = parse(r?.data ?? null);
  if (!r || !d) return undefined;
  if (r.mode === "patch") {
    const m = mergedPatch(id, d.entry);
    return m && { ...m, patched: { fields: Object.keys(pickFields(d.entry, PATCH_FIELDS)), origin: d.meta } };
  }
  return { ...(d.entry as FullEntry), id, origin: d.meta };
}

// ---------- 存稿、发布、撤下、回滚 ----------

export class AuthoringError extends Error {}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 存一条（导入、MCP、后台编辑都走这里）。内容有变化时清掉“已核对”。
 * 有错误也能存成草稿（发布时才拦），只有连 id 都没有的才不存。
 */
export function save(n: Normalized, by: string, note = ""): { id: string; saved: boolean; unchanged?: boolean; issues: Issues; fixes: string[]; status: Status } {
  if (!n.id || !ID_RE.test(n.id)) throw new AuthoringError(n.mode === "patch" ? "patchOf 不是有效的词条 id" : "没有词头，生成不了 id");
  const existing = db.getDraft(n.id);
  if (existing && existing.mode !== n.mode) {
    throw new AuthoringError(existing.mode === "new" ? `${n.id} 已经有一份新词稿了，不能再当补写` : `${n.id} 已经有一份补写稿了`);
  }
  if (n.mode === "new" && isBookId(n.id)) throw new AuthoringError(`原书里已经有 ${n.id}，要补内容请用 patchOf`);
  const issues = checkDraft(n.mode, n.id, n.entry, n.meta);
  const old = parse(existing?.data ?? null);
  if (old && same(old.entry, n.entry) && same({ ...old.meta, checked: null, via: null }, { ...n.meta, checked: null, via: null })) {
    return { id: n.id, saved: false, unchanged: true, issues, fixes: n.fixes, status: statusOf(existing!) };
  }
  const data: DraftData = { entry: n.entry, meta: { ...n.meta, checked: null } };
  db.saveDraft(n.id, n.mode, JSON.stringify(data), by, note);
  return { id: n.id, saved: true, issues, fixes: n.fixes, status: statusOf(db.getDraft(n.id)!) };
}

/** 把一段文本里的所有词条存成草稿；某一条出错不影响别的 */
export function importText(text: string, by: string, via: Origin["via"]) {
  const { items, repaired } = parseImport(text);
  return items.map((raw, i) => {
    try {
      const n = normalize(raw, via);
      if (repaired) n.fixes.unshift("JSON 有格式问题（字符串里没转义的引号、多余的逗号等），已自动修复");
      return { index: i, mode: n.mode, headword: n.mode === "patch" ? bookEntry(n.id)?.headword ?? n.id : n.entry.headword ?? "", ...save(n, by, via === "mcp" ? "MCP 提交" : "导入") };
    } catch (err) {
      return { index: i, headword: String((raw as any)?.headword ?? (raw as any)?.patchOf ?? `第 ${i + 1} 条`), saved: false, error: (err as Error).message };
    }
  });
}

/** 后台 JSON 编辑器保存：id 和类型不能改 */
export function update(id: string, data: { entry?: unknown; meta?: unknown }, by: string) {
  const r = db.getDraft(id);
  if (!r) throw new AuthoringError("没有这份稿子");
  const raw = { ...(data.entry as object), _meta: data.meta, ...(r.mode === "patch" ? { patchOf: id } : {}) };
  const n = normalize(raw, (data.meta as Origin | undefined)?.via ?? "manual");
  if (n.id !== id) throw new AuthoringError("不能改 id；要换 id 请另外新建");
  return save(n, by, "后台编辑");
}

export function publish(id: string, by: string, checked: boolean): Status {
  const r = db.getDraft(id);
  const d = parse(r?.data ?? null);
  if (!r || !d) throw new AuthoringError("没有这份稿子");
  if (statusOf(r) === "merged") throw new AuthoringError("这个词已经并入数据文件，以文件为准");
  const issues = checkDraft(r.mode, id, d.entry, d.meta);
  if (issues.errors.length) throw new AuthoringError(`还有 ${issues.errors.length} 个错误，改好才能发布：${issues.errors[0]}`);
  const data: DraftData = { entry: d.entry, meta: { ...d.meta, checked: checked ? { by, at: new Date().toISOString() } : null } };
  db.publishDraft(id, JSON.stringify(data), by);
  rebuild();
  return statusOf(db.getDraft(id)!);
}

export function unpublish(id: string, by: string): void {
  if (!db.getDraft(id)) throw new AuthoringError("没有这份稿子");
  db.unpublishDraft(id, by);
  rebuild();
}

/** 删除：发布中的要先撤下 */
export function remove(id: string): void {
  const r = db.getDraft(id);
  if (!r) throw new AuthoringError("没有这份稿子");
  if (r.live && !r.archived) throw new AuthoringError("这份稿子正在发布中，先撤下再删");
  db.deleteDraft(id);
}

/** 回滚：把某一版的内容存成新的工作稿（不自动发布） */
export function rollback(id: string, ver: number, by: string) {
  const r = db.getDraft(id);
  const rev = db.getRevision(id, ver);
  if (!r || !rev) throw new AuthoringError("没有这一版");
  db.saveDraft(id, r.mode, rev.data, by, `回滚到第 ${ver} 版`);
  return detailOf(id);
}

export function revisionData(id: string, ver: number): DraftData | undefined {
  return parse(db.getRevision(id, ver)?.data ?? null);
}

/** 已发布的新词，整理成 entries.json 的格式（并回仓库用） */
export function exportAdded(): FullEntry[] {
  return db.liveDrafts()
    .filter((r) => r.mode === "new" && !isBookId(r.id))
    .flatMap((r) => {
      const d = parse(r.live);
      return d ? [{ ...(d.entry as FullEntry), origin: d.meta }] : [];
    })
    .sort((a, b) => a.headword.localeCompare(b.headword, "en", { sensitivity: "base" }));
}

/** 给读者看的来源信息：不含核对人的名字 */
export function publicOrigin(o?: Origin | null) {
  if (!o) return null;
  return { kind: o.kind, model: o.model ?? null, sources: o.sources, doubts: o.doubts, checked: o.checked ? { at: o.checked.at } : null };
}

// ---------- 交给别的 AI 的上下文 ----------

const FIELD_GUIDE = `| 字段 | 说明 |
|---|---|
| headword | 词头，保持通行的大小写与写法 |
| id | 可省略，系统按词头生成（小写，空格变 -，去撇号） |
| variants | 其他拼法（可省略） |
| ipa | 英式音标，**不带两侧斜杠** |
| pos | 词性：n、v、adj、adv、n & v… |
| meaning | 中文释义，多个义项用全角分号；分隔 |
| teaser | 一句话钩子，≤ 40 字，制造好奇，**不剧透来历** |
| keyline | 读完后“记住这一句”，≤ 40 字，具体、有画面感，最好带关键原词 |
| evolution | 词义演变 2–4 步，从最早来源到今义，每步 ≤ 18 字 |
| etymology | 词源正文，按自然段拆成数组，2–5 段，每段 80–250 字 |
| examples | 例句 2–3 条，每条 {"en": "...", "zh": "..."}，英文里目标词用 *斜体* |
| themes | 题材 1–3 个，只能从下面的固定列表里选 |
| subtheme | 选了“风俗与生活”时必填一个子专题 |
| langs | 词源涉及的语言（从推荐列表选） |
| era | 故事起点的世纪：16 即 16 世纪，公元前为负；正文没提年代就不填 |
| links | 和已有词条的关系，见下方，宁缺毋滥 |
| _meta | 来源信息：{"model": "你的模型名", "sources": [{"title": "...", "url": "..."}], "doubts": ["..."]} |`;

const RULES = `- **用自己的话写**，不要大段照搬任何来源。读者是中文母语的英语学习者，语气像一篇有趣的小品文，不要百科腔。
- **每个事实都要有依据**：_meta.sources 至少 1 条，优先 Etymonline、OED、Merriam-Webster、Wiktionary、可靠的学术来源，附上链接。
- **拿不准的不要编**：首见年代、人名、传说的不同版本、民间词源（folk etymology）等，凡是来源之间有分歧或只有孤证的，正文里用“据说”“一说”等措辞，并把具体的疑点写进 _meta.doubts（每条一句话）。没有疑点就写 []。
- teaser 是入口，只抛出反差或悬念，不说答案；keyline 是结尾的一句话总结；evolution 第一步写最早的来源（原词用 *斜体*），最后一步写今义。
- 文本约定：外语原词、书名用 *...* 包起来；中文引号用“ ”‘ ’（全角），不要用 ASCII 的 "；中文与数字、英文之间留一个空格（14 世纪、1835 年）。
- links 只在确有关系时写：同根（来自同一个外语词或词根）、同典故（出自同一个人物或事件）、衍生（一个词的来历直接建立在另一个词上）。why ≤ 30 字，要具体、可核对。只能指向下方“已有词条”里的 id。
- 只输出一个 \`\`\`json 代码块，不要别的说明文字。`;

function lists(): string {
  const sub = Object.entries(SUBTHEMES).map(([t, s]) => `- ${t}：${s!.join("、")}`).join("\n");
  return `### themes（固定列表）\n${THEMES.join("、")}\n\n### subtheme\n${sub}\n\n### langs（推荐列表）\n${LANGS.join("、")}\n\n### links 的 type\n${LINK_TYPES.join("、")}`;
}

/** 示范：只给结构和编辑字段，正文只露开头 */
function example(): string {
  const e = getEntry("alcohol") ?? [...allSummaries()].map((s) => getEntry(s.id)).find((x) => x?.keyline);
  if (!e) return "";
  const sample = {
    headword: e.headword, ipa: e.ipa, pos: e.pos, meaning: e.meaning, teaser: e.teaser, keyline: e.keyline, evolution: e.evolution,
    etymology: [`${(e.etymology[0] ?? "").slice(0, 60)}……（正文，按段拆开）`],
    examples: e.examples.slice(0, 1), themes: e.themes, langs: e.langs, ...(e.era ? { era: e.era } : {}),
    _meta: { model: "（你的模型名）", sources: [{ title: "Online Etymology Dictionary: alcohol", url: "https://www.etymonline.com/word/alcohol" }], doubts: [] },
  };
  return `\`\`\`json\n${JSON.stringify(sample, null, 2)}\n\`\`\``;
}

/** 已有词条清单：id、词头、简短释义（写 links、避免重复用）；给了 ids 就只列这些 */
function catalog(ids?: string[]): string {
  const only = ids && new Set(ids);
  return allSummaries()
    .filter((s) => !s.redirect && (!only || only.has(s.id)))
    .map((s) => `${s.id} | ${s.headword} | ${String(s.meaning ?? "").split("；")[0]!.slice(0, 16)}`)
    .join("\n");
}

/**
 * 附在上下文末尾的已有词条清单，详略可选（全部清单有一万多字，只写一两个词时没必要全带）：
 * full = id | 词头 | 释义；ids = 只列 id；near = 只列和要写的词拼写、内容相近的；none = 不附，links 留空
 */
export const CATALOG_MODES = ["full", "ids", "near", "none"] as const;
export type CatalogMode = (typeof CATALOG_MODES)[number];
const catalogMode = (v: unknown, fallback: CatalogMode): CatalogMode => (CATALOG_MODES as readonly string[]).includes(String(v)) ? (v as CatalogMode) : fallback;

/** 和这些词可能有关的已有词条：正文里提到它们的、id 开头几个字母相同的（同根词常常这样） */
function nearby(words: string[], limit = 40): string[] {
  const ids = new Set<string>();
  const all = allSummaries().filter((s) => !s.redirect);
  for (const w of words) {
    for (const h of search(w, 10)) if (!h.redirect) ids.add(h.id);
    const stem = toId(w).replace(/[^a-z]/g, "").slice(0, 4);
    if (stem.length === 4) for (const s of all) if (s.id.includes(stem)) ids.add(s.id);
  }
  for (const w of words) ids.delete(toId(w)); // 要写的词自己不算
  return [...ids].slice(0, limit);
}

function catalogSection(mode: CatalogMode, words: string[] = []): string {
  if (mode === "none") return `## 已有词条\n\n这次不附已有词条清单：links 一律写 []。`;
  if (mode === "ids") {
    const ids = allSummaries().filter((s) => !s.redirect).map((s) => s.id);
    return `## 已有词条的 id（${ids.length} 个）\n\n写 links 时只能用这里的 id；这些词都已经收录了，不要再写。\n\n\`\`\`\n${ids.join(", ")}\n\`\`\``;
  }
  if (mode === "near") {
    const ids = nearby(words);
    if (!ids.length) return `## 已有词条\n\n没有找到和这些词相近的已有词条：links 写 []。`;
    return `## 可能相关的已有词条（id | 词头 | 释义）\n\n只列了和要写的词拼写或内容相近的 ${ids.length} 个。links 只能从这里选，没有确实的关系就写 []。\n\n\`\`\`\n${catalog(ids)}\n\`\`\``;
  }
  return `## 已有词条（id | 词头 | 释义），写 links 时只能用这里的 id\n\n\`\`\`\n${catalog()}\n\`\`\``;
}

const INTRO = () => `「词源一日」是一个中文的英语词源阅读网站，每天讲一个英语单词的来历。现有词条整理自几本词源书（${books().map((b) => `《${b.short}》`).join("、")}）；你写的词条不在书里，页面上会标明“AI 整理”，并列出你给的参考来源和存疑之处。`;

/** 要写的词，每个可以带一句写作要求 */
export type Target = { word: string; note?: string };

/**
 * 解析“每行一个词，后面可以跟备注”：serendipity：重点讲 Walpole 的信 / petrichor | 雨后的气味。
 * 没有备注的行可以用逗号隔开好几个词。传数组时每项是词或 {word, note}。
 */
export function parseTargets(v: unknown, limit = 30): Target[] {
  const out: Target[] = [];
  const push = (word: string, note = "") => {
    const w = word.trim();
    if (w && !out.some((t) => toId(t.word) === toId(w))) out.push(note.trim() ? { word: w, note: note.trim().slice(0, 200) } : { word: w });
  };
  if (Array.isArray(v)) {
    for (const x of v) typeof x === "string" ? push(x) : x && typeof x === "object" && push(String((x as any).word ?? ""), String((x as any).note ?? ""));
  } else {
    for (const line of String(v ?? "").split("\n")) {
      const m = line.match(/^\s*([^:：|]+?)\s*(?:[:：|]| - | — )\s*(\S.*)$/);
      if (m) push(m[1]!, m[2]!);
      else for (const w of line.split(/[,，、;；]+/)) push(w);
    }
  }
  return out.slice(0, limit);
}

/** 写作规范（MCP 的 get_guidelines 也返回这一段） */
export function guidelines(): string {
  return `## 输出格式

\`\`\`json
{ "format": "ety-entry/1", "entries": [ { "headword": "...", "ipa": "...", "pos": "...", "meaning": "...", "teaser": "...", "keyline": "...", "evolution": ["..."], "etymology": ["..."], "examples": [{ "en": "...", "zh": "..." }], "themes": ["..."], "langs": ["..."], "era": 19, "links": [{ "id": "已有词条 id", "type": "同根", "why": "..." }], "_meta": { "model": "...", "sources": [{ "title": "...", "url": "..." }], "doubts": ["..."] } } ] }
\`\`\`

## 字段

${FIELD_GUIDE}

## 写作要求

${RULES}

## 固定列表

${lists()}

## 示范（现有词条 alcohol 的结构）

${example()}`;
}

/** 指定词：要写的词（可带写作要求）+ 规范 + 已有词条清单 */
export function contextForNew(words: (string | Target)[], opts: { catalog?: CatalogMode } = {}): string {
  const items = parseTargets(words);
  const rows = items.map((t) => ({ ...lookupWord(t.word), note: t.note })).filter((l) => l.word);
  const todo = rows.filter((l) => l.status === "new" || l.status === "similar" || l.status === "draft");
  if (!todo.length) throw new AuthoringError("这些词都已经收录了");
  const noted = todo.some((l) => l.note);
  return `# 任务：为「词源一日」写 ${todo.length === 1 ? `新词条 ${todo[0]!.word}` : `${todo.length} 个新词条`}

${INTRO()}

## 要写的词

${todo.map((l) => `- **${l.word}**（id：${l.id}）${l.note ? `\n  编辑的要求：${l.note}` : ""}${l.status === "similar" ? `\n  注意：已有词条 ${l.target?.headword}，确认不是同一个词再写` : ""}`).join("\n")}
${noted ? "\n“编辑的要求”优先于下面的通用要求，但事实依据、格式规则照旧。\n" : ""}
${guidelines()}

${catalogSection(catalogMode(opts.catalog, "full"), todo.map((l) => l.word))}
`;
}

const TASTES: Record<string, string> = {
  common: "常用词优先：四六级、考研、雅思或日常阅读里常见，但来历少有人知的词",
  rare: "有故事的冷门词：不常见，但来历有趣、值得一讲",
  any: "不限常用还是冷门，来历有趣就行",
};

/** 让 AI 自己选词：给方向、数量、偏好 */
export function contextForPick(o: { count?: number; theme?: string; hint?: string; taste?: string; catalog?: CatalogMode }): string {
  const n = Math.min(Math.max(Math.round(Number(o.count) || 5), 1), 20);
  const theme = (THEMES as readonly string[]).includes(String(o.theme)) ? String(o.theme) : "";
  const hint = String(o.hint ?? "").trim().slice(0, 200);
  const mode = catalogMode(o.catalog, "ids");
  return `# 任务：为「词源一日」挑 ${n} 个值得讲的英语单词，写成词条

${INTRO()}

## 选词要求

- 数量：${n} 个
- 方向：${[theme && `专题“${theme}”`, hint].filter(Boolean).join("；") || "不限，挑来历有故事的词"}
- 偏好：${TASTES[String(o.taste)] ?? TASTES.common}
- 只挑**还没收录**的词${mode === "none" ? "（这次没附清单，系统导入时会查重，撞上已收录的会被退回）" : "：下面清单里的词都已经有了，同一个词的其他拼法、派生形式也算"}。
- 来历要有可靠来源支撑，说不清来历的词不要拿来凑数。
- 这 ${n} 个词尽量各不相同：不同语源、不同年代、不同类型的故事。
${theme ? `- themes 里要包含“${theme}”。\n` : ""}
${guidelines()}

${catalogSection(mode)}
`;
}

/** 从一段英文里找词 */
export function contextForText(o: { text?: string; count?: number; catalog?: CatalogMode }): string {
  const text = String(o.text ?? "").trim();
  if (!text) throw new AuthoringError("先粘一段英文");
  if (text.length > 8000) throw new AuthoringError("文章太长了，一次不超过 8000 字");
  const n = Math.min(Math.max(Math.round(Number(o.count) || 3), 1), 15);
  const mode = catalogMode(o.catalog, "ids");
  return `# 任务：从下面这段英文里挑 ${n} 个值得讲来历的词，写成「词源一日」的词条

${INTRO()}

## 选词要求

- 只从原文里出现的词里挑，词头用词典原形（复数、过去式等还原）。
- 挑读者看到会好奇的词：来历有故事、和今义反差大的。不要挑 the、and 这类功能词，也不要挑来历平平无奇的词。
- 只挑**还没收录**的词${mode === "none" ? "（这次没附清单，系统导入时会查重）" : "，下面清单里的都已经有了"}。不够 ${n} 个就少写几个，不要凑数。
- examples 的第一条用原文里含这个词的句子（太长可以截短），配上中文翻译；其余例句照常写。

## 原文

\`\`\`text
${text}
\`\`\`

${guidelines()}

${catalogSection(mode)}
`;
}

/** 补写原书词条：把原书内容给它看，只让它写指定的字段 */
export function contextForPatch(ids: string[], fields: string[], opts: { catalog?: CatalogMode } = {}): string {
  const fs = fields.filter((f) => (PATCH_FIELDS as readonly string[]).includes(f));
  const want = fs.length ? fs : ["links"];
  const items = ids.map((id) => bookEntry(id)).filter((e): e is FullEntry => !!e);
  const show = (e: FullEntry) => {
    const kin = kinOf(e.id).map((l) => `${l.id}（${l.type}）`).join("、");
    const auto = e.auto?.length ? `程序粗略生成、可以整个重写的字段：${e.auto.join("、")}\n` : "";
    return `### ${e.headword}（id：${e.id}，出自《${getBook(e.book)?.short ?? "原书"}》）\n\n\`\`\`json\n${JSON.stringify(pickFields(e, ["headword", "meaning", "phrases", "teaser", "keyline", "evolution", "etymology", "themes", "subtheme", "langs", "era", "links"]), null, 2)}\n\`\`\`\n${kin ? `已有关系：${kin}\n` : ""}${auto}`;
  };
  return `# 任务：给「词源一日」的 ${items.length} 个原书词条补写 ${want.join("、")}

这些词条的正文来自各自的原书（见每条的“出自”），**正文、释义、例句不能改**，只补写下面指定的字段。补写的内容在页面上会标明“AI 补充”。

## 要补写的字段：${want.join("、")}

${want.includes("links") ? "links 是**追加**：只写新发现的关系，已有关系不用重复。宁缺毋滥，没有确定的关系就写空数组。\n" : ""}
## 输出格式

\`\`\`json
{ "format": "ety-entry/1", "entries": [ { "patchOf": "词条 id", ${want.map((f) => `"${f}": ...`).join(", ")}, "_meta": { "model": "...", "sources": [{ "title": "...", "url": "..." }], "doubts": [] } } ] }
\`\`\`

## 写作要求

${RULES}

## 固定列表

${lists()}

## 要补写的词条

${items.map(show).join("\n")}

${catalogSection(catalogMode(opts.catalog, "full"), items.map((e) => e.headword))}
`;
}

/** 修改：当前稿子 + 校验问题 + 读者报错 + 管理员批注，让它改好整条返回 */
export function contextForRevise(id: string, notes: string): string {
  const d = detailOf(id);
  if (!d?.data) throw new AuthoringError("没有这份稿子");
  const reports = d.reports.filter((r) => !r.resolvedAt);
  const current = d.mode === "patch" ? { patchOf: id, ...d.data.entry, _meta: d.data.meta } : { ...d.data.entry, _meta: d.data.meta };
  delete (current._meta as any).checked;
  delete (current._meta as any).via;
  return `# 任务：修改「词源一日」的${d.mode === "patch" ? `原书词条 ${d.headword} 的补写内容` : `词条 ${d.headword}`}

改好后按同样的格式返回**整条**（不是只返回改动的部分），放在一个 \`\`\`json 代码块里。

## 当前内容

\`\`\`json
${JSON.stringify({ format: "ety-entry/1", entries: [current] }, null, 2)}
\`\`\`
${d.issues.errors.length || d.issues.warnings.length ? `\n## 校验发现的问题\n\n${[...d.issues.errors.map((x) => `- 错误：${x}`), ...d.issues.warnings.map((x) => `- 提醒：${x}`)].join("\n")}\n` : ""}${reports.length ? `\n## 读者报错\n\n${reports.map((r) => `- ${r.text}`).join("\n")}\n` : ""}${notes.trim() ? `\n## 编辑的修改意见\n\n${notes.trim()}\n` : ""}
${guidelines()}

## 已有词条（id | 词头 | 释义）

\`\`\`
${catalog()}
\`\`\`
`;
}
