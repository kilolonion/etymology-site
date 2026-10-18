// 多个页面共用的片段

import { actions, api, esc, icon, local, rich, toast } from "./lib.js";
import { enablePush, pushStatus } from "./push.js";
import { emblem, primaryTheme, tint } from "./themes.js";

export const starBtn = (e) =>
  `<button class="icon-btn star" data-action="star" data-id="${esc(e.id)}" aria-pressed="${!!e.starred}" aria-label="收藏">${icon("star")}</button>`;

export const sayBtn = (text, cls = "icon-btn") =>
  `<button class="${cls}" data-action="say" data-text="${esc(text)}" aria-label="朗读">${icon("sound")}</button>`;

/** 正文段落；传 used 就给书里有的词加词卡链接（见 words.js） */
export const prose = (paras, cls = "", used = null) =>
  `<div class="prose ${cls}">${paras.map((p) => `<p>${rich(p, { link: !!used, used: used ?? undefined })}</p>`).join("")}</div>`;

// ---------- 可折叠的区块：点标题收起 / 展开；有 key 的会记住你上次的选择 ----------

const FOLDS = "folds";
/** 手机上默认收起次要的区块，少翻几屏 */
export const isWide = () => matchMedia("(min-width: 760px)").matches;

export function fold(summary, body, { key = "", open = true, cls = "" } = {}) {
  const saved = key ? local.get(FOLDS, {})[key] : undefined;
  const isOpen = typeof saved === "boolean" ? saved : open;
  return `<details class="fold ${cls}"${key ? ` data-fold="${esc(key)}"` : ""}${isOpen ? " open" : ""}>
    <summary>${summary}<span class="fold-chev" aria-hidden="true">${icon("right")}</span></summary>
    <div class="fold-body">${body}</div>
  </details>`;
}

/** 区块标题（和 .kicker 一样的样式），放在 fold 的 summary 里 */
export const foldHead = (zh, en, meta = "") =>
  `<h3 class="kicker">${zh} <span class="en">${en}</span>${meta ? `<span class="meta">${meta}</span>` : ""}</h3>`;

// 用户点了标题之后记住开合（默认值随屏幕宽窄变，只有点过的才记）
document.addEventListener("click", (ev) => {
  const d = ev.target.closest?.("details[data-fold] > summary")?.parentElement;
  if (!d) return;
  setTimeout(() => {
    const all = local.get(FOLDS, {});
    all[d.dataset.fold] = d.open;
    local.set(FOLDS, all);
  });
});

/** 词源之路：首尾节点标“源”“今” */
export function route(e, used = null) {
  if (!e.evolution?.length) return "";
  const n = e.evolution.length;
  const label = (i) => (i === 0 ? "源" : i === n - 1 ? "今" : String(i));
  return fold(
    foldHead("词源之路", "The Journey", `${n} 站`),
    `<ol class="route">${e.evolution
      .map((s, i) => `<li><span class="node">${label(i)}</span><span class="txt">${rich(s, { link: !!used, used: used ?? undefined })}</span></li>`)
      .join("")}</ol>`,
    { key: "entry.route" },
  );
}

/** 一句话记住（大号引文） */
export const pull = (e, used = null) =>
  e.keyline ? `<blockquote class="pull">${rich(e.keyline, { link: !!used, used: used ?? undefined })}<small>一句话记住</small></blockquote>` : "";

/** 例句：默认显示前 show 条，其余折叠；例句里的英文词都能点（书里有的词带下划线） */
export function examples(e, show = 2, used = null) {
  const li = (x) => `<li>
    <p class="ex-en"><span>${used ? rich(x.en, { link: true, used, tap: true }) : rich(x.en)}</span>${sayBtn(x.en, "icon-btn sm")}</p>
    <p class="ex-zh">${esc(x.zh)}</p>
  </li>`;
  const head = e.examples.slice(0, show);
  const rest = e.examples.slice(show);
  return `<ol class="examples">${head.map(li).join("")}</ol>${
    rest.length
      ? `<details class="more-ex"><summary>再看 ${rest.length} 个例句</summary><ol class="examples">${rest.map(li).join("")}</ol></details>`
      : ""
  }`;
}

/** 相关词卡片：各自带专题色和纹章；读过的标“已读” */
export const linkCards = (items) =>
  `<div class="links">${items
    .map(
      (s) => `<a class="link-card" href="#/w/${esc(s.id)}" style="${tint(s)}">
        ${emblem(primaryTheme(s))}<b>${esc(s.headword)}</b><span>${esc(s.meaning)}</span>
        ${s.read ? `<i class="seen">已读</i>` : ""}
      </a>`,
    )
    .join("")}</div>`;

/** 词条关系的说法：“和 X 同根” */
const REL_PHRASE = { 同根: "同根", 同典故: "出自同一典故", 衍生: "一脉相承" };

/** 推荐理由，一句话说明“为什么是这个词” */
export function reasonText(r) {
  if (!r) return "";
  const w = (x) => `<em>${esc(x)}</em>`;
  switch (r.type) {
    case "link": return `和你读过的 ${w(r.word)} 互为参见`;
    case "kin": return `和你读过的 ${w(r.word)} ${REL_PHRASE[r.rel] ?? "有关"}`;
    case "theme": return `你读过的 ${w(r.word)} 也属于「${esc(r.theme)}」`;
    case "anchor":
      if (r.rel) return `和 ${w(r.word)} ${REL_PHRASE[r.rel] ?? "有关"}`;
      return r.theme ? `和 ${w(r.word)} 同属「${esc(r.theme)}」` : `${w(r.word)} 的参见词条`;
    case "taste": return `你收藏过「${esc(r.theme)}」的词`;
    case "new": return `新专题：${esc(r.theme)}`;
    default: return "";
  }
}

