#!/usr/bin/env bash
set -euo pipefail
tmp=$(mktemp -d /tmp/reporting-source.XXXXXX)
trap 'pg_ctl -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
initdb -D "$tmp/data" -A trust --no-locale >"$tmp/init.log"
pg_ctl -D "$tmp/data" -l "$tmp/server.log" -o "-p 5432 -h '' -k $tmp -c invoice_preview.disposable=yes" start >/dev/null
env -i PATH="$PATH" HOME="$HOME" USER="${USER:-runner}" \
 NODE_OPTIONS="--require ./tests/helpers/deny-network-egress.cjs" \
 node --import tsx tests/reporting-source-scale.test.ts "$tmp"
