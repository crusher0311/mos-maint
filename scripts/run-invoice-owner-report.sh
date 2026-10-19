#!/usr/bin/env bash
set -euo pipefail
tmp=$(mktemp -d /tmp/invoice-owner-report.XXXXXX)
port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
cleanup() {
  pg_ctl -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
initdb -D "$tmp/data" -A trust --no-locale >"$tmp/init.log"
pg_ctl -D "$tmp/data" -l "$tmp/server.log" -o "-p $port -h 127.0.0.1 -k $tmp -c invoice_preview.disposable=yes" start >/dev/null
NODE_OPTIONS="--require ./scripts/_stubs/server-only-stub.cjs" timeout 900s node --import tsx scripts/validate-invoice-owner-report.ts "$port"
