# DB integration-cache cutover — per-integration Mongo→Postgres flip

Task: **#556 — migrate integration source-of-truth caches to Postgres**
(Tekmetric / Protractor / Shop-Ware / AutoFlow / AutoVitals).
Downstream: the wider Wave-2/Wave-3 cutover and, eventually,
**Decommission MongoDB**.

This runbook flips the canonical store for one integration's cache group
at a time. Each integration is independent — flip, soak, and (if needed)
roll back one without touching the others.

> **Safety.** In this repl, the dev MongoDB connection points at the
> **production** cluster. Do **not** run backfills, `createIndex`, or any
> write from the dev environment — every such command hits prod live.
> All backfill/flip steps below are **operator actions against the
> deployed app's env**, run during an announced window.

---

## Architecture summary

The PG mirror tables already exist (`drizzle/0014_wave3.sql`; schema in
`lib/db/schema/wave3.ts` and `lib/db/schema/wave2.ts`). Task #556 adds
the **flip switches and the gated read/write surface**, defaulting to
Mongo so nothing changes until an operator opts in.

* **Flags** — `lib/db/integration-cache-write-mode.ts`. Two per
  integration, read on every call (toggling is a no-deploy operation —
  set/unset env, the next request picks it up):
  * `<INTEGRATION>_CACHE_PG_CANONICAL=1` → the abstracted cache repos for
    that integration read & write **Postgres**. Default OFF (unset/`0`)
    keeps **Mongo** canonical.
  * `WRITE_MONGO_<INTEGRATION>_CACHE` → soak-window shadow write to the
    legacy Mongo collections. Default **ON**; any value other than the
    literal `"0"` leaves it enabled. Flip to `0` once the soak passes.

  `<INTEGRATION>` ∈ `{TEKMETRIC, PROTRACTOR, SHOPWARE, AUTOFLOW,
  AUTOVITALS}`.

* **Dispatch** — each abstracted Mongo repo checks
  `isXCachePgCanonical()` at the top of every helper. When OFF it runs
  the original Mongo body verbatim (private `*Mongo` fn) — byte-for-byte
  unchanged behaviour. When ON it calls the PG repo, then replays the
  Mongo write through `shadowWriteMongoIntegrationCache()` (non-fatal:
  errors are logged, never thrown, so a Mongo blip can't break the
  request once PG is canonical).

* **PG read/write surface** —
  `lib/data/repositories/pg/shopware-cache.ts`,
  `lib/data/repositories/pg/protractor-cache.ts`,
  `lib/data/repositories/pg/autovitals-cache.ts`. They mirror the Mongo
  repo signatures and return Mongo-shaped docs (verbatim source doc kept
  in the `payload`/`raw` jsonb column), so callers see no shape change.

* **Backfill** — `scripts/backfill-mongo-to-supabase.ts`, the same
  resumable/idempotent MIRRORS registry used by W3/W4. Run a mirror with
  `--mirror=<key>`; verify with `--mirror=<key> --verify-only`.

### What "gated" does and does not cover

The flags route the **abstracted** repos
(`lib/data/repositories/*`). Two things are **out of the gated path**
and must be handled before a flip is real for that integration:

1. **Direct, unabstracted Mongo access.** Several call sites read these
   collections via `db.collection("…")` directly (they live in the
   `scripts/check-direct-db.cjs` allowlist). Those keep reading **Mongo**
   regardless of the flag. As long as `WRITE_MONGO_<INTEGRATION>_CACHE`
   is ON they stay correct (PG-canonical writes are mirrored back to
   Mongo), but they will not see PG-only data and they cannot be the
   source of truth. Fold each onto the gated repo (or a PG read) before
   turning the shadow write off. Inventory per integration below.

2. **Backfill coverage.** A flip is only safe once the integration's
   collections have a MIRROR spec **and** a clean backfill. AutoVitals
   `autovitals_appointments` / `autovitals_inspections` do **not** yet
   have mirror specs (see the comment near the `autovitals_imports`
   spec) — add them before flipping AutoVitals, or historical
   appointments/inspections will be absent from PG after the flip.

---

## Per-integration readiness

