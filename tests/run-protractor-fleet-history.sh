#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
env -i PATH="$PATH" HOME="$HOME" \
  LD_AUDIT="${LD_AUDIT:-}" REPLIT_LD_LIBRARY_PATH="${REPLIT_LD_LIBRARY_PATH:-}" \
  LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}" NIX_LD_LIBRARY_PATH="${NIX_LD_LIBRARY_PATH:-}" \
  PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
  NODE_OPTIONS="--require $PWD/tests/helpers/deny-network-egress.cjs --require $PWD/scripts/_stubs/server-only-stub.cjs" \
  bash -c '
    set -e
    node --import tsx tests/protractor-fleet-history.smoke.ts
    node --import tsx tests/protractor-fleet-history.mongo.ts
    node --import tsx --test app/platform-admin/protractor-history/history-client.test.ts
  '
