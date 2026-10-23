#!/usr/bin/env bash
set -euo pipefail
umask 077
tmp=$(mktemp -d /tmp/export-pg.XXXXXX)
trap 'pg_ctl -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
initdb -D "$tmp/data" -A trust --no-locale >"$tmp/init.log"
pg_ctl -D "$tmp/data" -l "$tmp/server.log" -o "-p 5432 -h '' -k $tmp" start >/dev/null
if [[ "${1:-}" == "worker" ]]; then
  env -i PATH="$PATH" NODE_ENV=test EXPORT_FIXTURE_PG_SOCKET="$tmp" \
    node --require ./tests/helpers/export-worker-network-guard.cjs \
    --import tsx --test tests/protractor-export-worker-real-redis.test.ts
else
env -i PATH="$PATH" HOME="$HOME" PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
  NODE_OPTIONS="--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs" \
  node --import tsx tests/protractor-export-connection.test.ts "$tmp"
env -i PATH="$PATH" HOME="$HOME" PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
  NODE_OPTIONS="--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs" \
  node --import tsx tests/protractor-export-pg-permissions.test.ts "$tmp"
env -i PATH="$PATH" HOME="$HOME" PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
  NODE_OPTIONS="--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs" \
  node --import tsx tests/protractor-export-pg.test.ts "$tmp"
fi
