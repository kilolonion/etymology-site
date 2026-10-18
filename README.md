# 词源一日

每天一个《英语词源典故词典》里的故事：首页抛出一个问题，有兴趣就点进去读完整篇。支持多个用户，每人的阅读进度、收藏、每日推荐和提醒各自独立，手机、电脑同步。

> ⚠️ 书的内容受版权保护。网站只能凭邀请码注册，不开放注册；请只邀请自己人，不要公开传播。

## 使用方式

- **今日**：报头 + 一张专题色的封面（单词是大标题，钩子问题是导语，附一行推荐理由）。点进去读完整篇。
- **读完之后**：封面盖上“已读”章，显示一句话记住；下面是“明日预告”（可以点开提前读，明天会换新词）。
- **旧词重逢**：按 3 / 7 / 14 / 30 / 60 / 120 / 240 天的间隔重现一个读过的词，先看单词回想，点一下翻面看“一句话记住”。
- **本周**：七日格，读过的那天盖一枚专题色圆章，点开可回看。
- **随手翻一页**：推荐一个没读过的词，先看问题，可以“换一个”。
- **文章页**：词源正文 → 词源之路 → 一句话记住 → 例句 → 相关的词 → 接着读 → 出处卡片。读到“一句话记住”并停留 8 秒以上才记为已读，随手点开不算。
- **账号**：管理员在“我的 → 邀请与成员”里生成邀请链接（7 天有效、只能用一次），朋友打开链接设置用户名和密码即可；也能重置成员密码、删除成员。每人可在“账号与安全”里改密码、退出登录。
- **探索**：搜索、专题展厅（没读的露出问题，读过的显示“一句话记住”；“风俗与生活”可按 12 个子专题筛选）、语源之路（从哪种语言出发、经哪些语言来到英语）、时间长廊（按故事起点的世纪排列）、按字母。**我的**：书架、阅读足迹、专题纹章、语源分布，以及收藏卡片墙、阅读时间线、每日提醒。

## 推荐逻辑（backend/src/recommend.ts）

每天的新词、“随手翻一页”、文章末尾的“接着读”都由同一套打分决定，每个用户按自己的阅读记录单独计算，目标是**既有关联，又有变化**：

| 因素 | 作用 |
|---|---|
| 和读过的词互为“参见” | 加分最多：新词直接挂在旧记忆上 |
| 和最近 7 天读过的词同专题（风俗与生活按子专题算） | 加分：形成小的知识网 |
| 和当前文章相关（接着读） | 加分 |
| 收藏过的专题 | 加分：贴合兴趣 |
| 读得少的专题 | 小幅加分：保证覆盖面 |
| 和昨天、今天同一个主专题 | 减分：避免单调 |
| 和最近几次推送首字母相同 | 减分：避免 A、A、A…… |
| 按日期固定的随机扰动 | 同一天结果稳定，不同天有变化 |

得分最高的理由会以一句话显示在封面上，比如“和你读过的 agony 互为参见”“新专题：航海与军事”。

## 结构

前后端分开：`frontend/` 是纯静态文件，`backend/` 只提供 `/api`。生产环境由 nginx 托管前端、把 `/api` 转发给后端，两者同一个域名，登录用 HttpOnly Cookie。

```
frontend/    静态前端，原生 JS，无构建步骤
  index.html  css/  fonts/（自托管英文字体）  icons/  sw.js（推送）  manifest.webmanifest
  js/        main.js（路由）lib.js themes.js components.js push.js
  js/views/  home  entry  explore  me  auth（登录 / 注册）account（账号、邀请与成员）
backend/     API 服务：Node 24（直接运行 .ts）+ Hono + node:sqlite
  src/       main.ts（路由）auth.ts（账号、会话、邀请码）db.ts（SQLite）recommend.ts daily.ts push.ts entries.ts
  data/      entries.json   ← 词条数据，替换后约 2 秒内自动重新加载
  scripts/   validate-entries.ts（数据校验）admin.ts（服务器上的管理命令）
  var/       app.db         ← 账号与阅读进度（运行时生成）
deploy/      nginx.conf  etymology.service
docs/        DATA_FORMAT.md（词条数据格式）
```

## 账号与安全

