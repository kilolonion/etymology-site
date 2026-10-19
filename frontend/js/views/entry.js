// 文章页：一个词的完整故事（电脑上右侧是相关词和出处卡）。读到“一句话记住”、且停留几秒后才算读完，随手点开不算。
// 没读过的词，开头先猜一下它的来历里有哪种语言，读到“词源之路”揭晓；读完时就地展开收尾（连续天数、今日目标、名次、明日预告、再读一个）。
// 顶部一条进度，读到“一句话记住”正好走满；字号可以调。

import { examples, family, fold, foldHead, isWide, linkCards, prose, pull, reasonText, route, sayBtn, starBtn } from "../components.js";
import { actions, api, esc, icon, local, render, rich, toast, warmSpeech } from "../lib.js";
import { emblem, primaryTheme, themeTag, tint } from "../themes.js";
import { queueRead } from "../offline.js";
import { invalidateSummaries } from "./explore.js";
import { setWordIndex } from "../words.js";

/** 至少停留这么久，读到结尾才记为已读 */
const MIN_DWELL = 8000;
let unwatch = null;
/** 这一篇挂在 window 上的监听（进度条、揭晓），换篇或离开时一起拆掉 */
let page = null;
/** 正在看的这篇（读完收尾时要用它的单词和“接着读”） */
let current = null;

/** 字号三档，记在这台设备上 */
const FONT_SCALES = [1, 1.12, 1.25];
const fontScale = () => FONT_SCALES[local.get("font-scale", 0)] ?? 1;

/** 正文大约要读几分钟（中文按每分钟 400 字算） */
export const readMinutes = (e) => Math.max(1, Math.round([...(e.etymology ?? []), ...(e.evolution ?? []), e.keyline ?? ""].join("").length / 400));

export async function viewEntry(id) {
  unwatch?.();
  page?.abort();
  page = new AbortController();
  const sig = page.signal;
  // 词条目录用来给正文里的词加词卡链接；拿不到也不耽误看文章
  const [e, all] = await Promise.all([api(`/entries/${encodeURIComponent(id)}`), api("/entries").catch(() => null)]);
  if (all) indexWords(all);
  if (e.redirect) {
    location.replace(`#/w/${e.redirect}`);
    return;
  }

  current = e;
  const theme = primaryTheme(e);
  // 相关的词：同专题的词；参见和有关系的词已经在“词的亲缘”里，“接着读”里有的也不重复
  const shownIds = new Set([...e.upNext, ...e.seeAlso, ...e.kin].map((x) => x.id));
  const more = e.related.filter((x) => !shownIds.has(x.id)).slice(0, 4);
  // 这一篇里已经加过词卡链接的词条，每个词只链第一次；自己不链
  const used = new Set([e.id]);

  render(`
    <article style="${tint(e)};--fs:${fontScale()}">
      <div class="read-progress" aria-hidden="true"><span></span></div>
      <header class="hero">
        ${emblem(theme)}
        <div class="hero-bar">
          <button class="back" data-action="back">${icon("left")}返回</button>
          <span class="hero-acts"><span class="mins">约 ${readMinutes(e)} 分钟</span><button class="icon-btn fs-btn" data-action="font-size" aria-label="调整字号">Aa</button>${starBtn(e)}</span>
        </div>
        ${themeTag(theme)}
        <h1>${esc(e.headword)}</h1>
        ${e.variants?.length ? `<p class="variants">亦作 ${e.variants.map(esc).join(", ")}</p>` : ""}
        <div class="phon">${sayBtn(e.headword)}<span class="ipa">/${esc(e.ipa)}/</span><span class="pos">${esc(e.pos)}</span></div>
        <p class="meaning">${esc(e.meaning)}</p>
        <p class="teaser">${rich(e.teaser, { link: true, used })}</p>
        ${guessBlock(e)}
      </header>

      <div class="article-body">
        <h3 class="kicker">词源 <span class="en">The Story</span></h3>
        ${prose(e.etymology, "dropcap", used)}
        <div class="guess-reveal" hidden></div>
        ${route(e, used)}
        ${pull(e, used)}
        <div class="read-mark" aria-hidden="true"></div>

        ${fold(foldHead("例句", "In Use", `${e.examples.length} 句`), examples(e, 2, used), { key: "entry.examples" })}

        ${family(e)}

        <aside class="article-side">
          ${more.length ? fold(foldHead("相关的词", "Related", `${more.length} 个`), linkCards(more), { key: "entry.related", open: isWide() }) : ""}

          <section class="catalog" aria-label="出处">
            <div class="r"><span>出处</span><span>《英语词源典故词典》第 ${e.page} 页</span></div>
            <div class="r"><span>专题</span><span>${e.themes.map(esc).join("、")}</span></div>
            ${e.langs?.length ? `<div class="r"><span>语源</span><span>${e.langs.map(esc).join(" · ")}</span></div>` : ""}
            <div class="r"><span>阅读</span><span class="read-state ${e.read ? "ok" : ""}">${e.read ? "已读" : "读到“一句话记住”就算读完"}</span></div>
            <div class="acts"><button class="text-btn" data-action="toggle-read" data-id="${esc(e.id)}" data-read="${e.read}">${e.read ? "标为未读" : "标为已读"}</button></div>
          </section>
        </aside>

        ${e.upNext.length ? `<h3 class="kicker">接着读 <span class="en">Up Next</span></h3><div class="upnext">${e.upNext.map(nextCard).join("")}</div>` : ""}

        <footer class="finis">
          <span class="fleuron" aria-hidden="true">${emblem(theme)}</span>
          <p>${esc(e.headword)} 的故事就到这里</p>
          <div class="acts">
            <a class="btn sm" href="#/">${icon("today")}回到今日</a>
            <a class="btn sm ghost" href="#/explore/t/${encodeURIComponent(theme)}">更多「${esc(theme)}」</a>
          </div>
        </footer>
      </div>
    </article>`);
  document.title = `${e.headword} · 词源一日`;

  warmSpeech(e.headword);
  if (!e.read) watchReading(e);
  watchProgress(sig);
  watchReveal(e, sig);
  addEventListener("hashchange", () => page?.abort(), { signal: sig, once: true });
}

