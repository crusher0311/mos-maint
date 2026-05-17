#!/bin/bash
set -e

npm install --legacy-peer-deps

# Chrome extension publish: DO NOT auto-publish from post-merge.
#
# Standing rule from replit.md (set 2026-05-06): NEVER auto-publish the
# mos-tools-extension. Brandon must say "publish it" before anything is
# sent to Google. A previous version of this script ran the wrapper
# automatically when the manifest version changed in the merge, and on
# 2026-05-17 that path shipped v1.27.7 to CWS without Brandon's
# approval as part of the Task #434 merge. Never again.
#
# The merge step still surfaces the manifest delta below as an FYI so
# it's obvious a publish is pending. To actually ship, run:
#     npm run ext:auto-publish
# or (for full control) `npx tsx scripts/auto-publish-extension.ts`.
#
# If you ever WANT post-merge to publish (you almost certainly don't),
# set POST_MERGE_ALLOW_EXTENSION_PUBLISH=1 in the environment. The flag
# is intentionally noisy and undocumented in replit.md so it can't be
# enabled by accident.
MANIFEST=mos-tools-extension/manifest.json
CURR_VERSION=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$MANIFEST" 2>/dev/null || true)
PREV_VERSION=$(git show HEAD~1:"$MANIFEST" 2>/dev/null \
  | grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' || true)

if [ -n "$PREV_VERSION" ] && [ "$PREV_VERSION" = "$CURR_VERSION" ]; then
  echo "[ext:auto-publish] manifest version unchanged since HEAD~1 ($CURR_VERSION) — nothing to do"
elif [ "${POST_MERGE_ALLOW_EXTENSION_PUBLISH:-}" = "1" ]; then
  echo "[ext:auto-publish] POST_MERGE_ALLOW_EXTENSION_PUBLISH=1 set — running wrapper (was: ${PREV_VERSION:-unknown}, now: $CURR_VERSION)"
  npx tsx scripts/auto-publish-extension.ts
else
  echo "[ext:auto-publish] manifest version changed (was: ${PREV_VERSION:-unknown}, now: $CURR_VERSION)"
  echo "[ext:auto-publish] NOT publishing — standing rule: only Brandon publishes the extension."
  echo "[ext:auto-publish] To ship, run: npm run ext:auto-publish"
fi
