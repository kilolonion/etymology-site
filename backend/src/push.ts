// 网页推送提醒：每个用户到了自己设定的时间，如果今天的故事还没读，就把今天的问题推送到他订阅过的设备。
// 每周日晚上另发一条本周小结（这周读了几个、多来自哪种语言、连续几天）；一个词没读的那周不发。
// VAPID 密钥全站共用：优先读环境变量，没有就首次启动时自动生成并存进数据库。

import { getOrBuildPaper } from "./paper.ts";
import webpush from "web-push";
import * as db from "./db.ts";
import { isDone, localDay, localTime, streak, todayId, weekDays } from "./daily.ts";
import { getEntry } from "./entries.ts";

/** 设定时间后多久之内还会补发（服务器重启、休眠后），超过就不发了 */
const WINDOW_MINUTES = 120;
/** 周日几点发本周小结 */
const RECAP_TIME = "20:00";

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
    // 提醒顺便说一声日报出了：今天的问题放在正文，点开进日报（头版就是今天的词）
    const p = getOrBuildPaper(u.id, day, day);
    const n = p ? p.sections.reduce((a, x) => a + x.items.length, 0) + (p.lead ? 1 : 0) : 0;
    const title = n ? `今日日报 · ${n} 篇` : "今天的问题";
    await sendToUser(u.id, { title, body: e.teaser.replace(/\*/g, ""), url: n ? "/#/paper" : "/#/", tag: `daily-${day}` });
  }
  // 周日晚上：本周小结
  const week = weekDays(day);
  const recapDiff = nowMin - minutes(RECAP_TIME);
  if (day !== week[6] || recapDiff < 0 || recapDiff > WINDOW_MINUTES) return;
  for (const u of db.pushTargets()) {
    if (u.lastRecapDay === day) continue;
    db.setLastRecapDay(u.id, day);
    const body = recapText(u.id, week[0]!, day);
    if (body) await sendToUser(u.id, { title: "这一周的词", body, url: "/#/me/history", tag: `recap-${day}` });
  }
}

/** 本周小结：这周读了几个（不算手动标记的）、来得最多的语言、连续天数；一个没读就不发 */
export function recapText(uid: number, monday: string, day: string): string {
  const ids = db.readLog(uid).filter((r) => !r.manual && r.read_day >= monday && r.read_day <= day && getEntry(r.id)).map((r) => r.id);
  const counted = ids.length;
  if (!counted) return "";
  const langs = new Map<string, number>();
  for (const id of ids) for (const l of getEntry(id)!.langs ?? []) if (l !== "其他") langs.set(l, (langs.get(l) ?? 0) + 1);
  const [top] = [...langs].sort((a, b) => b[1] - a[1]);
  const heads = ids.slice(0, 3).map((id) => getEntry(id)!.headword).join("、");
  const s = streak(uid, day);
  return [
    `这周你读了 ${counted} 个词${heads ? `（${heads}${ids.length > 3 ? " 等" : ""}）` : ""}`,
    top ? `其中 ${top[1]} 个和${top[0]}有关` : "",
    s > 1 ? `已经连续 ${s} 天` : "",
  ].filter(Boolean).join("，") + "。";
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
