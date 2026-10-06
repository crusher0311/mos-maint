# JWT overnight recovery plan — October 5, 2026

**Activation update:** The one-off, existing-header-only recovery is now
deployed and scheduled. See `jwt-overnight-run-2026-10-05.md` for verified
runtime state, exact scope and remaining gaps. Earlier “not active” statements
below describe the pre-activation assessment, not the current job state.

## Status

The user approved JWT-only overnight recovery on October 5, 2026.
**Not scheduled or activated.** No production data or provider policy was changed.
The authorization contract and transport integration are implemented in an
unpublished production-based release candidate; the runner and deployment are
not complete.
This approval does not permit bypassing those missing controls.
Do not disguise background jobs as interactive requests or resume general
workers to work around this restriction.

## Observed capacity and controls

- Bounded, uncapped-in-practice 24-hour production Mongo telemetry query:
  5,202 relay-tagged events, all HTTP 200; highest minute 21 events.
  Recorded latency p95: 2,691 ms. No recorded 429 or 5xx.
- These are logged events, not a verified unique-request ledger. Sparse
  traffic and missing events cannot establish a higher safe physical rate.
- Recent web-process samples: approximately 20.7–20.9 ms event-loop p95,
  one active PG connection, zero waiting/idle-in-transaction connections;
  199 Mongo connections. These are snapshots, not an overnight load test.
- Keep the existing fleet physical limiter and serialized transport.
  No higher rate, wider response-size allowance or weaker breaker is proposed.
- Persisted live policy permits callbacks and interactive requests only and
  confirms background workers suspended. Both workers are actually suspended.
- All ten JWT historical progress records say completed, last active July 12.
  Resetting those cursors would be a broad replay, not targeted recovery.

## Baseline triage (ordinary invoices only)

| Month | Native invoice count | Stored terminal RO count | Net shortfall |
|---|---:|---:|---:|
| August | 6,603 | 6,035 | 568 |
| September | 6,392 | 3,822 | 2,570 |

All twenty location/month cells were checked with read-only, five-second SQL
deadlines. Counts use UTC close dates; native timezone remains unconfirmed.
These **3,138 net differences are not yet 3,138 proven missing identities**.
Exact WO/invoice/source identity comparisons must classify the actual cases.

Outside the repaired 701 September cell, all 9,277 stored terminal rows have
zero header labor. This does not make all those zeroes wrong: native genuine
zeroes and signed negative labor must be preserved. It establishes the need
to reconcile existing rows as well as recover missing ones.

September count differences by location:
701: 18 (known holds), 702: 276, 703: 290, 704: 296, 705: 377,
706: 216, 707: 480, 708: 208, 709: 248, 710: 161.

## Proposed narrowly authorized run

1. Lock scope to canonical JWT shops 227–236, mapped locations 701–710.
   Revalidate enterprise membership and each shop's provider binding at run time.
2. Compare exact native August/September identities with stored records first.
   Classify absent, nonterminal, wrong-date, ambiguous and already-correct rows.
   Use existing final source snapshots where sufficient; do not fetch merely
   because a normalized hour field is null.
3. Start with one daily window at location 707 in September, then remaining
   September cells 702–710, then August 701–710. Exclude the already-reconciled
   580 invoices and keep the 18 known 701 holds in their exception queue.
4. Request final invoices in daily windows, one recovery request outstanding
   at a time, through the genuine shared relay/admission path. Persist response
   identity, day and checkpoints. Never widen to a month-sized API response.
5. Split application into two guarded classes:
   - Existing header discrepancies: independently match native amount and
     canonical final source; guard the row hash and update only approved labor
     fields and audit metadata, preserving every other field.
   - Missing/stale final invoices: use the existing identity, source-structure,
     disposition, finance and service-detail guards. Hold ambiguous records;
     do not invent customer or vehicle associations or remove old history.
6. Validate one day before continuing. Stop immediately on unexpected mutations,
   failed reconciliation, provider cooldown/size failures or sustained load.
   Respect all existing timeout/retry policies; checkpoint rather than force-skip.
7. Keep genuine zeroes, signed labor and credits distinct. Credit application,
   warranty arithmetic exceptions, identity merges and service-history removals
   stay held for explicit resolution. Net/loaded-cost availability is not inferred.

## Proposed operating window and limits

- Earliest proposed window: October 5, 10:00 p.m. through October 6, 5:00 a.m.
  America/Chicago (03:00–10:00 UTC on October 6).
- This window is **a proposal, not a reservation or running schedule**. If
  policy support and verification are not ready, do not start a late catch-up
  that extends into shop hours.
- Require shop quiet-window eligibility in addition to the outer time window.
- Keep other background jobs/workers suspended. Authorization must be JWT-only,
  expire at the window end and enforce scope/date/request bounds server-side.
