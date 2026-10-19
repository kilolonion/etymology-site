// 下拉刷新（触屏）：页面在最顶上时往下拉，顶部出现一个圆形指示器，拉够距离松手就刷新当前这一页。
// 刷新是“软”的：清掉接口缓存、把这一页重新画一遍，不整页重载（登录、滚动、离线缓存都不受影响）；顺便检查前端有没有新版本。
// 首页桌面在编辑、词卡 / 组件库弹层开着、在输入框里时不响应；横着划（书架、筛选条）也不算。
//
// 流畅度上的几个约束（别改回去）：
// - touchmove 要 preventDefault，所以必须是非被动监听；而非被动监听会让浏览器每次滚动都等 JS 回话。
//   所以只在页面停在最顶上（scrollY <= 0）时才挂它，往下滚了就摘掉，平时滚动不受影响；
// - 跟手的位移只用 transform / opacity，每帧最多写一次（requestAnimationFrame 合并）；
// - 刷新最多转 MAX_SPIN 毫秒：网络再慢也要把指示器收起来（数据回来了照样会画上去）。

import { icon } from "./lib.js";

/** 拉到这么远（指示器下移的像素）松手才刷新 */
const TRIGGER = 64;
/** 最多拉到这么远 */
const MAX = 110;
/** 刷新至少转这么久，太快了看不出刷过 */
const MIN_SPIN = 450;
/** 刷新最多转这么久，超时就当“已交给后台”收起来 */
const MAX_SPIN = 8000;
/** 收起动画的时长（要和 style.css 里 .ptr.back 的 transition 一致） */
const BACK_MS = 260;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  let frame = 0; // 待执行的 rAF
  let backTimer = 0;

  const blocked = (target) =>
    busy ||
    document.body.classList.contains("desk-editing") ||
    document.querySelector(".desk-sheet, .wcard.sheet") ||
    target.closest?.("input, textarea, select, [contenteditable]");

  /** 立刻把指示器画到 d 的位置 */
  const paint = (d) => {
    ind.style.setProperty("--d", `${d}px`);
    ind.style.setProperty("--p", String(Math.min(1, d / TRIGGER)));
    ind.classList.toggle("ready", d >= TRIGGER);
  };
  /** 跟手时用：每帧最多画一次 */
  const paintSoon = (d) => {
    dist = d;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paint(dist);
    });
  };

  const reset = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    clearTimeout(backTimer);
    ind.classList.add("back");
    ind.classList.remove("on", "ready", "spin", "done");
    paint(0);
    start = null;
    pulling = false;
    dist = 0;
    // 等淡出完再换回箭头、摘掉过渡类；否则对勾会在淡出的时候变回箭头，闪一下
    backTimer = setTimeout(() => {
      ind.classList.remove("back");
      if (!pulling && !busy) ic.innerHTML = icon("refresh");
    }, BACK_MS);
  };

  addEventListener("touchstart", (ev) => {
    if (ev.touches.length !== 1 || scrollY > 0 || blocked(ev.target)) return;
    start = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
    dist = 0;
  }, { passive: true });

  const onMove = (ev) => {
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
      // 上一次的收起动画还没放完就又拉了：马上摘掉过渡，不然指示器会慢半拍地跟手
      clearTimeout(backTimer);
      ind.classList.remove("back");
      ind.classList.add("on");
    }
    // 越往下越拉不动
    paintSoon(Math.min(MAX, (dy - 6) * 0.5));
    if (ev.cancelable) ev.preventDefault(); // 别让浏览器自己的回弹 / 下拉刷新也来一下
  };

  // 只有停在最顶上才需要拦截 touchmove；往下滚了就摘掉，平时滚动不被它拖慢
  let armed = false;
  const arm = () => {
    const want = scrollY <= 0;
    if (want === armed) return;
    armed = want;
    if (want) addEventListener("touchmove", onMove, { passive: false });
    else removeEventListener("touchmove", onMove);
  };
  addEventListener("scroll", arm, { passive: true });
  arm();

  const end = async () => {
    if (!pulling) {
      start = null;
      return;
    }
    cancelAnimationFrame(frame);
    frame = 0;
    if (dist < TRIGGER) return reset();
    busy = true;
    start = null;
    pulling = false;
    paint(TRIGGER * 0.85);
    ind.classList.add("spin");
    navigator.vibrate?.(10);
    try {
      const t0 = Date.now();
      // 刷新卡住也不能一直转：到点就收起来，数据回来后页面自己会更新
      await Promise.race([Promise.resolve().then(refresh).catch(() => {}), sleep(MAX_SPIN)]);
      await sleep(Math.max(0, MIN_SPIN - (Date.now() - t0)));
      ind.classList.remove("spin");
      ind.classList.add("done");
      ic.innerHTML = icon("check");
      await sleep(300);
    } finally {
      busy = false; // 不管中间出什么错，都要放开，不然之后再也拉不动
      reset();
    }
  };
  addEventListener("touchend", end);
  addEventListener("touchcancel", () => (pulling || start) && reset());
}
