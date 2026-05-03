# Wave 0 — Mongo orphan-collection drop

- **Date:** 2026-05-03
- **Task:** #341 (DB switchover W0)
- **Database:** `mos-maintenance-mvp` (production Atlas cluster)
- **Operator script:** `scripts/wave0-drop-orphans.ts`
- **Type:** Destructive drop of confirmed-orphan collections, plus
  re-classification of "verify before dropping" candidates that turned
  out to still have live callers.

## Method

1. Re-grep the codebase for every Wave 0 candidate listed in
   `docs/db-migration-map.md` §4.1 and §4.2 to confirm only `_archive/**`
   (or zero) references remain. Any collection with a live caller in
   `app/`, `lib/`, `routes/`, or `scripts/` is reclassified instead of
   dropped.
2. For each confirmed orphan, snapshot the collection: existence,
   `estimatedDocumentCount`, up to three `_id` samples, and the first
   document's top-level keys.
3. Drop confirmed orphans in one short admin session (`npx tsx
   scripts/wave0-drop-orphans.ts`).

## Re-grep results

| Candidate | Wave 0 source | Live references found | Decision |
| --- | --- | --- | --- |
| `webhook_events` | §4.1 | none (only `docs/db-migration-map.md`) | DROP |
| `serviceevents` | §4.1 | none | DROP |
| `vehicleschedules` | §4.1 | none | DROP |
| `inspectionfindings` | §4.1 | none (DVI writer in `lib/integrations/dvi.ts` only writes `tickets`, not `inspectionfindings`) | DROP |
| `analyses` | §4.1 | none | DROP |
| `oeschedules` | §4.1 | none | DROP |
| `LKP_VIN_MAINTENANCE` | §4.1 | none in Mongo (the script references are CSV filenames / Postgres table names in `scripts/dataone-postgres-import.ts` etc.) | DROP |
| `LKP_YMM_MAINTENANCE` | §4.1 | same — Postgres/CSV only | DROP |
| `DEF_MAINTENANCE_EVENT` | §4.1 | same — Postgres/CSV only | DROP |
| `password_resets` | §4.1 | live: `app/api/admin/db-indexes/route.ts` ensures `token` unique + `expiresAt` TTL indexes on this collection | RECLASSIFY → W3 (auth-adjacent; already row 108 in §3.1) |
| `services_by_ymm` | §4.1 | live: `routes/maintenance.js`, `routes/vin-maintenance.js`, `routes/vin-next-due.js` (Express routers wired by `server.js`) | RECLASSIFY → W2 (retire the legacy Express server first) |
| `tickets` | §4.2 | live writer `lib/integrations/dvi.ts:282`, live reader `app/api/vehicles/[vin]/refresh/route.ts:67` (DVI integration — distinct from PG `support_tickets`) | RECLASSIFY → W3 |
| `shop_users` | §4.2 | live reader `app/api/platform-admin/tickets/route.ts:315` (multi-collection join) | RECLASSIFY → W4 (joined to `users`/`tickets`) |
| `workflow_runs` | §4.2 | live reader `app/api/workflows/runs/route.ts` | RECLASSIFY → W2 (no in-repo writer; needs external-writer check before drop) |

## Snapshot before drop

Run timestamp: 2026-05-03T21:57Z (production Atlas).

### Confirmed orphans

| Collection | Exists in prod? | Doc count | Sample `_id`s | First-doc keys |
| --- | --- | --- | --- | --- |
| `webhook_events` | no | — | — | — |
| `serviceevents` | no | — | — | — |
| `vehicleschedules` | no | — | — | — |
| `inspectionfindings` | no | — | — | — |
| `analyses` | no | — | — | — |
| `oeschedules` | no | — | — | — |
| `LKP_VIN_MAINTENANCE` | no | — | — | — |
| `LKP_YMM_MAINTENANCE` | no | — | — | — |
| `DEF_MAINTENANCE_EVENT` | no | — | — | — |

All nine confirmed-orphan collections were **already absent** from the
production database at snapshot time — likely dropped manually or never
recreated after the original DataOne ETL was retired. No documents
were lost in this task; the drop step was effectively a no-op
verification.

### Reclassified (left in place)

| Collection | Exists in prod? | Doc count | Sample `_id`s | First-doc keys |
| --- | --- | --- | --- | --- |
| `password_resets` | yes | 0 | — | — |
| `services_by_ymm` | no | — | — | — |
| `tickets` | yes | 1 | `68b5a5ec6abc7d4a868481d5` | `_id, roNumber, shopId, createdAt, customerExternalId, mileage, source, status, updatedAt, vin` |
| `shop_users` | no | — | — | — |
| `workflow_runs` | no | — | — | — |

`password_resets`, `services_by_ymm`, `shop_users`, and `workflow_runs`
were not dropped — they have live callers in the repo even though most
of them currently hold no data in production. Dropping any of them
would just be re-created on next write/index-ensure, masking the real
W2/W3/W4 cleanup work needed to retire the callers.

## Drop session

`npx tsx scripts/wave0-drop-orphans.ts` executed against production at
2026-05-03T21:58Z. Because every confirmed-orphan was already absent,
the drop loop emitted only `SKIP <name> (does not exist)` lines and no
collections were modified. Output retained in script logs.

## Outcome

- Wave 0 confirmed-orphan list verified clean in production.
- Five "verify before drop" candidates reclassified into later waves
  with the live caller documented.
- No data lost; no callers broken.
- `docs/db-migration-map.md` updated to reflect DROPPED / RECLASSIFIED
  status per collection.
