// 文章页：一个词的完整故事（电脑上右侧是相关词和出处卡）。读到“一句话记住”、且停留几秒后才算读完，随手点开不算。

import { examples, family, fold, foldHead, isWide, linkCards, prose, pull, reasonText, route, sayBtn, starBtn } from "../components.js";
import { actions, api, esc, icon, render, rich, toast, warmSpeech } from "../lib.js";
import { emblem, primaryTheme, themeTag, tint } from "../themes.js";
import { queueRead } from "../offline.js";
import { invalidateSummaries } from "./explore.js";
import { setWordIndex } from "../words.js";

/** 至少停留这么久，读到结尾才记为已读 */
const MIN_DWELL = 8000;
let unwatch = null;

export async function viewEntry(id) {
  unwatch?.();
  // 词条目录用来给正文里的词加词卡链接；拿不到也不耽误看文章
  const [e, all] = await Promise.all([api(`/entries/${encodeURIComponent(id)}`), api("/entries").catch(() => null)]);
  if (all) indexWords(all);
  if (e.redirect) {
    location.replace(`#/w/${e.redirect}`);
    return;
  }

  const theme = primaryTheme(e);
  // 相关的词：同专题的词；参见和有关系的词已经在“词的亲缘”里，“接着读”里有的也不重复
  const shownIds = new Set([...e.upNext, ...e.seeAlso, ...e.kin].map((x) => x.id));
  const more = e.related.filter((x) => !shownIds.has(x.id)).slice(0, 4);
  // 这一篇里已经加过词卡链接的词条，每个词只链第一次；自己不链
  const used = new Set([e.id]);

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
        <p class="teaser">${rich(e.teaser, { link: true, used })}</p>
      </header>

      <div class="article-body">
        <h3 class="kicker">词源 <span class="en">The Story</span></h3>
        ${prose(e.etymology, "dropcap", used)}
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

async function setRead(id, read, { quiet = true } = {}) {
  let offline = false;
  try {
    await api(`/entries/${id}/read`, { method: "POST", body: { read } });
  } catch (err) {
    if (!err.offline) throw err;
    // 没网：先记在本地，联网后自动补交；界面照常显示成已读
    queueRead(id, read);
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
  else if (!quiet) toast("读完了，已记入本周");
  return offline;
}

actions["toggle-read"] = async (el) => {
  const read = el.dataset.read !== "true";
  unwatch?.();
  if (await setRead(el.dataset.id, read)) return; // 离线时 setRead 已经提示过了
  toast(read ? "已标为已读" : "已标为未读，之后还会推荐给你");
};