// ---------- 读前先猜：它的来历里有哪种语言 ----------

const LANGS = ["拉丁语", "希腊语", "古英语", "法语", "古法语", "意大利语", "西班牙语", "德语", "荷兰语", "古诺尔斯语", "阿拉伯语", "美国英语"];
const hashOf = (s) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
const guessKey = (id) => `guess:${id}`;

/** 一个出现在它来历里的语言 + 两个没出现的，顺序按词固定 */
function guessOptions(e) {
  const real = (e.langs ?? []).filter((l) => l !== "其他");
  if (!real.length) return null;
  const h = hashOf(e.id);
  const answer = real[h % real.length];
  const wrong = LANGS.filter((l) => !real.includes(l)).sort((a, b) => hashOf(e.id + a) - hashOf(e.id + b)).slice(0, 2);
  return { answer, real, opts: [answer, ...wrong].sort((a, b) => hashOf(a + e.id) - hashOf(b + e.id)) };
}

function guessBlock(e) {
  const g = guessOptions(e);
  if (e.read || !g) return "";
  const saved = local.get(guessKey(e.id), null);
  return `<div class="guess" data-id="${esc(e.id)}">
    <p class="g-q">读之前先猜：下面哪种语言在它的来历里出现过？</p>
    <div class="g-opts">${g.opts.map((o) => `<button data-action="guess" data-lang="${esc(o)}" aria-pressed="${saved === o}">${esc(o)}</button>`).join("")}</div>
    <p class="g-note">${saved ? `你猜的是「${esc(saved)}」，读到“词源之路”揭晓` : "选一个再往下读，读到“词源之路”揭晓"}</p>
  </div>`;
}

actions.guess = (el) => {
  const box = el.closest(".guess");
  local.set(guessKey(box.dataset.id), el.dataset.lang);
  for (const b of box.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === el));
  box.querySelector(".g-note").textContent = `你猜的是「${el.dataset.lang}」，读到“词源之路”揭晓`;
};

