---
name: DB cutover flips are operator-only
description: The Mongo→Postgres wave cutovers (flip canonical flag, run backfill, soak, remove safety nets) cannot be done from an isolated task env — they are production operations.
---

# DB cutover flips are operator-only production actions

The Mongo→Postgres migration is staged in waves (W0–W4) gated by env flags
(`IDENTITY_PG_CANONICAL`, `WRITE_MONGO_IDENTITY`, `WRITE_MONGO_NORMALIZED`,
`WRITE_MONGO_COUNTERS/API_KEYS/EVENTS`, etc.). Tasks that say "flip
canonical", "run the backfill", "soak", or "retire the Mongo shadow / remove
the fallback" are **operator-only** and must NOT be attempted from an isolated
task env.

**Why:**
- This repl's dev Mongo IS the production cluster (see `dev-mongo-is-prod.md`),
  so the backfill and any write hit prod live.
- Flipping `*_PG_CANONICAL=1` only matters on the production deploy env; setting
  it here does nothing for prod and can break the dev app if PG isn't backfilled.
- A soak is multi-hour/multi-day monitoring of real production traffic.
- Removing a safety net (e.g. the extension-auth `pg_miss_mongo_hit` Mongo
  fallback) is gated on the soak confirming **zero drift**. Doing it before the
  flip+soak strips the net that keeps users logged in through the cutover.

**How to apply:**
- For a "flip + retire" wave task: confirm whether the prod flip/soak actually
  happened before touching safety nets. Check (read-only): runtime env flags
  (`process.env.*`), `.env*` / `.replit` / `render.yaml`, and deployment logs
  for the soak-gate markers (`pg_miss_mongo_hit`, `[DualWritePgIdentity]`,
  `[ShadowMongoIdentity]`). No markers + unset flags = cutover never ran.
- If the cutover hasn't run, the deliverable is the **code-ready state +
  accurate doc of remaining operator steps** in `docs/db-migration-map.md`
  (mirror the W3a/W3b §10.5/§11.8 "cannot complete in an isolated task env"
  convention). Do NOT mark the wave complete or remove fallbacks.
- The runbooks (`docs/runbooks/db-w4-cutover.md`, etc.) hold the exact operator
  sequence; reference them rather than improvising.

**Deploying merged cutover code is SAFE (code deploy ≠ cutover):** every
`*_PG_CANONICAL` flag resolves via `process.env.X === "1"` → default OFF (Mongo
canonical). Shipping the merged migration tasks to prod does NOT activate any
cutover; only setting the env var to `"1"` on the Render service does. To prove
no cutover is live on prod, list the service env vars via the Render API
(`GET /v1/services/{id}/env-vars`, paginate by `cursor`, `limit<=100`) and
confirm no canonical/cutover flag is present/`=1`. Build-time smoke tests emit a
deliberate `Postgres error ... simulated pg blip` line proving the
fallback-to-per-process/Mongo path works — that is test noise, not a prod fault.
