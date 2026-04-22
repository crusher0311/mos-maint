# Tekmetric 5K-Shop Scaling Plan

**Status:** Step 2 Phases A + B + C complete (default-on, soaking before flag flip)
**Owner:** Engineering
**Last updated:** 2026-04-22

---

## The Problem

Today we run ~200 active Tekmetric shops. The roadmap is **5,000 shops**.

Our current architecture polls every shop every 30 minutes across 4 Tekmetric API endpoints (repair orders, vehicles, customers, jobs). Math:

| Scale       | Approx requests/min  | Tekmetric limit |
| ----------- | -------------------- | --------------- |
| 200 shops   | ~1,300/min           | ~600/min ❌      |
| 5,000 shops | ~33,000/min          | ~600/min ❌❌    |

We are already over budget at 200 shops (the 429 storms confirm it). The current design **cannot scale** by tuning — it needs to change shape.

---

## The Insight

We already receive nearly all the same data via Tekmetric webhooks, which we log to `tekmetric_webhook_logs` in MongoDB. Polling is largely redundant — we just don't trust the webhooks enough to turn polling off.

The fix is to flip the model:

> **Webhooks become the source of truth. Polling becomes a slow weekly safety net. Deep data (job lines, inspection findings) is fetched on-demand only when needed.**

Result at 5K shops: **<200 req/min steady state** — comfortably under any reasonable rate limit, with headroom for growth past 10K.

---

## The 4-Step Plan

### Step 1 — Empirical webhook coverage report  ✅ COMPLETE (2026-04-22)
**Effort:** Half a day (actual)
**Risk:** Zero (read-only)
**Deliverables:**
- `scripts/tekmetric-webhook-coverage-analysis.ts` — repeatable per-shop coverage report
- `scripts/tekmetric-webhook-payload-sample.ts` — dumps actual payload schema per event category
- JSON output: `scripts/output/tekmetric-webhook-coverage-*.json`

**Key findings:**

1. **Webhook payloads are MUCH richer than we believed.** A single `RepairOrder` event delivers the complete RO object: status, mileage (`milesIn`/`milesOut`), customer ID, vehicle ID, **all 14 job line items inline**, totals, dates, custom labels. The entire `/repair-orders/{id}` AND `/jobs?repairOrderId=X` polling can likely be eliminated — that data is already in the webhook payload.

2. **Shop scope clarification:** 37 active Tekmetric shops in `shops` collection (not 200+ — that figure includes all integration providers). Scaling target for Tekmetric specifically is 37 → 5,000 (135× growth).

3. **Volume reality check:** 10,955 webhook events received in 3 days = ~150/hour across all 37 shops. Tiny compared to our polling load.

4. **Webhook event categories actually flowing (last 3 days):**
   | Category | Count |
   |---|---|
   | RO.StatusUpdated | 2,738 |
   | Appointment.Other | 2,092 |
   | Customer.JobsApprovedDeclined | 1,642 |
   | RO.Created | 938 |
   | RO.Completed | 749 |
   | PO.Received | 658 |
   | RO.Posted | 550 |
   | Payment.Made | 538 |
   | Inspection.Complete | 344 |
   | Customer.ViewedInspection | 216 |
   | RO.Deleted | 71 |

5. **Webhook delivery latency:** ~13 seconds end-to-end (Tekmetric → us). Effectively real-time.

6. **Webhook health gaps (already actionable):**
   - **6 configured shops have NEVER delivered a webhook in the 3-day window** — broken subscriptions that have been invisible to us:
     - tekId=470 / mosId=36 — HEART Certified Auto Care
     - tekId=471 / mosId=37 — HEART Certified Auto Care
     - tekId=275 / mosId=54 — Demore's Automotive
     - tekId=33 / mosId=84 — EC Auto Repair
     - tekId=13809 / mosId=100 — International Auto
     - tekId=16298 / mosId=103 — Honest Tom's Complete Auto Care - Silver Spring
   - **3 silent shops** (delivered events more than 24h ago but not since)
   - **664 events tagged with `data.shopId=0`** — unknown shop attribution issue worth investigating separately

7. **Untapped event types we already receive but barely use:**
   - `Customer.JobsApprovedDeclined` — could update VHI in real-time, trigger notifications
   - `Payment.Made` / refunds — billing reconciliation
   - `PO.Received` — parts arrival tracking
   - `Appointment.*` lifecycle events

