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

- `SYNTHETIC_BASE_URL` — defaults to `http://127.0.0.1:${PORT||5000}`.
  Set to the public Render URL if you also want an external uptime
  monitor to curl the route from outside the box.
- `SYNTHETIC_SHOP_ID` — MOS shopId of the sentinel shop.
- `SYNTHETIC_SMS_SHOP_ID` — sentinel shop's SMS-side shopId (Tekmetric
  numeric id).
- `SYNTHETIC_PROVIDER` — `tekmetric` (default) | `protractor` | `shopware`.
- `SYNTHETIC_VIN` — 17-character sentinel VIN. Pick one that has
  history in CARFAX so the VHI path actually exercises a real plan
  build.
- `SYNTHETIC_EXT_TOKEN` — extension token (`ext_...`) for the sentinel
  test user. Treat as a secret.
- `SYNTHETIC_PARTNER_API_KEY` — partner API key for `/api/external/*`.

The sentinel shop should be a dedicated test shop. Every synthetic
write carries `synthetic: true` so analytics/billing pipelines can
filter it out; today the only write is the run record in
`synthetic_runs` itself (TTL 14 days).

## Alerting

- Single failure → marker emitted, no email. Single failures are
  treated as transient.
- Two consecutive failures of the **same step** → marker emitted +
  email to `getPlatformAdminEmails()` with the step name, error,
  sentinel ids, and a re-run command. State-based dedup: while the
  step is still in the "alerted" state, additional failures do NOT
  re-page.
- Recovery (a previously-alerted step returns ok) → state cleared +
  recovery email.

This mirrors the dedup pattern in `app/api/cron/cron-health-alerter/route.ts`.

## Re-run command

```sh
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://<render-host>/api/cron/synthetic-prod-smoke
```

## Status surface

`/admin/synthetic-prod-smoke` — 24h pass rate, currently-paged steps,
per-step state, last 50 runs.

JSON: `GET /api/admin/synthetic-prod-smoke` (admin/platform_admin only).

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
