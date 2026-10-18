// 网页推送：注册 Service Worker、订阅 / 取消订阅

import { api } from "./lib.js";

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

let regPromise;
export function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  regPromise = navigator.serviceWorker.register("/sw.js").catch(() => null);
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
