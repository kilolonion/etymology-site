// 按书读：一本书的目录（原书顺序、按书里的字母章分组、读到哪了），以及同一个词几本书怎么讲的并排对照。
// 从目录、文章底部的上一篇 / 下一篇点进去的文章带 ?in=book，打开时把书签挪到那一篇。

import { api, esc, icon, render, rich } from "../lib.js?v=212dd6fbae";
import { fold, prose } from "../components.js?v=212dd6fbae";
import { tint } from "../themes.js?v=212dd6fbae";

const pctOf = (read, count) => (count ? Math.round((read / count) * 100) : 0);

// ---------- 一本书的目录 ----------

export async function viewBook(id) {
  const d = await api(`/books/${encodeURIComponent(id)}`, { fresh: true });
  const pct = pctOf(d.read, d.count);
  // 默认展开书签所在的那一章；没书签就展开第一章
  const openAt = d.next?.pos ?? 1;
  let n = 0;
  const chapters = d.chapters.map((c) => {
    const from = n + 1;
    n += c.items.length;
    return { ...c, from, read: c.items.filter((x) => x.read).length, open: openAt >= from && openAt <= n };
  });
  render(`
    <button class="back" data-action="back">${icon("left")}返回</button>
    <header class="book-head">
      <div class="bk-cover big" aria-hidden="true"><i>${esc(d.seal)}</i><small>${esc(d.short)}</small></div>
      <div>
        <h1>《${esc(d.title)}》</h1>
        <p class="bk-by">${esc([d.author, d.publisher, d.year].filter(Boolean).join(" · "))}</p>
        <div class="bk-prog big">
          <span class="bk-pct"><b>${pct}%</b>读过 ${d.read} / ${d.count} 篇</span>
          <div class="progress"><span style="width:${pct}%"></span></div>
        </div>
      </div>
    </header>
    ${d.intro ? `<p class="book-intro">${esc(d.intro)}</p>` : ""}
    ${d.next
      ? `<a class="book-go" href="#/w/${esc(d.next.id)}?in=book">
          <small>${d.next.resume ? "回到书签" : d.mark ? "接着往下读" : d.read ? "从第一篇没读的开始" : "从第一篇读起"} · 第 ${d.next.pos} / ${d.count} 篇</small>
          <b>${esc(d.next.headword)}</b>${icon("arrow")}</a>`
      : `<p class="book-done">${icon("check")}整本书都读完了。想重温，就从下面的目录里挑。</p>`}
    <div class="chapter-map" aria-label="各章读了多少">${chapters
      .map((c) => `<button data-action="jump" data-letter="${esc(c.letter)}" style="--p:${pctOf(c.read, c.items.length)}%" title="${esc(c.letter)}：读过 ${c.read} / ${c.items.length}">${esc(c.letter)}</button>`)
      .join("")}</div>
    ${chapters
      .map((c) =>
        fold(
          `<h2 class="group-letter" id="letter-${esc(c.letter)}">${esc(c.letter)}</h2><span class="group-meta">第 ${c.from}–${c.from + c.items.length - 1} 篇 · 读过 ${c.read} / ${c.items.length}</span>`,
          `<ol class="toc" start="${c.from}">${c.items.map((x) => tocRow(x, d)).join("")}</ol>`,
          { open: c.open, cls: "letter-group" },
        ),
      )
      .join("")}`);
  document.title = `${d.short} · 词源一日`;
}

function tocRow(x, d) {
  const here = d.next?.id === x.id;
  return `<li id="toc-${esc(x.id)}"><a class="toc-row${x.read ? " read" : ""}${here ? " here" : ""}" href="#/w/${esc(x.id)}?in=book" style="${tint(x)}">
    <span class="dot"></span>
    <b>${esc(x.headword)}</b>
    <span class="toc-m">${esc(x.meaning)}</span>
    <span class="toc-f">${here ? `<em>${d.next.resume ? "书签" : "下一篇"}</em>` : ""}${x.starred ? icon("star", "star-s") : ""}${x.read ? icon("check", "toc-ok") : ""}${d.pages && x.page ? `<small>p.${x.page}</small>` : ""}</span>
  </a></li>`;
}

