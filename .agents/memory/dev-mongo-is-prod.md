---
name: Dev Mongo is Prod Mongo
description: The development MongoDB connection in this repl points at the production cluster.
---

In this project the development environment's MongoDB (`MONGODB_USERNAME`/`MONGODB_PASSWORD`,
via `lib/mongo.ts` `getDb`/`getMongoClient`) connects to the SAME cluster as production.

**Why:** Brandon confirmed dev Mongo = prod Mongo. There is no separate dev Mongo instance.

**How to apply:**
- Any `createIndex`, `updateOne`, `deleteMany`, etc. run from a dev script (e.g. `npx tsx _x.ts`)
  mutates production data immediately. Treat every Mongo write as a prod write.
- Prefer `background: true` for index builds and scope queries tightly.
- The `code_execution` sandbox lacks the Mongo secrets, so live Mongo work must go through
  bash + tsx (which inherits the env). Postgres (`DATABASE_URL`) is separate.
- DB layout: cron bookkeeping (`cron_status`, `cron_runs`, `cron_locks`) lives in db `mos`;
  everything else (e.g. `protractor_callback_events`, `protractor_sync_progress`, `shops`,
  `job_index`) lives in db `mos-maintenance-mvp` (the `getDb` default).
