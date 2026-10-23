#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${NORMALIZATION_CLEAN_ENV:-}" != yes ]]; then
  exec env -i PATH="$PATH" HOME="$HOME" NORMALIZATION_CLEAN_ENV=yes bash "$0"
fi
tmp=$(mktemp -d /tmp/protractor-normalization.XXXXXX)
port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
trap 'pg_ctl -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
initdb -D "$tmp/data" -A trust --no-locale >"$tmp/init.log"
pg_ctl -D "$tmp/data" -l "$tmp/server.log" -o "-p $port -h 127.0.0.1 -k $tmp -c invoice_preview.disposable=yes" start >/dev/null
export PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true
export NODE_OPTIONS="--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs"
timeout 120 node --import tsx tests/protractor-normalization-retries.smoke.ts "$port"
# Run ACL tests in a second disposable database, without touching runtime fixtures.
createdb -h 127.0.0.1 -p "$port" normalization_acl
timeout 120 node --import tsx tests/protractor-normalization-permissions.smoke.ts "$port"
