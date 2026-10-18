// 服务器上的管理命令（直接操作数据库，不需要登录）：
//   npm run admin -- invite [备注]       生成一个普通邀请码（7 天有效）
//   npm run admin -- invite-admin        生成一个管理员邀请码（忘了管理员密码、或想再加一个管理员时用）
//   npm run admin -- reset <用户名>      重置某人的密码，打印临时密码
//   npm run admin -- users               列出所有用户
//   npm run admin -- backup [目录]        把数据库拷一份快照（默认 var/backups/，只留最近 10 份）

import { readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { backupTo, findLogin, listUsers, openDb } from "../src/db.ts";

const ROOT = resolve(import.meta.dirname, "..");
openDb(process.env.STATE_DB ?? resolve(ROOT, "var/app.db"));
// 数据库打开后再加载认证模块（它在加载时会用到数据库）
const { newAdminInvite, newInvite, resetPassword } = await import("../src/auth.ts");

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "invite": {
    const admin = listUsers().find((u) => u.isAdmin);
    const code = newInvite(admin?.id, args.join(" "));
    console.log(`邀请码：${code}（7 天内有效）\n注册链接：<你的网址>/#/join/${code}`);
    break;
  }
  case "invite-admin": {
    const code = newAdminInvite();
    console.log(`管理员邀请码：${code}（24 小时内有效）\n注册链接：<你的网址>/#/join/${code}`);
    break;
  }
  case "reset": {
    const u = findLogin(args[0] ?? "");
    if (!u) {
      console.error(`没有用户“${args[0] ?? ""}”`);
      process.exit(1);
    }
    console.log(`${u.username} 的临时密码：${await resetPassword(u.id)}\n登录后请到“我的 → 账号与安全”里修改。`);
    break;
  }
  case "users": {
    for (const u of listUsers()) {
      console.log(`${u.isAdmin ? "★" : " "} ${u.username.padEnd(20)} 已读 ${String(u.read).padStart(4)}  注册于 ${u.createdAt.slice(0, 10)}`);
    }
    break;
  }
  case "backup": {
    const dir = resolve(args[0] ?? resolve(ROOT, "var/backups"));
    // 文件名用服务器本地时间：app-20261018-224500.db
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const file = resolve(dir, `app-${stamp}.db`);
    backupTo(file);
    // 文件名按时间排序，旧的删掉，只留最近 KEEP 份
    const KEEP = 10;
    const old = readdirSync(dir).filter((f) => /^app-\d{8}-\d{6}\.db$/.test(f)).sort().slice(0, -KEEP);
    for (const f of old) rmSync(resolve(dir, f));
    console.log(`已备份到 ${file}${old.length ? `（清理了 ${old.length} 份旧备份）` : ""}`);
    break;
  }
  default:
    console.log("用法：npm run admin -- invite [备注] | invite-admin | reset <用户名> | users | backup [目录]");
}