/** 读到词源之路时揭晓：猜过的才揭晓（没猜就先不揭晓，回头猜了再读下来照样揭晓），揭晓一次就不再猜 */
function watchReveal(e, signal) {
  const box = document.querySelector(".guess-reveal");
  const g = guessOptions(e);
  if (!box || !g || !document.querySelector(".guess")) return;
  const io = new IntersectionObserver((list) => {
    if (!list.some((x) => x.isIntersecting)) return;
    const saved = local.get(guessKey(e.id), null);
    if (!saved) return;
    io.disconnect();
    const ok = g.real.includes(saved);
    const path = [...g.real, ...(g.real.at(-1) === "美国英语" ? [] : ["英语"])].map((l) => `<span${l === saved ? ` class="hit"` : ""}>${esc(l)}</span>`).join(icon("right"));
    box.innerHTML = `<p class="gr-head ${ok ? "ok" : "no"}">${icon(ok ? "check" : "close")}${ok ? `猜对了，它的来历里有${esc(saved)}` : `没猜中，${esc(saved)}不在它的来历里`}</p><p class="gr-path">${path}</p>`;
    box.hidden = false;
    box.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: "ease-out" });
    local.set(guessKey(e.id), null);
  }, { rootMargin: "0px 0px -30% 0px" });
  io.observe(box.nextElementSibling ?? box);
  signal.addEventListener("abort", () => io.disconnect());
}

// ---------- 进度条、字号 ----------

/** 顶部进度：从文章开头到“一句话记住”（记为读完的地方）走满 */
function watchProgress(signal) {
  const bar = document.querySelector(".read-progress span");
  const mark = document.querySelector(".read-mark");
  if (!bar || !mark) return;
  const update = () => {
    const end = mark.getBoundingClientRect().top + scrollY - innerHeight * 0.85;
    bar.style.transform = `scaleX(${end <= 0 ? 1 : Math.min(1, Math.max(0, scrollY / end))})`;
  };
  addEventListener("scroll", update, { passive: true, signal });
  addEventListener("resize", update, { signal });
  update();
}

actions["font-size"] = () => {
  const next = (Number(local.get("font-scale", 0)) + 1) % FONT_SCALES.length;
  local.set("font-scale", next);
  document.querySelector("article")?.style.setProperty("--fs", FONT_SCALES[next]);
  toast(["字号：标准", "字号：大", "字号：特大"][next]);
}

/** 目录没变就不重建索引 */
let indexed = null;
function indexWords(all) {
  if (all === indexed) return;
  indexed = all;
  setWordIndex(all);
}

function nextCard(x) {
  return `<a class="next-card" href="#/w/${esc(x.id)}" style="${tint(x)}">
    ${emblem(primaryTheme(x))}
    <span class="why">${reasonText(x.reason) || esc(primaryTheme(x))}</span>
    <p class="q">${rich(x.teaser)}</p>
    <span class="w"><b>${esc(x.headword)}</b>${icon("arrow")}</span>
  </a>`;
}

/** 读到结尾标记（且停留够久）时记为已读；中途离开这篇就不记 */
function watchReading(e) {
  const opened = Date.now();
  const here = `#/w/${e.id}`;
  const mark = document.querySelector(".read-mark");
  if (!mark) return;
  const check = () => {
    if (location.hash.split("?")[0] !== here) return stop();
    if (mark.getBoundingClientRect().top > innerHeight) return;
    stop();
    setTimeout(() => {
      if (location.hash.split("?")[0] === here) setRead(e.id, true, { quiet: false });
    }, Math.max(0, MIN_DWELL - (Date.now() - opened)));
  };
  const stop = () => {
    removeEventListener("scroll", check);
    removeEventListener("resize", check);
    unwatch = null;
  };
  addEventListener("scroll", check, { passive: true });
  addEventListener("resize", check);
  unwatch = stop;
  check(); // 短文章在大屏上一打开就能看到结尾
}

