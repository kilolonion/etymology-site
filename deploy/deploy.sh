#!/usr/bin/env bash
# 一键部署：在本机打包某个 git 提交，校验、打版本号，再同步到服务器。
#
#   deploy/deploy.sh                 部署当前 HEAD（未提交的改动不会带上）
#   deploy/deploy.sh <提交|标签>      部署指定版本，也用来回滚，如 deploy/deploy.sh HEAD~1
#   deploy/deploy.sh --dry-run       只打包、校验，列出会改动哪些文件，不碰服务器上的东西
#   deploy/deploy.sh -y              不再询问确认
#   deploy/deploy.sh status          看服务器上现在是哪个版本
#
# 服务器地址等配置写在 deploy/deploy.env（不进 git，参考 deploy/deploy.env.example）。
#
# 顺序：校验 → 备份数据库（后端有变化时）→ 后端（依赖变了才 npm ci，代码变了才重启，重启后做健康检查）
#      → 前端（index.html 最后传，保证它引用的新版本文件都已经就位）→ 记下部署信息。
# 后端起不来就停在那里，前端保持旧版，不会出现新前端配旧后端。

set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO"

# ---------- 配置 ----------
[ -f deploy/deploy.env ] && . deploy/deploy.env
DEPLOY_HOST=${DEPLOY_HOST:-overseas}             # ssh 别名；写 local 表示部署到本机目录（测试用）
DEPLOY_DIR=${DEPLOY_DIR:-/opt/etymology-site}
NODE_BIN=${NODE_BIN:-/opt/node24/bin}            # 服务器上 node / npm 所在目录
SERVICE=${SERVICE:-etymology}
SERVICE_USER=${SERVICE_USER:-ety}                # 服务以谁的身份运行；备份数据库时用这个身份，免得生成 root 的文件
RESTART_CMD=${RESTART_CMD:-systemctl restart $SERVICE}
LOGS_CMD=${LOGS_CMD:-journalctl -u $SERVICE -n 30 --no-pager}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:8787/api/auth}

# ---------- 参数 ----------
DRY=0 YES=0 REF=HEAD CMD=deploy
for a in "$@"; do
  case $a in
    -n|--dry-run) DRY=1 ;;
    -y|--yes) YES=1 ;;
    status) CMD=status ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "不认识的参数：$a" >&2; exit 2 ;;
    *) REF=$a ;;
  esac
done

say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# 在服务器上执行一段脚本（从标准输入读）
remote() {
  if [ "$DEPLOY_HOST" = local ]; then bash -s; else ssh "$DEPLOY_HOST" bash -s; fi
}
dest() { if [ "$DEPLOY_HOST" = local ]; then echo "$DEPLOY_DIR/$1"; else echo "$DEPLOY_HOST:$DEPLOY_DIR/$1"; fi; }
# 不带属主（服务器上用 root 传也不会把文件变成本机的 uid）
sync() { rsync -rlpt --no-owner --no-group "$@"; }

# 把服务器上的部署信息读出来：key=value 每行一个
remote_info() {
  printf 'cat %q 2>/dev/null || true\n' "$DEPLOY_DIR/.deploy-info" | remote
}
info_get() { sed -n "s/^$1=//p" <<<"$2" | head -1; }

if [ $CMD = status ]; then
  info=$(remote_info)
  [ -n "$info" ] || die "$DEPLOY_HOST:$DEPLOY_DIR 还没有用这个脚本部署过"
  echo "$info"
  exit 0
fi

