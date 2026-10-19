// MCP（Model Context Protocol）服务：让别的 AI 程序直接取写作上下文、查已有词条、校验并提交草稿。
// 走 Streamable HTTP 的无状态用法：每个 POST 是一条 JSON-RPC 消息，直接回 JSON，不开 SSE 流、不发会话号。
// 鉴权用后台“工具”页签生成的令牌（Authorization: Bearer ety_…），不认登录 Cookie。
// 令牌只能读和交草稿；发布、标记“已核对”只能由管理员在后台点。

import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { allow, type AppEnv } from "./auth.ts";
import {
  AuthoringError, checkDraft, contextForNew, contextForPatch, detailOf, guidelines, listAll, lookupWord, normalize, publicOrigin, save,
} from "./authoring.ts";
import * as db from "./db.ts";
import { allSummaries, getEntry, isBookId, kinOf, search } from "./entries.ts";

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER = { name: "etymology-daily", title: "词源一日", version: "1.0.0" };
const SCOPES = ["read", "draft"] as const;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const INSTRUCTIONS = `「词源一日」是一个中文的英语词源阅读网站。你可以帮编辑写新词条，或给原书词条补写关系等编辑字段。
推荐流程：check_headword 查重 → get_guidelines（带上要写的词）拿到写作规范和已有词条清单 → 写好后 validate_entry 自查 → submit_entry 存成草稿。
草稿要由管理员在后台核对、发布，读者才看得到；页面上会标明“AI 整理”，并列出你给的参考来源（_meta.sources）和存疑之处（_meta.doubts）。
不确定的事实不要编，写进 doubts。`;

type Token = NonNullable<ReturnType<typeof db.findToken>>;
type Tool = {
  name: string;
  title: string;
  description: string;
  scope: (typeof SCOPES)[number];
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  run: (args: Record<string, any>, t: Token) => unknown;
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const entryArg = {
  description: "词条对象（和后台导入的格式相同）。新词写 headword 等字段；给原书词条补写时写 patchOf 和要补的字段。都要带 _meta：{model, sources, doubts}",
  oneOf: [{ type: "object" }, { type: "string" }],
};
/** 有的客户端把对象当成字符串传 */
const asObject = (v: unknown) => {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      throw new AuthoringError("entry 不是有效的 JSON");
    }
  }
  return v;
};
const byName = (t: Token) => `${t.username}（MCP：${t.name}）`;

