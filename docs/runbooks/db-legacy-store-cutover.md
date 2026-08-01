# Legacy pre-normalized store cutover (task #1000)

Covers the last data-bearing Mongo group: `vehicles` / `customers` /
`manual_vehicles`, `dvi` / `dvi_results`, `canned_jobs` /
`canned_job_applications`, `concern_conversations`, `shop_repair_patterns`,
`support_tickets` — plus the retired `repair_orders` / `jobs` / `job_history`
group (see `docs/db-migration-map.md` §13 for dispositions).

All flags default OFF → Mongo canonical → zero behaviour change. Flags are in
`lib/db/legacy-store-write-mode.ts` and are read on every call (no-deploy
toggles).

| Domain | Canonical flag | Shadow kill-switch | Gated repo(s) | Backfill mirror key(s) |
| --- | --- | --- | --- | --- |
| vehicles/customers/manual_vehicles | `LEGACY_VEHICLES_PG_CANONICAL` | `WRITE_MONGO_LEGACY_VEHICLES` | `lib/data/repositories/{vehicles,customers}.ts` → `pg/pre-normalized.ts` | `pre_vehicles`, `pre_customers`, `pre_manual_vehicles` |
| DVI | `DVI_PG_CANONICAL` | `WRITE_MONGO_DVI` | `lib/data/repositories/dvi.ts` → `pg/dvi.ts` | `dvi`, `dvi_results` |
| canned jobs | `CANNED_JOBS_PG_CANONICAL` | `WRITE_MONGO_CANNED_JOBS` | `lib/data/repositories/canned-jobs.ts` → `pg/canned-jobs.ts` | `canned_jobs`, `canned_job_applications` |
| concern conversations | `CONCERN_CONVERSATIONS_PG_CANONICAL` | `WRITE_MONGO_CONCERN_CONVERSATIONS` | `lib/data/repositories/concern-conversations.ts` → `pg/concern-conversations.ts` | `concern_conversations` |
| repair patterns | `REPAIR_PATTERNS_PG_CANONICAL` | `WRITE_MONGO_REPAIR_PATTERNS` | `lib/repair-patterns.ts` → `lib/data/repositories/pg/repair-patterns.ts` | `shop_repair_patterns` |
| support tickets | `SUPPORT_TICKETS_PG_CANONICAL` | `WRITE_MONGO_SUPPORT_TICKETS` | `lib/data/repositories/support-tickets.ts` → `pg/support-tickets.ts` | `support_tickets` |

## Operator procedure (per domain, prod-only)

1. Apply the pending migrations to Supabase (idempotent):
   `drizzle/0024_task1000_dvi_payload.sql`,
   `drizzle/0025_task1000_package3.sql`,
   `drizzle/0026_task1000_support_tickets.sql`.
2. Backfill: `tsx scripts/backfill-mongo-to-supabase.ts --mirror=<key>` for
   each key above (resumable; `--shop=<id>` for a canary shop first).
3. Parity: `tsx scripts/cutover-parity.ts --domain=legacy` — must be clean
   (count delta <1%, no missing sampled keys) for the domain's entities.
4. Flip `<DOMAIN>_PG_CANONICAL=1` (keep the shadow flag on) and watch logs
   for `[ShadowMongoLegacyStore]` errors during a 24–168 h soak, running
   periodic delta backfills for the domains whose long-tail writers are
   still direct-Mongo (see below).
5. After a clean soak, set `WRITE_MONGO_<DOMAIN>=0`.
6. Rollback at any point = unset the canonical flag.

## Long-tail direct-Mongo call sites (fold before dropping collections)

These remain on Mongo deliberately; they stay correct while shadow writes
are on, and must be folded onto the gated repos (or retired) before the
final decommission drops the collections:

- **vehicles/customers**: sync adapters and webhook/callback routes
  (`app/api/callbacks/protractor`, `app/api/webhooks/protractor/[token]`,
  `app/api/cron/protractor-sync`, `app/api/tekmetric/sync`,
  `scripts/protractor-sync-standalone.ts`), vehicle detail routes
  (`app/api/vehicles/[vin]/*`, `check-closed-orders`, `close-work-order`),
  dashboard/report/plan-build reads (`app/api/dashboard/data`,
  `app/api/report/[vin]`, `app/api/plan-build`), enterprise/admin
  counts + `lib/data-quality.ts`, `lib/integrations/dvi.ts`
  vehicle/customer enrichment writes, and the generic repo surface
  consumers (`app/api/customers/*`, `app/dashboard/protection-plans`).
  Because these writers still write Mongo-only pre-flip, the vehicles
  domain needs delta backfills during its soak, and the long-tail
  writers must be folded before `WRITE_MONGO_LEGACY_VEHICLES=0`.
- **support_tickets**: `app/api/support/tickets` POST keeps its task #344
  unconditional PG-first insert (the gated PG insert merges on
  `ticket_number`); `app/api/platform-admin/tickets` still joins
  `shop_users` directly (different collection, W4).

## Notes / preserved quirks

- `vehicles` is VIN-keyed with inconsistent shopId (missing/string/number):
  PG reads scope with `shop_id::text = ANY(variants) OR shop_id IS NULL`,
  mirroring the Mongo `$in` variants. Customer-facing reads must stay
  shop-scoped — VIN-only reads leak tenants.
- DVI data is advisory-only — never a history anchor; the gated repo only
  changes the storage, not those semantics.
- `canned_jobs`/`canned_job_applications` here are the *legacy* stores, not
  the provider canned-jobs caches; the empty-cache poisoning guards on the
  caches are untouched and the legacy reader keeps exact empty-result
  semantics.
- Support tickets bridge Mongo string ids via the unique `mongo_id` column;
  PG-native inserts mint an ObjectId hex so caller contracts hold. The
  backfill must run so historical tickets get `mongo_id` populated.