# ---------- 1. 打包 ----------
command -v rsync >/dev/null || die "本机没有 rsync"
command -v python3 >/dev/null || die "本机没有 python3"
COMMIT=$(git rev-parse --verify --quiet "$REF^{commit}") || die "找不到提交：$REF"
SHORT=$(git rev-parse --short "$COMMIT")
SUBJECT=$(git log -1 --format=%s "$COMMIT")
if [ "$REF" = HEAD ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "提示：工作区有未提交的改动，这次只部署已提交的 $SHORT，那些改动不会带上。"
fi

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/etymology-deploy.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
git archive "$COMMIT" | tar -x -C "$STAGE"

say "校验 $SHORT（$SUBJECT）"
[ -d backend/node_modules ] || die "本机先装一下依赖：npm --prefix backend install"
ln -s "$REPO/backend/node_modules" "$STAGE/backend/node_modules"   # 只为类型检查借用，不会传上去
(cd "$STAGE/backend" && node_modules/.bin/tsc) || die "类型检查没过"
(cd "$STAGE/backend" && node --disable-warning=ExperimentalWarning scripts/validate-entries.ts data/entries.json) \
  || die "词条数据校验没过"
rm "$STAGE/backend/node_modules"

FRONT_VER=$(python3 -I deploy/version-assets.py "$STAGE/frontend")

# 后端代码和依赖各算一个指纹，和上次部署的比，决定要不要 npm ci、要不要重启
fingerprint() { (cd "$STAGE/backend" && find "$@" -type f | LC_ALL=C sort | xargs shasum -a 256) | shasum -a 256 | cut -c1-12; }
BACK_VER=$(fingerprint src scripts package.json package-lock.json)
LOCK_VER=$(fingerprint package-lock.json)

# ---------- 2. 和服务器上的比一比 ----------
info=$(remote_info)
OLD_COMMIT=$(info_get commit "$info")
OLD_FRONT=$(info_get frontend "$info")
OLD_BACK=$(info_get backend "$info")
OLD_LOCK=$(info_get lock "$info")
NEED_NPM=0 NEED_RESTART=0
[ "$LOCK_VER" != "$OLD_LOCK" ] && NEED_NPM=1
[ "$BACK_VER" != "$OLD_BACK" ] && NEED_RESTART=1

echo
echo "  目标      $DEPLOY_HOST:$DEPLOY_DIR"
echo "  提交      ${OLD_COMMIT:-（未知，第一次用这个脚本）} → $SHORT"
echo "  前端版本  ${OLD_FRONT:-？} → $FRONT_VER$([ "$FRONT_VER" = "$OLD_FRONT" ] && echo '（没变）')"
echo "  后端      $([ $NEED_RESTART = 1 ] && echo '有变化，部署后重启' || echo '没变，不重启')"
echo "  依赖      $([ $NEED_NPM = 1 ] && echo '有变化，重新 npm ci' || echo '没变')"
echo

EXCL=(--exclude node_modules --exclude var)
if [ $DRY = 1 ]; then
  say "试运行：会改动这些文件（* 开头的是要删掉的）"
  { sync -n -i -c --delete "${EXCL[@]}" "$STAGE/backend/" "$(dest backend/)"
    sync -n -i -c --delete "$STAGE/frontend/" "$(dest frontend/)"; } | grep -v '^\.' || echo "（没有）"
  exit 0
fi

if [ $YES = 0 ]; then
  read -r -p "确认部署？[y/N] " ok
  [[ $ok =~ ^[yY] ]] || { echo "已取消"; exit 1; }
fi

# ---------- 3. 备份数据库（后端要重启时才做：新代码可能会改表结构）----------
# 不调用服务器上的 admin.ts：那是旧版代码，未必有 backup 命令。这里直接只读打开数据库做 VACUUM INTO。
printf 'mkdir -p %q\n' "$DEPLOY_DIR" | remote
if [ $NEED_RESTART = 1 ]; then
  say "备份数据库"
  { printf 'DIR=%q NODE_BIN=%q SU=%q\n' "$DEPLOY_DIR" "$NODE_BIN" "$SERVICE_USER"
    cat <<'SH'
set -e
DB="$DIR/backend/var/app.db"
if [ ! -f "$DB" ]; then echo "（还没有数据库，跳过）"; exit 0; fi
run=()
# 用 root 登录时换成服务的身份，免得在 var/ 里留下 root 的文件
[ "$(id -u)" = 0 ] && id "$SU" >/dev/null 2>&1 && run=(runuser -u "$SU" --)
"${run[@]}" "$NODE_BIN/node" --disable-warning=ExperimentalWarning -e '
  const { DatabaseSync } = require("node:sqlite");
  const fs = require("node:fs"), path = require("node:path");
  const [db, dir] = process.argv.slice(1);
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  const file = path.join(dir, `app-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db`);
  new DatabaseSync(db, { readOnly: true }).prepare("VACUUM INTO ?").run(file);
  // 只留最近 10 份（和 npm run admin -- backup 用同一个目录、同一种文件名）
  const old = fs.readdirSync(dir).filter((f) => /^app-\d{8}-\d{6}\.db$/.test(f)).sort().slice(0, -10);
  for (const f of old) fs.rmSync(path.join(dir, f));
  console.log("已备份到 " + file);
' "$DB" "$DIR/backend/var/backups"
SH
  } | remote || die "数据库备份失败，没有继续部署"
fi

# ---------- 4. 后端 ----------
# 先把记录里的后端指纹作废：万一这次中途失败，服务器上已经是新文件，下次不能再当成“没变”而跳过重启
if [ $NEED_RESTART = 1 ] || [ $NEED_NPM = 1 ]; then
  printf 'f=%q; [ -f "$f" ] && { grep -vE "^(backend|lock)=" "$f" > "$f.tmp"; mv "$f.tmp" "$f"; }; true\n' \
    "$DEPLOY_DIR/.deploy-info" | remote
fi
say "同步后端"
sync -c --delete "${EXCL[@]}" "$STAGE/backend/" "$(dest backend/)"
sync -c "$STAGE/deploy/" "$(dest deploy/)"
sync -c "$STAGE"/{README.md,DEPLOY-NOTES.md,.env.example,docker-compose.yml,package.json} "$(dest '')"
[ -d "$STAGE/docs" ] && sync -c --delete "$STAGE/docs/" "$(dest docs/)"

{ printf 'DIR=%q NODE_BIN=%q NEED_NPM=%q NEED_RESTART=%q RESTART_CMD=%q LOGS_CMD=%q HEALTH_URL=%q\n' \
    "$DEPLOY_DIR" "$NODE_BIN" "$NEED_NPM" "$NEED_RESTART" "$RESTART_CMD" "$LOGS_CMD" "$HEALTH_URL"
  cat <<'SH'
set -e
export PATH="$NODE_BIN:$PATH"
cd "$DIR/backend"
if [ "$NEED_NPM" = 1 ]; then
  echo "▸ 安装依赖"
  npm ci --omit=dev --no-audit --no-fund
fi
chmod -R a+rX "$DIR/backend"
healthy() { node -e 'fetch(process.argv[1]).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$HEALTH_URL"; }
# 后端没变，但服务没在跑（比如上次部署失败后停在那里）：也重启一下
if [ "$NEED_RESTART" != 1 ] && ! healthy; then
  echo "  服务没有响应（$HEALTH_URL），重启一下"
  NEED_RESTART=1
fi
if [ "$NEED_RESTART" = 1 ]; then
  echo "▸ 重启服务"
  eval "$RESTART_CMD"
  # 等它起来：最多 20 秒
  for i in $(seq 1 40); do
    if healthy; then
      echo "  健康检查通过（$HEALTH_URL）"
      exit 0
    fi
    sleep 0.5
  done
  echo "✗ 服务 20 秒内没起来，前端没有更新。最近的日志：" >&2
  eval "$LOGS_CMD" >&2 || true
  exit 1
fi
SH
} | remote || die "后端部署失败（数据库备份在 backend/var/backups/）。修好后重新跑；要回滚就 deploy/deploy.sh <上一个提交>"

# ---------- 5. 前端 ----------
say "同步前端（版本 $FRONT_VER）"
sync -c --delete --exclude /index.html "$STAGE/frontend/" "$(dest frontend/)"
sync -c "$STAGE/frontend/index.html" "$(dest frontend/)"

# ---------- 6. 记下这次部署 ----------
{ printf 'DIR=%q\n' "$DEPLOY_DIR"
  printf 'INFO=%q\n' "commit=$SHORT
subject=$SUBJECT
frontend=$FRONT_VER
backend=$BACK_VER
lock=$LOCK_VER
at=$(date '+%Y-%m-%d %H:%M:%S %z')
by=$(git config user.name || whoami)"
  cat <<'SH'
chmod -R a+rX "$DIR/frontend"
printf '%s\n' "$INFO" > "$DIR/.deploy-info"
SH
} | remote

say "部署完成：$SHORT · 前端 $FRONT_VER"