/** manual：手动“标为已读”，不算进排行榜、连续天数和每日目标 */
async function setRead(id, read, { quiet = true, manual = false } = {}) {
  let offline = false;
  let res = null;
  try {
    res = await api(`/entries/${id}/read`, { method: "POST", body: { read, manual } });
  } catch (err) {
    if (!err.offline) throw err;
    // 没网：先记在本地，联网后自动补交；界面照常显示成已读
    queueRead(id, read, manual);
    offline = true;
  }
  invalidateSummaries();
  const state = document.querySelector(".read-state");
  if (state) {
    state.textContent = read ? "已读" : "未读";
    state.classList.toggle("ok", read);
  }
  const btn = document.querySelector('[data-action="toggle-read"]');
  if (btn) {
    btn.dataset.read = String(read);
    btn.textContent = read ? "标为未读" : "标为已读";
  }
  if (offline) toast("离线中，已先记下，联网后自动同步");
  else if (res?.finish) showFinish(id, res.finish);
  else if (!quiet) toast("读完了，已记入本周");
  return offline;
}

actions["toggle-read"] = async (el) => {
  const read = el.dataset.read !== "true";
  unwatch?.();
  if (await setRead(el.dataset.id, read, { manual: read })) return; // 离线时 setRead 已经提示过了
  toast(read ? "已标为已读（手动标记不计入排行榜和连续天数）" : "已标为未读，之后还会推荐给你");
};

// ---------- 读完的收尾 ----------

/** 读完时在“一句话记住”下面展开：盖章、连续天数、今日目标、名次、补签、明日预告、再读一个 */
function showFinish(id, f) {
  const mark = document.querySelector(".read-mark");
  if (!mark || document.querySelector(".finish") || !location.hash.startsWith(`#/w/${id}`)) return;
  const next = current?.upNext?.[0];
  const note = f.repair
    ? f.repair.repaired
      ? "昨天漏的一天已经补上了，连续天数接上了"
      : `昨天漏了一天，今天再读 ${Math.max(1, f.repair.need - f.repair.have)} 个就能补上`
    : f.today >= f.goal
      ? `今日目标 ${f.goal} 个已完成${f.today > f.goal ? `，还多读了 ${f.today - f.goal} 个` : ""}`
      : `今日目标还差 ${f.goal - f.today} 个`;
  mark.insertAdjacentHTML("afterend", `<section class="finish" aria-live="polite">
    <div class="fin-top">
      <span class="stamp">读<br>完</span>
      <div>
        <p class="fin-title">${esc(current?.headword ?? "")} 读完了</p>
        <p class="fin-note">${note}</p>
      </div>
    </div>
    <ul class="fin-stats">
      <li><b>${f.streak}</b><span>天连续${f.streak && f.streak >= f.best ? " · 最长" : ""}</span></li>
      <li><b>${f.today}<small>/${f.goal}</small></b><span>今日目标</span></li>
      ${f.rank ? `<li><b>${f.rank.rank}<small>/${f.rank.of}</small></b><span>今天排名</span></li>` : ""}
    </ul>
    ${f.tomorrow ? `<a class="fin-letter" href="#/w/${esc(f.tomorrow.id)}"><small>明日预告 · 已拆封</small><span>${rich(f.tomorrow.teaser)}</span></a>` : ""}
    <div class="fin-acts">
      ${next ? `<a class="btn primary" href="#/w/${esc(next.id)}">再读一个：<em>${esc(next.headword)}</em>${icon("arrow")}</a>` : `<button class="btn primary" data-action="read-another" data-id="${esc(id)}">再读一个${icon("arrow")}</button>`}
      <a class="btn ghost" href="#/">回到今日</a>
    </div>
  </section>`);
  const box = document.querySelector(".finish");
  box.animate([{ opacity: 0, transform: "translateY(12px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" });
  navigator.vibrate?.(18);
}

/** 没有“接着读”时：从没读过的词里推荐一个 */
actions["read-another"] = async (el) => {
  el.disabled = true;
  const { entry } = await api(`/next?shuffle=1&skip=${encodeURIComponent(el.dataset.id)}`).catch(() => ({}));
  if (entry) location.hash = `#/w/${entry.id}`;
  else el.disabled = false;
};