| Integration | Abstracted repos gated | PG repo | Backfill mirrors present | Pre-flip work before shadow-off |
| --- | --- | --- | --- | --- |
| **Shop-Ware** | ✅ `shopware-cache.ts` (RO upsert/delete, vehicle, customer) | ✅ | ✅ `shopware_repair_orders`, `shopware_vehicles`, `shopware_customers` | Fold direct readers: `lib/shopware-jobs-prewarm.ts`, `app/api/dashboard/data/route.ts`, `app/api/plan-build/route.ts`. |
| **Protractor** | ✅ `protractor-work-orders.ts`, `protractor-vehicles.ts` | ✅ | ✅ `protractor_work_orders`, `protractor_vehicles` (also `protractor_invoices`, `protractor_callback_events`) | Fold direct readers: `lib/integrations/protractor.ts`, `lib/protractor-jobs-prewarm.ts`, `app/api/dashboard/data/route.ts`, `lib/vhi-rebuild.ts`, `lib/auto-booking/scheduler.ts`. |
| **AutoVitals** | ✅ `autovitals-vehicles.ts`, `-appointments.ts`, `-inspections.ts` | ✅ | ⚠️ `autovitals_vehicles` only — **add `autovitals_appointments` + `autovitals_inspections` mirror specs first** | Fold direct readers under `lib/integrations/autovitals.ts`, `app/api/autovitals/**`. |
| **Tekmetric** | ⚠️ flags provided; cache access is **direct/unabstracted** (sprawling readers) | — (reuses wave2/3 tables) | ✅ `tekmetric_work_orders`, `tekmetric_repair_orders`, `tekmetric_vehicles` | Hot path. Route the direct call sites (`lib/tekmetric-*`, dashboard, extension job-search) onto a gated surface before flipping. Treat as its own sub-project. |
| **AutoFlow** | ⚠️ flags provided; cache access is **direct/unabstracted** | — | ✅ `autoflow_dvi_items`, `autoflow_events`, `af_open` | Credentials live on the `shops` collection (W4 overlap) and `dvi_results` is shared — coordinate with identity (W4). Route direct call sites first. |

"✅ gated" = flipping the flag changes behaviour through the abstracted
repos today. "⚠️" = the flag exists for symmetry/future use but the
integration still needs its direct call sites routed before a flip means
anything; do that as a follow-up before attempting its cutover.

---

## Pre-window (T-1 day) — per integration `<I>`

1. **Schema is live in PG** (already shipped in `0014_wave3.sql`; verify
   the tables exist in the prod PG before proceeding).
2. **For AutoVitals only:** land the
   `autovitals_appointments` / `autovitals_inspections` mirror specs in
   `scripts/backfill-mongo-to-supabase.ts` and deploy before step 3.
3. **First backfill** with the flag still OFF (Mongo canonical):
   ```bash
   tsx scripts/backfill-mongo-to-supabase.ts --mirror=<mongo_collection>
   ```
   Run once per collection in the integration's group. Re-run any spec
   that returns `DRIFT(under)` until every spec reports `coverage>=99%`.
4. **Spot-check** the largest table:
   ```bash
   tsx scripts/backfill-mongo-to-supabase.ts --mirror=<collection> --verify-only
   ```

## Cutover window (T0) — one integration at a time

1. **Final delta backfill** — captures Mongo writes since the pre-window
   run. Verify every spec for the group ends `OK` (≤ tolerance).
2. **Flip the canonical flag** in the deployment env:
   ```
   <I>_CACHE_PG_CANONICAL=1
   WRITE_MONGO_<I>_CACHE=1      # keep mirroring during the soak (default)
   ```
3. **Restart the workflow** so the new env is picked up:
   ```
   restart_workflow "MOS Maintenance MVP"
   ```
4. **Smoke test** the integration's hot paths (sync/prewarm cron, the
   webhook route, and any dashboard/plan surface that reads its cache).
   Confirm reads return data and writes land in PG (`--verify-only`
   should stay `OK`).

## Post-window soak (T+24h–168h)

Direct, unabstracted readers/writers (inventory above) still touch
Mongo-only during the soak. Converge them with **periodic delta
backfills** while `WRITE_MONGO_<I>_CACHE=1`:

| When | What |
| --- | --- |
| T0 + 5 min | `--mirror=<collection>` first delta sweep, before external traffic |
| Every 15 min, 1h–24h | same; any `DRIFT(under)` → investigate |
| T+24h → T+168h | spot delta + watch logs for `[ShadowMongoCache]` errors |

Before flipping the shadow write off, **all** must hold:

1. Every mirror in the group reports `OK` (≤ tolerance) across the soak.
2. Every direct-access call site for the integration (allowlist
   inventory above) has been folded onto the gated repo / a PG read, or
   is confirmed read-only-against-history and acceptable.
3. Workflow logs show zero `[ShadowMongoCache]` write errors over 24h.

Then:
```
WRITE_MONGO_<I>_CACHE=0
```
Restart the workflow. The Mongo collections for that integration become
append-only history.

## Rollback

If a flipped integration misbehaves:

1. Set `<I>_CACHE_PG_CANONICAL=0` and restart the workflow. The
   abstracted repos revert to Mongo reads/writes immediately. Because
   `WRITE_MONGO_<I>_CACHE=1` was on during the PG-canonical period, every
   PG write was mirrored to Mongo, so the stores stay aligned — no data
   loss.
2. File a follow-up capturing the failure and re-plan that integration.
   The other integrations are unaffected.
