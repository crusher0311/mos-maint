#!/usr/bin/env bash
set -euo pipefail
umask 077
tmp=$(mktemp -d /tmp/invoice-stream-test.XXXXXX)
trap 'pg_ctl -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
initdb -D "$tmp/data" -A trust --no-locale >"$tmp/init.log"
pg_ctl -D "$tmp/data" -l "$tmp/server.log" -o "-p 5432 -h '' -k $tmp -c invoice_preview.disposable=yes -c temp_file_limit=0" start >/dev/null
if [[ "${1:-}" == "--snapshot" ]]; then
  PGOPTIONS="-c temp_file_limit=-1" pg_restore -h "$tmp" -p 5432 -U "$(id -un)" -d postgres --exit-on-error \
    generated-artifacts/reporting-snapshots/capture.G6Umcl/local-report.dump
fi
env -i PATH="$PATH" HOME="$HOME" NODE_OPTIONS="--require ./tests/helpers/deny-network-egress.cjs" \
  node --import tsx tests/invoice-fleet-stream.test.ts "$tmp" "$@"
