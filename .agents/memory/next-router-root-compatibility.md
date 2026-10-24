---
name: Next router root compatibility
description: Mixed app/pages directory roots cause invalid generated route imports after the Next 15 upgrade.
---

Keep both Next router entrypoints at the project root, even when a legacy
pages-router implementation remains under src.

**Why:** Next 15 derives a shared source-root flag from the pages router.
Combining root app routes with src/pages caused generated validators to import
nonexistent src/app routes. A successful build alone missed this because this
project separately runs typecheck.

**How to apply:** Preserve the root pages forwarding entrypoint and run
typecheck after generating production route types. Avoid concurrent dev and
build processes writing the same .next directory during verification.
