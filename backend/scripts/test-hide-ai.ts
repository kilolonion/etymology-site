// 「屏蔽 AI 内容」的回归测试：数据模型里 AI 补写的字段/关系，在 withoutAi、摘要、专题计数里都要正确隐藏，
// 尤其是「原书 auto 里本来就有的 AI 字段 + 后台又补写过」这种 provenance 容易算错的情况。
//
// 跑法：npm run test:hide-ai（只读 backend/data，不碰数据库，不启服务）

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  allSummaries, getEntry, isAiLink, loadEntries, rebuild, setOverlay, summaryFor, themeGroups, totalCount, withoutAi,
  type Overlay,
} from "../src/entries.ts";
import type { FullEntry, Link, Origin } from "../src/types.ts";

const ROOT = resolve(import.meta.dirname, "..");
const read = (f: string) => JSON.parse(readFileSync(resolve(ROOT, "data", f), "utf8")) as (Partial<FullEntry> & { id: string })[];
loadEntries(resolve(ROOT, "data/entries.json"));

let failed = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
};
const section = (name: string) => console.log(`\n${name}`);

const laili = read("laili.json");
const lishi = read("lishi.json");
const cidian = read("entries.json");
// 数据里挑真实样本：laili 几乎每条都有 AI 补的 keyline，少数几条有 AI 补的 links；cidian 的 keyline/teaser 是书里的
const keylineEntry = laili.find((e) => (e.auto ?? []).includes("keyline") && !(e.auto ?? []).includes("links"))!;
const linkEntry = laili.find((e) => (e.auto ?? []).includes("links"))!;
const manualLinkEntry = lishi.find((e) => (e.auto ?? []).includes("links"))!;
const bookEntry = cidian.find((e) => e.teaser && e.keyline)!;
const aiOrigin: Origin = { kind: "ai", model: "test", sources: [{ title: "test" }], doubts: [] };
const manualOrigin: Origin = { kind: "manual", via: "manual", sources: [], doubts: [] };
const base = (id: string) => getEntry(id)!;
const patch = (id: string, fields: Partial<FullEntry>, origin: Origin): Overlay => ({
  added: [], patches: new Map([[id, { fields, origin }]]), aiInDaily: false,
});
const reset = (overlay?: Overlay) => {
  setOverlay(() => overlay ?? { added: [], patches: new Map(), aiInDaily: false });
  rebuild();
};

// 1) 没补写：auto 里的 AI keyline / links 都要藏
section("原书 auto 里 AI 补写的字段 / 关系");
reset();
ok(withoutAi(base(keylineEntry.id)).keyline === undefined, `${keylineEntry.id}：AI keyline 被去掉`);
ok(isAiLink(linkEntry.id, (base(linkEntry.id).links ?? [])[0]!.id), `${linkEntry.id}：auto links 判为 AI 关系`);
ok((withoutAi(base(linkEntry.id)).links ?? []).length === 0, `${linkEntry.id}：AI 关系被去掉`);

// 2) AI 再补写 keyline：不能把数据文件里原来的 AI keyline 当“原书内容”恢复
section("AI 补写覆盖 auto 字段");
reset(patch(keylineEntry.id, { keyline: "【AI 后补】" }, aiOrigin));
ok(base(keylineEntry.id).keyline === "【AI 后补】", "补写后的 keyline 是新的 AI 内容");
ok(withoutAi(base(keylineEntry.id)).keyline === undefined, `${keylineEntry.id}：屏蔽后不会回退成数据文件里的 AI keyline`);
ok((withoutAi(base(keylineEntry.id)).auto ?? []).some((f) => f === "keyline") === false, "屏蔽后 auto 里不再标 keyline");

// 3) AI 追加 links：原书 auto 关系 + 追加的关系都要藏
section("AI 追加关系");
const addedLink: Link = { id: "alcohol", type: "同根", why: "AI 追加" };
reset(patch(linkEntry.id, { links: [addedLink] }, aiOrigin));
ok(isAiLink(linkEntry.id, (base(linkEntry.id).links ?? [])[0]!.id), "原书 auto 关系仍判为 AI");
ok(isAiLink(linkEntry.id, addedLink.id), "AI 追加的关系判为 AI");
ok((withoutAi(base(linkEntry.id)).links ?? []).length === 0, "屏蔽后两条关系都不出现");

// 4) 人工追加 links：原书 AI 关系藏掉，人工补的留着
section("人工补写关系");
const manualLink: Link = { id: "alcohol", type: "同根", why: "人工追加" };
reset(patch(manualLinkEntry.id, { links: [manualLink] }, manualOrigin));
ok(isAiLink(manualLinkEntry.id, (base(manualLinkEntry.id).links ?? [])[0]!.id), "原书 auto 关系仍判为 AI");
ok(!isAiLink(manualLinkEntry.id, manualLink.id), "人工追加的关系不算 AI");
ok((withoutAi(base(manualLinkEntry.id)).links ?? []).map((l) => l.id).join(",") === "alcohol", "屏蔽后只保留人工补的关系");

// 5) AI 补写 teaser：书里本来有钩子的，屏蔽时换回书里的
section("AI 补写书里已有的字段");
reset(patch(bookEntry.id, { teaser: "【AI 钩子】" }, aiOrigin));
ok((withoutAi(base(bookEntry.id)).teaser as string) === bookEntry.teaser, `${bookEntry.id}：屏蔽后 teaser 回退到书本内容`);

// 6) 摘要 / 专题 / 总数：AI 新词整篇不出现，原书词条用 withoutAi 后的样子
section("列表摘要与计数");
const aiEntry: FullEntry = {
  id: "zz-test-ai", headword: "zztestai", ipa: "ˈzuː", pos: "n.", meaning: "test", teaser: "test", keyline: "test",
  etymology: ["test"], examples: [], themes: ["商业与经济"], origin: aiOrigin,
};
reset({ added: [aiEntry], patches: new Map([[bookEntry.id, { fields: { teaser: "【AI 钩子】" }, origin: aiOrigin }]]), aiInDaily: false });
ok(summaryFor(aiEntry.id, true) === undefined, "屏蔽时 AI 新词没有摘要");
ok(summaryFor(aiEntry.id, false)?.id === aiEntry.id, "不屏蔽时 AI 新词有摘要");
ok(!allSummaries(true).some((s) => s.id === aiEntry.id), "屏蔽时列表里没有 AI 新词");
ok(totalCount(true) === totalCount(false) - 1, "屏蔽时总数少一个 AI 新词");
ok(!themeGroups(true).some((g) => g.ids.includes(aiEntry.id)), "屏蔽时专题计数不含 AI 新词");
ok((summaryFor(bookEntry.id, true)?.teaser as string) === bookEntry.teaser, "屏蔽时列表摘要用书本 teaser");
ok((summaryFor(keylineEntry.id, true)?.keyline ?? undefined) === undefined, "屏蔽时列表摘要没有 AI keyline");

reset();
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
