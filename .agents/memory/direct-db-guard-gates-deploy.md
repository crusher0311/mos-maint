---
name: direct-db guard gates prod deploy
description: why a new file touching Mongo can silently break the Render build
---

`scripts/check-direct-db.cjs` (`lint:direct-db`) runs inside `test:smoke`, which
runs at the front of the Render `prebuild`. So it is not just a local lint — it is
a **production deploy gate**. Any file that imports `getDb()`/`getMongoClient()`
(directly from `@/lib/mongo`) and is NOT on the allowlist (or under an always-allowed
prefix like `lib/data/`, `scripts/drain-`, migrations) **fails the Render build**, and
the web service stays on old code.

**Why:** the script's header says "do NOT add to the allowlist — use a repository,"
but operational/integration files (cron sweeps, webhook-subscribe helpers, telemetry
runners) legitimately touch operational-only collections that have no place in
`lib/data/repositories/`. The established precedent is to allowlist them **with a
comment** explaining why (see the alerter/health crons, synthetic runner, print-queue
repo, tekmetric `webhook-subscribe.ts`).

**How to apply:** any new file that reaches Mongo directly must either go through a
repository OR be added to the allowlist with a justifying comment. After adding,
run `node scripts/check-direct-db.cjs` locally — it must print `0 unauthorized` AND
report no *stale* entries. A merge that adds DB-touching files without updating this
allowlist will pass the merge but break the next prod deploy.
