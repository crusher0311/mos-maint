#!/usr/bin/env bash
set -euo pipefail
# Invoke from either prepared release checkout after installing its lockfile.
# No live worker startup. All application checks deny external egress.
if [[ "${INVOICE_COMPAT_CLEAN:-}" != yes ]]; then
  exec env -i PATH="$PATH" HOME="$HOME" \
    LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}" LD_AUDIT="${LD_AUDIT:-}" \
    REPLIT_LD_LIBRARY_PATH="${REPLIT_LD_LIBRARY_PATH:-}" \
    INVOICE_COMPAT_CLEAN=yes bash "$0" "$@"
fi
export PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true
export NODE_OPTIONS="--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs"
timeout 90 node --import tsx tests/invoice-background-compatibility.smoke.ts "$@"
timeout 90 node --import tsx tests/invoice-evidence-preservation.smoke.ts
timeout 90 bash tests/run-protractor-work-order-identity.sh
timeout 180 npm run typecheck
timeout 90 node --import tsx tests/backfill-drain-worker-incremental-entrypoint.smoke.ts
if [[ -f tests/protractor-callback-worker.smoke.ts ]]; then
  timeout 90 node --import tsx tests/protractor-callback-worker.smoke.ts
fi
out=$(mktemp -d /tmp/invoice-worker-bundle.XXXXXX)
trap 'rm -rf "$out"' EXIT
entries=(scripts/backfill-drain-worker.ts)
if [[ -f scripts/protractor-callback-worker.ts ]]; then
  entries+=(scripts/protractor-callback-worker.ts)
fi
timeout 90 node_modules/.bin/esbuild "${entries[@]}" \
  --bundle --platform=node --format=esm --packages=external --outdir="$out"
echo "PASS isolated release checks (workers bundled, never started)"
