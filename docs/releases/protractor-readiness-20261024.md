# Protractor readiness — 2026-10-24

## Decision and authority

**Read-only stage completed; restoration is not signed off.** No deployment,
provider request, database mutation, retry activation, worker resume, grant
renewal, or canonical flag change was performed. This is not permission to run
the commands in older runbooks.

The operator approved the documented service-specific safety-release **scope**
on October 24, after this report, selecting “Approve scope; keep recovery
disabled.” The approval was explicitly for the production operator, subject to
the preflight gates below, not deployment from this isolated fork. No production
change was executed in response.

Approved scope:

- Web: `a1b295a22e982960eb646f2497f17eaf9398ef6b`.
- Callback worker: `112ba236c332528b15c243e385d588e1bb97ba69`.
- Historical candidate: `ae43cd3788c37821a1b4b644a52f2c06ddfc2ca4`,
  image preparation only while workers remain suspended.
- Recovery remains disabled; no worker resumption, schema reinstall, fleet
  restart, provider write, export activation or unrelated release.

A recovery pilot is **not yet
execution-ready**: no exact failed normalization payload has been verified.
Do not activate the fleet-wide retry flag to discover one.

Observations below were collected approximately 12:53–12:57 UTC. Log measurement
window: **12:50:00–12:55:00 UTC**. These are point-in-time observations, not
ongoing attestations. Shop numbers are internal scope identifiers; no customer,
vehicle, provider identity, credential, payload, or raw error body is included.

## Deployed services, not configured branches

Render inventory and the latest five deploy records per service were read.
Production is external Render; this fork has no Replit deployment.

| Service | State | Actual last live revision | Configured branch / auto-deploy |
| --- | --- | --- | --- |
| Web `mos-tools` | Running | `95c1f5d2ef0881dd2f85db1e201ed05994e881e7`, Oct 23 14:14 UTC | `release/protractor-export-pg-20261023` / off |
| `mos-protractor-callback-worker` | Running | `ad56fc491260de75415388a49893ece6c5791685`, Oct 22 10:20 UTC | `main` / on |
| `backfill-drain-worker` | Suspended | `8d190f07b70c4f15affa1faba19f8e13041e41b8`, Oct 5 | `release/invoice-background-20261019` / on |
| `mos-maint-background-v2` | Suspended | `8d190f07b70c4f15affa1faba19f8e13041e41b8`, Oct 5 | `release/invoice-background-20261019` / on |
| Export-only worker | Suspended | No live deployment in returned records; initial deployment canceled | Separate export branch / off |

The October 23 normalization candidates are still **not deployed**. Configured
historical branch heads must not be confused with the last images run.

Service-level settings for web and callback worker show trial enforcement and
relay-required `true`, outbound-disabled `false`, worker-schedule-disabled `true`.
The two linked environment groups were also inspected. The queried canonical
flags (`PROTRACTOR_OPS_PG_CANONICAL`, `API_USAGE_PG_CANONICAL`) and
local-normalization flag were absent from those groups and the inspected service
overrides: source defaults imply Mongo operations/usage and retries off.
`IDENTITY_PG_CANONICAL` was absent from the groups, but was not included in the
service-override projection; identity canonical selection remains unverified.
**Saved settings are not runtime environment proof.** Full normalized-family
read/write selection and any non-Render writer inventory remain unverified.

An `_id`-indexed read of the shared admission record found operator stop false,
mode `live`, scope `callbacks_and_interactive`, relay required, worker suspension
attested, and unchanged start/replay floor **2026-09-15T11:52:46.690Z**. This was
a projected inspection, not complete structural validation of the generation.
Actual Render historical-worker suspension was independently verified.
Per-connection breaker state was not measured.

## Transport evidence, including missing responses

Render queries were restricted to the two named production resources and the
five-minute window; only `type=app` records with an instance label were included.
Build output, QA, and other services were excluded. Filtered relay-event queries
returned `hasMore=false`; records were deduplicated by log ID.

| Runtime | Request events | Response events | HTTP 200 | Transport-error events | Response duration p95 / max |
| --- | ---: | ---: | ---: | ---: | --- |
| Web | 45 | 45 | 45 | 0 | 5,291 / 7,055 ms |
| Callback worker | 29 | 28 | 28 | 1 | 7,449 / 13,110 ms |

