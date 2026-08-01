# Mongo → Postgres Cutover Sequence (load-relief ordering)

**Written:** 2026-06-05, after the shared-Mongo saturation incident (giant-shop
Tekmetric history catch-up overloaded the shared Atlas cluster → fleet-wide Mongo
timeouts, login "Request timed out", slow/locked keytags).

**Purpose:** the *order* in which to flip the remaining Mongo domains to Postgres,
chosen so we (a) take load off the shared Mongo cluster fastest and (b) protect
login and the extension first. This sits on top of the full inventory in
`docs/db-migration-map.md` (the living source of truth) and the per-domain
mechanics in the other runbooks (`db-integration-cache-cutover.md`,
`db-w4-cutover.md`, `worker-queue-cutover.md`). It does **not** replace them.

**Audience note (plain language):** "dual-write" is the *middle* of a migration,
not the end. While a domain is dual-writing, we still write Mongo **and** still
*read* Mongo, so Mongo is still load-bearing — that is exactly the stage that
failed in this incident. A domain only stops loading Mongo when we (1) prove the
Postgres copy matches during a soak, (2) flip reads to Postgres, **and** (3) turn
the Mongo writes off. Steps 1–3 are what this sequence schedules.

---

## Ground rules (apply to every step below)

- **Every flip is a no-deploy env change**, read per request, reversible in
  <60s by unsetting the flag. No code ship is required to flip or roll back.
- **Every flip is an operator/production action.** It cannot be done from an
  isolated task environment, and it must not be bundled into a feature task.
- **Soak before you stop Mongo writes.** The pattern for each domain is the same:
  1. **Backfill** the Postgres copy (where a backfill exists).
  2. **Flip reads to PG** by setting `<DOMAIN>_PG_CANONICAL=1`, leaving the Mongo
     shadow write **on** (`WRITE_MONGO_<DOMAIN>=1`).
  3. **Soak 24–168h** with the parity/drift verifier clean and error metrics flat.
  4. **Stop Mongo writes** by setting `WRITE_MONGO_<DOMAIN>=0`. *This is the step
     that actually relieves Mongo.*
  5. **Code cleanup** (retire the Mongo handles) happens later, per domain — not
     on the critical path for load relief.
- **One domain at a time**, off-peak, with a named owner watching Better Stack
  (filter to host `mos-maintenance-mvp-main`).
- **Do not resume the history catch-up at full throttle** while a cutover soak is
  in flight — a backfill + a soak hitting Mongo at once muddies the parity signal.

---

## Recommended order

The official map (`db-migration-map.md` §6) sequences by blast radius
(W1 → W2 → W3 → W4) for the *full decommission*. For **load relief after this
incident** the priority is different: do the cheap, already-built, high-relief
flips first, and protect login early. Where this diverges from the strict
"tenancy-core-last" rule, it is called out and explained.

### Step 1 — Finish the normalized data cutover (quick win, already built)

