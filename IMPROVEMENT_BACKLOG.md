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

### [ ] 1. Audit & DRY the extension feature-gate pattern
**Why now:** We just shipped the same fix three times. The "validate token →
resolve shop → check user-shop access → check feature entitlement" block is
copy-pasted across `vhi-coach`, `prefill-dvi`, and `enhance-findings`. Any new
extension route is one forgotten line away from re-introducing the bug HEART
Certified Auto Care reported.

**Proposed approach:**
1. Audit every route under `app/api/extension/**` and list which ones do/don't
   call `getFeatureEntitlements`. Decide for each whether a feature gate is
   appropriate (some, like `/features` itself, intentionally don't gate).
2. Extract a helper, e.g. `lib/extension-route-guard.ts`, exposing:
   ```ts
   resolveExtensionShop(req, {
     requiredFeatures: ["maintenance", "dvi_prefill"],
     providerHint: "tekmetric",
   }): Promise<{ ok: true, mosShopId, shopDoc, isPlatformAdmin } | { ok: false, response }>
   ```
   Helper handles: token validation, body parsing of `smsShopId`/`provider`,
   shop lookup, user-shop access check, entitlement check, platform-admin
   bypass, fail-closed behavior, and consistent CORS headers.
3. Refactor the three current routes to use it. Net code should shrink.
4. Add a lightweight grep-based check (CI step or `scripts/`) that fails if any
   `app/api/extension/**` route imports `findShopBySmsId` without also
   importing `resolveExtensionShop` (or explicitly opting out via a comment
   like `// gate-exempt: <reason>`).

**Files likely touched:** `lib/extension-route-guard.ts` (new), the 3 fixed
routes, plus any other extension routes flagged by the audit, and a new
`scripts/check-extension-gates.cjs`.

**Acceptance:** All extension routes either gate or have an explicit exempt
comment; the check script is green; the three fixed routes are 30+ lines
shorter; one new test exercises the helper's deny path.

---

### [ ] 2. Verify HoverCode actually applied our logo (don't trust 200)
**Why now:** HoverCode happily returned `200 OK` while producing logo-less QRs.
We only noticed because a human looked at a printed sticker. Same trust-the-200
risk exists everywhere we hit a third-party API.

**Proposed approach:**
1. After `createHovercode` and `updateHovercodeLogo`, immediately `GET` the
   record back and assert `logo_url` matches what we sent. If it doesn't, log a
   `warn` event with shop ID, QR ID, and expected vs. actual.
2. Surface those warnings on the platform observability page as a
   "QR generation drift" counter.
3. Apply the same read-back pattern to other "fire-and-forget" externals where
   silent corruption is plausible (Resend send confirmations, Twilio media
   uploads, Stripe price/product mutations).

**Files likely touched:** `lib/hovercode.ts`, `app/api/sticker/generate/route.ts`,
`app/api/sticker/regenerate-qr/route.ts`, observability page route.

**Acceptance:** A unit test simulates HoverCode returning 200 with no
`logo_url`; our code surfaces a warning instead of pretending success. Manual
spot-check on staging shows the read-back path runs.

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

### [ ] 9. Architecture diagram & doc refresh
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
