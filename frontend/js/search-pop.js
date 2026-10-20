// 首页搜索组件：在输入框下面原地弹出下拉框，边打字边搜；“最近”一行是搜过的词。
// 下拉框挂在 body 上、position: fixed，不会被卡片裁掉；跟着输入框走（滚动、改窗口大小时重新定位）。

import { api, esc, local } from "./lib.js?v=212dd6fbae";
import { tint } from "./themes.js?v=212dd6fbae";

const KEY = "search-history";
const MAX = 10;

/** 搜索历史：最近的在前，同一个词只留一次 */
export const searchHistory = {
  list: () => (Array.isArray(local.get(KEY, null)) ? local.get(KEY, []) : []),
  add(q) {
    q = String(q ?? "").trim();
    if (!q) return;
    local.set(KEY, [q, ...this.list().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, MAX));
  },
  clear: () => local.set(KEY, []),
};

const mark = (text, q) => {
  const safe = esc(text);
  if (!q) return safe;
  const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return safe.replace(re, (m) => `<mark>${m}</mark>`);
};

/**
 * 接管 root 里的搜索组件（事件委托，组件重画了也照样有效）。
 * isEditing()：桌面在编辑时不弹；onHistory()：历史变了，让首页重画搜索组件。
 */
let teardown = null;
export function mountSearchPop(root, { isEditing = () => false, onHistory = () => {} } = {}) {
  teardown?.();
  const ctl = new AbortController();
  teardown = () => {
    close();
    ctl.abort();
  };
  const sig = { signal: ctl.signal };
  let pop = null; // { el, input, items, active, q, total }
  let timer = 0;
  let seq = 0;

  const close = () => {
    pop?.el.remove();
    pop?.input.setAttribute("aria-expanded", "false");
    pop = null;
  };

  function place() {
    if (!pop) return;
    const form = pop.input.closest("form") ?? pop.input;
    if (!form.isConnected) return close();
    const r = form.getBoundingClientRect();
    const width = Math.max(r.width, Math.min(420, innerWidth - 16));
    const left = Math.min(Math.max(8, r.left), innerWidth - width - 8);
    Object.assign(pop.el.style, { left: `${left}px`, top: `${r.bottom + 6}px`, width: `${width}px`, maxHeight: `${Math.max(160, innerHeight - r.bottom - 20)}px` });
  }

  function open(input) {
    if (pop?.input === input) return pop;
    close();
    const el = document.createElement("div");
    el.className = "search-pop";
    el.id = "search-pop";
    el.setAttribute("role", "listbox");
    document.body.append(el);
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", "search-pop");
    pop = { el, input, items: [], active: -1, q: "", total: 0 };
    place();
    el.addEventListener("pointerdown", (ev) => ev.preventDefault()); // 点下拉框时输入框别失焦
    el.addEventListener("click", (ev) => {
      const a = ev.target.closest("a[data-i], a.sp-all");
      if (!a) return;
      searchHistory.add(pop?.q);
      onHistory();
      close();
    });
    el.addEventListener("pointermove", (ev) => {
      const a = ev.target.closest("a[data-i]");
      if (a) highlight(Number(a.dataset.i), false);
    });
    return pop;
  }

  function highlight(i, scroll = true) {
    if (!pop) return;
    const links = [...pop.el.querySelectorAll("a[data-i], a.sp-all")];
    if (!links.length) return;
    pop.active = (i + links.length) % links.length;
    links.forEach((a, k) => a.classList.toggle("on", k === pop.active));
    if (scroll) links[pop.active].scrollIntoView({ block: "nearest" });
  }

  function paint(q, hits, loading = false) {
    if (!pop) return;
    pop.q = q;
    pop.total = hits.length;
    pop.active = -1;
    const top = hits.slice(0, 7);
    const all = `#/explore?q=${encodeURIComponent(q)}`;
    pop.el.innerHTML = hits.length
      ? `<p class="sp-head">${loading ? "搜索中…" : `找到 ${hits.length} 个`}</p>
        ${top
          .map((h, i) => {
            const target = h.redirect ?? h.id;
            const sub = h.snippet ? mark(h.snippet, q) : h.redirect ? `见 ${esc(h.redirect)}` : mark(h.meaning ?? "", q);
            return `<a role="option" data-i="${i}" href="#/w/${esc(target)}" ${h.themes ? `style="${tint(h)}"` : ""}>
              <span class="dot"></span><b>${mark(h.headword, q)}</b><span class="sp-sub">${sub}</span>${h.read || h.redirect ? "" : `<span class="sp-new">未读</span>`}
            </a>`;
          })
          .join("")}
        ${hits.length > top.length ? `<a class="sp-all" href="${all}">查看全部 ${hits.length} 个结果 →</a>` : ""}`
      : loading
        ? `<p class="sp-head">搜索中…</p>`
        : `<p class="sp-empty">没有找到“${esc(q)}”，换个说法试试，比如中文释义</p>`;
    place();
  }

  async function run(input) {
    const q = input.value.trim();
    if (!q) return close();
    open(input);
    const mine = ++seq;
    if (!pop.total) paint(q, [], true);
    let hits = [];
    try {
      hits = await api(`/search?q=${encodeURIComponent(q)}`);
    } catch {
      hits = [];
    }
    if (mine !== seq || !pop || pop.input !== input || input.value.trim() !== q) return;
    paint(q, Array.isArray(hits) ? hits : []);
  }

  const isBox = (t) => t?.matches?.(".w-search input[name=q]");

  root.addEventListener("input", (ev) => {
    if (!isBox(ev.target) || isEditing()) return;
    clearTimeout(timer);
    const input = ev.target;
    if (!input.value.trim()) return close();
    timer = setTimeout(() => run(input), 140);
  }, sig);

  root.addEventListener("focusin", (ev) => {
    if (isBox(ev.target) && ev.target.value.trim() && !isEditing()) run(ev.target);
  }, sig);

  root.addEventListener("focusout", (ev) => {
    if (!isBox(ev.target)) return;
    setTimeout(() => {
      if (pop && document.activeElement !== pop.input) close();
    }, 120);
  }, sig);

  root.addEventListener("keydown", (ev) => {
    if (!isBox(ev.target)) return;
    const input = ev.target;
    if (ev.key === "Escape") {
      if (pop) {
        ev.stopPropagation();
        close();
      } else input.blur();
      return;
    }
    if (!pop) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      highlight(pop.active + (ev.key === "ArrowDown" ? 1 : -1));
    } else if (ev.key === "Enter" && pop.active >= 0) {
      ev.preventDefault();
      const a = [...pop.el.querySelectorAll("a[data-i], a.sp-all")][pop.active];
      a?.click();
      if (a) location.hash = a.getAttribute("href");
    }
  }, sig);

  // 回车 / 搜索键：记进历史，去探索页看全部结果
  root.addEventListener("submit", (ev) => {
    const input = ev.target.querySelector?.("input[name=q]");
    if (!isBox(input)) return;
    ev.preventDefault();
    const q = input.value.trim();
    if (q) searchHistory.add(q);
    close();
    location.hash = q ? `#/explore?q=${encodeURIComponent(q)}` : "#/explore";
  }, sig);

  // “最近”里的词：填进输入框，原地搜；“清除”清空历史
  root.addEventListener("click", (ev) => {
    if (isEditing()) return;
    const chip = ev.target.closest(".w-search [data-q]");
    const clear = ev.target.closest(".w-search [data-clear-history]");
    if (!chip && !clear) return;
    ev.preventDefault();
    if (clear) {
      searchHistory.clear();
      onHistory();
      return;
    }
    const input = chip.closest(".w-search").querySelector("input[name=q]");
    input.value = chip.dataset.q;
    input.focus();
    run(input);
  }, sig);

  addEventListener("scroll", place, { passive: true, signal: ctl.signal });
  addEventListener("resize", place, sig);
  addEventListener("hashchange", () => {
    close();
    ctl.abort();
  }, sig);

  return { close };
}