- Pause recovery when live traffic needs capacity; no cap increase is needed
  to make use of quiet periods. Watch actual latency, errors and database load,
  rather than treating a low hourly average as permission for a burst.
- Use a renewable singleton job lease, durable checkpoints and a hard morning
  stop. Unfinished work remains queued for a separately eligible window.
- Final request/write budgets must come from the identity preview; no
  unbounded request budget or automatic cursor reset is approved by this plan.

## Before activation

The currently deployed provider policy has no JWT-only scheduled-recovery
scope. Implementing and activating that authorization is a separate safety
boundary from the existing callback/interactive mode. Test rejection of other
shops, other dates, expired windows, unregistered jobs, duplicate workers,
operator stops and failed source checks before deployment.

Implementation status:
- Added a separate JWT-only grant contract, not an interactive-context override.
- Admission eligibility restricts daily final-invoice GETs to August/September,
  excludes all of 701 September, and binds run identity and live generation.
- Grants require a manifest hash, finite budget, explicit stop state and a
  22:00–05:00 Chicago window, including the DST boundary.
- Wired paired Mongo admission/consumption expressions into the existing atomic
  fleet confirmation in the release candidate. Ordinary background requests
  remain denied, and exhausting the JWT budget does not exhaust callback access.
- Added a distinct expiring async context; it never impersonates interactive
  traffic. Actual endpoint, method and shop must match a compiled daily invoice
  read. Credential overrides, interactive priority and SOAP are rejected.
- In-flight request deadlines are capped at the context expiry/hard stop.
- Tests exercise eligibility and emitted expressions, malformed records,
  budget exhaustion, duplicate ownership confirmation, window boundaries,
  detached work and a mocked full client-to-dispatch path. No real provider
  traffic occurred. Existing fleet-pacer and operator-stop tests passed.
- Do not install a grant or schedule a job until actual shop/endpoint binding,
  singleton ownership, canonical membership revalidation, priority/load
  handling and atomic budget consumption are connected and verified.

### Legacy identity blocker discovered during the preview

The native manifest contains 12,397 ordinary invoices across 467 daily windows,
excluding credits and all of location 701 September. Its source hash matches
the previously assessed export. This is candidate evidence, not an authorization
to write every row.

The read-only number-based preview found:
- 3,510 zero-header records requiring final-source verification.
- 975 records whose header already matches the native amount.
- 649 nonterminal records, 16 date discrepancies and 10 number collisions.
- 7,237 native WO numbers without an exact stored-number match.

**That final number is not a missing-invoice count.** A separate monthly check
found **4,789 August terminal rows stored under provider GUIDs instead of human
WO numbers**, across all ten JWT shops. Sampled rows carry the same GUID as
their primary Protractor invoice source ID and lack a raw source payload.
September has no GUID-numbered rows in the nine unrepaired cells.

Consequently, a number-based "create missing" pass is unsafe. Obtain final
source identities first; resolve the same provider GUID to an existing row
before considering a create. If GUID and human-number matches identify
different rows, hold the case rather than merge or delete either. Preserve
existing child/history links. Do not classify these legacy rows as absent,
rename their IDs, or re-run broad backfill cursors as a shortcut.

The two inspected legacy GUIDs had no entry in the sampled Mongo invoice
snapshot collection. This does not establish that all caches are empty.
The scoped source-read/reconciliation runner is still needed before safe
automatic writes; **no production permit, schedule or recovery write is active**.

Evidence: `jwt-overnight-native-manifest.json` and
`jwt-overnight-identity-preview.json`. The preview's `absent_wo` classification
means absent by human number only.

### Release candidate and verification

Production-based candidate: commit `8cf3081c` in
`/tmp/jwt-reporting-release`, based on the previously deployed reporting release.
It is committed locally but has not been pushed or deployed. Keeping this
candidate separate preserves newer production transport code absent from
the task checkout. Do not replace that production client with the older local
client or publish the task checkout wholesale.

Passed: overnight policy, context and atomic/client-admission smoke tests;
existing Protractor fleet-pacer and operator-stop smoke tests; typechecks in
both checkouts. These tests use synthetic data and blocked network egress.
No signed-in UI was changed or verified.

The existing historical labor-hours repair remains separate. Assess it in dry
run against demonstrated line evidence; do not duplicate or automatically run
that production repair. January–July and October 1 onward are later assessment
phases, not an automatic extension of the supplied August/September export.

## Morning reconciliation

Report native/stored identities, newly applied versus already-correct records,
exceptions with reasons, signed header labor and independently covered sold
hours by location/day/month. Record remaining gaps, load, API error counts and
why the run stopped. A green queue/completed flag alone is not reconciliation.

Evidence: `jwt-overnight-preflight.json`, `jwt-overnight-cells.json`, and
`jwt-overnight-runtime-settings.json`. The last file contains only explicitly
allowlisted non-secret runtime configuration; it is not a complete effective
configuration inventory.
