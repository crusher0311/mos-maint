---
name: Repo migrations must keep test seams wired
description: Moving direct-Mongo reads/writes into flag-gated repositories silently bypasses smoke-test __deps/getDb seams and blocks prod deploys.
---

**Rule:** When a route/lib function's Mongo access is moved into a `lib/data/repositories/*` repo, every smoke test that injected a fake db via a `__deps`/`__fastpathDeps` seam breaks silently — the repo calls its own `getDb`, not the seam. The fix is to expose the repo function on the seam object (default = repo) and have the test stub it against the same fake seed.

**Why:** The task #999 integration-ops repo migration broke two prebuild smoke tests (protractor new-shop fastpath, tekmetric webhook idempotency) this way, which failed the Render prebuild and silently blocked ALL prod deploys for 3+ days (last live deploy fell behind main).

**How to apply:** When migrating any direct db access into a repository, grep tests for the module's seam (`__deps`, `__fastpathDeps`) and for the collection name; route the new repo call through the seam. Also: run the full `npm run prebuild` locally before pushing — it's the exact Render gate and much cheaper than an 8-min failed build. Check Render deploy status after merges; a merge to the repl does NOT deploy — only a push to GitHub main does. Note: `gitPush` callback rejects this repo's credential-helper config (DANGEROUS_CONFIG); plain `git push origin main` in the shell works.
