#!/bin/bash
set -euo pipefail
ROOT=/workspace/etymology-site
LOG=$ROOT/var/logs/api.log
PIDFILE=$ROOT/var/logs/api.pid
mkdir -p "$ROOT/var/logs"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running pid=$(cat "$PIDFILE")"
  exit 0
fi
set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a
cd "$ROOT/backend"
nohup /usr/bin/node --disable-warning=ExperimentalWarning src/main.ts >>"$LOG" 2>&1 &
echo $! >"$PIDFILE"
echo "started pid=$(cat "$PIDFILE") log=$LOG"
