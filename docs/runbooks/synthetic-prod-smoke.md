# Synthetic Prod Smoke (task #512)

## What

`app/api/cron/synthetic-prod-smoke/route.ts` runs every 5 minutes (entry
`synthetic-prod-smoke` in `lib/cron/jobs.cjs`) and exercises the top
user-visible actions against a sentinel shop + sentinel VIN. Each step
records `{ ok, latencyMs, status, error }` to `synthetic_runs` and
emits a `[ShopErrorRate] {"group":"SYNTHETIC_FAIL", ...}` marker per
failure for Better Stack to group by step (`code` field).

Steps:

1. `extension_auth` — protected `/api/extension/labor-rates` GET with
   the sentinel extension token. Proves token + shop-lookup is healthy.
2. `plan_build_vhi` — `GET /api/external/vehicles/{vin}/vhi` with the
   sentinel partner API key. Proves the plan engine + Mongo+PG path.
3. `tekmetric_labor_rates` — same labor-rates GET but asserted as a
   JSON payload (distinguishes "auth ok, upstream Tekmetric down" from
   "auth dead").
4. `tekmetric_open_ros` — calls `getRepairOrders(tekShopId, {page:0,size:5})`
   from `lib/integrations/tekmetric/client.ts` directly (same path the
   sync workers and side panel `/api/extension/plan` use). Proves the
   open-RO list upstream is healthy — the second leg of "labor rates
   AND open ROs". Auto-skips with ok=true when `SYNTHETIC_PROVIDER` is
   not `tekmetric`. An empty page is treated as ok (sentinel shop may
   be quiet).
5. `apply_canned_job` — `POST /api/extension/jobs/apply-canned?_synthetic=1`
   (the path Kurt reported broken when "Add canned job" silently
   dropped). The route runs the full upstream WO-lookup chain
   (canned-jobs config → vehicle-by-VIN → open-WO search) and only
   short-circuits immediately before the destructive
   `applyCannedJobToWorkOrder(...)` call so a fake job never lands on
   a real customer RO in the third-party SMS. "No open WO" on the
   sentinel is treated as a successful synthetic.
6. `save_concern` — `POST /api/extension/inspections?_synthetic=1` with
   `roId="synthetic-smoke-<smsShopId>"`. The Mongo upsert into
   `tekmetric_work_orders` runs end-to-end (so write regressions
   actually fire), but the sentinel roId never collides with a real
   Tekmetric workOrderId — every synthetic write lands on a dedicated
   doc tagged `synthetic: true` so analytics/billing pipelines can
   exclude it. Clean up with
   `db.tekmetric_work_orders.deleteMany({ synthetic: true })`.
7. `sticker_print` — calls `renderStickerStandard` directly and
   confirms the PNG signature + a sane byte count.

## Sentinel configuration (env vars on Render)

### Per-vendor sentinels (task #525)

Task #512 v1 shipped with one sentinel shop on Tekmetric. That caught
Tekmetric-side and shared-code regressions, but a Protractor- or
Shop-Ware-specific regression (e.g. canned-jobs cache shape change,
Protractor stage-refresh outage) would not fire. Task #525 adds one
dedicated sentinel shop **per SMS vendor**, each with its own sentinel
VIN + extension token. Every step runs once per configured vendor and
consecutive-failure state is tracked per **(step × vendor)** so a
Protractor regression pages independently of a healthy Tekmetric run of
the same step.

For each vendor `<V>` in `TEKMETRIC` / `PROTRACTOR` / `SHOPWARE`:

- `SYNTHETIC_<V>_SHOP_ID` — MOS shopId of that vendor's sentinel shop.
- `SYNTHETIC_<V>_SMS_SHOP_ID` — sentinel shop's SMS-side shopId
  (Tekmetric numeric id / Protractor / Shop-Ware shop id).
- `SYNTHETIC_<V>_VIN` — 17-character sentinel VIN. Pick one that has
  history in CARFAX so the VHI path actually exercises a real plan
  build.
- `SYNTHETIC_<V>_EXT_TOKEN` — extension token (`ext_...`) for that
  vendor's sentinel test user. Treat as a secret.
- `SYNTHETIC_<V>_PARTNER_API_KEY` — partner API key for `/api/external/*`
  (optional; falls back to the shared `SYNTHETIC_PARTNER_API_KEY`).

A vendor is **configured** (and therefore exercised) when ANY of its
identity vars (`SHOP_ID` / `SMS_SHOP_ID` / `EXT_TOKEN` / `VIN`) is set.
Configure as many vendors as you have sentinel shops for — partially
configured fleets are fine (e.g. Tekmetric + Protractor only).

Example (all three vendors):

