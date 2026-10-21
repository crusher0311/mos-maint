#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Clear inherited credentials and deny external sockets before importing routes.
env -i PATH="$PATH" HOME="$HOME" \
  PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
  NODE_OPTIONS="--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs" \
  sh -c 'node --import tsx --test tests/check-in-drafts.test.ts tests/check-in-transfer-route.test.ts tests/ro-shared-draft-client.test.ts && node --import tsx tests/browser/check-in-transfer.smoke.ts'
