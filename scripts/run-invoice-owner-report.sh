#!/usr/bin/env bash
set -euo pipefail
umask 077
mkdir -p generated-artifacts/reporting-snapshots
out=$(mktemp -d generated-artifacts/reporting-snapshots/capture.XXXXXX)
tmp=$(mktemp -d /tmp/invoice-owner-report.XXXXXX)
port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
cleanup() {
  pg_ctl -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
initdb -D "$tmp/data" -A trust --no-locale >"$tmp/init.log"
pg_ctl -D "$tmp/data" -l "$tmp/server.log" -o "-p $port -h 127.0.0.1 -k $tmp -c invoice_preview.disposable=yes" start >/dev/null
result=0
NODE_OPTIONS="--require ./scripts/_stubs/server-only-stub.cjs" timeout 900s node --import tsx scripts/validate-invoice-owner-report.ts "$port" >"$out/validation.jsonl" 2>&1 || result=$?
# Preserve the marked LOCAL database, including failed/partial runs labelled as
# such. Never dump a source connection or mistake a partial capture for success.
pg_dump -h 127.0.0.1 -p "$port" -U "$(id -un)" -d postgres -Fc -f "$out/local-report.dump"
cp /tmp/invoice-owner-closure.json "$out/owner-closure.json"
printf '{"validationExitCode":%s}\n' "$result" > "$out/status.json"
echo "Protected local capture: $out (validation exit $result)"
exit "$result"
