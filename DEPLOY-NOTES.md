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

```bash
# 本地打包（排除 node_modules / var）
tar czf /tmp/etymology-site.tgz --exclude='backend/node_modules' --exclude='backend/var' .
scp /tmp/etymology-site.tgz overseas:/tmp/
ssh overseas 'tar xzf /tmp/etymology-site.tgz -C /opt/etymology-site \
  && cd /opt/etymology-site/backend && /opt/node24/bin/npm ci --omit=dev \
  && chmod -R a+rX /opt/etymology-site/frontend /opt/etymology-site/backend/node_modules \
  && systemctl restart etymology'
```

改完前端：把 `frontend/index.html` 里三处 `?v=`（fonts.css / style.css / main.js）日期序号往上推，然后在服务器上跑一次

```bash
cd /opt/etymology-site && python3 deploy/version-assets.py frontend && chmod -R a+rX frontend
```

这一步会给所有 `import ... from "./x.js"` 补上同一个 `?v=`。**必须跑**：站点在 Cloudflare 后面，CF 会给 js/css 盖 4 小时浏览器缓存 TTL（源站的 no-cache 被覆盖），只有 index.html 带版本号的话，用户可能拿到旧模块 + 新入口，直接白屏（页面只剩顶栏和底部 tab）。

## 注意

- `.env` 里 `COOKIE_SECURE=1`（站点是 HTTPS），`HOST=127.0.0.1`（只监听回环）。上 docker 部署时要在 compose 里覆盖成 `0.0.0.0`，见仓库里的 `docker-compose.yml`。
- 第一个管理员邀请码只会在**还没有任何账号**时打印在日志里，7 天有效；过期或漏看了就重启服务拿新的。
- 备份只要数据库：`sqlite3 /opt/etymology-site/backend/var/app.db ".backup /root/ety-backup-$(date +%F).db"`（或直接停服务拷 app.db*）。
- 备份/迁移时 `backend/var/` 里三个文件（app.db / -wal / -shm）要一起拷，或者先停服务。