These are complete **returned log-event counts for the filter/window**, not a
complete physical-admission ledger. Requests and responses were not individually
joined; boundary-crossing attempts, lost telemetry, and local admission denials
are not ruled out. The transport error was attributed to shop 233. No raw error
body was collected. Do not interpret 73/73 HTTP 200s as 74 successful requests.
All measured responses were non-priority; **advisor interactive latency is
unavailable**, not zero. Duration includes client admission wait and is not
provider-only latency. No DB-load or saturation time series was obtained.

Mongo usage's latest 50 records were production relay records, newest
12:54:55.184 UTC. Its actual provider/time index is named `provider_timestamp`,
not the `provider_1_timestamp_-1` hint in the current live-monitor source.
These reads used the inspected real index; no index was installed or renamed.

## Shop and callback processing evidence

### Inventory and recent history application

A projected, `_id`-indexed shops read returned all 502 documents below its 1,001
cap. There were 83 explicitly declared Protractor shops, 78 excluding canceled
billing records. This is complete for that **declared-provider subset**, not a
verified complete legacy-credential eligibility inventory. No credentials were
retrieved to infer additional legacy shops.

At 12:54:08 UTC the last-24-hour callback read returned the newest **2,001 GET
rows and hit its cap**; POST returned zero below cap. GET outcomes:

| Category | Sample count |
| --- | ---: |
| `applied_indexed` | 245 |
| `coalesced` | 1,020 |
| `terminal_no_history` | 490 |
| `deferred` | 246 |

There were 126 unprocessed sampled records: 112 Contact records and 14
non-Contact records; none of these 2,001 rows had exhausted attempts. Contact
retention is not runnable callback backlog. Outcomes are stored bookkeeping,
not independent verification of every normalized child.

**Recent indexed-history evidence (55 non-canceled declared shops):**
29, 35, 50, 51, 67, 69, 70, 113, 115, 139, 140, 141, 142, 143, 162, 217,
219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233,
234, 235, 236, 282, 283, 285, 287, 288, 289, 290, 292, 294, 296, 299, 301,
302, 303, 304, 306, 307, 309, 457, 538, 564.

**No applied-history evidence in this capped sample (23; freshness unknown):**
25, 66, 68, 71, 72, 76, 109, 114, 163, 218, 291, 293, 295, 297, 300, 305,
308, 330, 344, 362, 363, 380, 499.

Neither list establishes complete current shop data. Inactivity, capped sampling,
and terminal/no-history work are alternative explanations for no applied row.
Do not label the latter list as confirmed stale shops.

Independent PostgreSQL parent-row samples, using the shop/coalesced-close-date
index and one row per shop, confirmed Protractor history dated Oct 23 for:

| Shop | Latest sampled history date UTC | Parent updated UTC |
| --- | --- | --- |
| 139 | Oct 23 22:31:16.363 | Oct 23 23:42:35.613 |
| 233 | Oct 23 22:54:58.253 | Oct 24 00:30:51.838 |
| 538 | Oct 23 22:55:17.507 | Oct 24 03:54:37.105 |

These three parents do not establish child completeness or fleet freshness.

### Old eligible records versus deliberately held history

Separate ascending indexed queue reads used method GET/POST, priorities 0/1,
processed false, and either side of the fixed replay floor; cap 501 per
partition. GET priority 1 hit cap in both cohorts. The other six partitions
returned zero below cap.

| Cohort | Sample | Contact | Attempts >=3 | Non-Contact, attempts <3 | Oldest such record |
| --- | ---: | ---: | ---: | ---: | --- |
| At/after replay floor | 501 | 254 | 86 | 161 | Sept 15 12:01:50.421 UTC |
| Before replay floor, **held** | 501 | 0 | 17 | 484 | May 29 14:59:43.082 UTC |

The 161 are eligibility **candidates**, not authorization to dispatch: current
shop, ownership, coalescing, generation and safety checks still apply. Their
presence demonstrates stale eligible-cohort records, not fleet outage.
The oldest sample's reasons were 254 unsupported contacts, 160 pending replay,
68 dispatch failures, 18 missing VIN, and 1 safety boundary.
The held sample is not included in live backlog or live lag.

