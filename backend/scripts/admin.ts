// 服务器上的管理命令（直接操作数据库，不需要登录）：
//   npm run admin -- invite [备注]       生成一个普通邀请码（7 天有效）
//   npm run admin -- invite-admin        生成一个管理员邀请码（忘了管理员密码、或想再加一个管理员时用）
//   npm run admin -- reset <用户名>      重置某人的密码，打印临时密码
//   npm run admin -- users               列出所有用户
//   npm run admin -- backup [目录]        把数据库拷一份快照（默认 var/backups/，只留最近 10 份）
//   npm run admin -- export-added [文件]  把后台发布的新词导出成 entries.json 的格式（默认打印出来）
//   npm run admin -- merge-added <文件>   把导出的新词并进 data/entries.json（在本机仓库里跑，并完校验一遍，再提交、部署）

import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { backupTo, findLogin, listUsers, openDb } from "../src/db.ts";

const ROOT = resolve(import.meta.dirname, "..");
openDb(process.env.STATE_DB ?? resolve(ROOT, "var/app.db"));
// 数据库打开后再加载认证模块（它在加载时会用到数据库）
const { newAdminInvite, newInvite, resetPassword } = await import("../src/auth.ts");

const [cmd, ...args] = process.argv.slice(2);
const ENTRIES = process.env.ENTRIES_PATH ?? resolve(ROOT, "data/entries.json");

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
  case "export-added": {
    const { exportAdded, initAuthoring } = await import("../src/authoring.ts");
    const { loadEntries } = await import("../src/entries.ts");
    initAuthoring();
    loadEntries(ENTRIES);
    const list = exportAdded();
    const text = JSON.stringify(list, null, 2) + "\n";
    if (args[0]) {
      writeFileSync(resolve(args[0]), text);
      console.log(`导出了 ${list.length} 个新词到 ${resolve(args[0])}`);
    } else process.stdout.write(text);
    process.exit(0);
  }
  case "merge-added": {
    // 只动 entries.json，不碰数据库：新词以 origin 字段保留来源，并回之后后台那份稿子显示“已并入数据文件”，以文件为准
    if (!args[0]) {
      console.error("用法：npm run admin -- merge-added <导出的文件.json>");
      process.exit(1);
    }
    const { checkAll } = await import("../src/validate.ts");
    const incoming = JSON.parse(readFileSync(resolve(args[0]), "utf8")) as Record<string, any>[];
    if (!Array.isArray(incoming)) throw new Error("文件里应该是一个数组");
    const data = JSON.parse(readFileSync(ENTRIES, "utf8")) as Record<string, any>[];
    const head = (e: Record<string, any>) => String(e.headword).replace(/^the /i, "");
    let added = 0, updated = 0, skipped = 0;
    for (const e of incoming) {
      if (!e?.id || !e.origin) {
        console.log(`跳过 ${e?.headword ?? "?"}：没有 id 或 origin（只并后台导出的新词）`);
        skipped++;
        continue;
      }
      const at = data.findIndex((x) => x.id === e.id);
      if (at >= 0) {
        if (!data[at]!.origin) {
          console.log(`跳过 ${e.id}：和原书词条同 id`);
          skipped++;
        } else if (JSON.stringify(data[at]) !== JSON.stringify(e)) {
          data[at] = e;
          updated++;
        }
        continue;
      }
      const pos = data.findIndex((x) => head(x).localeCompare(head(e), "en", { sensitivity: "base" }) > 0);
      data.splice(pos < 0 ? data.length : pos, 0, e);
      added++;
    }
    const { errors, warnings } = checkAll(data);
    for (const w of warnings) console.log(`⚠️  ${w}`);
    for (const err of errors) console.log(`❌ ${err}`);
    if (errors.length) {
      console.log(`\n有 ${errors.length} 个错误，没有写入 ${ENTRIES}`);
      process.exit(1);
    }
    writeFileSync(ENTRIES, JSON.stringify(data, null, 2) + "\n");
    console.log(`\n新增 ${added}，更新 ${updated}，跳过 ${skipped}，已写入 ${ENTRIES}。检查一下 git diff，再提交、部署。`);
    process.exit(0);
  }
  default:
    console.log("用法：npm run admin -- invite [备注] | invite-admin | reset <用户名> | users | backup [目录] | export-added [文件] | merge-added <文件>");
}
