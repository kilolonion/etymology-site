// 文章页：一个词的完整故事（电脑上右侧是相关词和出处卡）。读到“一句话记住”、且停留几秒后才算读完，随手点开不算。
// 没读过的词，开头先猜一下它的来历里有哪种语言，读到“词源之路”揭晓；读完时就地展开收尾（连续天数、今日目标、名次、明日预告、再读一个）。
// 顶部一条进度，读到“一句话记住”正好走满；字号可以调。
// 不在书里的词（后台新增）词头下有来源标签，点开看参考来源和存疑之处；每篇都能报错。管理员可以用 ?draft=1 预览稿子。

import { nextFromPaper, notePaperRead } from "./paper.js?v=212dd6fbae";
import { examples, family, fold, foldHead, isWide, linkCards, prose, pull, reasonText, route, sayBtn, starBtn } from "../components.js?v=212dd6fbae";
import { actions, api, esc, icon, local, render, rich, SRC_TEXT, toast, warmSpeech } from "../lib.js?v=212dd6fbae";
import { emblem, primaryTheme, themeTag, tint } from "../themes.js?v=212dd6fbae";
import { queueRead } from "../offline.js?v=212dd6fbae";
import { invalidateSummaries } from "./explore.js?v=212dd6fbae";
import { setWordIndex } from "../words.js?v=212dd6fbae";

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

export async function viewEntry(id, query) {
  unwatch?.();
  page?.abort();
  page = new AbortController();
  const sig = page.signal;
  const draft = !!query?.get("draft");
  // 词条目录用来给正文里的词加词卡链接；拿不到也不耽误看文章
  const [e, all] = await Promise.all([
    api(`/entries/${encodeURIComponent(id)}${draft ? "?draft=1" : ""}`, draft ? { fresh: true } : undefined),
    api("/entries").catch(() => null),
  ]);
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
    ${e.preview ? `<div class="draft-bar"><span>草稿预览 · 读者还看不到这一版</span><a href="#/me/admin?tab=entries&d=${encodeURIComponent(e.id)}">回到稿子</a></div>` : ""}
    <article style="${tint(e)};--fs:${fontScale()}">
      <div class="read-progress" aria-hidden="true"><span></span></div>
      <header class="hero">
        ${emblem(theme)}
        <div class="hero-bar">
          <button class="back" data-action="back">${icon("left")}返回</button>
          <span class="hero-acts"><span class="hero-btns"><button class="icon-btn fs-btn" data-action="font-size" aria-label="调整字号">Aa</button>${e.preview ? "" : starBtn(e)}</span><span class="mins">约 ${readMinutes(e)} 分钟</span></span>
        </div>
        ${themeTag(theme)}
        <h1>${esc(e.headword)}</h1>
        ${e.src ? `<button class="src-badge ${e.src}" data-action="src-info">${SRC_TEXT[e.src]}</button>` : ""}
        ${e.variants?.length ? `<p class="variants">亦作 ${e.variants.map(esc).join(", ")}</p>` : ""}
        <div class="phon">${sayBtn(e.headword)}<span class="ipa">/${esc(e.ipa)}/</span><span class="pos">${esc(e.pos)}</span></div>
        <p class="meaning">${esc(e.meaning)}</p>
        <p class="teaser">${rich(e.teaser, { link: true, used })}</p>
        ${e.preview ? "" : guessBlock(e)}
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
            ${sourceRows(e)}
            <div class="r"><span>专题</span><span>${e.themes.map(esc).join("、")}</span></div>
            ${e.langs?.length ? `<div class="r"><span>语源</span><span>${e.langs.map(esc).join(" · ")}</span></div>` : ""}
            ${e.preview ? "" : `<div class="r"><span>阅读</span><span class="read-state ${e.read ? "ok" : ""}">${e.read ? "已读" : "读到“一句话记住”就算读完"}</span></div>
            <div class="acts"><button class="text-btn" data-action="report">${icon("flag")}报错</button><button class="text-btn" data-action="toggle-read" data-id="${esc(e.id)}" data-read="${e.read}">${e.read ? "标为未读" : "标为已读"}</button></div>`}
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
  if (!e.read && !e.preview) watchReading(e);
  watchProgress(sig);
  watchReveal(e, sig);
  addEventListener("hashchange", () => page?.abort(), { signal: sig, once: true });
}

// ---------- 来源：原书 / AI 整理 / 编辑撰写，补写过的原书词条 ----------

const FIELD_NAMES = { teaser: "钩子", keyline: "一句话记住", evolution: "词义演变", links: "词的关系", era: "年代", subtheme: "子专题", langs: "语源" };
const BOOK = "《英语词源典故词典》";
const patchLabel = (p) => `${p.origin?.kind === "manual" ? "编辑补写的" : "AI 补充的"}（${p.origin?.checked ? "已核对" : "待核对"}）`;

