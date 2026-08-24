---
name: Auth lint vs new auth mechanisms
description: check-unauthed-routes runs in the Render prebuild; any route using a NEW auth mechanism fails the prod build until the lint learns the pattern.
---
Rule: introducing a new auth mechanism (signed share tokens, one-time grants, etc.) requires adding its call pattern to AUTH_PATTERNS in scripts/check-unauthed-routes.cjs + positive/import-only fixtures in scripts/test-check-unauthed-routes.cjs, in the SAME change.
**Why:** 2026-08-22 a merge added verifyShareToken/consumeExtensionActionGrant routes; prebuild lint failed, prod build silently stayed broken for 2 days while merges piled up (nobody watches Render build status).
**How to apply:** run full `npm run prebuild` before pushing anything that adds routes or auth helpers; also note smoke harnesses that eval extension background.js need stubs for new globals it calls.
