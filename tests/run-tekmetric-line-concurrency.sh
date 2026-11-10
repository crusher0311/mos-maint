#!/usr/bin/env bash
set -euo pipefail
if [[ "${PARENT_IDENTITY_SANITIZED:-}" != yes ]]; then
  exec env -i PATH="$PATH" HOME="$HOME" PARENT_IDENTITY_SANITIZED=yes bash "$0"
fi
tmp="$(mktemp -d /tmp/parent-identity.XXXXXX)"
trap 'pg_ctl -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
initdb -D "$tmp/data" -A trust --no-locale >"$tmp/init.log"
pg_ctl -D "$tmp/data" -l "$tmp/server.log" \
  -o "-k $tmp -h '' -c parent_identity.disposable=yes" start >/dev/null
PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' \
  node --import tsx tests/tekmetric-line-concurrency.pg.ts "$tmp"