/** 出处卡里的“出处”一行，加一句说明哪些是原书、哪些是另写的 */
function sourceRows(e) {
  if (e.origin) {
    return `<div class="r"><span>出处</span><span>${e.origin.kind === "manual" ? "编辑撰写" : "AI 整理"}（不在原书中）</span></div>
      <p class="src-note">${e.origin.sources.length} 条参考来源${e.origin.doubts.length ? `，${e.origin.doubts.length} 处存疑` : ""}。<button data-action="src-info">看来源</button></p>`;
  }
  const patched = e.patched?.fields?.length
    ? `其中「${e.patched.fields.map((f) => FIELD_NAMES[f] ?? f).join("、")}」是${patchLabel(e.patched)}，<button data-action="src-info">看来源</button>。`
    : "";
  return `<div class="r"><span>出处</span><span>${BOOK}第 ${e.page} 页</span></div>
    <p class="src-note">正文、释义、例句照原书；钩子、一句话记住、词义演变为编辑补写。${patched}</p>`;
}

/** 弹出一张卡片（来源说明、报错共用），关掉就移除 */
function dialog(html) {
  document.querySelector(".src-dialog")?.remove();
  const d = document.createElement("dialog");
  d.className = "src-dialog";
  d.innerHTML = `<div class="sd-in">${html}</div>`;
  document.body.append(d);
  d.addEventListener("close", () => d.remove());
  // 点到卡片外面（遮罩）也关
  d.addEventListener("click", (ev) => ev.target === d && d.close());
  d.showModal();
  return d;
}

const sourceList = (o) => `
  <h3>参考来源</h3>
  <ul>${o.sources.map((s) => `<li>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>` : esc(s.title)}</li>`).join("") || "<li>（没有列出）</li>"}</ul>
  ${o.doubts.length ? `<h3>存疑之处</h3><ul class="doubts">${o.doubts.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}`;

const cnDay = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
};
const checkedText = (o) => (o.checked ? `管理员于 ${cnDay(o.checked.at)}对照来源核对过。` : "还没有经过人工核对，请带着一点怀疑读。");

actions["src-info"] = () => {
  const e = current;
  if (!e) return;
  let body;
  if (e.origin) {
    const o = e.origin;
    body = `<h2>这篇的来源<span class="src-badge ${e.src}">${SRC_TEXT[e.src]}</span></h2>
      <p>${esc(e.headword)} 不在${BOOK}里。${o.kind === "manual" ? "这篇由本站编辑根据公开资料撰写。" : `内容由 AI${o.model ? `（${esc(o.model)}）` : ""}根据公开资料整理，`}${checkedText(o)}</p>
      ${sourceList(o)}`;
  } else if (e.patched) {
    const o = e.patched.origin;
    body = `<h2>补写的内容</h2>
      <p>${esc(e.headword)} 的正文出自${BOOK}第 ${e.page} 页。「${e.patched.fields.map((f) => FIELD_NAMES[f] ?? f).join("、")}」是后来补充的${o.kind === "manual" ? "，由编辑撰写" : `，由 AI${o.model ? `（${esc(o.model)}）` : ""}整理`}。${checkedText(o)}</p>
      ${sourceList(o)}`;
  } else return;
  const d = dialog(`${body}<div class="sd-acts"><button class="btn sm" data-action="report">${icon("flag")}我发现了错误</button><button class="btn sm primary" data-action="dlg-close">知道了</button></div>`);
  d.querySelector("[data-action=dlg-close]").focus();
};

actions["dlg-close"] = (el) => el.closest("dialog")?.close();

actions.report = () => {
  const e = current;
  if (!e) return;
  const d = dialog(`<h2>报告错误</h2>
    <p>${esc(e.headword)} 哪里不对？写清楚是哪一句、应该是什么，最好附上出处。管理员会看到。</p>
    <textarea rows="4" maxlength="500" placeholder="比如：第二段的年份应该是 1754 年，见……"></textarea>
    <div class="sd-acts"><button class="btn sm" data-action="dlg-close">取消</button><button class="btn sm primary" data-action="report-send">提交</button></div>`);
  d.querySelector("textarea").focus();
};

actions["report-send"] = async (el) => {
  const d = el.closest("dialog");
  const text = d.querySelector("textarea").value.trim();
  if (text.length < 4) return toast("多写几个字，说说哪里不对");
  el.disabled = true;
  try {
    await api(`/entries/${encodeURIComponent(current.id)}/report`, { method: "POST", body: { text } });
    d.close();
    toast("收到了，谢谢");
  } catch (err) {
    toast(err.message);
    el.disabled = false;
  }
};

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
  if (read) notePaperRead(id);
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
  // 从日报点进来的：“再读一个”接着日报往下；否则用文章末尾“接着读”的第一个
  const st = history.state ?? {};
  const viaPaper = [st.from?.hash, st.root?.hash].some((h) => h?.startsWith("#/paper"));
  const next = (viaPaper && nextFromPaper(id)) || current?.upNext?.[0];
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
      ${next ? `<a class="btn primary next" href="#/w/${esc(next.id)}"><small>再读一个</small><span class="w"><em>${esc(next.headword)}</em>${icon("arrow")}</span></a>` : `<button class="btn primary" data-action="read-another" data-id="${esc(id)}">再读一个${icon("arrow")}</button>`}
      <div class="fin-sub">${viaPaper ? `<a class="btn ghost" href="#/paper">回到日报</a>` : `<a class="btn ghost" href="#/paper">浏览日报</a><a class="btn ghost" href="#/">回到今日</a>`}</div>
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
