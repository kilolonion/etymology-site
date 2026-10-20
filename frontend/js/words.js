// 正文里的词：书里有的词自动加上链接，点一下弹出词卡（看一眼它的来历，不用离开当前这篇）；
// 例句里其余的英文词也能点，查个简明释义、听个发音。

import { esc } from "./lib.js?v=212dd6fbae";

let matcher = null; // { re, ids: 小写写法 → 词条 id, caps: 只认大写写法的 }

/** 用词条目录建索引；目录变了（比如词条热更新）就重建 */
export function setWordIndex(all) {
  const ids = new Map();
  const caps = new Set();
  for (const s of all) {
    const target = s.redirect ?? s.id;
    for (const w of [s.headword, ...(s.variants ?? [])]) {
      const k = w.toLowerCase().replace(/^the /, "");
      // 太短的词（gas、tip 之外的两个字母）容易误伤；全大写的缩写（OK、SOS）例外
      if (k.length < 3 && !/^[A-Z]{2,}$/.test(w)) continue;
      if (!ids.has(k) || !s.redirect) ids.set(k, target);
      // May、March、Dutch 这种首字母大写的，只在正文里也大写时才算
      if (/^[A-Z]/.test(w.replace(/^the /i, ""))) caps.add(k);
    }
  }
  const alts = [...ids.keys()]
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[ -]/g, "[ -]"));
  matcher = { re: new RegExp(`(?<![A-Za-z'’-])(${alts.join("|")})(?:'s|’s|es|s)?(?![A-Za-z])`, "gi"), ids, caps };
}

export const hasWordIndex = () => !!matcher;

const find = (text) => {
  const k = text.toLowerCase();
  const id = matcher.ids.get(k) ?? matcher.ids.get(k.replace(/-/g, " ")) ?? matcher.ids.get(k.replace(/ /g, "-"));
  if (!id) return null;
  if (matcher.caps.has(k) && !/^[A-Z]/.test(text)) return null;
  return id;
};

const wordLink = (id, html) => `<a class="wl" href="#/w/${esc(id)}" data-action="peek" data-id="${esc(id)}">${html}</a>`;
const tapWord = (w) => `<span class="tw" data-action="look" data-w="${esc(w)}">${esc(w)}</span>`;
const tapAll = (text) => text.split(/([A-Za-z][A-Za-z'’-]*[A-Za-z]|[A-Za-z])/).map((p, i) => (i % 2 ? tapWord(p) : esc(p))).join("");

/**
 * 一段纯文字（不含 *斜体* 记号）转成 HTML，顺手给词条加链接。
 * used：已经加过链接的词条，同一篇里每个词只链第一次；self 也放在这里面。
 * tap：其余英文词也做成可点的（例句用）。
 */
export function linkText(text, used, tap = false) {
  if (!matcher) return tap ? tapAll(text) : esc(text);
  let out = "";
  let last = 0;
  for (const m of text.matchAll(matcher.re)) {
    const id = find(m[1]);
    if (!id || used.has(id)) continue;
    used.add(id);
    const before = text.slice(last, m.index);
    out += (tap ? tapAll(before) : esc(before)) + wordLink(id, esc(m[0]));
    last = m.index + m[0].length;
  }
  const rest = text.slice(last);
  return out + (tap ? tapAll(rest) : esc(rest));
}

/** 斜体里的内容：整个斜体正好是一个词条才加链接（斜体多是拉丁语、法语原词，别乱认） */
export function linkItalic(text, used) {
  const id = matcher && find(text.replace(/[.,;:!?]$/, ""));
  if (!id || used.has(id)) return esc(text);
  used.add(id);
  return wordLink(id, esc(text));
}