const TOOLS: Tool[] = [
  {
    name: "get_guidelines",
    title: "写作规范与上下文",
    description: "取写词条的完整上下文：输出格式、字段说明、写作要求、固定列表、示范，以及已有词条清单（写 links 用）。给 words 时针对这些新词；给 patch_ids 时是给这些原书词条补写 fields 指定的字段。都不给就只返回规范。",
    scope: "read",
    readOnly: true,
    inputSchema: obj({
      words: { type: "array", items: { type: "string" }, description: "要写的新词" },
      patch_ids: { type: "array", items: { type: "string" }, description: "要补写的原书词条 id" },
      fields: { type: "array", items: { type: "string", enum: ["teaser", "keyline", "evolution", "links", "era", "subtheme", "langs"] }, description: "补写哪些字段，默认 links" },
    }),
    run: (a) => {
      if (Array.isArray(a.patch_ids) && a.patch_ids.length) return contextForPatch(a.patch_ids.map(String).slice(0, 20), Array.isArray(a.fields) ? a.fields : []);
      if (Array.isArray(a.words) && a.words.length) return contextForNew(a.words.map(String).slice(0, 30));
      return guidelines();
    },
  },
  {
    name: "check_headword",
    title: "查重",
    description: "查这些词是否已经收录：entry = 已有词条，redirect = 是跳转词条，similar = 可能是已有词的变形，draft = 后台已经有稿子，new = 可以写。",
    scope: "read",
    readOnly: true,
    inputSchema: obj({ words: { type: "array", items: { type: "string" }, minItems: 1 } }, ["words"]),
    run: (a) => (Array.isArray(a.words) ? a.words : [a.words]).map(String).slice(0, 50).map(lookupWord),
  },
  {
    name: "search_entries",
    title: "搜索词条",
    description: "按词头、释义、正文搜索已有词条（找 links 的候选、参考写法）。",
    scope: "read",
    readOnly: true,
    inputSchema: obj({ query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["query"]),
    run: (a) => search(String(a.query ?? ""), Math.min(50, Number(a.limit) || 20)).map((h) => ({
      id: h.id, headword: h.headword, meaning: h.meaning, keyline: h.keyline, themes: h.themes, redirect: h.redirect, src: h.src ?? "book", snippet: h.snippet,
    })),
  },
  {
    name: "list_entries",
    title: "已有词条清单",
    description: "全部已有词条：id | 词头 | 释义 | 来源（book = 原书，ai / ai-ok / edit = 后台新增）。",
    scope: "read",
    readOnly: true,
    inputSchema: obj({}),
    run: () => allSummaries().filter((s) => !s.redirect).map((s) => `${s.id} | ${s.headword} | ${s.meaning ?? ""} | ${s.src ?? "book"}`).join("\n"),
  },
  {
    name: "get_entry",
    title: "读一个词条",
    description: "读一个已发布词条的全部内容，含来源信息和关系（同根 / 同典故 / 衍生，双向）。",
    scope: "read",
    readOnly: true,
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    run: (a) => {
      const e = getEntry(String(a.id));
      if (!e) throw new AuthoringError(`没有 ${a.id} 这个词条`);
      return {
        ...e,
        origin: publicOrigin(e.origin),
        patched: e.patched ? { fields: e.patched.fields, origin: publicOrigin(e.patched.origin) } : undefined,
        book: isBookId(e.id),
        kin: kinOf(e.id),
      };
    },
  },
  {
    name: "list_drafts",
    title: "草稿列表",
    description: "后台所有稿子（新词和补写）：状态、错误数、存疑数、读者报错数。",
    scope: "read",
    readOnly: true,
    inputSchema: obj({ status: { type: "string", enum: ["draft", "live", "changed", "archived", "merged"] } }),
    run: (a) => listAll().filter((d) => !a.status || d.status === a.status),
  },
  {
    name: "get_draft",
    title: "读一份稿子",
    description: "读一份稿子的当前内容、校验结果、读者报错和版本记录。",
    scope: "read",
    readOnly: true,
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    run: (a) => {
      const d = detailOf(String(a.id));
      if (!d) throw new AuthoringError(`没有 ${a.id} 这份稿子`);
      return d;
    },
  },
  {
    name: "list_reports",
    title: "读者报错",
    description: "读者报告的错误（默认只看没处理的），可以据此修改稿子再提交。",
    scope: "read",
    readOnly: true,
    inputSchema: obj({ all: { type: "boolean", description: "true 时包括已处理的" } }),
    run: (a) => db.listReports({ open: !a.all, limit: 100 }).map((r) => ({ id: r.id, entryId: r.entryId, headword: getEntry(r.entryId)?.headword ?? r.entryId, text: r.text, at: r.at, resolved: !!r.resolvedAt })),
  },
  {
    name: "validate_entry",
    title: "校验（不保存）",
    description: "按网站的规则校验一个词条，返回自动修正、错误和提醒，不保存。",
    scope: "read",
    readOnly: true,
    inputSchema: obj({ entry: entryArg }, ["entry"]),
    run: (a) => {
      const n = normalize(asObject(a.entry), "mcp");
      return { id: n.id, mode: n.mode, fixes: n.fixes, ...checkDraft(n.mode, n.id, n.entry, n.meta), normalized: { ...n.entry, _meta: n.meta } };
    },
  },
  {
    name: "submit_entry",
    title: "提交草稿",
    description: "把一个词条存成草稿（同 id 的会更新，并留历史版本）。有错误也会存，但改好才能发布。不会发布，发布由管理员在后台核对后操作。",
    scope: "draft",
    readOnly: false,
    inputSchema: obj({ entry: entryArg }, ["entry"]),
    run: (a, t) => {
      const n = normalize(asObject(a.entry), "mcp");
      const r = save(n, byName(t), "MCP 提交");
      if (r.saved) db.logAudit(t.userId, byName(t), "MCP 提交词条稿", `${n.mode === "patch" ? "补写 " : ""}${n.id}`);
      return { ...r, next: r.issues.errors.length ? "还有错误，改好后再提交一次" : "已存成草稿，等管理员核对发布" };
    },
  },
];

// ---------- JSON-RPC ----------

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };
const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function handle(msg: Rpc, t: Token) {
  const id = msg.id;
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(id, -32600, "Invalid Request");
  const tools = TOOLS.filter((x) => t.scopes.includes(x.scope));
  switch (msg.method) {
    case "initialize": {
      const want = msg.params?.protocolVersion;
      return ok(id, {
        protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: tools.map((x) => ({
          name: x.name,
          title: x.title,
          description: x.description,
          inputSchema: x.inputSchema,
          annotations: { title: x.title, readOnlyHint: x.readOnly, destructiveHint: false, idempotentHint: x.readOnly, openWorldHint: false },
        })),
      });
    case "tools/call": {
      const name = msg.params?.name;
      const tool = tools.find((x) => x.name === name);
      if (!tool) {
        const exists = TOOLS.some((x) => x.name === name);
        return fail(id, -32602, exists ? `令牌没有 ${name} 需要的权限` : `没有 ${name} 这个工具`);
      }
      try {
        const out = tool.run(msg.params?.arguments ?? {}, t);
        return ok(id, { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] });
      } catch (err) {
        // 出错也当成工具结果告诉模型（找不到、格式不对），让它自己改；不是预料中的错另外记日志
        if (!(err instanceof AuthoringError)) console.error("[mcp]", err);
        const text = err instanceof AuthoringError ? err.message : `出错了：${(err as Error).message}`;
        return ok(id, { content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${msg.method}`);
  }
}

export const mcp = new Hono();

function auth(c: Context): Token | Response {
  // 浏览器发来的跨站请求一律拒绝（防 DNS rebinding）；MCP 客户端一般不带 Origin
  const origin = c.req.header("origin");
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {}
    if (host !== c.req.header("host")) return c.json({ error: "不接受跨站请求" }, 403);
  }
  const m = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i);
  const t = m ? db.findToken(sha256(m[1]!)) : undefined;
  if (!t) {
    c.header("WWW-Authenticate", 'Bearer realm="etymology-daily", error="invalid_token"');
    return c.json({ error: "需要有效的令牌：后台 → 工具 → MCP 令牌" }, 401);
  }
  if (!allow(`mcp:${t.id}`, 120)) return c.json({ error: "请求太频繁，一分钟后再试" }, 429);
  db.touchToken(t.id);
  return t;
}

mcp.post("/", async (c) => {
  const t = auth(c);
  if (t instanceof Response) return t;
  let msg: unknown;
  try {
    msg = await c.req.json();
  } catch {
    return c.json(fail(null, -32700, "Parse error"), 400);
  }
  const list = Array.isArray(msg) ? (msg as Rpc[]) : [msg as Rpc];
  // 通知和客户端发来的响应没有 id，不用回
  const out = list.filter((m) => m && m.method && m.id !== undefined && m.id !== null).map((m) => handle(m, t));
  if (!out.length) return c.body(null, 202);
  return c.json(Array.isArray(msg) ? out : out[0]);
});

// 无状态：不提供服务器推送流，也没有会话可删
mcp.get("/", (c) => c.body(null, 405, { Allow: "POST" }));
mcp.delete("/", (c) => c.body(null, 405, { Allow: "POST" }));

// ---------- 后台：令牌管理（挂在 /api/admin/tokens，requireAdmin 在外面） ----------

export const tokensAdmin = new Hono<AppEnv>();

tokensAdmin.get("/", (c) => c.json({ tokens: db.listTokens(), scopes: SCOPES, tools: TOOLS.map((x) => ({ name: x.name, title: x.title, scope: x.scope })) }));

tokensAdmin.post("/", async (c) => {
  const { name = "", scopes = ["read", "draft"], days = 90 } = await c.req.json<{ name?: string; scopes?: string[]; days?: number }>().catch(() => ({}) as never);
  const n = String(name).trim().slice(0, 30);
  if (!n) return c.json({ error: "给令牌起个名字，比如“Claude Desktop”" }, 400);
  const sc = SCOPES.filter((s) => (Array.isArray(scopes) ? scopes : []).includes(s));
  if (!sc.length) return c.json({ error: "至少选一个权限" }, 400);
  if (sc.includes("draft") && !sc.includes("read")) sc.unshift("read");
  const d = Number(days);
  const expiresAt = d > 0 ? new Date(Date.now() + Math.min(d, 3650) * 86_400_000).toISOString() : null;
  const token = `ety_${randomBytes(24).toString("base64url")}`;
  const u = c.get("user");
  const id = db.createToken(n, sha256(token), u.id, sc, expiresAt);
  db.logAudit(u.id, u.username, "生成 MCP 令牌", `${n}（${sc.join("、")}${expiresAt ? `，${d} 天` : "，不过期"}）`);
  return c.json({ id, token, name: n, scopes: sc, expiresAt });
});

tokensAdmin.delete("/:id", (c) => {
  const u = c.get("user");
  const id = Number(c.req.param("id"));
  const ok = db.revokeToken(id);
  if (ok) db.logAudit(u.id, u.username, "吊销 MCP 令牌", `#${id}`);
  return c.json({ ok });
});
