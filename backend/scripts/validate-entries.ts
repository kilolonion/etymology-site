// 校验词条数据是否符合 ../docs/DATA_FORMAT.md 的约定。规则在 src/validate.ts，后台导入和 MCP 提交也用它。
// 用法: node scripts/validate-entries.ts data/entries.json
// 同目录有 books.json 时，书目里的每本书一起校验（id 跨书不能重复，links 可以指向别的书）。
// 退出码: 0 = 无错误（可能有警告），1 = 有错误

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkAll } from "../src/validate.ts";
import { BASE_BOOK, type Book } from "../src/types.ts";

const path = process.argv[2] ?? "data/entries.json";
const registry = join(dirname(path), "books.json");

function readArray(file: string): Record<string, any>[] {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.log(`❌ ${file} JSON 解析失败: ${(err as Error).message}`);
    process.exit(1);
  }
  if (!Array.isArray(data)) {
    console.log(`❌ ${file} 顶层必须是数组`);
    process.exit(1);
  }
  return data as Record<string, any>[];
}

const books: Book[] = existsSync(registry) ? (readArray(registry) as Book[]) : [];
const parts: { name: string; entries: Record<string, any>[] }[] = [{ name: path, entries: readArray(path) }];
for (const b of books) {
  if (b.id === BASE_BOOK) continue;
  const file = join(dirname(path), b.file);
  if (!existsSync(file)) {
    console.log(`❌ 书目里的《${b.short}》找不到文件 ${file}`);
    process.exit(1);
  }
  const entries = readArray(file);
  const stray = entries.filter((e) => e?.book !== b.id).length;
  if (stray) console.log(`❌ ${file} 里有 ${stray} 条的 book 不是 ${b.id}`);
  parts.push({ name: file, entries });
}

const entries = parts.flatMap((p) => p.entries);
const { errors, warnings } = checkAll(entries);
for (const w of warnings) console.log(`⚠️  ${w}`);
for (const err of errors) console.log(`❌ ${err}`);
const full = entries.filter((e) => !("redirect" in e)).length;
console.log(
  `\n共 ${entries.length} 条（完整词条 ${full}，跳转 ${entries.length - full}）；` +
    (parts.length > 1 ? `${parts.map((p) => `${p.name.replace(/^.*\//, "")} ${p.entries.length}`).join("、")}；` : "") +
    `${errors.length} 个错误，${warnings.length} 个警告`,
);
process.exit(errors.length ? 1 : 0);