/** 读完之后顺势询问要不要每日提醒（已开启 / 不支持 / 关掉过就不显示） */
export async function reminderPrompt() {
  if (local.get("reminder-dismissed")) return "";
  const status = await pushStatus();
  if (status === "needs-install") {
    return `<section class="prompt">${icon("phone")}<div>
      <h3>想每天收到提醒？</h3>
      <p>iPhone 需要先把本站“添加到主屏幕”，从主屏幕打开后就能开启。</p>
      <div class="acts"><a class="btn sm" href="#/me/reminder">怎么添加</a><button class="btn sm ghost" data-action="push-dismiss">不用了</button></div>
    </div></section>`;
  }
  if (status !== "off") return "";
  const { time } = await api("/reminder");
  return `<section class="prompt">${icon("bell")}<div>
    <h3>每天 ${esc(time)} 提醒你？</h3>
    <p>到点推送当天的问题，读完了就不打扰。</p>
    <div class="acts"><button class="btn sm primary" data-action="push-enable">开启提醒</button><button class="btn sm ghost" data-action="push-dismiss">不用了</button></div>
  </div></section>`;
}

actions["push-enable"] = async (el) => {
  el.disabled = true;
  try {
    await enablePush();
    el.closest(".prompt")?.remove();
    toast("提醒已开启，发了一条测试通知");
  } catch (err) {
    el.disabled = false;
    toast(err.message);
  }
};

actions["push-dismiss"] = (el) => {
  local.set("reminder-dismissed", true);
  el.closest(".prompt")?.remove();
  toast("可以随时在“我的 → 每日提醒”里开启");
};

/** 词的亲缘：中间是这个词，四周是参见词和同根、同典故、衍生的词；下面逐条写出理由 */
const REL_ORDER = ["衍生", "同根", "同典故", "参见"];
const REL_EN = { 衍生: "Derived", 同根: "Same Root", 同典故: "Same Story", 参见: "See Also" };

export function family(e) {
  const nodes = [
    ...e.kin.map((k) => ({ ...k })),
    ...e.seeAlso.map((s) => ({ ...s, rel: "参见", why: "书中注明“参见”" })),
  ].sort((a, b) => REL_ORDER.indexOf(a.rel) - REL_ORDER.indexOf(b.rel));
  if (!nodes.length) return "";
  const shown = nodes.slice(0, 8);

  // 椭圆上均匀排开；从正上方开始，顺时针
  const W = 340, H = 220, cx = W / 2, cy = H / 2, rx = 122, ry = 78;
  const pillW = (t) => Math.min(150, t.length * 8.6 + 22);
  const pos = shown.map((_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / shown.length;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
  const pill = (x, y, text, cls) => {
    const w = pillW(text);
    return `<rect x="${x - w / 2}" y="${y - 14}" width="${w}" height="28" rx="14" class="${cls}"/><text x="${x}" y="${y + 5}">${esc(text)}</text>`;
  };
  // 视口只框住实际用到的上下范围，节点少时不留大片空白
  const ys = [cy, ...pos.map(([, y]) => y)];
  const top = Math.min(...ys) - 18, bottom = Math.max(...ys) + 18;
  const svg = `<svg class="kin-map" viewBox="0 ${top} ${W} ${bottom - top}" role="img" aria-label="${esc(e.headword)} 的亲缘词关系图">
    ${pos.map(([x, y], i) => `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="edge r-${REL_ORDER.indexOf(shown[i].rel)}"/>`).join("")}
    ${shown
      .map((n, i) => `<a href="#/w/${esc(n.id)}" class="kin-node${n.read ? " read" : ""}" style="${tint(n)}">${pill(pos[i][0], pos[i][1], n.headword, "pill")}</a>`)
      .join("")}
    <g class="kin-center">${pill(cx, cy, e.headword, "pill")}</g>
  </svg>`;

  const used = REL_ORDER.filter((r) => shown.some((n) => n.rel === r));
  const legend = `<p class="kin-legend">${used.map((r) => `<span><i class="r-${REL_ORDER.indexOf(r)}"></i>${r}</span>`).join("")}</p>`;
  const list = nodes
    .map((n) => `<a class="kin-row" href="#/w/${esc(n.id)}" style="${tint(n)}">
      <span class="rel r-${REL_ORDER.indexOf(n.rel)}">${n.rel}</span>
      <b>${esc(n.headword)}</b>
      <span class="why">${rich(n.why)}</span>
      ${n.read ? `<i class="seen">已读</i>` : ""}
    </a>`)
    .join("");
  return fold(
    foldHead("词的亲缘", used.length === 1 ? REL_EN[used[0]] : "Word Family", `${nodes.length} 个词`),
    `<figure class="kin">${svg}${legend}</figure>
    ${fold(`<span class="kin-more">逐条看关系</span>`, `<div class="kin-list">${list}</div>`, { key: "entry.kin-list", open: isWide(), cls: "sub" })}`,
    { key: "entry.kin" },
  );
}
