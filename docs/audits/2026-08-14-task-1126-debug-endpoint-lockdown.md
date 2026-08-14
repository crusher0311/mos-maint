# 2026-08-14 — Debug endpoint lockdown + prod signing-secret verification (task #1126)

Response to the Fable5 pen-test finding that unauthenticated `/api/debug/*`
endpoints leaked customer/vehicle data and CARFAX config.

## Routes removed (deleted, not gated)

A repo-wide grep found **zero** references to any of these routes from product
code, tests, scripts, or the extension — they were one-off debugging leftovers,
so they were deleted outright:

| Route | What it leaked | Auth before |
|---|---|---|
| `app/api/debug/dashboard/route.ts` | up to 10 customer records (name, status, ticket id, VIN, full vehicle object) for ANY caller-supplied `?shop=` | none |
| `app/api/debug/events/route.ts` | VINs, RO numbers, statuses from the events collection | none |
| `app/api/debug-env/route.ts` | `CARFAX_POST_URL`, `CARFAX_PDI` env values | none |
| `app/api/debug/dashboard-data/route.ts` | events/RO/VIN analysis (was session-gated but unused) | session |
| `app/api/debug/session/route.ts` | echoed the full session object (incl. token) to the caller | session |

The now-empty `app/api/debug/` directory is gone. The stale allowlist entry for
`debug/dashboard-data` was removed from `scripts/check-direct-db.cjs`.

Sibling sweep: the two remaining `debug`-named routes,
`app/api/carfax/debug/[vin]/route.ts` and `app/api/protractor/debug/route.ts`,
both already require an authenticated session (`getSession()` → 401) and are
shop-scoped to the session's shop. Left in place.

## Production secret verification (Render, 2026-08-14)

Checked via the Render API across the prod web service (`mos-tools`), the
drain worker (`backfill-drain-worker`), and the "MOS Tools ENV" env group
(linked to `mos-maint-background-v2`):

| Secret | Prod status | Effect |
|---|---|---|
| `TEKMETRIC_WEBHOOK_SIGNING_SECRET` | **NOT SET** | Tekmetric webhook signature verification is DISABLED (route accepts any payload) |
| `SHOPMONKEY_WEBHOOK_SIGNING_SECRET` | **NOT SET** | Shopmonkey webhook signature verification is DISABLED |
| `AUTOFLOW_SIGNING_SECRET` | **NOT SET** | AutoFlow webhook HMAC check is DISABLED (single-source URL is tokenless → fully unauthenticated) |
| `REPORT_SHARE_SECRET` | **NOT SET** | `lib/report-share.ts` falls through to `STRIPE_WEBHOOK_SECRET` |
| `STRIPE_WEBHOOK_SECRET` | SET (all services) | — |

Notes:
- Report-share links are **not** using the hard-coded `"vhr-share-default-key"`
  fallback in production, because `STRIPE_WEBHOOK_SECRET` is set and is the
  second fallback. Still, share-token signing keyed off the Stripe webhook
  secret couples two unrelated trust domains — a dedicated
  `REPORT_SHARE_SECRET` should be set (note: setting it invalidates all
  previously issued share links, so pick a rollout window).
- Enabling the Tekmetric/Shopmonkey signing secrets requires the provider-side
  secret value and confirmation of their exact header/encoding (captured
  headers exist in `tekmetric_webhook_logs.headers` for introspection).
  Enabling AutoFlow HMAC requires configuring the same secret on AutoFlow's
  side. These are operator/provider-coordinated actions and were intentionally
  not flipped as part of this task (flagged for follow-up).
