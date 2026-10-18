#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--resume-run" ]]; then
  tmp="${2:?Local run directory required}"; shift 2
  [[ "$tmp" == /tmp/jwt-report-local.* && -d "$tmp/data" ]] || exit 2
else
  tmp=$(mktemp -d /tmp/jwt-report-local.XXXXXX)
fi
port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
cleanup() {
  status=$?
  pg_ctl -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true
  if [[ $status == 0 ]]; then rm -rf "$tmp"; else
    printf 'Local validation paused; retained private database: %s\n' "$tmp"
  fi
}
trap cleanup EXIT
if [[ ! -f "$tmp/data/PG_VERSION" ]]; then
  initdb -D "$tmp/data" -A trust --no-locale >"$tmp/init.log"
fi
pg_ctl -D "$tmp/data" -l "$tmp/server.log" -o "-p $port -h 127.0.0.1 -k $tmp -c invoice_preview.disposable=yes" start >/dev/null
NODE_OPTIONS="--require ./scripts/_stubs/server-only-stub.cjs" timeout 3600s node --import tsx scripts/validate-jwt-report-local.ts "$port" "$@"
