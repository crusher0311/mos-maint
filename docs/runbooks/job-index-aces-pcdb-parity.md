# Runbook — ACES / PCDB parity across providers (job_index)

**Task #695.** Goal: VIN-decoded ACES IDs (and line-level PCDB / PartsTech part
IDs) consistent across all shop-management providers, using **Tekmetric as the
reference** (vehicle ACES on write + per-line PCDB).

This runbook is **operator-only**. Dev Mongo IS prod Mongo, so nothing here runs
automatically — an operator runs the historical backfill deliberately, off-peak.

---

## What ships in code (automatic, no operator action)

On-write enrichment now happens for every provider going forward:

| Provider   | Vehicle ACES on write | Per-line PCDB on write | Path |
|------------|-----------------------|------------------------|------|
| Tekmetric  | ✅ (reference)        | ✅                     | `lib/integrations/tekmetric/job-index.ts` + `NormalizedIngestionService.writeToJobIndex` |
| Shopmonkey | ✅                    | ⛔ inherent gap        | `NormalizedIngestionService.writeToJobIndex` (generic `aces` enrichment) |
| Shop-Ware  | ✅ (new)              | ✅ when SW returns tags | `app/api/webhooks/shopware/route.ts` → `lib/integrations/shopware/webhook-job-index.ts` |
| Protractor | ✅                    | ⛔ no line-rebuild path | `NormalizedIngestionService.writeToJobIndex` |

### Shop-Ware was the core gap (now fixed for new ROs)
The Shop-Ware live write path is the **webhook**, which does NOT use
`NormalizedIngestionService`. It built a flat `job_index` doc with no `vehicle`
subdoc, no ACES, and no `lines`/PCDB. It now:

1. Decodes the RO VIN to ACES once (`enrichVinWithAces`) and nests the IDs under
   `vehicle.*` (the canonical Tekmetric shape the coverage tooling reads).
2. Builds per-service `lines[]` (labor + parts), attaching PCDB / PartsTech IDs
   to each part line via `extractShopWarePcdb` (reads `part.integrator_tags`).
3. Requests the `integrator_tags` association on the RO fetch. **If the SW API
   rejects that association it degrades to the base association** (best-effort —
   never break SW indexing over an enrichment).

### Hash-churn guard
`computeJobHash` (`lib/job-index.ts`) now strips the volatile `acesDecodedAt`
timestamp before hashing. The ACES *IDs* still participate (a real re-decode
flips the hash), but a re-fire that produces the same IDs does NOT rewrite the
row. Without this, adding `vehicle.acesDecodedAt` (a fresh `Date` each decode)
to the SW entry would churn the whole SW corpus on every webhook.

---

## Known / inherent gaps (document, do not "fix" blindly)

- **Shopmonkey PCDB**: `ShopmonkeyPart` / `ShopmonkeyServiceItem` carry no PCDB /
  integrator fields, so Shopmonkey has no line-level PCDB source. ACES-on-write
  works; PCDB is inherently absent until Shopmonkey exposes part classification.
- **Shop-Ware PCDB depends on the SW shop**: `integrator_tags` only arrive when
  the shop runs a PartsTech-style catalog integration AND the SW API returns the
  `integrator_tags` association. When absent, part lines are still written (with
  number/brand/price) but without PCDB IDs — same honest behavior as Tekmetric.
  - **Verified 2026-06-27 (Task #697) — currently unavailable for every connected
    SW shop.** Across all cached prod SW ROs (81,726 docs; 67,368 with parts) for
    the three connected shops (Shop-Ware Demo #77, State Street #136, Hoover Street
    #174), **zero** parts carry an `integrator_tags` key. Their parts are
    hand-entered/non-catalog (keys: `id,brand,description,number,*_cents,quantity,
    part_inventory_id,taxable` — no PCDB/PartsTech fields; descriptions like "Misc
    Bolts"). Shop-level `integrator_tags` is `[]` on every reachable shop, i.e. no
    catalog integration is configured. Caveat: the cached `raw` is last-written by
    the backfill/prewarm path (`lib/shopware-jobs-prewarm.ts`), which fetches with
    the **base** association set (no `integrator_tags`), so the cache reflects that
    path, not the webhook's enriched fetch — but the absence of any catalog
    integration is the dispositive signal. Net: SW line-level PCDB stays empty in
    practice for these tenants; `extractShopWarePcdb` is correct but has nothing to
    map. It will only populate if/when an SW shop onboards a PartsTech-style
    catalog. Direct live confirmation of the enriched fetch could not be done from
    dev: dev creds are **sandbox-scoped** (`SHOPWARE_USE_SANDBOX=true`; prod API
    returns 401), and the SW `services.parts.integrator_tags` association is itself
    intermittently 500 (the exact flakiness the webhook's degrade-once logic
    guards against). When the enriched single-RO fetch did return 200 in sandbox,
    the demo ROs simply carried no parts at all.
- **Protractor PCDB**: no line-rebuild path; historical Protractor payloads carry
  no PCDB.
- **Line-level PCDB is ~0% across the historical corpus** — historical payloads
  predate tag capture. Re-running the backfill won't conjure PCDB that the source
  RO never carried; only ROs ingested *after* this change (or re-pulled with the
  `integrator_tags` association) can populate it.

---

## Historical backfill (operator-only, off-peak)

The historical rebuild already exists: `scripts/backfill-job-index-aces.ts`
(`npm run backfill:job-index-aces`). It is idempotent + resumable (safe to
ctrl-c and re-run). Phases:

- **A. Source-table reindex** — creates missing `job_index` entries from the
  source tables. Shop-Ware is counted-only here (needs a live SW re-ingest via
  `NormalizedIngestionService`, not this script).
- **B. ACES enrichment** — decodes VINs for any doc missing
  `vehicle.acesDecodedAt`; for Tek + SW it also rebuilds per-line `lines[]` with
  PCDB attached (PCDB only lands if the source RO carried tags).
- **C. PG mirror** — mirrors enriched ACES IDs into PG `job_index` columns.

### Recommended sequence

1. **Coverage baseline (read-only):**
   ```
   npm run report:job-index-aces-coverage -- --by-shop
   ```
2. **Dry run a single shop first:**
   ```
   npm run backfill:job-index-aces -- --shop <SHOP_ID> --dry-run
   ```
3. **Enrichment-only on one shop (cache-first, cheapest — biggest fixable win
   is Protractor history):**
   ```
   npm run backfill:job-index-aces -- --shop <SHOP_ID> --skip-reindex
   ```
   `--skip-reindex` runs Phase B (+ C) without the Phase-A source-table reindex —
   the safe, free, cache-first path for VIN-rich-but-undecoded shops.
4. **Re-run the coverage report** to confirm the shop moved, then widen to more
   shops. Run off-peak; this touches prod Mongo + DataOne.

### Caveats
- `shopware_repair_orders` is keyed by **`tenantId`, not `shopId`** — a
  shopId-filtered SW reindex/VIN-recovery matches nothing. (See memory:
  *ACES coverage gaps*.)
- ACES can never exceed a shop's VIN coverage; `acesEngineId` is structurally
  higher than `acesVehicleId` (ambiguous trims blank `vehicle_id`).

---

## Verify (no DB needed)

```
npm run test:job-index-aces-coverage     # per-provider ACES-on-write + per-line PCDB, incl. SW webhook
npm run test:job-index-hash-canonical    # acesDecodedAt does NOT churn hash; ACES id change DOES
```
