#!/bin/bash
set -euo pipefail
# Bypass box fake-IP DNS (198.18.x) for Argo edges
sudo sed -i '/argotunnel\.com/d' /etc/hosts
sudo tee -a /etc/hosts >/dev/null <<'HOSTS'
# Cloudflare Tunnel edges (bypass box fake-IP DNS)
198.41.192.167 region1.v2.argotunnel.com
198.41.200.73 region2.v2.argotunnel.com
198.41.192.67 region1.argotunnel.com
198.41.200.23 region2.argotunnel.com
198.41.192.77 cfd-features.argotunnel.com
HOSTS
pkill -9 cloudflared 2>/dev/null || true
sleep 1
mkdir -p /workspace/cf-deploy/logs
nohup sudo cloudflared tunnel --no-autoupdate --protocol http2 run --token-file /etc/cloudflared/token \
  > /workspace/cf-deploy/logs/cloudflared.log 2>&1 &
echo "cloudflared started pid=$!"