```sh
SYNTHETIC_TEKMETRIC_SHOP_ID=901
SYNTHETIC_TEKMETRIC_SMS_SHOP_ID=12345
SYNTHETIC_TEKMETRIC_VIN=1HGCM82633A123456
SYNTHETIC_TEKMETRIC_EXT_TOKEN=ext_...

SYNTHETIC_PROTRACTOR_SHOP_ID=902
SYNTHETIC_PROTRACTOR_SMS_SHOP_ID=pt-67890
SYNTHETIC_PROTRACTOR_VIN=2FMDK3GC4BBA00001
SYNTHETIC_PROTRACTOR_EXT_TOKEN=ext_...

SYNTHETIC_SHOPWARE_SHOP_ID=903
SYNTHETIC_SHOPWARE_SMS_SHOP_ID=sw-24680
SYNTHETIC_SHOPWARE_VIN=3VWFE21C04M000002
SYNTHETIC_SHOPWARE_EXT_TOKEN=ext_...
```

> Note: `tekmetric_open_ros` only runs for the Tekmetric vendor; it
> auto-skips with `ok=true` for Protractor / Shop-Ware (the upstream
> open-RO call is Tekmetric-specific). `tekmetric_labor_rates` runs for
> every vendor via the provider-aware `/api/extension/labor-rates` route.

### Shared

- `SYNTHETIC_BASE_URL` — defaults to `http://127.0.0.1:${PORT||5000}`.
  Set to the public Render URL if you also want an external uptime
  monitor to curl the route from outside the box.
- `SYNTHETIC_PARTNER_API_KEY` — shared partner API key for
  `/api/external/*` (used by any vendor without its own
  `SYNTHETIC_<V>_PARTNER_API_KEY`).

### Legacy single-sentinel (back-compat)

If **no** per-vendor vars are configured, the runner falls back to the
original single-sentinel env so existing deployments keep working
unchanged:

- `SYNTHETIC_SHOP_ID`, `SYNTHETIC_SMS_SHOP_ID`, `SYNTHETIC_VIN`,
  `SYNTHETIC_EXT_TOKEN`, and `SYNTHETIC_PROVIDER`
  (`tekmetric` (default) | `protractor` | `shopware`).

The sentinel shop should be a dedicated test shop. Every synthetic
write carries `synthetic: true` so analytics/billing pipelines can
filter it out; today the only write is the run record in
`synthetic_runs` itself (TTL 14 days).

## Alerting

- Single failure → marker emitted, no email. Single failures are
  treated as transient.
- Two consecutive failures of the **same (step × vendor)** → marker
  emitted + email to `getPlatformAdminEmails()` with the step name,
  **vendor**, error, sentinel ids, and a re-run command. State-based
  dedup: while that (step × vendor) is still in the "alerted" state,
  additional failures do NOT re-page. State docs are keyed
  `step:<name>:<vendor>` in `synthetic_state`.
- Recovery (a previously-alerted (step × vendor) returns ok) → state
  cleared + recovery email.
- Each failure marker carries `extra.provider` so Better Stack can
  group/filter by vendor in addition to step (`code`).

This mirrors the dedup pattern in `app/api/cron/cron-health-alerter/route.ts`.

## Re-run command

```sh
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://<render-host>/api/cron/synthetic-prod-smoke
```

## Status surface

`/admin/synthetic-prod-smoke` — 24h pass rate, currently-paged
(step × vendor) pairs, per-(step × vendor) state grouped by vendor, and
the last 50 runs with step latencies grouped by vendor.

JSON: `GET /api/admin/synthetic-prod-smoke` (admin/platform_admin only).
Each `state` entry carries a `provider` field; each `runs` entry carries
a `vendors[]` array (plus the legacy flattened `steps[]` for back-compat).

## Break glass

- `SYNTHETIC_SMOKE_DISABLED=true` on Render — cron handler short-
  circuits with `{ok:true, skipped:"disabled"}`.
- `SHOP_ERROR_MARKER_DISABLED=true` already mutes the `[ShopErrorRate]`
  marker (project-wide kill switch from task #510).

## External monitor backstop

The route is also reachable from an external uptime monitor with
`Authorization: Bearer $CRON_SECRET`. If the in-process cron stops
firing because the web service is down, the external monitor will
report the failure as a monitor-side outage even though no synthetic
record will be written.

## Backtesting against historical incidents

The two incidents that motivated this task:

- **Vandalia/Fairview prefetch 500s** — `plan_build_vhi` against the
  sentinel VIN would have returned 5xx and paged after the second
  consecutive 5-min tick.
- **Kurt "Add canned job" drop** — `apply_canned_job` would have
  returned a non-200 / wrong-shape body and paged on the same cadence.

When adding a new step, add the corresponding incident to this list
so we keep evidence that the synthetic catches the regressions it
was built to catch.
