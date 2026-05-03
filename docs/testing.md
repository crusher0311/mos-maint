# Testing

This repo's safety-net tests run as plain `tsx` scripts under `tests/*.smoke.ts`.
There is no Vitest / Jest runner — the existing `tests/` directory built up a
foothold in this pattern (each test is a self-contained Node script that
exits non-zero on the first failed assertion), and the CI wrapper
(`npm run test:smoke`) just runs them in series.

If you need a heavier framework later, add it alongside — don't replace these
files wholesale; they are deliberately lightweight so they stay green during
big infrastructure refactors (DB cutovers, integration rewrites, etc).

## What the safety net covers (task #304)

The safety net targets the things that hurt most when they break, focused on
the code paths the DB cutover touches. Coverage in priority order:

| File                                            | What it pins                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `tests/hovercode-drift.smoke.ts`                | `verifyHovercode` read-back guard. Pins the **200-with-no-logo** drift case (the prod bug that shipped logo-less QRs), the qr_data-mismatch case, and the read-back-failed case. Mocks `globalThis.fetch`. |
| `tests/vhi-score-snapshot.smoke.ts`             | Pure VHI scoring math: `categoryMultiplier`, `separateComplimentary`, `computeScore`, `getScoreTier`, `formatVhiItem`. Pinned fixtures so a refactor of the deduction weights / tier boundaries is a loud test failure, not a silent customer-facing score shift. |
| `tests/vhi-rebuild-snapshot.smoke.ts`           | `rebuildVhi` end-to-end (with `__deps` seam stubbing the DB / cached plan / build trigger): happy path returns the full canonical VHI result shape (score, tier, vehicle, currentMiles, summary counts including separated complimentary, formatted bucket items with correct iconStatus); build-trigger failure returns `failedStage:"triggerPlanBuild"` with `upstreamStatus`; cache-empty-after-build returns `failedStage:"cacheReadAfterBuild"` with `built:true`. |
| `tests/hovercode-create-payload.smoke.ts`       | HoverCode create-call contract: outgoing POST body to `/hovercode/create/` includes `logo_url` (caller-supplied is forwarded verbatim, otherwise the `appointment-logo.png` default is sent), plus `qr_data`, `workspace`, `dynamic`, `generate_png`, and `Authorization: Token …`. Pins the SEND half of the 200-with-no-logo prod bug — the `hovercode-drift` test pins the read-back half. |
| `tests/jobs-search-shape.smoke.ts`              | Pure mapper `mapServiceJobToCanonicalResult` (extracted from `searchSupabaseServiceJobs`): pins the canonical job-search result shape downstream consumers (dashboard cards, plan-build, recommendations) depend on — `_id`, `vehicle{vin,year,make,model,engine}`, `job{title,description,name,keywords,totals}`, `lines[]`, top-level `totals`, `performedAt` precedence (completed → closed → createdAt), `workOrderId`, `workOrderNumber`, `sourceSystem` (with `"unknown"` fallback), and `dataSource:"supabase"`. |
| `tests/tekmetric-webhook-signature.smoke.ts`    | Tekmetric webhook HMAC: introspection-mode (no secret → bypass), missing header, wrong sig, correct hex sig, `sha256=<hex>` prefix stripped, body-tampering invalidates. Uses the `__verifySignature` test seam exposed by the route. |
| `tests/stripe-webhook-signature.smoke.ts`       | Stripe webhook signature gate runs before any Mongo touch. Missing `stripe-signature` → 400; bogus signature with a secret set → 400 (must NOT be 500). |
| `tests/extension-route-guard.smoke.ts`          | Extension route guard: platform-admin bypass, empty-feature-list short-circuit, no-auth → 401, response-body shape on the auth-failure path. Also runs the `check-extension-gates.cjs` lint script as a child process. |
| `tests/extension-auth-no-plaintext.smoke.ts`    | Extension auth route: bcrypt-correct → 200, bcrypt-wrong → 401, no-hash → 401 (no silent rehash from the legacy plaintext fallback that was removed in task #302). |
| `tests/extension-shop-lookup.smoke.ts`          | Multi-provider shop-id resolution in `lib/extension-shop-lookup.findShopBySmsId`: Tekmetric numeric/string, Protractor connectionId, Shopware tenantSubdomain, Autoflow domain-with-suffix, provider inference, platform-admin bypass, non-admin scoping by `userShopIds`, the Shopware single-candidate fallback (and refusal when ambiguous). Uses the `__deps.getDb` seam + `tests/utils/fake-mongo.ts`. |
| `tests/stripe-webhook-idempotency.smoke.ts`     | Stripe webhook duplicate-event short-circuit: a pre-seeded `stripe_webhook_events` row with `status:"processed"` returns `{duplicate:true}` and triggers ZERO write ops; an in-flight (`status:"received"`) prior row does **not** short-circuit; a brand-new event id triggers the dedup write before any business-logic side effect. |
| `tests/tekmetric-webhook-idempotency.smoke.ts`  | Tekmetric webhook replay-safe upsert: re-delivering the same RO event converges to exactly one row in `tekmetric_work_orders` (keyed by `workOrderId`), advances `updatedAt` on the existing row, and logs each delivery to `tekmetric_webhook_logs` independently. |
| `tests/jobs-search-canonical.smoke.ts`          | The canonical Postgres job-search (`searchSupabaseServiceJobs`) keeps its no-op guards: empty `searchShopIds`, empty tokens AND no `vehicleMake`, and empty-string `vehicleMake` all return `[]` before `getDb()` is called — protecting Postgres from a full-table scan over `normalized_service_jobs`. |
| `tests/oe-logo.smoke.ts`                        | Logo lookup behaviour for OE/brand spellings (an earlier safety net). |

## What is intentionally NOT covered here

These are skipped on purpose — adding them would require either a real Mongo
or scaffolding more invasive than the production-bug surface justifies.

- **Job search after the full triple-source collapse.** The supabase path's
  no-op guards AND canonical result shape are both pinned today
  (`jobs-search-canonical` + `jobs-search-shape`). Once the route in
  `app/api/jobs/search/route.ts` stops fanning out to `job_index` +
  `normalized_*` and becomes a single-source query, add a final wiring test
  for the collapsed route — see `IMPROVEMENT_BACKLOG.md` item #7.
- **Triggers under the webhook idempotency upserts** (VHI auto-rebuilds, NIS
  dual-write, plan-cache invalidation). Tested via the e2e suite which has
  the full external-system fixtures; the upsert itself is pinned here.
- **Code-coverage targets.** No percentage gate; coverage emerges from "did
  this catch the prod bug class it claims to catch?".

## Running locally

```bash
# Run the full smoke suite (also runs in CI before every build).
npm run test:smoke

# Run a single file.
npx tsx tests/hovercode-drift.smoke.ts
```

The full suite runs in well under a couple of minutes on a laptop. Anything
that needs Mongo or a long warmup should not be added to `test:smoke` — put
it under `tests/e2e/` instead.

## How to add a new safety-net test

1. Create `tests/<your-thing>.smoke.ts` next to its peers. Mirror the shape
   of an existing test (top-of-file docstring with **what / why**, an
   `ok(name, cond, detail?)` helper, and a final `process.exit(1)` on
   failures so CI sees a non-zero exit).
2. Mock external I/O (`globalThis.fetch`, etc.) or use the `__deps`
   test-seam pattern (see `app/api/extension/auth/route.ts` for an example
   — the route exposes a `__deps.getDb` that tests overwrite to swap in a
   tiny in-memory fake collection). Don't reach for real Mongo.
3. Add an `npm` script for it (`"test:<thing>": "tsx tests/<your-thing>.smoke.ts"`).
4. Wire it into `test:smoke` in `package.json` so it runs in CI on every PR.
5. Run `npm run test:smoke` once locally to confirm the suite stays green
   in under a couple of minutes.

## When a safety-net test fails

The smoke tests are deliberately strict — a failure usually means one of:

- A pure helper's behaviour shifted (legitimate refactor → update the
  fixture and call out the score-tier / shape change in the PR).
- An unintentional regression (the more common case → revert or fix before
  merge; the test name will tell you exactly which contract you broke).

Don't disable a smoke test to land a PR. Adjust the fixture, document the
shift, or fix the regression.
