#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${INVOICE_DUAL_CLEAN:-}" != yes ]]; then
  exec env -i PATH="$PATH" HOME="$HOME" INVOICE_DUAL_CLEAN=yes bash "$0"
fi
umask 077
tmp=$(mktemp -d /tmp/invoice-dual.XXXXXX)
trap 'test ! -f "$tmp/mongo.pid" || kill "$(cat "$tmp/mongo.pid")" 2>/dev/null || true; pg_ctl -D "$tmp/pg" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
marker=$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')
port=$(node -e 'let s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
mkdir "$tmp/mongo"
initdb -D "$tmp/pg" -A trust --no-locale >"$tmp/init.log"
pg_ctl -D "$tmp/pg" -l "$tmp/pg.log" -o "-h '' -k $tmp -c invoice_preview.disposable=$marker" start >/dev/null
mongod --dbpath "$tmp/mongo" --bind_ip 127.0.0.1 --port "$port" --nounixsocket \
  --wiredTigerCacheSizeGB 0.25 --fork --logpath "$tmp/mongo.log" --pidfilepath "$tmp/mongo.pid" >/dev/null
INVOICE_DUAL_SOCKET="$tmp" INVOICE_DUAL_PORT="$port" INVOICE_DUAL_MARKER="$marker" \
  NODE_OPTIONS="--require ./tests/helpers/invoice-dual-network-guard.cjs" \
  timeout 120s node --import tsx tests/invoice-dual-store.test.ts
