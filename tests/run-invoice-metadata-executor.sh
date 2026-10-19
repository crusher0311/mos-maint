#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${INVOICE_METADATA_CLEAN_ENV:-}" != yes ]]; then
  exec env -i PATH="$PATH" HOME="$HOME" INVOICE_METADATA_CLEAN_ENV=yes bash "$0"
fi
tmp=$(mktemp -d /tmp/invoice-owner-offline.XXXXXX)
trap 'pg_ctl -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
initdb -D "$tmp/data" -A trust --no-locale >"$tmp/init.log"
pg_ctl -D "$tmp/data" -l "$tmp/server.log" \
  -o "-h '' -k $tmp -c invoice_preview.disposable=yes" start >/dev/null
INVOICE_OWNER_TEST_SOCKET="$tmp" NODE_OPTIONS="--require ./tests/helpers/invoice-owner-offline-guard.cjs" \
  timeout 90s node --import tsx --test tests/invoice-metadata-executor.test.ts
