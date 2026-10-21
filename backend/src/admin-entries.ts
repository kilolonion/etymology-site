// 管理后台 · 词条：查重、导出上下文、导入、编辑、发布 / 撤下、回滚、读者报错、导出已发布的新词。
// 挂在 /api/admin/entries 下（requireAdmin 已经在外面做了）。

import { Hono, type Context } from "hono";
import type { AppEnv } from "./auth.ts";
import {
  AuthoringError, contextForNew, contextForPatch, contextForPick, contextForRevise, contextForText, detailOf, exportAdded, importText,
  listAll, lookupWord, parseTargets, publish, remove, revisionData, rollback, STATUS_TEXT, unpublish, update, type CatalogMode,
} from "./authoring.ts";
import * as db from "./db.ts";
import { bookEntry, getEntry, isBookId, rebuild, search } from "./entries.ts";

export const entriesAdmin = new Hono<AppEnv>();

const who = (c: Context<AppEnv>) => c.get("user").username;
const log = (c: Context<AppEnv>, action: string, detail = "") => db.logAudit(c.get("user").id, who(c), action, detail);
const body = <T>(c: Context) => c.req.json<T>().catch(() => ({}) as T);
const words = (v: unknown) =>
  (Array.isArray(v) ? v : String(v ?? "").split(/[\n,，、;；]+/)).map((w) => String(w).trim()).filter(Boolean).slice(0, 30);

/** AuthoringError 是给人看的说明，其余的是 bug */
async function guard(c: Context, fn: () => unknown) {
  try {
    return c.json(await fn());
  } catch (err) {
    if (err instanceof AuthoringError) {
      return c.json({ error: (err as Error).message }, 400);
    }
    throw err;
  }
}

entriesAdmin.get("/", (c) => {
  const reports = db.listReports({ open: true });
  return c.json({
    drafts: listAll(),
    reports: reports.length,
    aiInDaily: db.getSetting("aiInDaily") === "1",
  });
});

/** 查重：每个词现在是什么状态 */
entriesAdmin.post("/lookup", async (c) => {
  const { words: w } = await body<{ words?: unknown }>(c);
  return c.json(parseTargets(w).map((t) => lookupWord(t.word)));
});

/** 原书词条联想（补写时挑词用） */
entriesAdmin.get("/book", (c) =>
  c.json(search(c.req.query("q") ?? "", 10).filter((h) => !h.redirect && isBookId(h.id)).map((h) => ({ id: h.id, headword: h.headword, meaning: h.meaning }))),
);

/**
 * 交给别的 AI 的上下文：new = 写指定的词（可带写作要求），pick = 让它按方向自己选词，text = 从一段英文里找词，
 * patch = 补写原书词条，revise = 修改一份稿子。catalog 是附多少已有词条（full / ids / near / none）
 */
entriesAdmin.post("/context", async (c) => {
  const { mode = "new", words: w, ids, fields, id, notes = "", catalog, count, theme, hint, taste, text } = await body<{
    mode?: string; words?: unknown; ids?: unknown; fields?: string[]; id?: string; notes?: string;
    catalog?: CatalogMode; count?: number; theme?: string; hint?: string; taste?: string; text?: string;
  }>(c);
  return guard(c, () => {
    if (mode === "revise") return { text: contextForRevise(String(id ?? ""), String(notes)) };
    if (mode === "patch") {
      const list = words(ids).filter((x) => bookEntry(x));
      if (!list.length) throw new AuthoringError("先挑几个原书词条");
      return { text: contextForPatch(list, Array.isArray(fields) ? fields : [], { catalog }) };
    }
    if (mode === "pick") return { text: contextForPick({ count, theme, hint, taste, catalog }) };
    if (mode === "text") return { text: contextForText({ text, count, catalog }) };
    const list = parseTargets(w);
    if (!list.length) throw new AuthoringError("先写几个要加的词");
    return { text: contextForNew(list, { catalog }) };
  });
});