The same eligible edge at 12:54:58.897 and 12:55:27.344 UTC returned unchanged
501/254/86/161 counts and oldest timestamp. This establishes a stationary
sampled edge over 28 seconds, **not a fleet backlog trend or exact total**.
Recent non-Contact pending records were seen at shops 71, 72, 230–233 while
processing timestamps were also advancing. A longer comparable trend remains
required before activation.

### Normalization and history status

The production normalization retry table exists, has enabled and forced RLS,
and an ordered read below a 101-row cap returned **zero rows**. `anon`,
`authenticated`, and `service_role` had neither SELECT nor INSERT privileges.
This refresh is narrower than a complete sequence/view/role privilege audit.
No schema was reinstalled. Empty retries are expected before activation and
are **not proof of no normalization failures**.

A 100-record capped runtime timing sample from the callback worker included
three normalization successes, one skipped, and five not-run outcomes; there
were no failures in that sample. A separate exact-text query found no
`Callback normalization failed` messages in the five-minute window.
These timings intentionally omit shop identities; per-shop normalization failure
coverage is **unknown**. Web returned no callback timing records for this window.

Indexed legacy backfill reads returned one record for each of the 78 shops:
73 marked completed; 51, 457, 499, 538 and 564 not marked completed.
Shop 51's in-progress/error timestamps were last Sept 28; the other four had
epoch last-run timestamps. These are stale bookkeeping, not evidence that
suspended workers are running or authorization to restart imports.
The independent `_id`-indexed shop-538 operator history job is **completed**.
Its incomplete legacy row must not cause the completed import to be repeated.
PG progress reads for shops 139, 233 and 538 returned no rows; that is not an
absence-of-history conclusion.

## Exact safety-release recommendation — scope approved, execution gated

Source comparisons confirm web and callback candidates each add 13 files of
normalization/guard/schema/test documentation changes against their distinct
live baselines. Historical candidate adds only three provider-version guard/test
files against `b35fde9b`, preserving the already staged background compatibility
changes. No invoice repair, export activation, onboarding release or unrelated
main changes are authorized.

| Service | Exact proposed candidate |
| --- | --- |
| Web | `a1b295a22e982960eb646f2497f17eaf9398ef6b` |
| Callback | `112ba236c332528b15c243e385d588e1bb97ba69` |
| Historical workers, image preparation only | `ae43cd3788c37821a1b4b644a52f2c06ddfc2ca4` |

1. The approval recorded above covers these exact service/revision pairs, not
   a main-branch deployment or changed candidates. The production operator must
   recheck revisions, inherited settings, and all canonical writers immediately
   before acting. Any changed scope requires fresh approval.
2. Explicitly keep `PROTRACTOR_LOCAL_NORMALIZATION_RETRIES` disabled everywhere.
   Preserve relay-only transport, shared pacing/concurrency, breakers, emergency
   stop, preview isolation, callback floor and general-worker suspension.
3. Pin/release callback candidate first; wait for exact live commit and outgoing
   instance drain. Observe callbacks before releasing the exact web candidate.
   Recovery remains off throughout the mixed-writer interval.
4. Historical workers stay suspended. Do not resume them just to build or verify
   an image. If the platform cannot prepare a replacement while preserving
   suspension, defer their deployment; a configured branch alone is not proof.
   No old historical image may subsequently be resumed.
5. Verify exact deployed image revisions and runtime gates, unchanged floor,
   fresh callback progress and new-instance logs. Stop promotion on transport
   errors, uncertain runtime policy, or monitoring loss. Require actual advisor
   latency and DB-load baselines; this report does not supply them.
6. No migration command: schema is already installed. Refresh full ACL evidence.
   The October 23 report records candidate-specific real-PG and build checks.
   This session reran the current checkout's credential-stripped,
   network-denied disposable PostgreSQL retry and permissions suites: both
   passed. That is not a new clean native build of all pinned candidates.

Rollback while retries have never been activated: return only affected web or
callback service to its exact baseline above, reverify new-instance runtime
evidence, and leave history suspended. Preserve all connections, payloads,
progress and schema. After any future retry activation, do not blindly return
to an unguarded writer; stop recovery and assess committed receipts first.
No data deletion, completed-import reset or global policy relaxation is rollback.

## Bounded local pilot design — not approval-ready

