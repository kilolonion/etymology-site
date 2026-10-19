// 校验 data/entries.json 是否符合 ../docs/DATA_FORMAT.md 的约定。规则在 src/validate.ts，后台导入和 MCP 提交也用它。
// 用法: node scripts/validate-entries.ts data/entries.json
// 退出码: 0 = 无错误（可能有警告），1 = 有错误

import { readFileSync } from "node:fs";
import { checkAll } from "../src/validate.ts";

const path = process.argv[2] ?? "data/entries.json";

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
const { errors, warnings } = checkAll(entries);
for (const w of warnings) console.log(`⚠️  ${w}`);
for (const err of errors) console.log(`❌ ${err}`);
const full = entries.filter((e) => !("redirect" in e)).length;
console.log(
  `\n共 ${entries.length} 条（完整词条 ${full}，跳转 ${entries.length - full}）；` +
    `${errors.length} 个错误，${warnings.length} 个警告`,
);
process.exit(errors.length ? 1 : 0);