/** 粘贴导入：每条单独存成草稿 */
entriesAdmin.post("/import", async (c) => {
  const { text = "" } = await body<{ text?: string }>(c);
  if (String(text).length > 400_000) return c.json({ error: "太长了，一次少导一些" }, 400);
  return guard(c, () => {
    const results = importText(String(text), who(c), "import");
    const saved = results.filter((r) => r.saved);
    if (saved.length) log(c, "导入词条", saved.map((r) => r.headword).join("、"));
    return { results };
  });
});

entriesAdmin.get("/reports", (c) =>
  c.json(db.listReports({ limit: 100 }).map((r) => {
    const e = getEntry(r.entryId);
    return { ...r, headword: e?.headword ?? r.entryId, book: isBookId(r.entryId), draft: !!db.getDraft(r.entryId) };
  })),
);

entriesAdmin.post("/reports/:rid/resolve", async (c) => {
  const { reopen = false } = await body<{ reopen?: boolean }>(c);
  const ok = db.resolveReport(Number(c.req.param("rid")), who(c), !!reopen);
  if (ok) log(c, reopen ? "重新打开报错" : "处理报错", `#${c.req.param("rid")}`);
  return c.json({ ok });
});

/** 已发布的新词，entries.json 格式，下载后并回仓库 */
entriesAdmin.get("/export", (c) => {
  const list = exportAdded();
  c.header("content-disposition", `attachment; filename="added-entries-${new Date().toISOString().slice(0, 10)}.json"`);
  return c.json(list);
});

entriesAdmin.put("/settings", async (c) => {
  const { aiInDaily } = await body<{ aiInDaily?: boolean }>(c);
  if (typeof aiInDaily === "boolean") {
    db.setSetting("aiInDaily", aiInDaily ? "1" : "0");
    rebuild();
    log(c, aiInDaily ? "核对过的新词进入每日推送" : "新词不进每日推送");
  }
  return c.json({ aiInDaily: db.getSetting("aiInDaily") === "1" });
});

// ----- 单份稿子 -----

entriesAdmin.get("/d/:id", (c) => {
  const d = detailOf(c.req.param("id"));
  return d ? c.json({ ...d, statusText: STATUS_TEXT[d.status] }) : c.json({ error: "没有这份稿子" }, 404);
});

entriesAdmin.put("/d/:id", async (c) => {
  const id = c.req.param("id");
  const data = await body<{ entry?: unknown; meta?: unknown }>(c);
  return guard(c, () => {
    const r = update(id, data, who(c));
    if (r.saved) log(c, "修改词条稿", id);
    return r;
  });
});

entriesAdmin.post("/d/:id/publish", async (c) => {
  const id = c.req.param("id");
  const { checked = false } = await body<{ checked?: boolean }>(c);
  return guard(c, () => {
    const status = publish(id, who(c), !!checked);
    log(c, "发布词条", `${id}${checked ? "（已核对）" : "（待核对）"}`);
    return { status };
  });
});

entriesAdmin.post("/d/:id/unpublish", (c) => {
  const id = c.req.param("id");
  return guard(c, () => {
    unpublish(id, who(c));
    log(c, "撤下词条", id);
    return { ok: true };
  });
});

entriesAdmin.post("/d/:id/rollback", async (c) => {
  const id = c.req.param("id");
  const { ver } = await body<{ ver?: number }>(c);
  return guard(c, () => {
    const d = rollback(id, Number(ver), who(c));
    log(c, "回滚词条稿", `${id} → 第 ${ver} 版`);
    return d;
  });
});

entriesAdmin.get("/d/:id/v/:ver", (c) => {
  const d = revisionData(c.req.param("id"), Number(c.req.param("ver")));
  return d ? c.json(d) : c.json({ error: "没有这一版" }, 404);
});

entriesAdmin.delete("/d/:id", (c) => {
  const id = c.req.param("id");
  return guard(c, () => {
    remove(id);
    log(c, "删除词条稿", id);
    return { ok: true };
  });
});