- 用户名 + 密码登录；密码用 scrypt 加盐散列保存。
- 登录后发一个随机令牌放在 HttpOnly、SameSite=Lax 的 Cookie 里（180 天，常用就自动续期），数据库只存令牌的 SHA-256。
- 改动数据的接口只接受 JSON 请求，配合 SameSite Cookie 防跨站伪造。
- 登录、注册、校验邀请码都有频率限制（每个 IP 每分钟 10 次，每个用户名每分钟 5 次）。
- 改密码后其他设备自动退出；管理员重置密码会让对方所有设备退出。
- 退出登录时会取消这台设备的推送订阅，换人登录不会收到上一个人的提醒。

## 本地运行

```bash
npm --prefix backend install
npm run dev
```

打开 http://localhost:8787 。开发模式下后端顺便托管 `frontend/`，一个进程就够了。

第一次启动、还没有任何账号时，终端里会打印一个**管理员邀请码**和注册链接，用它注册第一个账号（就是管理员）。

其他命令（在项目根目录运行）：

| 命令 | 作用 |
|---|---|
| `npm run validate` | 校验词条数据 |
| `npm run typecheck` | 后端类型检查 |
| `npm run admin -- users` | 列出所有用户 |
| `npm run admin -- invite [备注]` | 生成一个普通邀请码 |
| `npm run admin -- invite-admin` | 生成管理员邀请码（24 小时有效，忘了管理员密码时用） |
| `npm run admin -- reset <用户名>` | 重置某人的密码，打印临时密码 |
| `npm run admin -- backup [目录]` | 给数据库拍一份快照（默认 `backend/var/backups/`，留最近 10 份） |
| `npm run deploy` | 一键部署到服务器，见下方“更新” |

## 部署到服务器

把项目放到 `/opt/etymology-site`，前端由宿主机的 nginx 直接托管，后端用 Docker 或 systemd 跑在 `127.0.0.1:8787`。

### 1. 后端

方式一，Docker（推荐）：

```bash
cd /opt/etymology-site
cp .env.example .env
docker compose up -d --build
docker compose logs api        # 第一次启动时，这里有管理员邀请码
```

方式二，直接用 Node 24+：

```bash
cd /opt/etymology-site/backend && npm ci --omit=dev
cp ../.env.example ../.env
sudo cp ../deploy/etymology.service /etc/systemd/system/
sudo systemctl enable --now etymology
journalctl -u etymology        # 第一次启动时，这里有管理员邀请码
```

### 2. 前端与 HTTPS

```bash
sudo cp deploy/nginx.conf /etc/nginx/conf.d/etymology.conf   # 改成你的域名和证书路径
sudo nginx -t && sudo systemctl reload nginx
```

证书可以用 certbot 申请。推送通知要求网站走 HTTPS。

### 3. 注册管理员

打开日志里的链接 `https://你的域名/#/join/邀请码`，设置用户名和密码。之后在“我的 → 邀请与成员”里邀请朋友。

### 更新

**一键部署**（在本机运行，需要能 ssh 到服务器、两边都装了 rsync）：

```bash
cp deploy/deploy.env.example deploy/deploy.env   # 第一次：填服务器地址、目录等
npm run deploy                                   # 部署当前提交；--dry-run 试运行，HEAD~1 回滚，status 看线上版本
```

它会校验、自动给前端打版本号、备份数据库、按需 `npm ci` 和重启并做健康检查，详见 `DEPLOY-NOTES.md`。

手动更新时：

- **前端**：先对一份拷贝运行 `python3 deploy/version-assets.py <拷贝目录>` 再覆盖 `frontend/`，不用重启。在 CDN 后面不打版本号会读到旧模块。
- **后端**：替换 `backend/src/` 后重启（`docker compose up -d --build` 或 `systemctl restart etymology`）。
- **词条数据**：覆盖 `backend/data/entries.json`，无需重启。阅读进度按词条 `id` 记录，已有词条的 `id` 不要改。

## 环境变量（.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `COOKIE_SECURE` | 关 | HTTPS 下设为 `1` |
| `TZ_NAME` | `Asia/Shanghai` | 判断“今天”用的时区（全站统一） |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | 后端监听地址 |
| `ENTRIES_PATH` | `backend/data/entries.json` | 词条文件 |
| `STATE_DB` | `backend/var/app.db` | 账号与阅读进度数据库 |
| `FRONTEND_DIR` | 空 | 设置后后端顺便托管前端（`npm run dev` 已设为 `../frontend`）；生产环境留空 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | 自动生成 | 推送密钥；不填则首次启动时生成并存进数据库 |
| `VAPID_SUBJECT` | `mailto:admin@localhost` | 推送联系方式，建议填你的邮箱 |
