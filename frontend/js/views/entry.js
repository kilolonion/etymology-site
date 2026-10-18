// 文章页：一个词的完整故事（电脑上右侧是相关词和出处卡）。读到“一句话记住”、且停留几秒后才算读完，随手点开不算。

import { examples, family, linkCards, prose, pull, reasonText, route, sayBtn, starBtn } from "../components.js";
import { actions, api, esc, icon, render, rich, toast } from "../lib.js";
import { emblem, primaryTheme, themeTag, tint } from "../themes.js";
import { invalidateSummaries } from "./explore.js";

/** 至少停留这么久，读到结尾才记为已读 */
const MIN_DWELL = 8000;
let unwatch = null;

export async function viewEntry(id) {
  unwatch?.();
  const e = await api(`/entries/${encodeURIComponent(id)}`);
  if (e.redirect) {
    location.replace(`#/w/${e.redirect}`);
    return;
  }

  const theme = primaryTheme(e);
  // 相关的词：同专题的词；参见和有关系的词已经在“词的亲缘”里，“接着读”里有的也不重复
  const shownIds = new Set([...e.upNext, ...e.seeAlso, ...e.kin].map((x) => x.id));
  const more = e.related.filter((x) => !shownIds.has(x.id)).slice(0, 4);

  render(`
    <article style="${tint(e)}">
      <header class="hero">
        ${emblem(theme)}
        <div class="hero-bar">
          <button class="back" data-action="back">${icon("left")}返回</button>
          ${starBtn(e)}
        </div>
        ${themeTag(theme)}
        <h1>${esc(e.headword)}</h1>
        ${e.variants?.length ? `<p class="variants">亦作 ${e.variants.map(esc).join(", ")}</p>` : ""}
        <div class="phon">${sayBtn(e.headword)}<span class="ipa">/${esc(e.ipa)}/</span><span class="pos">${esc(e.pos)}</span></div>
        <p class="meaning">${esc(e.meaning)}</p>
        <p class="teaser">${rich(e.teaser)}</p>
      </header>

      <div class="article-body">
        <h3 class="kicker">词源 <span class="en">The Story</span></h3>
        ${prose(e.etymology, "dropcap")}
        ${route(e)}
        ${pull(e)}
        <div class="read-mark" aria-hidden="true"></div>

        <h3 class="kicker">例句 <span class="en">In Use</span></h3>
        ${examples(e, 2)}

        ${family(e)}

        <aside class="article-side">
          ${more.length ? `<h3 class="kicker">相关的词 <span class="en">Related</span></h3>${linkCards(more)}` : ""}

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

  if (!e.read) watchReading(e);
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

async function setRead(id, read, { quiet = true } = {}) {
  await api(`/entries/${id}/read`, { method: "POST", body: { read } });
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
  if (!quiet) toast("读完了，已记入本周");
}

actions["toggle-read"] = async (el) => {
  const read = el.dataset.read !== "true";
  unwatch?.();
  await setRead(el.dataset.id, read);
  toast(read ? "已标为已读" : "已标为未读，之后还会推荐给你");
};
