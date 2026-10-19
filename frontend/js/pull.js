// 下拉刷新（触屏）：页面在最顶上时往下拉，顶部出现一个圆形指示器，拉够距离松手就刷新当前这一页。
// 刷新是“软”的：清掉接口缓存、把这一页重新画一遍，不整页重载（登录、滚动、离线缓存都不受影响）；顺便检查前端有没有新版本。
// 首页桌面在编辑、词卡 / 组件库弹层开着、在输入框里时不响应；横着划（书架、筛选条）也不算。

import { icon } from "./lib.js";

/** 拉到这么远（指示器下移的像素）松手才刷新 */
const TRIGGER = 64;
/** 最多拉到这么远 */
const MAX = 110;
/** 刷新至少转这么久，太快了看不出刷过 */
const MIN_SPIN = 450;

/** refresh：刷新当前页的函数（返回 Promise） */
export function initPull(refresh) {
  if (!("ontouchstart" in window)) return;
  const ind = document.createElement("div");
  ind.className = "ptr";
  ind.setAttribute("aria-hidden", "true");
  ind.innerHTML = `<span class="ptr-ic">${icon("refresh")}</span>`;
  document.body.append(ind);
  const ic = ind.querySelector(".ptr-ic");

  let start = null; // { x, y }
  let dist = 0;
  let pulling = false;
  let busy = false;

  const blocked = (target) =>
    busy ||
    document.body.classList.contains("desk-editing") ||
    document.querySelector(".desk-sheet, .wcard.sheet") ||
    target.closest?.("input, textarea, select, [contenteditable]");

  const show = (d) => {
    ind.style.setProperty("--d", `${d}px`);
    ind.style.setProperty("--p", String(Math.min(1, d / TRIGGER)));
    ind.classList.toggle("ready", d >= TRIGGER);
  };

  const reset = () => {
    ic.innerHTML = icon("refresh");
    ind.classList.add("back");
    ind.classList.remove("on", "ready", "spin", "done");
    show(0);
    setTimeout(() => ind.classList.remove("back"), 260);
    start = null;
    pulling = false;
    dist = 0;
  };

  addEventListener("touchstart", (ev) => {
    if (ev.touches.length !== 1 || scrollY > 0 || blocked(ev.target)) return;
    start = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
    dist = 0;
  }, { passive: true });

  addEventListener("touchmove", (ev) => {
    if (!start) return;
    const dx = ev.touches[0].clientX - start.x;
    const dy = ev.touches[0].clientY - start.y;
    if (!pulling) {
      // 先往上划、横着划，或者页面已经不在顶上：这一下不是下拉刷新
      if (dy < 6 || Math.abs(dx) > dy || scrollY > 0) {
        if (dy < -4 || Math.abs(dx) > 10 || scrollY > 0) start = null;
        return;
      }
      pulling = true;
      ind.classList.add("on");
    }
    // 越往下越拉不动
    dist = Math.min(MAX, (dy - 6) * 0.5);
    show(dist);
    if (ev.cancelable) ev.preventDefault(); // 别让浏览器自己的回弹 / 下拉刷新也来一下
  }, { passive: false });

  const end = async () => {
    if (!pulling) {
      start = null;
      return;
    }
    if (dist < TRIGGER) return reset();
    busy = true;
    start = null;
    pulling = false;
    show(TRIGGER * 0.85);
    ind.classList.add("spin");
    navigator.vibrate?.(10);
    const t0 = Date.now();
    try {
      await refresh();
    } catch {}
    await new Promise((r) => setTimeout(r, Math.max(0, MIN_SPIN - (Date.now() - t0))));
    ind.classList.remove("spin");
    ind.classList.add("done");
    ic.innerHTML = icon("check");
    await new Promise((r) => setTimeout(r, 300));
    busy = false;
    reset();
  };
  addEventListener("touchend", end);
  addEventListener("touchcancel", () => (pulling || start) && reset());
}
