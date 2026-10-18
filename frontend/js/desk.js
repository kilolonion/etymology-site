// 首页桌面：像手机主屏幕一样摆小组件。
// 长按任意卡片（或点“编辑主屏幕”）进入编辑：卡片轻轻晃动，可以拖动换位置、点 − 移除、点右下角换大小、点 ＋ 从组件库添加。
// 布局只存在这台设备上（手机和电脑屏幕不一样，各摆各的）。
//
// 网格：手机 4 列、宽屏 8 列，格子是正方形。尺寸：图标 1×1、小 2×2、中 4×2、大 4×4、条 4×1。
// 排列按顺序从左上往右下填（grid-auto-flow: dense，小的会补进空位），拖动改的是顺序。

import { esc, icon, local } from "./lib.js";

const KEY = "desk-layout";
export const SIZE_NAME = { icon: "图标", s: "小", m: "中", l: "大", bar: "条" };

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
export const resetLayout = () => local.set(KEY, null);

/** 一个小组件的外壳：内容 + 编辑时才出现的“移除”“换大小”按钮 */
export function shell(id, size, w, body) {
  return `<div class="w size-${size}" data-w="${esc(id)}" data-size="${size}">
    ${body}
    <button class="w-del" data-desk="remove" aria-label="移除${esc(w.name)}" tabindex="-1">${icon("minus")}</button>
    ${w.sizes.length > 1 ? `<button class="w-size" data-desk="resize" aria-label="换个大小" tabindex="-1">${icon("resize")}</button>` : ""}
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

  // ---------- 编辑模式 ----------

  const editing = () => root.classList.contains("editing");
  function enterEdit() {
    if (editing()) return;
    root.classList.add("editing");
    document.body.classList.add("desk-editing");
    for (const el of grid.querySelectorAll(".w")) el.tabIndex = 0;
    for (const b of grid.querySelectorAll(".w-del, .w-size")) b.tabIndex = 0;
    navigator.vibrate?.(12);
  }
  function exitEdit() {
    if (!editing()) return;
    root.classList.remove("editing");
    document.body.classList.remove("desk-editing");
    for (const el of grid.querySelectorAll(".w")) el.removeAttribute("tabindex");
    for (const b of grid.querySelectorAll(".w-del, .w-size")) b.tabIndex = -1;
    closeGallery();
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
          layout = loadLayout(opts.widgets, opts.defaults);
          grid.innerHTML = layout.map(([id, size]) => opts.render(id, size)).join("");
          commit();
          if (editing()) {
            root.classList.remove("editing");
            enterEdit();
          }
        },
        remove: () => removeWidget(el),
        resize: () => resizeWidget(el),
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
    flip(() => el.remove(), el);
    commit();
  }

  function resizeWidget(el) {
    const w = opts.widgets[el.dataset.w];
    const next = w.sizes[(w.sizes.indexOf(el.dataset.size) + 1) % w.sizes.length];
    flip(() => {
      el.outerHTML = opts.render(el.dataset.w, next);
    });
    const fresh = grid.querySelector(`.w[data-w="${CSS.escape(el.dataset.w)}"]`);
    if (fresh) {
      fresh.tabIndex = 0;
      for (const b of fresh.querySelectorAll(".w-del, .w-size")) b.tabIndex = 0;
      fresh.focus({ preventScroll: true });
    }
    commit();
  }

  /** 改动前后各量一次位置，让别的卡片滑到新位置，而不是一下子跳过去 */
  function flip(mutate, skip = null) {
    const items = [...grid.querySelectorAll(":scope > .w")].filter((n) => n !== skip);
    const before = new Map(items.map((n) => [n, n.getBoundingClientRect()]));
    mutate();
    for (const n of items) {
      if (!n.isConnected) continue;
      const a = before.get(n);
      const b = n.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (dx || dy) n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  }

  // 编辑时用键盘也能挪：方向键前后移动
  grid.addEventListener("keydown", (ev) => {
    const el = ev.target.closest?.(".w");
    if (!editing() || !el || ev.target !== el) return;
    const back = ev.key === "ArrowLeft" || ev.key === "ArrowUp";
    const fwd = ev.key === "ArrowRight" || ev.key === "ArrowDown";
    if (ev.key === "Delete" || ev.key === "Backspace") return removeWidget(el);
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

  let drag = null;
  const HOLD_EDIT = 480; // 平时长按多久进入编辑
  const HOLD_DRAG = 180; // 编辑时触屏按住多久开始拖

  grid.addEventListener("pointerdown", (ev) => {
    const el = ev.target.closest(".w");
    if (!el || ev.button > 0 || ev.target.closest("[data-desk], input")) return;
    const touch = ev.pointerType !== "mouse";
    drag = { el, id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY, active: false, armed: false, tx: 0, ty: 0, last: null };
    const arm = () => {
      if (!drag || drag.el !== el) return;
      if (!editing()) {
        enterEdit();
        suppressClick = true;
      }
      drag.armed = true;
    };
    if (editing() && !touch) drag.armed = true;
    else drag.timer = setTimeout(arm, editing() ? HOLD_DRAG : HOLD_EDIT);
  });

  addEventListener("pointermove", (ev) => {
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
    follow();
    hitTest();
  }, sig);
  addEventListener("pointerup", (ev) => drag && ev.pointerId === drag.id && finish(), sig);
  addEventListener("pointercancel", (ev) => drag && ev.pointerId === drag.id && finish(), sig);
  // 正在拖的时候别让页面跟着滚（触屏）
  document.addEventListener("touchmove", (ev) => {
    if (drag?.armed) ev.preventDefault();
  }, { passive: false, signal: ctl.signal });
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
    drag = null;
  }

  function start() {
    drag.active = true;
    const r = drag.el.getBoundingClientRect();
    drag.gx = drag.x0 - r.left;
    drag.gy = drag.y0 - r.top;
    drag.el.classList.add("dragging");
    root.classList.add("dragging-any");
    drag.scroll = setInterval(autoScroll, 16);
  }

  /** 卡片跟着指针走：算出它不带位移时本该在哪，再补上差值 */
  function follow() {
    const r = drag.el.getBoundingClientRect();
    const left = r.left - drag.tx;
    const top = r.top - drag.ty;
    drag.tx = drag.x - drag.gx - left;
    drag.ty = drag.y - drag.gy - top;
    drag.el.style.transform = `translate(${drag.tx}px, ${drag.ty}px) scale(1.04)`;
  }

  /** 指针落在哪张卡片中间，就把被拖的卡片挪到它的位置；离开那张卡片前不再和它换，免得来回抖 */
  function hitTest() {
    const target = document
      .elementsFromPoint(drag.x, drag.y)
      .map((n) => n.closest?.(".w"))
      .find((w) => w && w !== drag.el && grid.contains(w));
    if (!target) {
      drag.last = null;
      return;
    }
    if (target === drag.last) return;
    const r = target.getBoundingClientRect();
    const inX = (drag.x - r.left) / r.width;
    const inY = (drag.y - r.top) / r.height;
    if (inX < 0.2 || inX > 0.8 || inY < 0.15 || inY > 0.85) return;
    drag.last = target;
    const items = [...grid.children];
    const after = items.indexOf(drag.el) < items.indexOf(target);
    flip(() => (after ? target.after(drag.el) : target.before(drag.el)), drag.el);
    follow();
  }

  function autoScroll() {
    if (!drag?.active) return;
    const edge = 70;
    const v = drag.y < edge ? -(edge - drag.y) / 4 : drag.y > innerHeight - edge ? (drag.y - (innerHeight - edge)) / 4 : 0;
    if (!v) return;
    scrollBy(0, v);
    follow();
    hitTest();
  }

  function finish() {
    clearTimeout(drag.timer);
    clearInterval(drag.scroll);
    if (drag.active) {
      const el = drag.el;
      const from = el.style.transform;
      el.style.transform = "";
      el.classList.remove("dragging");
      root.classList.remove("dragging-any");
      el.animate([{ transform: from }, { transform: "none" }], { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" });
      commit();
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
    }
    drag = null;
  }

  // 点桌面空白处、按 Esc 都算“完成”
  root.addEventListener("pointerdown", (ev) => {
    if (editing() && ev.target === grid) exitEdit();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && editing()) {
      if (gallery) closeGallery();
      else exitEdit();
    }
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
                : w.sizes.map((s) => `<button data-sheet="add" data-id="${esc(id)}" data-size="${s}">${w.sizes.length > 1 ? SIZE_NAME[s] : "添加"}</button>`).join("")}</span>
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
    if (editing()) {
      el.tabIndex = 0;
      for (const b of el.querySelectorAll(".w-del, .w-size")) b.tabIndex = 0;
    }
    commit();
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.animate([{ transform: "scale(.6)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 260, easing: "cubic-bezier(.3,1.4,.5,1)" });
  }

  return {
    /** 数据晚到了：把用到这些数据的组件重画一遍（拖着的时候不动） */
    refresh(ids) {
      if (drag?.active) return;
      for (const el of grid.querySelectorAll(".w")) {
        if (!ids.includes(el.dataset.w)) continue;
        el.outerHTML = opts.render(el.dataset.w, el.dataset.size);
      }
    },
  };
}