**Implication for Step 2:** the elimination scope is wider than we thought. The `/repair-orders/{id}` and `/jobs?repairOrderId=X` polling can likely both be turned off — webhook payloads carry that data inline. Only `/repair-orders/{id}/inspections` (DVI task details) and `/customers/{id}` / `/vehicles/{id}` follow-ups when initially missing remain truly necessary.

### Step 2 — Trust the webhooks (lazy fetching)  🟡 IN PROGRESS
**Effort:** 1-2 weeks
**Risk:** Medium (changes core data flow)
**Depends on:** Step 1 results

- Stop polling for data webhooks already deliver (status, mileage, customer info, DVI completion).
- Move job line items + inspection findings to **on-demand fetch** — only call `/jobs` or `/inspections` when a VHI is being built or a sticker generated, not preemptively for every RO.
- Cache aggressively, invalidate via webhook.

#### Step 2 Phase A — Webhooks contribute to job_index in shadow mode  ✅ COMPLETE (2026-04-22)
**Risk:** Zero — purely additive. Polling stays fully on; readers unchanged.

What changed in code:
- `app/api/webhooks/tekmetric/route.ts`: webhook receiver now persists the full RO payload (`data: repairOrder`, including the `jobs[]` array) onto the cache row in BOTH the terminal and non-terminal branches. This was the missing piece that previously forced `indexTekmetricWorkOrderJobs` to fall back to a `/jobs` API call on the first terminal webhook for any RO.
- `lib/tekmetric-job-index.ts`: `indexTekmetricWorkOrderJobs` now accepts an `options` arg with `{ indexedVia, preloadedJobs }`. When called from the webhook receiver, jobs are passed in directly from the webhook payload — zero outbound Tekmetric API calls per RO.
- Every `job_index` write is now stamped with `metadata.indexedVia: "webhook" | "poll" | "backfill" | "reindex"` so we can measure webhook coverage.
- New admin endpoint: `GET /api/platform-admin/tekmetric/index-source-breakdown?days=7` returns per-shop, per-day counts grouped by `indexedVia`, plus a summary with `webhookCoveragePct` per shop.

What to watch (over the next 3-7 days):
- Hit the breakdown endpoint daily. Per-shop, the goal is `webhookCoveragePct` trending toward ~100% — that means webhooks alone produce the same job_index rows polling does.
- `[Tekmetric Webhook] Indexed N jobs for RO #X (via=webhook, preloaded=true)` log lines should appear in production logs as terminal RO webhooks arrive.
- If `webhookCoveragePct` for a shop stays low while `poll` count is high, that shop is webhook-silent for terminal events — investigate before scaling polling back.

What's still TO DO in Step 2:
- _(none — Phases B + C complete; soak the metrics, then flip `TEKMETRIC_POLLING_FETCH_INSPECTIONS=false` per env)_

#### Step 2 Phase B — Webhooks dual-write to NormalizedIngestionService  ✅ COMPLETE (2026-04-22)
**Risk:** Low — soft-fail dual-write; webhook always 200s; polling stays on.

What changed:
- `lib/normalized-ingestion.ts`: added `IngestionOptions.ingestionVia` + private `_stampIngestionVia()` that writes immutable `firstIngestedVia/firstIngestedAt` (set-if-missing via `{$exists:false}` filter) and always-fresh `lastIngestedVia/lastIngestedAt` to `normalized_work_orders`. Stamped after both insert and update paths.
- `app/api/cron/tekmetric-sync/route.ts`: polling NIS instantiation passes `ingestionVia: "poll"`.
- `app/api/webhooks/tekmetric/route.ts`: new `runWebhookNormalizedIngestion()` helper resolves internal shop, enriches vehicle/customer (cache-first, API fallback, soft-fail on missing VIN), passes `ingestionVia: "webhook"`. Called from BOTH terminal and non-terminal RO branches.
- `app/api/platform-admin/tekmetric/normalized-ingestion-breakdown/route.ts` (NEW): per-shop/per-day breakdown with `webhookCoveragePct = webhook/(webhook+poll)`. Mirrors the Phase A `index-source-breakdown` endpoint. Pre-Phase-B rows surface as `unattributed`.

