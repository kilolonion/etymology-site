// 词卡：点正文里带下划线的词，就地弹出一张小卡片——单词、发音、释义、故事的开头，想看全文再点进去。
// 电脑上贴着那个词弹出，手机上从底部升起。卡片里的词也能接着点，卡片换成新词。

import { actions, api, esc, icon, rich, srcMark } from "./lib.js?v=212dd6fbae";
import { primaryTheme, themeTag, tint } from "./themes.js?v=212dd6fbae";

let box = null;
let anchor = null;
let ticket = 0; // 连点几个词时，只画最后一个

const wide = () => matchMedia("(min-width: 760px)").matches;

function ensureBox() {
  if (box) return box;
  box = document.createElement("div");
  box.className = "wcard";
  box.setAttribute("role", "dialog");
  box.hidden = true;
  document.body.append(box);
  return box;
}

function place() {
  if (!box || box.hidden) return;
  if (!wide() || !anchor?.isConnected) {
    box.classList.add("sheet");
    box.style.left = box.style.top = "";
    return;
  }
  box.classList.remove("sheet");
  const r = anchor.getBoundingClientRect();
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  const left = Math.min(Math.max(12, r.left + r.width / 2 - w / 2), innerWidth - w - 12);
  const below = r.bottom + 10 + h < innerHeight || r.top < h + 20;
  box.style.left = `${left + scrollX}px`;
  box.style.top = `${(below ? r.bottom + 10 : r.top - h - 10) + scrollY}px`;
}

function show(html, label) {
  ensureBox();
  box.innerHTML = html;
  box.setAttribute("aria-label", label);
  const first = box.hidden;
  box.hidden = false;
  place();
  if (first) box.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "ease-out" });
}

export function closeCard() {
  if (!box || box.hidden) return;
  box.hidden = true;
  anchor?.classList.remove("on");
  anchor = null;
  ticket++;
}

const say = (text) =>
  `<button class="icon-btn sm" data-action="say" data-text="${esc(text)}" aria-label="朗读">${icon("sound")}</button>`;
const closeBtn = `<button class="icon-btn sm wc-x" data-action="close-card" aria-label="关闭">${icon("close")}</button>`;

const loading = (word) => `<div class="wc-head"><b>${esc(word)}</b>${closeBtn}</div><div class="wc-wait"><span class="sk"></span><span class="sk"></span></div>`;

function entryCard(c) {
  // 屏蔽 AI 内容时，AI 整理的新词只给一个说明和出口，不显示释义/故事开头
  if (c.aiGate) {
    return `<div class="wc-in">
      <div class="wc-head"><b>${esc(c.headword)}${srcMark(c)}</b>${closeBtn}</div>
      <p class="wc-note">这一篇是 AI 整理的，已按你的设置隐藏。</p>
      <a class="wc-go" href="#/w/${esc(c.id)}?ai=1">仍然查看这一篇 ${icon("arrow")}</a>
      <a class="wc-go" href="#/me">去改设置 ${icon("arrow")}</a>
    </div>`;
  }
  const theme = primaryTheme(c);
  return `<div class="wc-in" style="${tint(c)}">
    <div class="wc-top">${themeTag(theme)}${c.read ? `<i class="seen">已读</i>` : ""}${closeBtn}</div>
    <div class="wc-head"><b>${esc(c.headword)}${srcMark(c)}</b>${say(c.headword)}</div>
    ${c.ipa || c.pos ? `<p class="wc-phon">${[c.ipa && `/${esc(c.ipa)}/`, c.pos && esc(c.pos)].filter(Boolean).join(" · ")}</p>` : ""}
    <p class="wc-mean">${esc(c.meaning)}</p>
    <p class="wc-gist">${rich(c.gist, { link: true, used: new Set([c.id]) })}</p>
    <a class="wc-go" href="#/w/${esc(c.id)}">读完整故事 ${icon("arrow")}</a>
  </div>`;
}

function glossCard(word, gloss) {
  return `<div class="wc-in">
    <div class="wc-head"><b>${esc(word)}</b>${say(word)}${closeBtn}</div>
    <p class="wc-mean">${gloss ? esc(gloss) : "没查到这个词的释义"}</p>
    <p class="wc-note">书里没有收这个词的故事${gloss ? " · 释义来自有道词典" : ""}</p>
  </div>`;
}

async function open(el, word, load) {
  const mine = ++ticket;
  // 卡片里点的词：卡片原地换内容，位置还跟着原来那个词
  if (!box?.contains(el)) {
    anchor?.classList.remove("on");
    anchor = el;
    el.classList.add("on");
  }
  show(loading(word), word);
  try {
    const html = await load();
    if (mine === ticket) show(html, word);
  } catch (err) {
    if (mine !== ticket) return;
    show(`<div class="wc-head"><b>${esc(word)}</b>${closeBtn}</div><p class="wc-note">${err.offline ? "离线中，这个词还没有存下来" : "暂时查不到，稍后再试"}</p>`, word);
  }
}

/** 正文里的词条链接；按住 ⌘ / Ctrl 点击照常打开文章 */
actions.peek = (el, ev) => {
  if (ev?.metaKey || ev?.ctrlKey) {
    location.hash = el.getAttribute("href");
    return;
  }
  if (anchor === el && !box.hidden) return closeCard();
  return open(el, el.textContent, async () => entryCard(await api(`/card/${encodeURIComponent(el.dataset.id)}`)));
};

/** 例句里其他的英文词：书里有就给词卡，没有就给简明释义 */
actions.look = (el) => {
  if (anchor === el && !box.hidden) return closeCard();
  const word = el.dataset.w;
  return open(el, word, async () => {
    const r = await api(`/lookup?w=${encodeURIComponent(word)}`);
    return r.card ? entryCard(r.card) : glossCard(word, r.gloss);
  });
};

actions["close-card"] = () => closeCard();

// 点卡片外面、按 Esc、换页都关掉
document.addEventListener("click", (ev) => {
  if (!box || box.hidden) return;
  if (box.contains(ev.target) || ev.target.closest('[data-action="peek"], [data-action="look"]')) return;
  closeCard();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeCard();
});
addEventListener("hashchange", closeCard);
addEventListener("resize", place);
