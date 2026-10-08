# Shop workflow pilot

## Activation status

Code is staged, not deployed or activated. No live provider or database was
contacted for development testing. This workspace's Mongo connection is shared
with production: do not boot the production app to test this feature.

The presentation artifact remains separate. The application route is
`/dashboard/shop-workflow`, using the existing authenticated dashboard.
In Platform Admin → Shops → edit the chosen shop, enable **Shop Workflow (pilot)**
and save. The per-shop `shop_workflow` feature defaults off and cannot be granted
by enterprise inheritance, plan tiers or the founder wildcard. The same setting
controls sidebar visibility, direct page access and every dispatch API request.
No environment allowlist is needed; `SHOP_DISPATCH_PILOT_SHOP_IDS` is no longer
used. Refresh the dashboard after toggling to update navigation; server access
changes on the next request. Disabling preserves existing workflow records.
Enable only after confirming location, staff accounts and provider connection.

## Pilot contract

- Read-only **Protractor** intake by exact work-order UUID, using existing
  shop-owned provider credentials, routing checks and bounded request options.
  Other providers need an adapter; API access alone is not a tested contract.
  There is no automated fleet sync, discovery, provider write-back or webhook.
  Managers explicitly import/refresh each RO. Source time/status is visible.
- Stable package IDs reconcile repeat imports without replacing dispatch choices.
  Missing/declined packages block further starts and pause active work for review.
  Closed/invoiced/canceled orders are rejected, not silently completed locally.
  Unknown statuses require manager review. No duration, technician identity,
  authorization, transportation or actual working time is inferred upstream.
- Managers create visits/jobs, map existing login emails to technicians, authorize
  imported jobs, plan assignments/dependencies/rack and correct times with a reason.
  Email mapping grants no shop access: the authenticated session must already be
  scoped to the allowed shop. Inactive staff must first relinquish unfinished work.
- Technicians can start/pause/complete only their assigned jobs. Starting another
  job requires explicit pause-current consent. A shared alignment rack admits
  only one active job. Dependency cycles/cross-visit dependencies are rejected.
- Customer plans (unknown/waiting/drop-off/returning) are independent of job pauses.
  Ride status, loaner status/ID, pickup commitment and notes persist on the visit.
  The same normalized loaner identifier cannot be assigned to two open visits.
  Closing requires all jobs complete and transportation obligations resolved.
- Actual active and paused waiting use server timestamps, not client timers.
  Estimates are manager-entered, not AI. Promise projections are limited/manual,
  not a scheduling optimizer or guarantee.
- Enterprise owner/admin branding follows the existing enterprise settings role
  convention, derives enterprise membership from the session's shop, and never
  accepts a client-selected enterprise. Managers may apply location overrides.
  PNG/JPEG/WebP logos are embedded, bounded and signature checked; no external URLs.

## Storage and concurrency

New Mongo collections `shop_dispatch_pilots` and
`shop_dispatch_enterprise_brands` use built-in `_id` indexes only. No changes to
existing collections, identity canonical flags, migrations or backfills.

All mutations compare document revision and atomically commit assignments,
sessions, transportation, audit and request receipt. Majority acknowledgement is
requested. UUID retries return the committed state without applying twice; reuse
with a different actor/payload fails. A timeout can be ambiguous: the UI retains
the exact request for retry. Conflicts require refresh/review; no optimistic
success or silent overwrite. Enterprise branding has its own revision/receipt.
Ten-second, visibility-aware polling updates other screens; this is not websocket
realtime or offline mode. Never navigate away from an unconfirmed save.

The deliberately bounded pilot retains history rather than silently deleting it:
500 visits, 2,500 jobs, 5,000 mutations, 8 MiB per board. Closed visits remain in
history. Exceeding a limit stops writes explicitly. Review usage before activation
and arrange durable archival/partitioning before expansion; audit download is
not an automatic archival service. Logo settings alone do not reset work.

## Verification and operator acceptance

Offline tests:
```
NODE_PATH=$PWD/artifacts/detect-dog-workflow/node_modules \
  artifacts/detect-dog-workflow/node_modules/.bin/tsx --test \
  tests/shop-dispatch.test.ts tests/shop-dispatch-http.test.ts
artifacts/detect-dog-workflow/node_modules/.bin/tsc \
  -p tests/shop-dispatch-browser/tsconfig.json
```
The test-only Vite harness in `tests/shop-dispatch-browser` displays a prominent
offline fixture label; it imports the real client UI but substitutes synthetic
responses. It does not change production auth. Do not publish this harness.

Before activation: resolve existing root dependency installation/security-policy
block, run the full Next build/typecheck, then verify in an approved environment:
two authorized browsers and a technician login; session expiry/revocation;
one actual open RO/package shape; failed and repeated import; concurrent saves;
parts hold/reassignment/handoff; ride/loaner collision/return; enterprise/local
branding permissions; audit correction and refresh persistence. Do not claim
live integration or the signed-in Next page verified from the offline fixture.
