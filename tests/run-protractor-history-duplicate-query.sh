#!/usr/bin/env bash
set -euo pipefail
tmp=$(mktemp -d /tmp/protractor-history-query.XXXXXX)
port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
trap 'pg_ctl -D "$tmp/data" -m fast stop >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
initdb -D "$tmp/data" -A trust --no-locale >"$tmp/init.log"
pg_ctl -D "$tmp/data" -l "$tmp/server.log" -o "-p $port -h 127.0.0.1 -k $tmp -c invoice_preview.disposable=yes" start >/dev/null
node --import tsx tests/protractor-history-duplicate-query.smoke.ts "$port"
