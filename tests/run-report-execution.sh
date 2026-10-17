#!/usr/bin/env bash
set -euo pipefail
# A throwaway local cluster, never the application's shared databases.
tmp=$(mktemp -d /tmp/report-execution.XXXXXX)
port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
trap 'pg_ctl -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
initdb -D "$tmp/data" -A trust --no-locale >"$tmp/init.log"
pg_ctl -D "$tmp/data" -l "$tmp/server.log" -o "-p $port -h 127.0.0.1 -k $tmp" start >/dev/null
NODE_OPTIONS="--require ./scripts/_stubs/server-only-stub.cjs" node --import tsx tests/report-runs-execution.smoke.ts "$port"
NODE_OPTIONS="--require ./scripts/_stubs/server-only-stub.cjs" node --import tsx tests/invoice-range-query.smoke.ts "$port"
