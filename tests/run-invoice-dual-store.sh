#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${INVOICE_DUAL_CLEAN:-}" != yes ]]; then
  exec env -i PATH="$PATH" HOME="$HOME" INVOICE_DUAL_CLEAN=yes bash "$0"
fi
umask 077
node --import tsx tests/invoice-repair-access-inventory.test.ts
tmp=$(mktemp -d /tmp/invoice-dual.XXXXXX)
cleanup() {
  for pid in "$tmp"/mongo-*.pid; do
    test ! -f "$pid" || kill "$(cat "$pid")" 2>/dev/null || true
  done
  pg_ctl -D "$tmp/pg" -m immediate stop >/dev/null 2>&1 || true
  # Wait for mongod shutdown before removing its files.
  for attempt in $(seq 1 100); do
    alive=no
    for pid in "$tmp"/mongo-*.pid; do
      test ! -f "$pid" || ! kill -0 "$(cat "$pid")" 2>/dev/null || alive=yes
    done
    [[ "$alive" == yes ]] || break
    sleep 0.1
  done
  for pid in "$tmp"/mongo-*.pid; do
    test ! -f "$pid" || kill -9 "$(cat "$pid")" 2>/dev/null || true
  done
  rm -rf "$tmp"
}
trap cleanup EXIT
marker=$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')
ports=$(node -e 'let ss=[];for(let i=0;i<3;i++){let s=require("net").createServer();ss.push(s);s.listen(0,"127.0.0.1",()=>{if(ss.every(x=>x.listening)){console.log(ss.map(x=>x.address().port).join(","));ss.forEach(x=>x.close())}})}')
port=${ports%%,*}
initdb -D "$tmp/pg" -A trust --no-locale >"$tmp/init.log"
pg_ctl -D "$tmp/pg" -l "$tmp/pg.log" -o "-h '' -k $tmp -c invoice_preview.disposable=$marker" start >/dev/null
for p in ${ports//,/ }; do
  mkdir "$tmp/mongo-$p"
  mongod --dbpath "$tmp/mongo-$p" --bind_ip 127.0.0.1 --port "$p" --nounixsocket \
    --replSet invoice_disposable --setParameter enableTestCommands=1 \
    --wiredTigerCacheSizeGB 0.25 --fork --logpath "$tmp/mongo-$p.log" --pidfilepath "$tmp/mongo-$p.pid" >/dev/null
done
INVOICE_DUAL_SOCKET="$tmp" INVOICE_DUAL_PORT="$port" INVOICE_DUAL_PORTS="$ports" INVOICE_DUAL_MARKER="$marker" \
  NODE_OPTIONS="--require ./tests/helpers/invoice-dual-network-guard.cjs" \
  timeout 240s node --import tsx tests/invoice-dual-store.test.ts
INVOICE_DUAL_SOCKET="$tmp" INVOICE_DUAL_PORT="$port" INVOICE_DUAL_PORTS="$ports" INVOICE_DUAL_MARKER="$marker" \
  NODE_OPTIONS="--require ./tests/helpers/invoice-dual-network-guard.cjs" \
  timeout 120s node --import tsx tests/invoice-native-schema.test.ts
INVOICE_DUAL_SOCKET="$tmp" INVOICE_DUAL_PORT="$port" INVOICE_DUAL_PORTS="$ports" INVOICE_DUAL_MARKER="$marker" \
  NODE_OPTIONS="--require ./tests/helpers/invoice-dual-network-guard.cjs" \
  timeout 120s node --import tsx tests/invoice-mandatory-fence.test.ts
