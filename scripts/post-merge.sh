#!/bin/bash
set -e

npm install --legacy-peer-deps

# Auto-publish the Detect Dog Chrome extension when the manifest version
# changed in this merge. Skipping the wrapper entirely on non-extension
# merges (instead of relying on the wrapper's own no-op path) keeps the
# post-merge step fast AND immune to transient CWS lookup failures —
# this satisfies the "never fail post-merge for non-extension changes"
# constraint. The wrapper still uses the live store version as the
# source of truth, so a missed publish from a previous merge self-heals
# on the next merge that touches the manifest, OR by manually running
# `npm run ext:auto-publish`.
MANIFEST=mos-tools-extension/manifest.json
CURR_VERSION=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$MANIFEST" 2>/dev/null || true)
PREV_VERSION=$(git show HEAD~1:"$MANIFEST" 2>/dev/null \
  | grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' || true)

if [ -n "$PREV_VERSION" ] && [ "$PREV_VERSION" = "$CURR_VERSION" ]; then
  echo "[ext:auto-publish] manifest version unchanged since HEAD~1 ($CURR_VERSION) — skipping"
else
  echo "[ext:auto-publish] manifest version changed (was: ${PREV_VERSION:-unknown}, now: $CURR_VERSION) — running wrapper"
  npx tsx scripts/auto-publish-extension.ts
fi