- **What:** the six normalized entities (vehicles / customers / work_orders /
  service_jobs / line_items / payments) are **already Postgres-canonical** and
  reads are already on PG (#344/#552). All that's left is to stop the Mongo
  shadow writes.
- **Why first:** no new code needed — it's unblocked. The Mongo shadow writes
  here are a meaningful slice of the write load on the shared cluster.
- **Operator actions:** run the production backfill (`scripts/backfill-mongo-to-supabase.ts`),
  complete a 24–168h soak with `scripts/verify-normalized-data.ts` clean, then set
  **`WRITE_MONGO_NORMALIZED=0`**.
- **Relieves Mongo:** writes for 6 high-volume collections stop.

### Step 2 — Move the operational primitives (cheap, no backfill)

- **What:** the cron distributed lock and the Tekmetric shared rate-limiter
  buckets → PG-native.
- **Why here:** these are *transient* state, not data stores, so the cutover is a
  **pure flag flip — no backfill, no soak** (see memory:
  "Operational primitives → PG"). Cheap and removes constant Mongo lock/limiter
  churn that every cron tick generates.
- **Operator actions:** set **`CRON_LOCK_PG_CANONICAL=1`** and
  **`TEKMETRIC_SHARED_LIMITER_PG_CANONICAL=1`**; watch one or two cron cycles.
- **Relieves Mongo:** removes the steady lock/limiter read-write traffic.

### Step 3 — Protect login: flip identity to Postgres (W4 identity, early)

- **What:** users / shops / sessions login path → Postgres
  (`IDENTITY_PG_CANONICAL=1`), Mongo kept as shadow for now.
- **Why early (divergence from "tenancy-core-last"):** login is exactly what
  failed in this incident. The PG login path and Mongo fallback already exist
  (`lib/extension-auth.ts`, `lib/db/wave4-write-mode.ts`). Flipping *reads* to PG
  does **not** require dropping Mongo `shops`/`users` — we keep the Mongo shadow
  on so the ~487 files that still read Mongo identity keep working. So we get the
  protective benefit (login no longer shares Mongo's fate) without the risk that
  makes tenancy-core normally go last. We are flipping reads, **not** dropping.
- **Coverage note (task #997):** in addition to the central libs, the
  abstracted identity repos (`lib/data/repositories/{sessions,shops,users}.ts`)
  are now flag-gated onto `lib/data/repositories/pg/identity.ts`, so their
  callers flip with the flag too. Three query-shape helpers remain Mongo-only
  (documented in-file: `findShopByQuery`, `listShopsByQuery`,
  `updateShopById` — nested-jsonb integration lookups); they stay correct
  while `WRITE_MONGO_IDENTITY=1`.
- **Parity:** `tsx scripts/cutover-parity.ts --domain=identity` (read-only;
  counts + freshness + bidirectional sampled key diffs) must exit 0 before
  the flip and during the soak.
- **Operator actions:** backfill users/shops into PG, set
  **`IDENTITY_PG_CANONICAL=1`**, soak 24–168h (login success metrics + parity),
  then later `WRITE_MONGO_IDENTITY=0` only once downstream Mongo identity readers
  are gone (that part stays gated behind the full W4 work — see `db-w4-cutover.md`).
- **Relieves Mongo + protects login:** login reads move off the shared cluster.

### Step 4 — The big one: integration caches → Postgres (per integration)

- **What:** the raw per-shop work-order/vehicle caches the extension reads live
  and the history catch-up writes (`tekmetric_*`, `protractor_*`, `shopware_*`,
  `autoflow_*`, `autovitals_*`). Flags per integration:
  `<INT>_CACHE_PG_CANONICAL=1` then `WRITE_MONGO_<INT>_CACHE=0`
  (`lib/db/integration-cache-write-mode.ts`).
- **Why last of the relief steps:** highest fan-in, needs the most careful soak,
  and it is the heaviest daily traffic. **Build status (task #997):** all five
  integrations now have PG-mirror cache repositories and flag-gated abstracted
  repos — Tekmetric (`pg/tekmetric-cache.ts`, gated `tekmetric-work-orders.ts`)
  and AutoFlow (`pg/autoflow-cache.ts`, gated `autoflow-cache.ts`) were added in
  #997 alongside the existing Protractor/Shop-Ware/AutoVitals ones. **Caveat:**
  the Tekmetric cache *writers* (sync/backfill/webhook, incl. `job_index` and
  `tekmetric_work_orders` catch-up writes) and the heavy aggregate readers
  (dashboard `data`, plan-build, vhi-rebuild) are still direct-to-Mongo; they
  stay correct while `WRITE_MONGO_TEKMETRIC_CACHE=1` but must be folded onto the
  gated surface before shadow-off (inventory in
  `db-integration-cache-cutover.md`). Pre-flip + soak parity gate for every
  integration: `tsx scripts/cutover-parity.ts --domain=<int>` must exit 0.
- **Recommended sub-order (canary → heaviest):**
  1. A low-traffic integration as canary (AutoVitals or AutoFlow).
  2. Shop-Ware, then Protractor (repos exist).
  3. **Tekmetric last** (build the PG-mirror repo + backfill first; it is the
     biggest writer and the one in this incident).
- **Operator actions per integration:** flip `<INT>_CACHE_PG_CANONICAL=1`, soak
  24–168h with drift verification (`db-integration-cache-cutover.md`), then
  `WRITE_MONGO_<INT>_CACHE=0`.
- **Relieves Mongo most:** this is what moves both the live extension reads **and**
  the giant-shop catch-up writes off the shared cluster — i.e. the direct fix for
  this incident's root cause.

### Step 5 — Remaining Wave 2/Wave 3 stores, then cleanup

- Remaining operational/cache collections (AI/plan caches, notifications, audit
  logs, sticker surface, billing/Stripe state, queues) per map §6 Wave 2/3.
- Final code cleanup: retire the ~487 files still holding a Mongo handle, then drop
  the dead collections. This is bookkeeping for *removing* Mongo, not for relieving
  it — load relief is already achieved by Steps 1–4.

---

## Soak checkpoints (gate to advance)

Advance to the next step only when the current step clears **all** of:

- Parity/drift verifier clean for the domain (no content mismatches).
- Better Stack (host `mos-maintenance-mvp-main`) shows no rise in Mongo timeouts,
  500s, or login failures across a full peak window.
- Per-entity write success metric flat after `WRITE_MONGO_*=0`.
- At least one full cron cycle and one peak business hour observed.

If any check regresses, **unset the flag** (instant rollback) and investigate
before retrying.

---

## What this sequence deliberately does NOT do

- It does **not** drop any Mongo collection or remove `lib/mongo.ts`, the
  `mongodb`/`mongoose` packages, or `MONGODB_*` env vars. That's the final
  decommission (map task, currently BLOCKED on the 487-file audit).
- It does **not** change the canonical store for CRM or Rescue Rover (excluded —
  separate back-out).
