# 词源一日 · 部署备忘（overseas）

2026-10-18 由 Minis 部署。

## 位置

| 项 | 值 |
|---|---|
| 域名 | https://words.kilolonion.com（Cloudflare 代理开） |
| 目录 | `/opt/etymology-site`（frontend / backend / deploy） |
| Node | `/opt/node24/bin/node`（v24.9.0，官方 tar 包解到 `/opt/node-v24.9.0-linux-x64`；系统自带的 22 跑不了 TS，别换回去） |
| 服务 | `systemd: etymology.service`（`User=ety`，`EnvironmentFile=/opt/etymology-site/.env`） |
| 监听 | `127.0.0.1:8787`，只给本机 nginx 用 |
| nginx | `/etc/nginx/conf.d/words-kilolonion.conf`（含 Cloudflare `real_ip` 还原，保证后端限流看到真人 IP） |
| 证书 | `/etc/letsencrypt/live/words.kilolonion.com/`（LE，DNS-01，2027-01-16 到期；`minis-tls-renew.timer` 每天 `certbot renew` 并 reload nginx） |
| 数据库 | `/opt/etymology-site/backend/var/app.db`（SQLite WAL，唯一的持久状态） |
| 日志 | `journalctl -u etymology` + `/var/log/nginx/access.log` |

## 常用命令

```bash
systemctl status etymology
journalctl -u etymology -f          # 邀请码、推送、报错都在这里
systemctl restart etymology
nginx -t && systemctl reload nginx
```

## 更新代码

在本机项目根目录：

```bash
npm run deploy                  # 部署当前 HEAD（只带已提交的内容）
npm run deploy -- --dry-run     # 先看看会改哪些文件
npm run deploy -- HEAD~1        # 回滚到上一个提交（任何提交、标签都行）
npm run deploy -- status        # 服务器上现在是哪个版本
```

脚本（`deploy/deploy.sh`）会依次：用 `git archive` 打包指定提交 → 类型检查 + 词条校验 → 给前端打版本号 → 后端有变化时先备份数据库（`backend/var/backups/`，留最近 10 份）→ rsync 后端，依赖变了才 `npm ci`、代码变了才重启，并做健康检查 → rsync 前端（`index.html` 最后传）→ 把版本信息写进 `/opt/etymology-site/.deploy-info`。后端起不来就停下，前端保持旧版；修好或回滚后再跑一次，会自动重启。

服务器地址等配置默认就是本页的值；要改就复制 `deploy/deploy.env.example` 为 `deploy/deploy.env`。前提：本机能 `ssh overseas`，两边都有 `rsync`。

前端版本号**不用再手动推**：`version-assets.py` 按前端文件内容算哈希，给 index.html 里的 css/js 和所有模块的 `import` 打上同一个 `?v=`，前端没改版本号就不变。这一步不能省：站点在 Cloudflare 后面，CF 会给 js/css 盖 4 小时浏览器缓存 TTL（源站的 no-cache 被覆盖），只有 index.html 带版本号的话，用户可能拿到旧模块 + 新入口，直接白屏（页面只剩顶栏和底部 tab）。

## 注意

- `.env` 里 `COOKIE_SECURE=1`（站点是 HTTPS），`HOST=127.0.0.1`（只监听回环）。上 docker 部署时要在 compose 里覆盖成 `0.0.0.0`，见仓库里的 `docker-compose.yml`。
- 第一个管理员邀请码只会在**还没有任何账号**时打印在日志里，7 天有效；过期或漏看了就重启服务拿新的。
- 部署时会自动备份；手动备份：`npm run admin -- backup`，或 `sqlite3 /opt/etymology-site/backend/var/app.db ".backup /root/ety-backup-$(date +%F).db"`（或直接停服务拷 app.db*）。
- 备份/迁移时 `backend/var/` 里三个文件（app.db / -wal / -shm）要一起拷，或者先停服务。
