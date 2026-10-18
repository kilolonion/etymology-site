// 校验 data/entries.json 是否符合 ../docs/DATA_FORMAT.md 的约定。
// 用法: node scripts/validate-entries.ts data/entries.json
// 退出码: 0 = 无错误（可能有警告），1 = 有错误

import { readFileSync } from "node:fs";
import { LANGS, LINK_TYPES, SUBTHEMES, THEMES } from "../src/types.ts";

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FULL_FIELDS = ["pos", "meaning", "teaser", "etymology", "examples", "themes"];
const themeSet = new Set<string>(THEMES);
const langSet = new Set<string>(LANGS);

const path = process.argv[2] ?? "data/entries.json";
const errors: string[] = [];
const warnings: string[] = [];

let data: unknown;
try {
  data = JSON.parse(readFileSync(path, "utf8"));
} catch (err) {
  console.log(`❌ JSON 解析失败: ${(err as Error).message}`);
  process.exit(1);
}
if (!Array.isArray(data)) {
  console.log("❌ 顶层必须是数组");
  process.exit(1);
}

const entries = data as Record<string, any>[];
const idSet = new Set(entries.map((e) => e?.id));
const seen = new Set<string>();
const linkPairs = new Set<string>();

entries.forEach((e, i) => {
  const where = `#${i} (${e?.id ?? e?.headword ?? "?"})`;
  if (typeof e !== "object" || e === null) {
    errors.push(`${where}: 不是对象`);
    return;
  }

  for (const k of ["id", "headword", "ipa", "page"]) {
    if (!(k in e)) errors.push(`${where}: 缺少 ${k}`);
  }
  if (e.id && !ID_RE.test(e.id)) errors.push(`${where}: id 格式不对（只能 a-z0-9 和 -）`);
  if (seen.has(e.id)) errors.push(`${where}: id 重复`);
  seen.add(e.id);
  if (!Number.isInteger(e.page)) errors.push(`${where}: page 必须是整数`);
  if (String(e.ipa ?? "").startsWith("/")) errors.push(`${where}: ipa 不要带两侧斜杠`);

  if ("redirect" in e) {
    if (!idSet.has(e.redirect)) warnings.push(`${where}: redirect 指向的 ${e.redirect} 不存在`);
    return;
  }

  for (const k of FULL_FIELDS) {
    const v = e[k];
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) {
      errors.push(`${where}: 缺少或为空 ${k}`);
    }
  }
  for (const t of e.themes ?? []) {
    if (!themeSet.has(t)) errors.push(`${where}: themes 不在固定列表里: ${t}`);
  }
  if ((e.themes ?? []).length > 3) warnings.push(`${where}: themes 超过 3 个`);
  // 有子专题的专题：词条得归进其中一个，且子专题要属于它所在的某个专题
  const subParents = (e.themes ?? []).filter((t: string) => t in SUBTHEMES);
  if (e.subtheme !== undefined) {
    const ok = subParents.some((t: string) => SUBTHEMES[t as keyof typeof SUBTHEMES]!.includes(e.subtheme));
    if (!ok) errors.push(`${where}: subtheme「${e.subtheme}」不属于它的专题 ${(e.themes ?? []).join("、")}`);
  } else if (subParents.length) {
    warnings.push(`${where}: 属于「${subParents[0]}」，但没有 subtheme`);
  }
  for (const l of e.links ?? []) {
    if (!idSet.has(l?.id)) errors.push(`${where}: links 指向的 ${l?.id} 不存在`);
    else if (l.id === e.id) errors.push(`${where}: links 不能指向自己`);
    if (!(LINK_TYPES as readonly string[]).includes(l?.type)) errors.push(`${where}: links 的 type 只能是 ${LINK_TYPES.join("、")}`);
    if (!l?.why) errors.push(`${where}: links → ${l?.id} 缺少 why`);
    else if ([...l.why].length > 30) warnings.push(`${where}: links → ${l.id} 的 why 超过 30 字`);
    if ((e.seeAlso ?? []).includes(l?.id)) warnings.push(`${where}: ${l.id} 已经是参见，links 里不用再写`);
    const key = [e.id, l?.id].sort().join("|");
    if (linkPairs.has(key)) errors.push(`${where}: 和 ${l?.id} 的关系重复记录了（一对只记一边）`);
    linkPairs.add(key);
  }
  if (e.era !== undefined && (!Number.isInteger(e.era) || e.era === 0 || e.era < -40 || e.era > 21)) {
    errors.push(`${where}: era 应为 -40…21 之间的非零整数（世纪，公元前为负）`);
  }
  for (const l of e.langs ?? []) {
    if (!langSet.has(l)) warnings.push(`${where}: langs 不在推荐列表里: ${l}`);
  }
  if (!e.keyline) warnings.push(`${where}: 缺少 keyline`);
  else if ([...e.keyline].length > 40) warnings.push(`${where}: keyline 超过 40 字`);
  if (!e.evolution) warnings.push(`${where}: 缺少 evolution`);
  else if (!Array.isArray(e.evolution) || e.evolution.length < 2 || e.evolution.length > 4) {
    errors.push(`${where}: evolution 应为 2–4 个字符串`);
  }
  if (!Array.isArray(e.etymology)) errors.push(`${where}: etymology 必须是字符串数组`);
  for (const ex of e.examples ?? []) {
    if (!ex?.en || !ex?.zh) errors.push(`${where}: 例句需要 en 和 zh`);
  }

  const texts: string[] = [
    ...(Array.isArray(e.etymology) ? e.etymology : []),
    ...(e.examples ?? []).map((ex: any) => ex?.en ?? ""),
    ...(Array.isArray(e.evolution) ? e.evolution : []),
  ];
  for (const t of texts) {
    if ((t.match(/\*/g) ?? []).length % 2) errors.push(`${where}: 斜体标记 * 不成对: ${t.slice(0, 30)}…`);
    if (t.includes('"') && /[一-鿿]/.test(t)) {
      warnings.push(`${where}: 中文段落里出现 ASCII 双引号，应改为“”`);
    }
  }
  for (const ref of e.seeAlso ?? []) {
    if (!idSet.has(ref)) warnings.push(`${where}: seeAlso 指向的 ${ref} 尚不存在`);
  }
});

for (const w of warnings) console.log(`⚠️  ${w}`);
for (const err of errors) console.log(`❌ ${err}`);
const full = entries.filter((e) => !("redirect" in e)).length;
console.log(
  `\n共 ${entries.length} 条（完整词条 ${full}，跳转 ${entries.length - full}）；` +
    `${errors.length} 个错误，${warnings.length} 个警告`,
);
process.exit(errors.length ? 1 : 0);