Prefer **shop 139 only**, because its weekday quiet window is operator-confirmed
in the background-expansion runbook. This is a planning preference, not a
verified gap. Shop 233's transport error does not establish a normalization gap
and does not justify changing pilot shops.

Proposed maximum: **one retained payload / one local attempt / zero provider
requests**, one owner, no retry, no continuation, no expansion. Reserve
**2026-10-26 18:30–18:45 America/Chicago (23:30–23:45 UTC)** only if separately
approved and quiet-hour evidence is refreshed. No weekend assumption.

Before requesting execution approval, a read-only preflight must identify an
exact retained payload and demonstrate a missing/failed canonical entity,
validate provider version and source identity, compare newer source versions,
and record a restricted manifest digest, source date and exact record scope.
If none is found, report no verified target and stop. Current retry-table
emptiness means there is **no executable manifest today**.

Existing drain inspection: it claims across all shops, admits up to five items
per call, allows six attempts with backoff, and has no approved one-use manifest,
shop-specific owner, quiet window or absolute per-run hard cutoff.
Its 10-second default budget (30-second maximum) limits admissions, not total
work. The 90-second lease and SQL timeouts do not implement this pilot contract.
**Do not enable it.** No runner changes were made speculatively without a target.
Closing these enforcement gaps in isolation, with real-PG tests, remains part
of this task before pilot approval.

Required pilot controls and checks:

- Bind shop 139, exact immutable manifest digest and provider connection,
  one-use run identity, one owner, server-clock window, and maximum one attempt.
  Reject wrong shop/version, duplicate owners, completed work, expired grants,
  lost ownership and ambiguous outcomes; deny provider egress.
- Stop admissions at 60 seconds or the quiet-window cutoff, whichever is first.
  Enforce rollback/cancellation of uncommitted work at 90 seconds; do not mistake
  a Promise timeout for database cancellation. Capture all mixed-store effects.
- Run no indexing, attribution, audit scheduling, exports or provider writes.
  Compare parent/child identities, counts, associations and source versions
  before/after; require an atomic PG completion receipt. Preserve evidence of
  any Mongo-only writes and never blindly replay after an ambiguous result.
- Before starting, capture two complete five-minute callback/advisor baselines
  and DB metrics. Stop on any new transport error, 429, auth failure, 5xx,
  deadline/ownership uncertainty, missing telemetry for >60 seconds, or failed
  correctness check. This observed five-minute transport window fails a
  zero-error starting gate.
- Stop if new (post-baseline) actionable callback lag exceeds 300 seconds or
  rises >60 seconds; track the old Sept 15 cohort separately. Stop if comparable
  advisor p95 exceeds 2x baseline or 10 seconds, DB CPU exceeds 70% for 60
  seconds, or DB connection use exceeds 80% for 60 seconds. No adequate advisor
  or DB baseline means no start, not an assumed healthy baseline.
- Stop only this pilot for ordinary failure; leave live callbacks/advisors
  running. Global emergency stop remains available for a fleet incident.
  No automatic rollback of committed data or renewal after stopping.

An upstream-fetch pilot, should local evidence prove insufficient, needs a new
exact scope and its own approval. Expired Afton, Burnett or JWT grants cannot
be reused.

## Handoff and remaining work

Onboarding verification remains with its existing task and runbook. No
Test/Connect action, token rotation, Sync Now invocation, or onboarding scope
change was attempted here. These live revision and callback findings can inform
that work; they do not verify its authorized end-to-end flow.

**Safety-release scope approved; production execution and full recovery remain
unverified.** The fork's deliverable is the readiness report and approved,
conditional operator handoff, not an executed release.
Remaining gates: exact failed retained-payload target, isolated pilot enforcement,
full runtime writer/canonical selection verification, comparable callback trend,
advisor latency and DB-load baseline, full schema permissions refresh, and
candidate deployment-build evidence. No pilot execution approval is requested
until its exact manifest and enforcement checks exist.

All data reads used native read-only operations, inspected indexes, Mongo
2.5-second execution deadlines and bounded results; metadata discovery used
connection/socket bounds. PG connections set
`default_transaction_read_only=on` and 2.5-second statement timeouts. No app or
worker was booted from this fork. No signed-in UI or screenshot was needed for
this operational document.
