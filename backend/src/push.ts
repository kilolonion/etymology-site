// 网页推送提醒：每个用户到了自己设定的时间，如果今天的故事还没读，就把今天的问题推送到他订阅过的设备。
// VAPID 密钥全站共用：优先读环境变量，没有就首次启动时自动生成并存进数据库。

import webpush from "web-push";
import * as db from "./db.ts";
import { isDone, localDay, localTime, todayId } from "./daily.ts";
import { getEntry } from "./entries.ts";

/** 设定时间后多久之内还会补发（服务器重启、休眠后），超过就不发了 */
const WINDOW_MINUTES = 120;

let publicKey = "";

export function initPush(): void {
  let pub = process.env.VAPID_PUBLIC_KEY ?? "";
  let priv = process.env.VAPID_PRIVATE_KEY ?? "";
  if (!pub || !priv) {
    pub = db.getSetting("vapidPublic") ?? "";
    priv = db.getSetting("vapidPrivate") ?? "";
    if (!pub || !priv) {
      const keys = webpush.generateVAPIDKeys();
      pub = keys.publicKey;
      priv = keys.privateKey;
      db.setSetting("vapidPublic", pub);
      db.setSetting("vapidPrivate", priv);
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:admin@localhost", pub, priv);
  publicKey = pub;
  setInterval(() => tick().catch((err) => console.error("[push]", err)), 30_000);
}

export const vapidPublicKey = () => publicKey;

export function checkTime(time: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

async function tick(): Promise<void> {
  const day = localDay();
  const nowMin = minutes(localTime());
  for (const u of db.pushTargets()) {
    if (u.lastPushDay === day) continue;
    const diff = nowMin - minutes(u.reminderTime);
    if (diff < 0 || diff > WINDOW_MINUTES) continue;
    db.setLastPushDay(u.id, day);
    if (isDone(u.id, day)) continue;
    const e = getEntry(todayId(u.id, day) ?? "");
    if (!e) continue;
    await sendToUser(u.id, { title: "今天的问题", body: e.teaser.replace(/\*/g, ""), url: "/#/", tag: `daily-${day}` });
  }
}

export type PushPayload = { title: string; body: string; url: string; tag?: string };

/** 发给某个用户的所有设备，返回成功数；失效的订阅会被清理 */
export async function sendToUser(uid: number, payload: PushPayload): Promise<number> {
  let ok = 0;
  for (const sub of db.userPushSubs(uid)) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 6 * 3600 });
      ok++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) db.removePushSub(sub.endpoint);
      else console.error(`[push] 发送失败 (${code ?? "?"}):`, (err as Error).message);
    }
  }
  return ok;
}

export function isValidSub(x: unknown): x is db.PushSub {
  const s = x as db.PushSub;
  return typeof s?.endpoint === "string" && s.endpoint.startsWith("https://") &&
    typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string";
}
