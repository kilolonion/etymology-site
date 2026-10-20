// 首页桌面：像手机主屏幕一样摆小组件。
// 长按任意卡片（或点“编辑主屏幕”）进入编辑：卡片轻轻晃动，可以拖动换位置、点 − 移除、点 ＋ 从组件库添加；
// 右下角的手柄按住拖动直接改大小（吸附到这个组件支持的尺寸），轻点则弹出尺寸菜单（像 macOS 绿灯的“移动与调整大小”）。
// 布局只存在这台设备上（手机和电脑屏幕不一样，各摆各的）。
//
// 网格：手机 4 列、宽屏 8 列，格子是正方形。尺寸：图标 1×1、小 2×2、中 4×2、大 4×4、条 4×1（宽×高）；
// 日报组件另用“行-列”：1-8、1-4、2-4、4-4、2-8、4-2、1-1、1-2（8 列宽的在手机上收成 4 列）。
// 排列按顺序从左上往右下填（grid-auto-flow: dense，小的会补进空位），拖动改的是顺序。

import { esc, icon, local } from "./lib.js?v=212dd6fbae";

const KEY = "desk-layout";
export const SIZE_NAME = { icon: "图标", s: "小", m: "中", l: "大", bar: "条" };
/** 尺寸名：日报这类用“行-列”标的，显示成 1×8 */
export const sizeName = (s) => SIZE_NAME[s] ?? s.replace("-", "×");

/** 读出布局：认不得的组件、不支持的尺寸、重复的都丢掉；从没存过就用默认的 */
export function loadLayout(widgets, fallback) {
  const saved = local.get(KEY, null);
  const list = Array.isArray(saved) ? saved : fallback;
  const seen = new Set();
  return list.filter(([id, size]) => {
    const w = widgets[id];
    if (!w || seen.has(id)) return false;
    seen.add(id);
    return w.sizes.includes(size);
  });
}

const saveLayout = (layout) => local.set(KEY, layout);

/** 一个尺寸在当前网格里占几列几行；“行-列”写法的宽度超过列数时收成整行 */
const NAMED = { icon: [1, 1], s: [2, 2], m: [4, 2], l: [4, 4], bar: [4, 1] };
export function dims(size, cols = 8) {
  const named = NAMED[size];
  if (named) return { w: Math.min(named[0], cols), h: named[1] };
  const [h, w] = size.split("-").map(Number);
  return { w: Math.min(w, cols), h };
}

/** 尺寸标签一律写“行-列”（2-4 = 2 行 4 列）。尺寸示意图：外框是桌面一段（列数 × 4 行），实心块是组件占的地方，像 macOS 窗口平铺菜单的小图标 */
function glyph({ w, h }, cols) {
  const rows = 4;
  const u = 6; // 一格的单位
  const W = cols * u, H = rows * u;
  const pad = 1.5;
  const fw = w * u, fh = Math.min(h, rows) * u;
  return `<svg viewBox="${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}" width="${(W + pad * 2) * (cols > 4 ? 1.05 : 1.35)}" aria-hidden="true">
    <rect x="0" y="0" width="${W}" height="${H}" rx="3.5" class="g-frame"/>
    <rect x="1.6" y="1.6" width="${Math.max(fw - 3.2, 2)}" height="${Math.max(fh - 3.2, 2)}" rx="2" class="g-fill"/>
  </svg>`;
}

/**
 * 列表按格子实际大小取舍：组件里标了 .fit 的容器，放不下的整行连同后面的都藏起来，不会出现被切掉半截的行。
 * 组件画的时候尽量多给几行，剩下的交给这里。.fit-sep 是小标题，它后面一行都没露出来时也一起藏掉。
 * 用 offsetTop 量（不受编辑模式晃动的 transform 影响），.fit 自己要是定位元素。
 */
export function fitRows(root) {
  for (const box of root.querySelectorAll(".fit")) {
    const items = [...box.children];
    for (const n of items) n.classList.remove("cut");
    const h = box.clientHeight;
    if (!h) continue;
    let cut = items.findIndex((n) => n.offsetTop + n.offsetHeight > h + 1);
    if (cut < 0) continue;
    // 第一行总是留着（一行都放不下时由它自己的行数限制收住），免得组件整个空掉
    cut = Math.max(cut, 1);
    while (cut > 1 && items[cut - 1].classList.contains("fit-sep")) cut--;
    for (const n of items.slice(cut)) n.classList.add("cut");
  }
}
export const resetLayout = () => local.set(KEY, null);

