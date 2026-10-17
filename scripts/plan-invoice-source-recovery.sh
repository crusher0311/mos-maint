#!/usr/bin/env bash
set -euo pipefail
dump=/tmp/jwt-report-replay-20261017.dump
test -f "$dump"
tmp=$(mktemp -d /tmp/invoice-source-plan.XXXXXX)
port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
trap 'pg_ctl -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
initdb -D "$tmp/data" -A trust --no-locale >"$tmp/init.log"
pg_ctl -D "$tmp/data" -l "$tmp/server.log" -o "-p $port -h 127.0.0.1 -k $tmp -c invoice_preview.disposable=yes" start >/dev/null
node --import tsx scripts/replay-invoice-local.ts "$port" schema
pg_restore -h 127.0.0.1 -p "$port" -U "$(id -un)" -d postgres --exit-on-error --no-owner --no-acl "$dump"
timeout 900 node --import tsx scripts/plan-invoice-source-recovery.ts "$port"