#### Step 2 Phase C — Webhook-driven inspection fetch + on-demand fallback  ✅ COMPLETE (2026-04-22)
**Risk:** Medium-low — polling fetch stays on by default behind an env flag, so the change is reversible per-environment.

What changed:
- `app/api/webhooks/tekmetric/route.ts`: the `Inspection.Complete` handler now (a) resolves `tekmetricShopId` from event → cache row → cache.data, (b) fetches the FULL inspection task list via `getRepairOrderInspectionsWithXAuth` using the shop's stored `xAuthToken`, (c) replaces (not pushes) `tekmetric_work_orders.inspections` with the fresh list and stamps `inspectionsFetchedAt` + `inspectionsSource: "webhook"`, (d) re-runs `runWebhookNormalizedIngestion` with the enriched RO so normalized tables get the inspections without waiting for polling. Soft-fails throughout.
- `app/api/cron/tekmetric-sync/route.ts`, `lib/tekmetric-incremental-sync.ts`, `app/api/cron/tekmetric-backfill/route.ts`: all 3 inline `getRepairOrderInspectionsWithXAuth` call sites are now gated by `process.env.TEKMETRIC_POLLING_FETCH_INSPECTIONS !== "false"` (default-on; flip to `"false"` per env to disable polling-time inspection fetching).
- `app/api/plan-build/route.ts`: on-demand fallback runs right after `tekmetricWOs` loads — for any cached RO with a DVI signal (`inspectionUrl` / `inspectionShareDate` / `dviDone`) but missing `inspectionTasks`, fetch in parallel (concurrency=4, 4s budget, soft-fail), mutate the in-memory doc, and persist back to the cache row with `inspectionsSource: "on-demand"`. Both DVI-findings read sites at lines ~1117 and ~1158 see the populated inspections without further changes.
- `app/api/platform-admin/tekmetric/normalized-ingestion-breakdown/route.ts`: response now includes an `inspections` block with per-shop counts grouped by `inspectionsSource` (`webhook` / `on-demand` / `polling-or-legacy`). Use this to decide when each environment is safe to flip.

What to watch (over the next 3-7 days):
- `inspections.totalsBySource.webhook` should grow steadily as `Inspection.Complete` events arrive.
- `inspections.totalsBySource["on-demand"]` should stay low; spikes mean webhook delivery is dropping.
- `[Tekmetric Webhook] Fetched N full inspection(s) for RO X (via=webhook)` log lines confirm the webhook fetch path is exercised in production.
- Once `webhook + on-demand` covers your active shops for a few days, set `TEKMETRIC_POLLING_FETCH_INSPECTIONS=false` per env to drop the polling-time fetch entirely.

### Step 3 — Safety nets
**Effort:** 1 week
**Risk:** Low
**Status:** Complete (3a + 3b shipped fully; 3c framework shipped, awaiting Tekmetric subscription API spec to enable).

- **3a. Webhook health monitor (DONE)**: `app/api/cron/tekmetric-webhook-health/route.ts` runs daily at 09:00 UTC, scans `tekmetric_webhook_logs` for the last 24h per Tekmetric shop, and emails platform admins about silent shops. Idempotent via `tekmetric_webhook_health_alerts` (unique index on `{tekmetricShopId, alertDate}`); re-running same day is a no-op. Registered in `lib/cron/jobs.cjs`.
- **3b. Signature verification (DONE — framework, default-OFF)**: Webhook handler now reads raw body before parsing JSON, runs HMAC verification when `TEKMETRIC_WEBHOOK_SIGNING_SECRET` is set (header configurable via `TEKMETRIC_WEBHOOK_SIGNATURE_HEADER`, default `x-tekmetric-signature`; algo via `TEKMETRIC_WEBHOOK_SIGNATURE_ALGO`, default `sha256`). Strips `sha256=` prefix, uses `crypto.timingSafeEqual`, returns 401 with detail on mismatch. ALSO: started capturing `headers` field on every `tekmetric_webhook_logs` row (only the introspection-relevant ones — see `HEADERS_TO_CAPTURE` allowlist) so we can confirm Tekmetric's actual signing format from real traffic before flipping enforcement on.
- **3c. Auto-subscription (DONE — framework + visibility, scaffolded)**: `lib/tekmetric-webhook-subscribe.ts` provides `subscribeShopToTekmetricWebhooks()` gated default-OFF behind `TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE=true`. The subscription endpoint URL is templated via `TEKMETRIC_WEBHOOK_SUBSCRIBE_URL_TEMPLATE` (token `{shopId}`) and the public callback via `TEKMETRIC_WEBHOOK_PUBLIC_URL` so the exact partner-API path can be confirmed without redeploying. Outcomes persist to `tekmetric_webhook_subscriptions` (one row per shop with `lastResult`, `lastAttemptAt`, `firstAttemptAt`). Visibility surface: `/api/platform-admin/tekmetric/webhook-subscription-status` reports per-shop `healthStatus` (`healthy`/`stale`/`silent`) plus 24h/7d/30d event counts and event-type breakdown — sorted silent-first so broken subscriptions surface immediately. Wiring into the onboarding flow is deferred until partner-eng confirms the subscribe API spec.

