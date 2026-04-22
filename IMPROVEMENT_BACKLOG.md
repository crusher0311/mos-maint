# Improvement Backlog (Hardening & Tech Debt)

This is a living checklist of code-quality, reliability, and cost-control work
that emerged from real bugs we hit. It is **separate from `FEATURE_BACKLOG.md`**
(which is product/feature work). Items here mostly do not change user-visible
behavior; they make the platform harder to break.

**How to use this doc**
- Pick the highest-priority `[ ]` item.
- Read the "Why now" / "Proposed approach" sections — they encode why we cared.
- When done, change `[ ]` to `[x]`, add the merge SHA, and move on.
- If you discover a new class-of-bug while working, add a new item here so
  future sessions can pick it up cold.

Last updated: 2026-04-22
Most recent context: closed a feature-gating gap on three extension routes
(`vhi-coach`, `prefill-dvi`, `enhance-findings`) and fixed silent logo-less
HoverCode QR generation across the sticker routes plus a backfill script.

---

## P0 — Do these next

### [x] 1. Audit & DRY the extension feature-gate pattern (2026-04-22)
**Shipped:**
- `lib/extension-route-guard.ts` exposes `guardExtensionShopRequest()` (full
  4-step flow) and `checkShopFeatureGate()` (lighter helper for routes that
  resolve the shop ID through a custom path).
- Refactored: `vhi-coach`, `prefill-dvi`, `enhance-findings` (each ~40+ lines
  shorter).
- New gates added: `inspections`, `ro-context`, `canned-jobs`, `jobs/search`,
  `plan`, `labor-rates` (GET+PUT), `keytag` (GET+POST), `sticker` (GET+POST),
  `concern-assistant`, `concern-assistant/inject-protractor`,
  `enhance-corrections` (GET+POST). The last four also got explicit
  user-shop-ownership checks (request-supplied shopId could otherwise be
  spoofed across tenants — IDOR risk).
- Marked exempt with `// gate-exempt: <reason>` in first 5 lines:
  `auth-token`, `features`, `preferences`.
- `scripts/check-extension-gates.cjs` (npm: `lint:extension-gates`) — fails
  CI if a route imports `findShopBySmsId` without either importing AND
  calling the guard, or carrying a top-of-file gate-exempt marker.
- `tests/extension-route-guard.smoke.ts` (npm: `test:extension-guard`) —
  exercises the helper's deny paths and runs the lint script as a subprocess.

**Follow-ups:** lint heuristic still only catches routes that import
`findShopBySmsId` — routes resolving the shop through `auth.user.shopId` or a
free-form `req.body.shopId` slip past the lint and were caught only by
architect review. Consider expanding the lint to also flag routes that read
`shopId` from `req.body`/query without an explicit ownership check.

---

### [x] 2. Verify HoverCode actually applied our logo (don't trust 200) (2026-04-22)
**Why now:** HoverCode happily returned `200 OK` while producing logo-less QRs.
We only noticed because a human looked at a printed sticker. Same trust-the-200
risk exists everywhere we hit a third-party API.

**What shipped (scoped to HoverCode + observability counter; the
Resend/Twilio/Stripe sweep was deferred):**
1. `lib/hovercode.ts` exports `verifyHovercode(id, expected, shopId, context)`.
   After every successful `POST /hovercode/create/` and `PUT /hovercode/<id>/update/`
   it fires a non-blocking `GET /hovercode/<id>/` and compares fields. Logo
   verification is presence-based (`logo_url || logo_image || logo`) because
   HoverCode re-hosts uploaded logos so URL equality is meaningless. `qr_data`
   is compared verbatim. Mismatches emit `console.warn("[HoverCode-Drift] ...")`
   with shop ID, QR ID, context, and expected-vs-actual diff. Read-back
   failures (network/HTTP errors) are themselves recorded as drift signals.
2. Drift events are recorded via `trackApiRequest("hovercode", "/verify/drift",
   "GET", 409, ...)` and successful verifications via `/verify/ok`, so the
   existing `api_usage` Mongo collection is the single source of truth.
3. `app/api/platform-admin/api-usage/summary/route.ts` aggregates `driftCount`
   and `verifyOkCount` per provider; `app/dashboard/admin/observability/page.tsx`
   shows a yellow "Drift" row in each provider card with the form
   `<drift> / <total verifications>`, hidden when zero.