// ---------- 几本书都讲过的词 ----------

export async function viewCompareList() {
  const list = await api("/compare");
  render(`
    <button class="back" data-action="back">${icon("left")}返回</button>
    <header class="page-head"><h1>对照读<span class="en">Side by Side</span></h1><p>${list.length} 个词几本书都讲过。同一个词，不同的作者挑的故事、讲的角度未必一样，点开并排看。</p></header>
    <label class="cmp-find">${icon("search")}<input type="search" placeholder="找一个词" aria-label="找一个词" data-cmp-find></label>
    <div class="cmp-list">${list.map(cmpRow).join("")}</div>`);
  document.title = "对照读 · 词源一日";
}

const cmpRow = (g) => `<a class="cmp-row" href="#/compare/${esc(g.id)}" data-head="${esc(g.headword.toLowerCase())}" style="${tint(g)}">
    <b>${esc(g.headword)}</b><span class="toc-m">${esc(g.meaning)}</span>
    <span class="cmp-seals">${g.books.map((b) => `<i class="${b.read ? "read" : ""}" title="${b.read ? "读过" : "没读过"}">${esc(b.seal)}</i>`).join("")}</span>
  </a>`;

document.addEventListener("input", (ev) => {
  const q = ev.target.matches?.("[data-cmp-find]") ? ev.target.value.trim().toLowerCase() : null;
  if (q === null) return;
  for (const r of document.querySelectorAll(".cmp-row")) r.hidden = !!q && !r.dataset.head.includes(q);
});

// ---------- 并排对照 ----------

export async function viewCompare(id) {
  const d = await api(`/compare/${encodeURIComponent(id)}`);
  const items = d.items;
  const cells = (f) => items.map((x) => `<div class="cmp-cell">${f(x) || `<span class="cmp-none">书里没写</span>`}</div>`).join("");
  const row = (label, f) => `<div class="cmp-label">${label}</div>${cells(f)}`;
  const ai = (x, f) => (x.auto.includes(f) ? `<sup class="ai-mark ai" title="由 AI 依据原文补写">AI</sup>` : "");
  render(`
    <button class="back" data-action="back">${icon("left")}返回</button>
    <header class="page-head"><h1>${esc(d.headword)}<span class="en">${items.length} 本书怎么讲</span></h1>
      <p>${items.length > 1 ? "按行对齐：释义、一句话记住、来历、例句。手机上左右滑动换一本。" : "只有一本书讲过这个词。"}</p></header>
    <div class="cmp-wrap"><div class="cmp-grid" style="--n:${items.length}">
      ${items
        .map(
          (x) => `<div class="cmp-top">
            <span class="cmp-seal">${esc(x.bookInfo?.seal ?? "")}</span>
            <span><b>《${esc(x.bookInfo?.short ?? "")}》</b><small>${esc(x.bookInfo?.author ?? "")}${x.bookInfo?.pages && x.page ? ` · 第 ${x.page} 页` : ""}</small></span>
            <a class="text-btn" href="#/w/${esc(x.id)}">${x.read ? "读过 · 再读" : "去读这篇"}${icon("right")}</a>
          </div>`,
        )
        .join("")}
      ${row("释义", (x) => [x.headword !== d.headword ? `<i class="cmp-hw">${esc(x.headword)}</i>` : "", x.pos ? `<em>${esc(x.pos)}.</em>` : "", esc(x.meaning)].filter(Boolean).join(" "))}
      ${row("一句话记住", (x) => (x.keyline ? `<p class="cmp-key">${rich(x.keyline)}${ai(x, "keyline")}</p>` : ""))}
      ${row("来历", (x) => prose(x.etymology))}
      ${row("例句", (x) => x.examples.map((e) => `<p class="cmp-ex"><span>${rich(e.en)}</span><small>${esc(e.zh)}</small></p>`).join(""))}
      ${row("语源 · 年代", (x) => [x.langs.join(" → "), x.era ? (x.era < 0 ? `公元前 ${-x.era} 世纪` : `${x.era} 世纪`) : ""].filter(Boolean).map(esc).join("<br>"))}
    </div></div>`);
  document.title = `${d.headword} · 对照读 · 词源一日`;
}