### Step 4 — Slow polling to weekly reconciliation
**Effort:** Half a day
**Risk:** Low
**Depends on:** Steps 2 & 3 in production for ~2 weeks

Drop the 30-minute incremental sync to a once-weekly delta sweep that catches any webhook gaps. Math at 5K shops: ~5,000 calls/week ≈ a few per minute average.

---

## Current State Inventory (as of 2026-04-22)

### Webhooks already deliver (confirmed by Step 1 analysis):
- All RO lifecycle events (Created, Posted, Completed, Invoiced, Deleted, StatusUpdated)
- **Full RO payload inline including all job line items** — no separate `/jobs` call needed
- Mileage (`milesIn`/`milesOut`), customer ID, vehicle ID, totals, dates, custom labels
- DVI completion (`Inspection.Complete`)
- Customer behavior (`Customer.ViewedInspection`, `Customer.JobsApprovedDeclined`)
- Payment lifecycle (`Payment.Made`, refunds)
- Purchase order lifecycle (`PO.Created`, `PO.Received`)
- Appointment lifecycle

### Webhooks do NOT deliver (still need API calls):
- DVI inspection task details/findings — `/repair-orders/{id}/inspections` (only completion is signaled)
- Full vehicle specs (year/make/model/VIN) — `/vehicles/{id}` — but only on FIRST encounter; cache forever after
- Full customer contact (email/phone) — `/customers/{id}` — same, only on first encounter

### Code touchpoints:
- Webhook receiver: `app/api/webhooks/tekmetric/route.ts`
- Webhook log collection: `tekmetric_webhook_logs` (MongoDB)
- Polling crons: `app/api/cron/tekmetric-backfill/route.ts`, `app/api/cron/tekmetric-sync/route.ts`, `app/api/cron/tekmetric-incremental-sync/route.ts`
- Sync libraries: `lib/tekmetric-incremental-sync.ts`, `lib/tekmetric-sync.ts`
- Central API client (rate-limited): `lib/integrations/tekmetric/client.ts`
- Pause switch: `PAUSE_TEKMETRIC_CRON=true` (env var, prod-only)

---

## Related Recent Work

- **Shop attribution fix (Apr 2026)**: Fixed "Shop #null" attribution across all Tekmetric call sites so per-shop usage shows correctly in the dashboard. Required for measuring volume per shop in Step 2.
- **`job_index` mileage backfill**: Off-hours, self-rate-limited script for fixing historical mileage data. Already ships.
- **Cron pause switch**: `PAUSE_TEKMETRIC_CRON` env var skips all `tekmetric-*` jobs at registration. Use during incidents.

---

## How to Resume This Plan

If we get pulled away to fight a fire and come back to this in days/weeks:

1. Read this file top to bottom.
2. Check the **Status** field at the top to see which step is in progress.
3. Look at `scripts/tekmetric-webhook-coverage-analysis.ts` and any output reports for Step 1 results.
4. Each step's "Depends on" line tells you what must be true before starting it.
5. Update the **Status** and **Last updated** fields when picking work back up.

---

## Non-Goals (for clarity)

- We are NOT trying to reduce Tekmetric's rate limit on their end — that's a separate conversation with their partner team and worth having, but the architecture must work even if they don't budge.
- We are NOT building a generic webhook-vs-poll framework. This plan is Tekmetric-specific. Shopware/Protractor have their own integration shapes and will need separate analysis if they hit similar scale.
- We are NOT touching the `job_index` historical backfill. That's a one-time data-quality job, separate from this scaling work.
