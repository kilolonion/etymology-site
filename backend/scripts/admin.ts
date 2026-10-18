// 服务器上的管理命令（直接操作数据库，不需要登录）：
//   npm run admin -- invite [备注]       生成一个普通邀请码（7 天有效）
//   npm run admin -- invite-admin        生成一个管理员邀请码（忘了管理员密码、或想再加一个管理员时用）
//   npm run admin -- reset <用户名>      重置某人的密码，打印临时密码
//   npm run admin -- users               列出所有用户

import { resolve } from "node:path";
import { findLogin, listUsers, openDb } from "../src/db.ts";

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
  default:
    console.log("用法：npm run admin -- invite [备注] | invite-admin | reset <用户名> | users");
}
