#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# No inherited credentials and no external network access.
for test in \
  tests/protractor-manual-sync-admission.smoke.ts \
  tests/protractor-onboarding-runtime.smoke.ts \
  tests/protractor-onboarding-transport.smoke.ts \
  tests/protractor-onboarding-canonical-discovery.smoke.ts \
  tests/protractor-onboarding-integration-status.test.ts
do
  env -i PATH="$PATH" HOME="$HOME" \
    NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' \
    timeout 60s node --import tsx "$test"
done

npm run test:protractor-settings-browser
