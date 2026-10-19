// 网页推送：注册 Service Worker、订阅 / 取消订阅

import { api } from "./lib.js";

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

let regPromise;

/**
 * 注册 Service Worker。地址带上当前前端的内容版本号：Cloudflare 会给 .js 盖几小时缓存，
 * 不带版本号的话，新部署的 sw.js 要等缓存过期才被手机发现，页面就一直停在旧版上。
 * 版本号由 main.js 从自己的 import 地址里取出。
 */
export function registerSW(version = "") {
  if (!("serviceWorker" in navigator)) return;
  regPromise = navigator.serviceWorker.register(version ? `/sw.js?v=${version}` : "/sw.js").catch(() => null);
  // 回到前台时主动查一次更新，开着不动也能跟上新版本
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") regPromise?.then((r) => r?.update().catch(() => {}));
  });
  // 服务端换了新的 SW（跟着就是新版页面）：提示一声，让人自己决定什么时候刷新
  navigator.serviceWorker.addEventListener("message", (ev) => {
    if (ev.data?.type !== "updated") return;
    if (!navigator.serviceWorker.controller) return; // 首次安装，页面本来就是新版，不用提示
    if (sessionStorage.getItem("ety-updated") === ev.data.version) return; // 同一次更新只提醒一遍
    sessionStorage.setItem("ety-updated", ev.data.version ?? "1");
    showUpdateBar();
  });
}

/** 顶部小条：有新版本，点一下刷新 */
function showUpdateBar() {
  let bar = document.querySelector(".update-bar");
  if (bar) return;
  bar = document.createElement("button");
  bar.className = "update-bar";
  bar.setAttribute("role", "status");
  bar.textContent = "词源一日已更新，点这里刷新";
  bar.addEventListener("click", () => location.reload());
  document.body.append(bar);
  setTimeout(() => bar?.remove(), 15000);
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