/** 一个小组件的外壳：内容 + 编辑时才出现的“移除”“换大小”按钮 */
export function shell(id, size, w, body) {
  return `<div class="w size-${size}" data-w="${esc(id)}" data-size="${size}">
    ${body}
    <button class="w-del" data-desk="remove" aria-label="移除${esc(w.name)}" tabindex="-1">${icon("minus")}</button>
    ${w.sizes.length > 1 ? `<button class="w-size" data-desk="resize" aria-label="调整大小" aria-haspopup="menu" tabindex="-1">${icon("resize")}</button>` : ""}
  </div>`;
}

/**
 * 接管一块桌面。
 * opts.widgets：{ id: { name, desc, sizes, group } }；opts.render(id, size)：画一个组件（含外壳）；
 * opts.defaults：默认布局。返回 { refresh(ids) } 用来在数据到了之后重画某几个组件。
 */
let teardown = null;

export function mountDesk(root, opts) {
  // 首页每画一次就接管一次：先拆掉上一次挂在 window / document 上的监听
  teardown?.();
  const ctl = new AbortController();
  const sig = { signal: ctl.signal };
  teardown = () => ctl.abort();
  const grid = root.querySelector(".desk-grid");
  let layout = loadLayout(opts.widgets, opts.defaults);

  const current = () => [...grid.querySelectorAll(":scope > .w")].map((el) => [el.dataset.w, el.dataset.size]);
  const commit = () => {
    layout = current();
    saveLayout(layout);
    root.classList.toggle("empty", !layout.length);
  };
  root.classList.toggle("empty", !layout.length);

  // 组件换了大小、重画了、窗口宽度变了、字体到了，都重新量一遍哪些行放得下
  let fitting = 0;
  const refit = () => {
    cancelAnimationFrame(fitting);
    fitting = requestAnimationFrame(() => fitRows(grid));
  };
  const ro = new ResizeObserver(refit);
  ro.observe(grid);
  const mo = new MutationObserver(refit);
  mo.observe(grid, { childList: true });
  ctl.signal.addEventListener("abort", () => {
    ro.disconnect();
    mo.disconnect();
    cancelAnimationFrame(fitting);
    closeMenu();
    hideGhost();
  });
  document.fonts?.ready.then(() => !ctl.signal.aborted && refit());
  fitRows(grid);

  /** 网格此刻的列数、格子边长、间距 */
  function metrics() {
    const cs = getComputedStyle(grid);
    const cols = cs.gridTemplateColumns.split(" ").filter(Boolean).length || 4;
    const gap = parseFloat(cs.columnGap) || 0;
    const cell = (grid.clientWidth - gap * (cols - 1)) / cols;
    return { cols, gap, cell };
  }
  const px = (n, m) => n * m.cell + (n - 1) * m.gap;

  /** 组件在网格里本来的位置（不算拖动位移、晃动），相对视口 */
  function homeRect(el) {
    const g = grid.getBoundingClientRect();
    // .desk-grid 是定位元素（见 CSS），offsetLeft/Top 就是相对它的
    return { left: g.left + grid.clientLeft + el.offsetLeft, top: g.top + grid.clientTop + el.offsetTop };
  }

  // ---------- 编辑模式 ----------

  const editing = () => root.classList.contains("editing");
  function setTabbable(el, on) {
    if (on) el.tabIndex = 0;
    else el.removeAttribute("tabindex");
    for (const b of el.querySelectorAll(".w-del, .w-size")) b.tabIndex = on ? 0 : -1;
  }
  function enterEdit() {
    if (editing()) return;
    root.classList.add("editing");
    document.body.classList.add("desk-editing");
    for (const el of grid.querySelectorAll(".w")) setTabbable(el, true);
    navigator.vibrate?.(12);
  }
  function exitEdit() {
    if (!editing()) return;
    root.classList.remove("editing");
    document.body.classList.remove("desk-editing");
    for (const el of grid.querySelectorAll(".w")) setTabbable(el, false);
    closeGallery();
    closeMenu();
  }

  root.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-desk]");
    if (btn) {
      ev.preventDefault();
      ev.stopPropagation();
      const el = btn.closest(".w");
      ({
        edit: enterEdit,
        done: exitEdit,
        add: openGallery,
        reset: () => {
          if (!confirm("恢复成默认的桌面布局？")) return;
          resetLayout();
          closeMenu();
          layout = loadLayout(opts.widgets, opts.defaults);
          grid.innerHTML = layout.map(([id, size]) => opts.render(id, size)).join("");
          commit();
          if (editing()) {
            root.classList.remove("editing");
            enterEdit();
          }
        },
        remove: () => removeWidget(el),
        // 轻点手柄：弹出尺寸菜单；刚拖过手柄改大小时那一下点击不算
        resize: () => {
          if (resizedAt && performance.now() - resizedAt < 400) return;
          menu?.el === el ? closeMenu() : openMenu(el);
        },
      })[btn.dataset.desk]?.();
      return;
    }
    // 编辑时卡片里的链接、按钮都不响应，免得拖着拖着跳走了
    if (editing() && ev.target.closest(".w")) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }, true);

  function removeWidget(el) {
    if (menu?.el === el) closeMenu();
    flip(() => el.remove(), el);
    commit();
  }

  /** 换成某个尺寸：重画这个组件，别的卡片滑到新位置；返回新的元素 */
  function setSize(el, size, { animate = true } = {}) {
    if (!el || el.dataset.size === size) return el;
    const id = el.dataset.w;
    const before = el.getBoundingClientRect();
    flip(() => {
      el.outerHTML = opts.render(id, size);
    });
    const fresh = grid.querySelector(`.w[data-w="${CSS.escape(id)}"]`);
    if (fresh) {
      if (editing()) setTabbable(fresh, true);
      if (animate) {
        // 自己从旧的大小“长”到新的大小：左上角不动，按比例缩放过去
        const after = fresh.getBoundingClientRect();
        if (after.width && after.height) {
          fresh.animate(
            [
              { transformOrigin: "0 0", transform: `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(${before.width / after.width}, ${before.height / after.height})` },
              { transformOrigin: "0 0", transform: "none" },
            ],
            { duration: 260, easing: "cubic-bezier(.2,.9,.25,1)" },
          );
        }
      }
    }
    commit();
    return fresh;
  }

  /**
   * 改动前后各量一次位置，让别的卡片滑到新位置，而不是一下子跳过去。
   * 上一段滑动还没走完时，从它此刻所在的位置接着滑（先量、再取消旧动画），不会闪回去。
   */
  const moving = new WeakMap();
  function flip(mutate, skip = null) {
    const items = [...grid.querySelectorAll(":scope > .w")].filter((n) => n !== skip && !n.classList.contains("dragging"));
    const before = new Map(items.map((n) => [n, n.getBoundingClientRect()]));
    for (const n of items) moving.get(n)?.cancel();
    mutate();
    for (const n of items) {
      if (!n.isConnected) continue;
      const a = before.get(n);
      const b = n.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      const anim = n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 300, easing: "cubic-bezier(.2,.85,.25,1)" });
      moving.set(n, anim);
    }
  }

  // 编辑时用键盘也能挪：方向键前后移动，Delete 移除，Enter 打开尺寸菜单
  grid.addEventListener("keydown", (ev) => {
    const el = ev.target.closest?.(".w");
    if (!editing() || !el || ev.target !== el) return;
    const back = ev.key === "ArrowLeft" || ev.key === "ArrowUp";
    const fwd = ev.key === "ArrowRight" || ev.key === "ArrowDown";
    if (ev.key === "Delete" || ev.key === "Backspace") return removeWidget(el);
    if (ev.key === "Enter" && el.querySelector(".w-size")) {
      ev.preventDefault();
      return openMenu(el);
    }
    if (!back && !fwd) return;
    ev.preventDefault();
    const sib = back ? el.previousElementSibling : el.nextElementSibling;
    if (!sib) return;
    flip(() => (back ? sib.before(el) : sib.after(el)));
    el.focus({ preventScroll: true });
    commit();
  });

  // ---------- 长按进入编辑、拖动换位置 ----------
  //
  // 鼠标：编辑时按下一挪就开始拖。触屏：先按住不动一小会儿才开始拖，手指一动就当成滚动页面。
  // 拖起来的卡片跟着指针走，原位留一个虚线“空位”；指针越过别的卡片的中线就插到它前 / 后面，其余卡片实时滑开。

  let drag = null;
  const HOLD_EDIT = 450; // 平时长按多久进入编辑
  const HOLD_DRAG = 160; // 编辑时触屏按住多久开始拖

  grid.addEventListener("pointerdown", (ev) => {
    if (ev.target.closest(".w-size") && editing()) return startResize(ev);
    const el = ev.target.closest(".w");
    if (!el || ev.button > 0 || ev.target.closest("[data-desk], input") || resize) return;
    closeMenu();
    const touch = ev.pointerType !== "mouse";
    drag = { el, id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY, active: false, armed: false, tx: 0, ty: 0, last: null, at: 0 };
    const arm = () => {
      if (!drag || drag.el !== el) return;
      if (!editing()) {
        enterEdit();
        suppressClick = true;
      }
      drag.armed = true;
      if (touch) {
        navigator.vibrate?.(8);
        el.classList.add("lifting");
      }
    };
    if (editing() && !touch) drag.armed = true;
    else drag.timer = setTimeout(arm, editing() ? HOLD_DRAG : HOLD_EDIT);
  });

  addEventListener("pointermove", (ev) => {
    if (resize && ev.pointerId === resize.id) return moveResize(ev);
    if (!drag || ev.pointerId !== drag.id) return;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    const moved = Math.hypot(drag.x - drag.x0, drag.y - drag.y0);
    if (!drag.armed) {
      if (moved > 8) cancel(); // 还没按够就动了：是在滚动页面
      return;
    }
    if (!drag.active) {
      if (moved < 4) return;
      start();
    }
    schedule();
  }, sig);
  addEventListener("pointerup", (ev) => {
    if (resize && ev.pointerId === resize.id) return endResize();
    if (drag && ev.pointerId === drag.id) finish();
  }, sig);
  addEventListener("pointercancel", (ev) => {
    if (resize && ev.pointerId === resize.id) return endResize();
    if (drag && ev.pointerId === drag.id) finish();
  }, sig);
  // 正在拖 / 改大小的时候别让页面跟着滚（触屏）
  document.addEventListener("touchmove", (ev) => {
    if (drag?.armed || resize) ev.preventDefault();
  }, { passive: false, signal: ctl.signal });
  // 卡片多是 <a>：浏览器原生的“拖链接”会吞掉后续 pointermove，桌面上一律不许
  grid.addEventListener("dragstart", (ev) => ev.preventDefault());
  // 长按菜单、长按后紧跟的那次点击都不要
  grid.addEventListener("contextmenu", (ev) => {
    if (drag?.armed || editing()) ev.preventDefault();
  });
  let suppressClick = false;
  grid.addEventListener("click", (ev) => {
    if (!suppressClick) return;
    suppressClick = false;
    ev.preventDefault();
    ev.stopPropagation();
  }, true);

  function cancel() {
    clearTimeout(drag?.timer);
    drag?.el.classList.remove("lifting");
    drag = null;
  }

  // 指针事件很密，跟随和命中检测合到每帧一次
  let frame = 0;
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!drag?.active) return;
      follow();
      hitTest();
    });
  }

  function start() {
    drag.active = true;
    const r = drag.el.getBoundingClientRect();
    drag.gx = drag.x0 - r.left;
    drag.gy = drag.y0 - r.top;
    moving.get(drag.el)?.cancel();
    drag.el.classList.remove("lifting");
    drag.el.classList.add("dragging");
    root.classList.add("dragging-any");
    slot = document.createElement("div");
    slot.className = "desk-slot";
    grid.append(slot);
    placeSlot();
    drag.scroll = setInterval(autoScroll, 16);
    follow();
  }

  /** 原位的虚线空位：跟着被拖卡片在网格里的真实位置走 */
  let slot = null;
  function placeSlot() {
    if (!slot || !drag) return;
    const el = drag.el;
    const s = slot.style;
    const to = { left: el.offsetLeft, top: el.offsetTop };
    const from = slot.dataset.ready ? { left: parseFloat(s.left), top: parseFloat(s.top) } : to;
    s.left = `${to.left}px`;
    s.top = `${to.top}px`;
    s.width = `${el.offsetWidth}px`;
    s.height = `${el.offsetHeight}px`;
    s.borderRadius = getComputedStyle(el).borderRadius;
    if (slot.dataset.ready && (from.left !== to.left || from.top !== to.top)) {
      slot.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: "none" }], { duration: 300, easing: "cubic-bezier(.2,.85,.25,1)" });
    }
    slot.dataset.ready = "1";
  }

  /** 卡片跟着指针走：算出它不带位移时本该在哪，再补上差值 */
  function follow() {
    const home = homeRect(drag.el);
    drag.tx = drag.x - drag.gx - home.left;
    drag.ty = drag.y - drag.gy - home.top;
    drag.el.style.transform = `translate(${drag.tx}px, ${drag.ty}px) scale(1.035)`;
  }

  /**
   * 换位规则（防“鬼畜”）：
   * 1. 命中检测用卡片的最终位置（offsetLeft/Top），不看正在滑动中的位置——滑到一半的卡片经过指针下面不算数。
   * 2. 一次换位只有在让“空位”离指针更近时才接受：先试着挪一下、量一量，不更近就原样放回（不动画）。
   *    网格是 dense 流，大小不一的卡片换位后别的卡片会补位，这一步保证不会出现 A↔B 来回弹。
   * 3. 换位后指针要再走开一段（或等滑动结束）才允许下一次，同时记住上一次的顺序，回到上一个顺序要求指针走得更远。
   */
  const rectOf = (el) => {
    const h = homeRect(el);
    return { left: h.left, top: h.top, right: h.left + el.offsetWidth, bottom: h.top + el.offsetHeight, width: el.offsetWidth, height: el.offsetHeight };
  };
  const inside = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  /** 指针到被拖卡片空位的距离（指针在空位里抓着的那个点为准） */
  const slotDist = () => {
    const r = rectOf(drag.el);
    return Math.hypot(r.left + drag.gx - drag.x, r.top + drag.gy - drag.y);
  };
  const orderKey = () => [...grid.querySelectorAll(":scope > .w")].map((n) => n.dataset.w).join("|");

  function hitTest() {
    const now = performance.now();
    if (drag.lockUntil && now < drag.lockUntil && Math.hypot(drag.x - drag.lx, drag.y - drag.ly) < 28) return;
    const items = [...grid.querySelectorAll(":scope > .w")];
    const others = items.filter((n) => n !== drag.el);
    const target = others.find((w) => inside(rectOf(w), drag.x, drag.y));
    if (!target) {
      // 拖到所有卡片下面的空白处：放到最后
      const lastEl = items[items.length - 1];
      const g = grid.getBoundingClientRect();
      if (lastEl !== drag.el && others.length && drag.y > Math.max(...others.map((n) => rectOf(n).bottom)) && drag.y < g.bottom + 80) {
        tryMove(() => lastEl.after(drag.el));
      }
      return;
    }
    const r = rectOf(target);
    const forward = items.indexOf(target) > items.indexOf(drag.el);
    // 越过中线才换：往后拖看是否过了左/上 35%，往前拖看是否过了右/下 65%
    const fx = (drag.x - r.left) / r.width;
    const fy = (drag.y - r.top) / r.height;
    const past = forward ? Math.max(fx, fy) > 0.35 : Math.min(fx, fy) < 0.65;
    if (!past) return;
    tryMove(() => (forward ? target.after(drag.el) : target.before(drag.el)));
  }

  function tryMove(mutate) {
    const el = drag.el;
    const before = slotDist();
    const keyBefore = orderKey();
    const next = el.nextElementSibling;
    // 试挪：同步改 DOM、量完立刻放回，浏览器不会画出中间状态
    mutate();
    const keyAfter = orderKey();
    const after = slotDist();
    next ? next.before(el) : grid.append(el);
    if (keyAfter === keyBefore) return;
    // 回到上一次的顺序：指针得离开上次换位的地方足够远，才认为是真想换回去
    const undo = keyAfter === drag.prevKey && Math.hypot(drag.x - drag.lx, drag.y - drag.ly) < 60;
    if (undo || after > before - 6) return;
    flip(mutate, el);
    grid.append(slot); // 空位永远在最后，不占网格顺序
    drag.prevKey = keyBefore;
    drag.lx = drag.x;
    drag.ly = drag.y;
    drag.lockUntil = performance.now() + 220;
    placeSlot();
    follow();
  }

  function autoScroll() {
    if (!drag?.active) return;
    const edge = 80;
    const v = drag.y < edge ? -(edge - drag.y) / 3.5 : drag.y > innerHeight - edge ? (drag.y - (innerHeight - edge)) / 3.5 : 0;
    if (!v) return;
    scrollBy(0, v);
    follow();
    hitTest();
  }

  function finish() {
    clearTimeout(drag.timer);
    clearInterval(drag.scroll);
    cancelAnimationFrame(frame);
    frame = 0;
    drag.el.classList.remove("lifting");
    if (drag.active) {
      const el = drag.el;
      const from = el.style.transform;
      el.style.transform = "";
      el.classList.remove("dragging");
      root.classList.remove("dragging-any");
      // 落下：从指针下的位置弹回空位
      el.animate([{ transform: from }, { transform: "scale(.99)", offset: 0.75 }, { transform: "none" }], { duration: 280, easing: "cubic-bezier(.2,.9,.3,1)" });
      slot?.remove();
      slot = null;
      commit();
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
    }
    drag = null;
  }

  // ---------- 拖右下角手柄改大小 ----------
  //
  // 按住手柄拖：虚线框跟着指针画出想要的大小，组件实时吸附到它支持的、和虚线框最接近的尺寸，别的卡片同步让位。
  // 没怎么动就松开 = 轻点，交给 click 打开尺寸菜单。

  let resize = null;
  let resizedAt = 0;

  function startResize(ev) {
    if (ev.button > 0) return;
    const el = ev.target.closest(".w");
    ev.preventDefault();
    ev.stopPropagation();
    resize = { el, id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, active: false };
  }

  function moveResize(ev) {
    const r = resize;
    r.x = ev.clientX;
    r.y = ev.clientY;
    if (!r.active) {
      if (Math.hypot(r.x - r.x0, r.y - r.y0) < 5) return;
      r.active = true;
      closeMenu();
      root.classList.add("resizing-any");
      r.el.classList.add("resizing");
      navigator.vibrate?.(8);
    }
    const m = metrics();
    const home = homeRect(r.el);
    // 想要的列数、行数（连续值）：指针到组件左上角的距离换算成格子
    const wantW = Math.max(0.5, (r.x - home.left + m.gap / 2) / (m.cell + m.gap));
    const wantH = Math.max(0.5, (r.y - home.top + m.gap / 2) / (m.cell + m.gap));
    showGhost(home.left, home.top, Math.max(r.x - home.left, 24), Math.max(r.y - home.top, 24), null);
    const w = opts.widgets[r.el.dataset.w];
    const dist = (s) => {
      const d = dims(s, m.cols);
      return (d.w - wantW) ** 2 + (d.h - wantH) ** 2;
    };
    const best = [...w.sizes].sort((a, b) => dist(a) - dist(b))[0];
    const cur = r.el.dataset.size;
    // 一点滞后：新尺寸要明显更接近才换，免得在两个尺寸中间来回跳
    if (best !== cur && dist(best) + 0.35 < dist(cur)) {
      r.el = setSize(r.el, best);
      r.el.classList.add("resizing");
      navigator.vibrate?.(6);
    }
    const d = dims(r.el.dataset.size, m.cols);
    ghostLabel(`${d.h}-${d.w}`);
  }

  function endResize() {
    const r = resize;
    resize = null;
    if (!r?.active) return; // 轻点：click 会打开菜单
    resizedAt = performance.now();
    r.el?.classList.remove("resizing");
    root.classList.remove("resizing-any");
    hideGhost();
    r.el?.focus({ preventScroll: true });
  }

  /** 虚线预览框（改大小、在菜单里悬停某个尺寸时都用它），位置相对视口 */
  let ghost = null;
  function showGhost(left, top, width, height, label) {
    if (!ghost) {
      ghost = document.createElement("div");
      ghost.className = "desk-ghost";
      ghost.innerHTML = `<span></span>`;
      document.body.append(ghost);
    }
    Object.assign(ghost.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    if (label != null) ghostLabel(label);
  }
  const ghostLabel = (t) => ghost && (ghost.firstElementChild.textContent = t);
  function hideGhost() {
    ghost?.remove();
    ghost = null;
  }

  // ---------- 尺寸菜单（轻点手柄） ----------
  //
  // 借鉴 macOS 绿灯菜单：上面一排是这个组件能用的尺寸，每个画成“桌面一段 + 实心块”的小图；
  // 悬停 / 聚焦某个尺寸时在组件原位画虚线预览，点一下就换成那个尺寸。下面一排是排列：移到最前、移到最后、移除。

  let menu = null;
  let menuClosedAt = 0;
  function openMenu(el) {
    closeMenu();
    const w = opts.widgets[el.dataset.w];
    const m = metrics();
    // 手机上 1-8 和 1-4 都是一整行，只留一个（当前用着的那个优先）
    const seen = new Map();
    for (const s of w.sizes) {
      const d = dims(s, m.cols);
      const k = `${d.w}x${d.h}`;
      if (!seen.has(k) || s === el.dataset.size) seen.set(k, s);
    }
    const options = [...seen.values()].sort((a, b) => w.sizes.indexOf(a) - w.sizes.indexOf(b));
    const pop = document.createElement("div");
    pop.className = "desk-menu";
    pop.setAttribute("role", "menu");
    pop.setAttribute("aria-label", `调整${w.name}的大小`);
    pop.innerHTML = `
      <p class="dm-title">调整大小</p>
      <div class="dm-sizes">${options
        .map((s) => {
          const d = dims(s, m.cols);
          const on = s === el.dataset.size;
          return `<button role="menuitemradio" aria-checked="${on}" class="dm-size${on ? " on" : ""}" data-size="${s}" title="${esc(sizeName(s))}">
            ${glyph(d, m.cols)}<small>${d.h}-${d.w}</small>
          </button>`;
        })
        .join("")}</div>
      <hr>
      <p class="dm-title">排列</p>
      <div class="dm-acts">
        <button role="menuitem" data-act="first">${icon("left")}移到最前</button>
        <button role="menuitem" data-act="last">移到最后${icon("right")}</button>
        <button role="menuitem" data-act="remove" class="danger">${icon("minus")}移除</button>
      </div>`;
    document.body.append(pop);
    menu = { el, pop };
    el.classList.add("menu-open");
    placeMenu();

    const preview = (s) => {
      if (!menu) return;
      const mm = metrics();
      const d = dims(s, mm.cols);
      const home = homeRect(menu.el);
      showGhost(home.left, home.top, px(d.w, mm), px(d.h, mm), `${d.h}-${d.w}`);
    };
    pop.addEventListener("pointerover", (ev) => {
      const b = ev.target.closest(".dm-size");
      if (b) preview(b.dataset.size);
    });
    pop.addEventListener("focusin", (ev) => {
      const b = ev.target.closest(".dm-size");
      if (b) preview(b.dataset.size);
      else hideGhost();
    });
    pop.addEventListener("pointerleave", hideGhost);
    pop.addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (!b || !menu) return;
      const target = menu.el;
      if (b.dataset.size) {
        hideGhost();
        closeMenu();
        const fresh = setSize(target, b.dataset.size);
        fresh?.focus({ preventScroll: true });
        return;
      }
      closeMenu();
      if (b.dataset.act === "remove") return removeWidget(target);
      flip(() => (b.dataset.act === "first" ? grid.prepend(target) : grid.append(target)));
      commit();
      target.focus({ preventScroll: true });
      target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    pop.addEventListener("keydown", (ev) => {
      const items = [...pop.querySelectorAll("button")];
      const i = items.indexOf(document.activeElement);
      if (ev.key === "ArrowRight" || ev.key === "ArrowDown") items[(i + 1) % items.length].focus();
      else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") items[(i - 1 + items.length) % items.length].focus();
      else return;
      ev.preventDefault();
    });
    (pop.querySelector(".dm-size.on") ?? pop.querySelector("button"))?.focus({ preventScroll: true });
    pop.animate([{ opacity: 0, transform: "translateY(-4px) scale(.97)" }, { opacity: 1, transform: "none" }], { duration: 160, easing: "ease-out" });
  }

  /** 菜单贴着手柄弹出，放不下就翻到上面 / 左边 */
  function placeMenu() {
    if (!menu) return;
    const h = menu.el.querySelector(".w-size")?.getBoundingClientRect() ?? menu.el.getBoundingClientRect();
    const p = menu.pop;
    const pw = p.offsetWidth, ph = p.offsetHeight;
    let left = h.left + h.width / 2 - pw / 2;
    let top = h.bottom + 8;
    if (top + ph > innerHeight - 8) top = h.top - ph - 8;
    left = Math.min(Math.max(8, left), innerWidth - pw - 8);
    top = Math.max(8, top);
    p.style.left = `${left}px`;
    p.style.top = `${top}px`;
  }

  function closeMenu() {
    if (!menu) return;
    menu.pop.remove();
    menu.el.classList.remove("menu-open");
    menu = null;
    if (!resize) hideGhost();
  }
  // 点菜单外面、滚动、改窗口大小都收起菜单
  document.addEventListener("pointerdown", (ev) => {
    if (menu && !menu.pop.contains(ev.target) && !ev.target.closest?.(".w-size")) {
      closeMenu();
      menuClosedAt = performance.now();
    }
  }, { capture: true, signal: ctl.signal });
  addEventListener("scroll", () => menu && closeMenu(), { passive: true, signal: ctl.signal });
  addEventListener("resize", () => menu && closeMenu(), sig);

  // 点桌面空白处、按 Esc 都算“完成”（菜单开着时先收菜单）
  root.addEventListener("pointerdown", (ev) => {
    // 这一下是用来收菜单的，就别顺带退出编辑
    if (editing() && ev.target === grid && performance.now() - menuClosedAt > 50) exitEdit();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || !editing()) return;
    if (menu) {
      const el = menu.el;
      closeMenu();
      el.focus({ preventScroll: true });
    } else if (gallery) closeGallery();
    else exitEdit();
  }, sig);
  // 离开首页：退出编辑，拆掉监听
  addEventListener("hashchange", () => {
    exitEdit();
    ctl.abort();
  }, sig);

  // ---------- 组件库 ----------

  let gallery = null;
  function openGallery() {
    closeGallery();
    const have = new Set(current().map(([id]) => id));
    const groups = [["widget", "小组件"], ["app", "快捷图标"]];
    gallery = document.createElement("div");
    gallery.className = "desk-sheet";
    gallery.innerHTML = `<div class="sheet-back" data-sheet="close"></div>
      <section class="sheet" role="dialog" aria-modal="true" aria-label="添加小组件">
        <header><h2>添加小组件</h2><button class="icon-btn sm" data-sheet="close" aria-label="关闭">${icon("close")}</button></header>
        ${groups
          .map(([g, title]) => `<h3>${title}</h3><ul>${Object.entries(opts.widgets)
            .filter(([, w]) => w.group === g)
            .sort(([a], [b]) => Number(have.has(a)) - Number(have.has(b))) // 还没放上桌面的排前面
            .map(([id, w]) => `<li class="${have.has(id) ? "have" : ""}">
              <span class="g-ic">${icon(w.icon ?? "grid")}</span>
              <div><b>${esc(w.name)}</b><small>${have.has(id) ? "已在桌面上" : esc(w.desc ?? "")}</small></div>
              <span class="g-sizes">${have.has(id)
                ? ""
                : w.sizes.map((s) => `<button data-sheet="add" data-id="${esc(id)}" data-size="${s}">${w.sizes.length > 1 ? sizeName(s) : "添加"}</button>`).join("")}</span>
            </li>`)
            .join("")}</ul>`)
          .join("")}
      </section>`;
    document.body.append(gallery);
    gallery.querySelector(".sheet").animate([{ transform: "translateY(24px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 220, easing: "ease-out" });
    gallery.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-sheet]");
      if (!b) return;
      if (b.dataset.sheet === "close") return closeGallery();
      addWidget(b.dataset.id, b.dataset.size);
    });
    gallery.querySelector("button")?.focus();
  }

  function closeGallery() {
    gallery?.remove();
    gallery = null;
  }

  /** 新组件放在最前面，滚过去让人看到 */
  function addWidget(id, size) {
    closeGallery();
    flip(() => grid.insertAdjacentHTML("afterbegin", opts.render(id, size)));
    const el = grid.firstElementChild;
    if (editing()) setTabbable(el, true);
    commit();
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.animate([{ transform: "scale(.6)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 260, easing: "cubic-bezier(.3,1.4,.5,1)" });
  }

  return {
    /** 数据晚到了：把用到这些数据的组件重画一遍（拖着的时候不动） */
    refresh(ids) {
      if (drag?.active || resize?.active) return;
      for (const el of grid.querySelectorAll(".w")) {
        if (!ids.includes(el.dataset.w)) continue;
        const open = menu?.el === el;
        if (open) closeMenu();
        el.outerHTML = opts.render(el.dataset.w, el.dataset.size);
        const fresh = grid.querySelector(`.w[data-w="${CSS.escape(el.dataset.w)}"]`);
        if (fresh && editing()) setTabbable(fresh, true);
      }
    },
  };
}
