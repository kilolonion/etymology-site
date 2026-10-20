// 网页推送：注册 Service Worker、订阅 / 取消订阅

import { api } from "./lib.js?v=212dd6fbae";
import { isStale, versionOfHtml } from "./update.js?v=212dd6fbae";

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

let regPromise;
let pageVersion = ""; // 这个页面自己跑的前端版本

/**
 * 注册 Service Worker。地址带上当前前端的内容版本号：Cloudflare 会给 .js 盖几小时缓存，
 * 不带版本号的话，新部署的 sw.js 要等缓存过期才被手机发现。版本号由 main.js 从自己的 import 地址里取出。
 *
 * 注意：页面跑的是旧版时注册的也是旧地址，所以“有没有新版”不能靠 SW 更新来发现，
 * 而是页面直接去比对线上首页的版本号（checkForUpdate）。
 */
export function registerSW(version = "") {
  if (!("serviceWorker" in navigator)) return;
  pageVersion = version;
  regPromise = navigator.serviceWorker.register(version ? `/sw.js?v=${version}` : "/sw.js").catch(() => null);

  // SW 后台发现新版本、并且把新版本的文件都存好了（ready），才提示刷新：这时点刷新是瞬间的，不会对着白屏等
  navigator.serviceWorker.addEventListener("message", (ev) => {
    const { type, version } = ev.data ?? {};
    if (type !== "ready" && type !== "updated") return;
    if (!navigator.serviceWorker.controller) return; // 首次安装，页面本来就是新版
    if (isStale(pageVersion, version)) promptUpdate(version);
  });

  // 打开几秒后、以及每次回到前台，去看一眼线上是不是已经有新版本了
  setTimeout(checkForUpdate, 4000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForUpdate();
  });
}

let lastCheck = 0;
/**
 * 看线上有没有新版本（一分钟内最多查一次）。有 Service Worker 时交给它：它取线上页面、把新文件预取好再发 ready；
 * 没有 SW（或还没接管）才自己拉首页比版本号。
 */
export async function checkForUpdate(force = false) {
  if (!pageVersion || (!force && Date.now() - lastCheck < 60_000)) return;
  lastCheck = Date.now();
  const sw = navigator.serviceWorker?.controller;
  if (sw) {
    sw.postMessage({ type: "check" });
    return;
  }
  try {
    const res = await fetch("/", { cache: "no-store" });
    if (!res.ok) return;
    const latest = versionOfHtml(await res.text());
    if (isStale(pageVersion, latest)) promptUpdate(latest);
  } catch {}
}

/** 同一个新版本在一次会话里只提醒一遍 */
function promptUpdate(version) {
  try {
    if (sessionStorage.getItem("ety-updated") === version) return;
    sessionStorage.setItem("ety-updated", version);
  } catch {}
  showUpdateBar();
}

/** 顶部小条：有新版本，点一下刷新 */
function showUpdateBar() {
  if (document.querySelector(".update-bar")) return;
  const bar = document.createElement("button");
  bar.className = "update-bar";
  bar.setAttribute("role", "status");
  bar.textContent = "词源一日已更新，点这里刷新";
  bar.addEventListener("click", () => location.reload());
  document.body.append(bar);
  // 到点淡出再摘掉，别突然消失
  setTimeout(() => {
    bar.classList.add("leaving");
    bar.addEventListener("animationend", () => bar.remove(), { once: true });
    setTimeout(() => bar.remove(), 600); // 兜底：动画被系统“减少动效”关掉时 animationend 可能不来
  }, 15000);
}

/**
 * 当前设备的提醒状态：
 * on / off / denied（被浏览器拒绝）/ needs-install（iPhone 需先添加到主屏幕）/ unsupported
 */
export async function pushStatus() {
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!supported) return isIOS && !isStandalone() ? "needs-install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await regPromise;
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

function keyToBytes(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("没有获得通知权限");
  const reg = await regPromise;
  if (!reg) throw new Error("Service Worker 注册失败");
  const { publicKey } = await api("/reminder");
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) });
  await api("/push/subscribe", { method: "POST", body: { subscription: sub.toJSON() } });
  await api("/push/test", { method: "POST" }).catch(() => {});
}

export async function disablePush() {
  const reg = await regPromise;
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api("/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
}