4. The three real sticker mutation paths now thread `shopId` and trigger the
   guard: `app/api/sticker/settings/route.ts` (wraps shared
   `updateHovercodeDestination`), `app/api/sticker/generate/route.ts` and
   `app/api/sticker/regenerate-qr/route.ts` (import `verifyHovercode` and call
   it after their local POST succeeds, since they need the raw PNG bytes the
   shared helper doesn't return).
5. `patchHovercode` request-level tracking now includes `shopId` for per-shop
   attribution of the underlying PUT, matching the create-path tracking.

**Verified by:** Architect re-review PASS on all six points; workflow boots
clean (`Ready in 1.9s`); all calls are fire-and-forget (`.catch(() => {})`)
so verification failures never break sticker generation or settings saves.

**Follow-ups still open:** Resend/Twilio/Stripe read-back sweep (deferred per
scoping decision); optional unit test mocking HoverCode 200-with-no-logo to
guard against regressions; staging spot-check that drift counters increment.

---

### [ ] 3. Rate-limit & budget the AI endpoints
**Why now:** `enhance-findings` and the other OpenAI-backed routes have no
per-shop ceiling. One stuck retry loop in the extension or one bad-actor token
could rack up real money in an hour. We currently have no alarm.

**Proposed approach:**
1. Add a small per-shop sliding-window limiter (e.g., 60 calls / 5 min) using
   either MongoDB TTL counters or a tiny in-memory LRU per Render instance.
2. Track daily token usage per shop in `api_usage` (already partially in
   place via `trackApiRequest`) and add a daily ceiling per plan tier.
3. When a shop crosses 80% of its daily budget, fire one email/Slack alert.
   When it hits 100%, return `429 { code: "ai_quota_exceeded" }` and let the
   extension show a gentle banner.
4. Platform admins exempt.

**Files likely touched:** `lib/api-usage-tracker.ts`, new `lib/rate-limit.ts`,
the AI extension routes, observability dashboard, plan-tier config.

**Acceptance:** Synthetic test loop hits the limit and gets 429; an admin can
view per-shop daily token spend on the observability page.

---

## P1 — Important, not urgent

### [ ] 4. Structured "feature denied" logging + admin diagnostic panel
**Why now:** When a shop says "I can't see VHI Coach", today's diagnosis path
is "read code." Should be one click.

**Proposed approach:**
1. Whenever a feature gate denies a request, log a structured event:
   `{ kind: "feature_denied", shopId, mosShopId, route, feature, reason, userId, ts }`.
   Send to the same Better Stack / Supabase log cache we already use.
2. Add a "Feature Diagnostics" section to the admin shop detail page that
   shows:
   - The shop's resolved entitlements (calls `getFeatureEntitlements`).
   - The last 50 denial events for that shop.
   - The plan tier, enterprise overrides, and shop overrides side-by-side, so
     it's obvious *which layer* turned the feature off.

**Files likely touched:** the three gate sites (DRYed via #1), a new admin page
under `app/admin/shops/[id]/feature-diagnostics/`, log cache reader.

**Acceptance:** Support can answer "why is X denied for shop Y?" in under 30
seconds without opening the codebase.

---

### [ ] 5. Make the in-process cron observable
**Why now:** Cron now runs inside the Render web service with a Mongo lock. If
it silently stops (crash loop, lock stuck, instance OOM), we won't notice until
data goes stale days later.

**Proposed approach:**
1. On every successful job run, write
   `{ jobName, startedAt, finishedAt, durationMs, ok }` to a small
   `cron_runs` collection (capped or TTL-7d).
2. Add a "Cron Health" panel to the platform observability page listing each
   job, its last successful run, and a red badge if the gap exceeds 2× the
   schedule interval.
3. Daily-grace-check job posts a heartbeat log even when there's nothing to do
   (otherwise we can't distinguish "healthy and idle" from "dead").

**Files likely touched:** `lib/cron/scheduler.ts`, `lib/cron/jobs.ts`, new
`lib/db/schema/cron-runs.ts` (or Mongo collection), observability page.

**Acceptance:** Killing a job for an hour shows a red badge within 2 intervals;
restoring it clears the badge automatically.

---

### [ ] 6. Normalize how we identify shops everywhere
**Why now:** `enhance_corrections.shopId` is keyed by the raw SMS shop ID
(Tekmetric/Protractor's number). If a shop migrates providers or their
upstream ID changes, their learned advisor corrections vanish silently. Same
fragility likely exists in other extension-written tables.

**Proposed approach:**
1. Audit every table that stores a shop ID written from the extension. List
   which use `mosShopId` vs raw provider ID.
2. For each that uses raw provider ID, add a `mosShopId` column, dual-write,
   then backfill, then read from the new column, then drop the old.
3. The extension can keep sending the SMS shop ID at the boundary; the
   server resolves once and writes only `mosShopId`.

**Files likely touched:** `lib/db/schema/enhance-corrections.ts`,
`app/api/extension/enhance-corrections/route.ts`,
`app/api/extension/enhance-findings/route.ts`, plus whatever the audit reveals.

**Acceptance:** Renaming a shop's Tekmetric ID in a test environment doesn't
lose its corrections / sniffer sessions / etc.

---

### [ ] 7. Tests around the things that hurt when they break
**Why now:** No automated test caught either of the last two production bugs
(logo-less QRs, missing feature gate). Both would have been one-line tests.

**Proposed approach (bare minimum, not "100% coverage"):**
1. `lib/hovercode.ts`: mock fetch; assert `createHovercode` and
   `updateHovercodeLogo` send `logo_url` and call the right endpoint shape.
2. Extension route guard (after #1 lands): assert each gate returns 403 when
   feature is off, 200 when on, bypasses for platform admins.
3. `rebuildVhi`: snapshot test on a known VIN/mileage fixture so the next
   refactor of VHI math doesn't silently shift bucket assignments.
4. Stripe webhook handler: signature-verification path + idempotency path.

**Files likely touched:** `__tests__/` or `tests/` directory (whatever the
project uses — needs to be set up if not), Jest/Vitest config.

**Acceptance:** `npm test` runs in CI and these four suites are green.

---

## P2 — Strategic / longer-horizon

### [ ] 8. Retire dead weight from the triple-source job search
**Why now:** Job search queries three data sources in parallel (legacy Mongo,
normalized Mongo, Supabase) per the architecture doc. Every result needs
deduplication. This is expensive in latency and is a permanent source of
"why doesn't search show X" tickets. Likely one of the three sources rarely
contributes a unique result.

**Proposed approach:**
1. Instrument the dedupe step to count, per query, how many unique winners
   came from each source.
2. After 2 weeks of data, if a source contributes < 5% unique results, draft
   a deprecation plan for it.
3. Cut over and delete code.

**Acceptance:** A dashboard tile shows per-source contribution; we have a
written go/no-go on retirement.

---

### [ ] 9. Backfill missing odometer onto historical `job_index` entries from Tekmetric API
**Why now:** During a VHI bug investigation (RO #150297, VIN `1C4PJMDS6HW621198`,
Heart shop 82), we discovered that **58% of `job_index` rows for Heart-Libertyville
have no `mileage` field** (20,479 of 35,560). The data was lost during whichever
backfill pass originally populated `job_index` — the parent `tekmetric_work_orders`
docs for those historical ROs also lack mileage (sample: 0/20 had it locally), so
the only authoritative source remaining is the Tekmetric API itself
(`GET /repair-orders/{id}` returns `milesIn` / `milesOut`).

A short-term fix shipped on 2026-04-22 in `app/api/plan-build/route.ts` and the
dashboard mirror: `computeAnchorMiles()` estimates the missing odometer as
`currentMiles - daysSince(last.date) × milesPerDay`. That correctly stops the
"falsely overdue" display ("31,859 mi over" for items already done last quarter)
but the anchor is approximated, not exact. We want the real number.

There is also a stale marker on the rows from a prior failed attempt:
`mileageBackfillTriedAt: 2026-04-21T...`. The script that wrote it isn't in the
repo — treat it as a hint, not a finished feature.

**Proposed approach:**
1. New script `scripts/job-index-mileage-backfill-tekmetric.ts` (model after
   `scripts/tekmetric-history-backfill.ts`).
2. Iterate `job_index` rows where `sourceSystem === 'tekmetric'` AND mileage is
   missing, grouped by `(shopId, workOrderId)` so we only call Tekmetric once
   per RO.
3. For each group: resolve the shop's `tekmetric.shopId`, call `getRepairOrders`
   with `repairOrderId` (or the single-RO endpoint), pull `milesOut ?? milesIn`,
   and bulk-update every row sharing that `workOrderId` with
   `{ mileage, vehicle.mileage, mileageBackfilledAt: now }`.
4. Politeness: cap to ~2 req/sec per shop, persist progress in a
   `tekmetric_mileage_backfill_progress` collection so crashes resume cleanly,
   and ensure we don't re-process rows already touched after the marker date.
5. Same defensive enrichment in `app/api/plan-build/route.ts`: when reading
   `job_index` and `mileage` is null, look up the parent `tekmetric_work_orders`
   doc for that `workOrderId` (single batched fetch) and use its odometer.
   Avoids regressing if a new ingestion gap appears.

**Files likely touched:** `scripts/job-index-mileage-backfill-tekmetric.ts` (new),
`app/api/plan-build/route.ts`, possibly `lib/tekmetric-job-index.ts` (helper).

**Acceptance:** Re-run the probe from 2026-04-22 against shop 82 and verify
`nullMileage` count drops to <5% of total. Spot-check 5 historical ROs in VHI
and confirm `last.miles` now matches the Tekmetric WO's `milesOut`.

---

### [ ] 10. Architecture diagram & doc refresh
**Why now:** `replit.md` is becoming a kitchen-sink list of every feature.
A new engineer (or a future agent session) can't form a mental model from it.

**Proposed approach:** One Mermaid diagram in `docs/` showing: the dual
DB strategy, where each integration plugs in, the extension flow, and the
cron/web-service split. Trim `replit.md` to architecture only and link out
to per-feature docs.

**Acceptance:** A new contributor can read `docs/architecture.md` in under 10
minutes and explain the data flow back.

---

## How items get added
When fixing a bug, ask: "Is this a class of bug or a one-off?" If class-of-bug,
add an item here describing the *pattern* and how to prevent recurrence — not
just the specific fix. That's how this doc earns its keep.
