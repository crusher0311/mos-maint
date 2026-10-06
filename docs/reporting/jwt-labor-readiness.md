# JWT labor pilot readiness — 2026-10-05

## Status: not ready for reconciled operational use

The governed reporting foundation and read-only pilot assessment are available,
but the task is **not complete**. Full-enterprise execution remains blocked.
Native evidence was subsequently supplied and assessed; reconciliation now has
measured discrepancies rather than only an access blocker.
Do not represent these results as reconciled, complete labor performance, or
fully loaded GP. The separately approved September 1 recovery is now complete:
all 21 approved invoices were recovered and all 22 native identities are included.
The separately authorized September 2–30 run subsequently completed processing:
217 candidates repaired and 18 held. Read-only header verification passed for
all 217 applied outcomes. This does not establish native financial reconciliation
or resolve the held exceptions. No migrations, index builds or cutover switches
were performed.

## Membership and history

Canonical `enterprise_accounts` membership resolved one enterprise named JWT:
shops 227–236, locations 701–710 respectively. All are Protractor.
Configured timezones are America/New_York except 709 (America/Chicago).
Timezone configuration has not been independently confirmed with JWT.

`jwt-coverage-2026-10-05.jsonl` contains the complete read-only monthly assessment:
100 location/month checks, January through October 5. Every location has
terminal ROs in every checked month. This establishes stored history, not
completeness relative to Protractor. The first annual query exceeded its
10-second deadline for location 702; splitting into monthly checks succeeded.
No timeout result was replaced with zero.

January–July job-level billed hours and declined jobs are largely missing.
Zero recorded decline counts cannot establish that nobody declined work.
August onward has hours and dispositions but remains partial. Recorded
discount totals defaulted by old normalization cannot establish zero discounts.
The assessment distinguishes explicit zero billed hours from missing hours.

## Runtime check

A production read-only query for 701, September 2026 found 342 terminal ROs.
Only 6 had complete supported sold-hour evidence, summing to 1.1 hours.
Presented and net labor sales were unavailable (zero covered ROs).
These are **not** JWT's actual September labor totals. Returning 1.1 without
the 6/342 coverage would be misleading; coverage counts travel with the measure.
The PG snapshot fallback did not improve this sample's coverage. The canonical
cache-only recovery subsequently matched all 342 ROs and improved supported sold
coverage to 86 ROs / 69.02 hours, and presented coverage to 80 ROs / 322.88 hours.
Net remained unavailable. This demonstrates useful historical reads without
executing the historical repair; it does not establish full baseline coverage.

## Representative source evidence

Three bounded cached Mongo Protractor records were inspected without customer,
VIN, contact, staff or credential output:

- RO 701007013, invoice date July 11: sold labor quantities 0.3, 0.5, 0.2;
  deferred labor quantities 1.0 and 0.7. Source lines carry explicit zero
  labor prices and costs. These zeros do not prove payroll cost is zero.
- ROs 701003414 and 701003167, September 17: material-only and empty packages.
  These demonstrate why missing service-job hours alone cannot distinguish
  a true zero-labor package from a normalization gap.
- Source line fields included Total, Discount, ExtendedTotal and TotalCost.
  The sample did not establish invoice/package-level discount allocation.

### Supplied native export

The supplied August–September Service Package Sales Data CSV contains 350,027
package rows, including locations outside JWT. Only canonical JWT locations
701–710 were included in the pilot totals (51,107 Invoice package rows and 223
Credit Invoice package rows). The raw export contains personal information and
is excluded from Git; `jwt-native-export-assessment.json` contains only aggregated
operational fields plus a SHA-256 fingerprint. Reproduce it using
`python scripts/assess-native-labor-export.py <csv-path>`.

| Native type and month | Distinct invoice numbers, summed per location | Raw billed hours | Raw Labor Total |
| --- | ---: | ---: | ---: |
| August Invoice | 6,603 | 8,171.68 | $871,130.05 |
| August Credit Invoice | 54 | -21.92 | -$2,852.76 |
| September Invoice | 6,392 | 6,958.24 | $709,553.20 |
| September Credit Invoice | 61 | -42.49 | -$4,246.12 |

These are package-row sums, **not certified net sales** or a deduplicated
technician allocation. Invoice Total repeats per package and was never summed.
Invoice and work-order identifiers differ; neither package-row counts nor
credit invoice counts may be silently substituted for distinct closed ROs.

For 701 September, the native export has 598 Invoice records (distinct invoice
and work-order numbers), 583.55 billed hours and $53,158.75 Labor Total, plus four
credit invoices, -3.60 hours and -$539.98. The stored query found only 342 terminal
ROs and 69.02 supported hours after cache recovery. This is a **population and
field-coverage discrepancy**, not a reconciled result; do not label the 256-count
difference as conclusively missing invoices until identities, statuses and date
semantics are aligned. This repair need goes beyond filling null job hours.

Native ROs 701003414 and 701003167 dated September 17 have zero billed hours
and zero Labor Total across all their exported packages, agreeing with the
previously inspected zero-labor cache evidence. The July source example is
outside this export's range.

Negative Labor Total rows occur inside ordinary invoices, prominently in
Discounts, Promotions & Coupons packages (including 15OFFLOF, IR and 10OFFLOF).
Those amounts must not be dropped, made positive, or subtracted again. This
establishes signed discount-package evidence, but not how API line/header
discounts map to the report. The export has no explicit discount allocation,
refund linkage, or declined/deferred-work fields; presented hours remain
unreconciled. Native dates lack offsets, so UTC/local business-date parity
remains unverified. Cache rows also remain mutable historical evidence.

The native Labor Cost column is largely zero and includes negative values even
on ordinary invoices. JWT Invoice row sums are -$128.10 in August and -$802.61
in September. Thus provider cost is present but is demonstrably unsuitable as
an assumed fully loaded payroll expense. Its accounting meaning requires
provider/shop confirmation; neither it nor derived GP is exposed.

## Contract and limits

Labor v1 is separate from legacy KPI definitions. Population is distinct
non-deleted closed/invoiced/paid ROs. Dates are UTC days from closed_date with
completed_date fallback, never import dates. Provider offsets convert to UTC;
local-shop business-day parity remains a reconciliation question.

Sold hours prefer explicitly billed hours. Presented hours additionally need
complete regular/deferred package evidence; pending estimates are excluded.
Repeated package identities count once and deferred membership wins.
Bands: [0,1), [1,2), [2,4], (4,infinity), unknown. Supported values and RO counts
are additive across bands. Other providers are unavailable, not fake zeros.

Net uses only labor, requires evidence proving Total − Discount = ExtendedTotal,
and uses ExtendedTotal once. Missing/unallocated invoice/package discounts
invalidate net. Negative credits retain their sign on the original close date.
Unallocated refunds/chargebacks invalidate net instead of guessing an allocation.
Parts, supplies, sublet and tax do not enter labor net. No loaded cost or GP is exposed.

The query is selective to labor definitions, uses parent-scoped aggregates,
retains the shared interactive 45-second deadline (existing background jobs
allow five minutes overall, with 45 seconds per statement), and rejects more
than 100,000 ROs rather than silently truncating. Full-enterprise/year performance has not
passed: the January 1–October 5 query exceeded the production 45-second statement
deadline. Removing child line joins and adding an explicit shop predicate
changed the job plan from per-order nested loops to a shop-indexed hash join,
but the full-range query still timed out. A subsequent change partitions reads
sequentially by authorized location/month within the same absolute budget and
rejects the entire result if any partition fails. Automated tests cover leap-year
boundaries, scope, and failure without partial results. The full JWT verification
still did not finish within the five-minute shell test window; no complete
enterprise result was obtained. No further production performance probes were
run. Durable resumable partition execution or operator-reviewed query/index
work remains necessary. No indexes were built and no application deadline was
widened beyond the existing reporting contract.
New definitions use execution cache version 2; pinned results
are not rewritten.

## Required evidence before treating the pilot as reconciled

### Identity comparison: location 701, September

A bounded read-only lookup of all 598 native Invoice work-order identities
against shop 227's normalized work orders found:

| Classification | September 1–14 | September 15–30 | Total |
| --- | ---: | ---: | ---: |
| Included terminal September RO | 3 | 339 | 342 |
| Absent by both native WO and invoice number lookup | 214 | 12 | 226 |
| Exact WO match, nonterminal stored status | 26 | 3 | 29 |
| Invoice-number-only candidate (not confirmed identity) | 1 | 0 | 1 |
| Total native invoices | 244 | 354 | 598 |

The 29 exact nonterminal matches comprise 12 draft, 8 scheduled, 7
inspection_in_progress and 2 work_complete records. They must not simply be
reclassified as invoiced to make the counts agree.

A second bounded check of the 256 excluded identities against the Mongo
Protractor cache examined top-level, rawPayload and legacy data WorkOrderNumber
fields (both string and numeric forms). All 29 nonterminal native identities
matched cache records, but their snapshots were WorkOrder/Appointment types
with sentinel `0001-01-01` invoice dates. None of the 226 unmatched normalized
identities matched the checked cache WO fields. Number-only cross-matches can
collide with unrelated work orders; the remaining single candidate is unresolved.
These checks do not prove absence under every possible provider GUID or store.

The concentration before September 15 supports the user's reported access
interruption as a leading cause, but its exact dates remain unverified.
Twelve unmatched invoices and three stale-status records on September 28–30
show that the recovery scope must also cover the later gap, not only September
1–14. This is not a timezone-only discrepancy.

Aggregate evidence is saved in `jwt-701-identity-comparison.json` and
`jwt-701-cache-comparison-summary.json`. No customer fields or credentials
are in those files. Probe SQL uses read-only sessions, 100-native-identity
batches and a 10-second statement timeout; the Mongo check is shop-scoped,
projected, capped at 1,001 rows and has a five-second server deadline.

**Recovery recommendation (requires operator approval):**
1. Start with location 701 and September only. Resolve the ambiguous identity
   before treating it as missing.
2. Recover authoritative final invoices for missing and stale entries through
   the rebuilt adapter, honoring its current relay/rate-limit safeguards.
   Preview the recovery candidates and proposed normalized changes before writes.
3. Do not widen terminal-status filters or modify dates to force agreement.
   Filling job hours alone cannot restore missing invoices or final snapshots;
   the existing labor-hours repair is not sufficient for this recovery.
4. Re-run identity and labor comparisons after recovery, then assess other JWT
   location/month cells. Only expand recovery where equivalent gaps are proven.
5. Per the user's direction, defer enterprise-report performance investigation
   until this data discrepancy is resolved.

No provider requests, repairs, backfills, or database writes were performed
during this investigation.

### Read-only recovery preview

The user authorized a read-only preview, **not a live repair**.
`jwt-701-recovery-preview.csv` lists the 256 excluded native identities,
their native dates, classification, and signed package sums. It contains no
customer contact or vehicle fields. The corresponding summary contains
259.71 native billed hours and $24,998.63 native Labor Total across these
candidates. These are export sums, not verified recoverable API values, not
certified net sales, and not amounts to blindly add to the current report.
The ambiguous invoice-number candidate remains explicitly ineligible for
automatic repair.

The offline preview is complete; the upstream-verified preview is blocked.
This task's working client still dispatches directly to Protractor, whereas
the newer shared branch contains relay transport and preview-environment
isolation. The inspected workspace configuration supplies neither relay mode
nor explicit development relay approval. No request was sent using the older
client, and no gate or configuration was changed.

Continue the upstream read-only preview on the approved relay-enabled runner
using the current adapter and its existing gates. Alternatively, coordinate
bringing the current adapter into this task branch and separately establish
approved preview relay access. Neither an old direct client nor a copied relay
credential is an acceptable substitute. Production runtime gate state was not
verified by this offline check.

An isolated checkout of the current shared adapter was subsequently prepared,
leaving the reporting working copy unchanged. Its local policy preflight
returned `development_relay_required`. The relay HMAC secret is already
available, but development relay mode, endpoint and explicit preview approval
are not configured. No provider request or configuration change was made by
that preflight.

### Existing-production-runtime check

The development configuration request was declined. No new environment
variables were set. Two short-lived Render jobs subsequently used the active
web service's existing deployed artifact and configuration; neither required
new relay credentials, development approval, a service restart or deployment.

The first job confirmed relay client and TypeScript runner availability and
local `allowed: true`. The second executed the bounded preview runner, which
requires relay-only transport, exact shop 227 configuration, one September 1–2
invoice GET (maximum 25 rows), no retries, and no automatic pagination.
It stopped at the scoped-policy guard **before resolving shop credentials or
making the GET**, because callback-only and/or timed-trial restrictions were
active. The captured event's original reason was `allowed` because that
diagnostic incorrectly reused the broad local-policy reason; execution reached
the blocked branch, not the provider. The runner now emits separate scoped
restriction reasons, covered by offline tests.

This supersedes the assumption that additional relay configuration was needed.
The unresolved issue is permission for standalone recovery reads during the
current controlled production mode, not relay authentication. Do not imitate a
callback, supply a fabricated interactive context, disable trial enforcement,
or open the fleet to obtain the preview. Continue on an explicitly approved
recovery-read path or after operators restore ordinary reads. No live repair
is authorized, and enterprise-report performance remains deferred.

### Authenticated preview implementation

`/platform-admin/jwt-invoice-preview` now provides an explicit-click preview,
linked from the Protractor operator controls. Its same-origin, JSON-only POST
requires a platform-admin session and rechecks canonical JWT membership for
shop 227. Scope overrides are rejected. It establishes a genuine authenticated,
shop-bound interactive request before checking effective persisted policy.
Callback-only trials remain blocked; no activation or trial-setting writes occur.
Each accepted invocation attempts one GET with a 20-second transport timeout,
no retries, no pagination, and at most 25 returned invoices. The shared
admission, lease, rate-limit, deadline and circuit-breaker controls remain active.

Only invoice/WO numbers, type, source date and comparison against the 22
September 1 native identities are returned. Customer, vehicle and financial
payloads are not returned. Results are always labeled partial; a stored-snapshot
match is not live normalized-data reconciliation or confirmation of net labor.
The preview makes no ingestion, cache-repair or normalization writes; normal
shared transport admission/accounting still applies. Concurrent requests are
blocked per web process, in addition to the fleet transport limits.

Synthetic service and route tests cover unauthorized requests, cross-origin
requests, forbidden overrides, canonical membership, transport mode, trial
restrictions, successful authenticated reads, redaction, oversized responses,
provider failures, no-store responses and concurrent clicks.

The preview-only release is now live on the production web service. The first
deployment was stopped by the existing operator-page UI tests because framework
link prefetch effects required a browser global absent from their test harness.
Non-prefetching navigation fixed that issue; operator UI tests, preview tests,
and TypeScript passed on the exact production release tree before the retry.
The successful deployment also passed the configured production build checks.
An unauthenticated production POST was rejected with HTTP 401.

The operator subsequently supplied a screenshot of a successful authenticated
preview: 22 returned/displayed records, with the native sample count also 22.
The returned records display `Type: WorkOrder` alongside September 1 invoice
dates and invoice numbers. The initial comparison incorrectly required
`Type: Invoice`, so it labeled these rows unverified even where their identities
could match. Comparison now separates identity/date matching from closure
validation, with regression tests for differing types and mismatched identities
or dates. This screenshot is evidence of a successful read, not proof that all
22 distinct native identities were reconciled or that financial totals agree.

Only preview files, navigation and their test registration were published;
the unfinished labor-reporting changes were not included in this release.
No relay configuration, trial scope or production stop was changed.
Operator-provided screenshots now demonstrate the signed-in preview and a
successful read. The second screenshot displays identity/date matches for the
22-row September 1 sample: 1 included, 9 absent by both numbers, and 12
nonterminal in the stored snapshot. These are historical snapshot classifications,
not a fresh normalized-database check. No live repair was performed.

The next source evidence needed for the nonterminal group is `WorkflowStage`
and `Status` from the returned records. The normalization path uses
`WorkflowStage || Status`, not `Type`; the current identity-only preview does
not expose those fields. Do not attribute the 12 nonterminal rows to the
preview's former Type check or change their normalized statuses on this evidence.

The extended preview now displays the two source status fields, invoice time,
header creation/modified times, a fresh read-only canonical database comparison,
and downloadable conditional dry-run recommendations. The database lookup is
fixed to the 22 native pairs, uses a read-only transaction, an eight-second
deadline, a five-second-or-shorter statement timeout, and a capped result set.
Failure remains unavailable, never absent. Duplicate/conflicting identities,
soft deletion, conflicting source dispositions and unknown closure block proposals.
Recommendations require source-detail and business-date validation plus explicit
operator approval; there is no repair endpoint or write path.

A fresh external-production read-only check on 2026-10-05 still found 13 stored
records for these 22 native pairs: 1 included, 12 nonterminal, 9 absent by both
numbers. Thus the earlier snapshot gap still exists.

The operator's downloaded evidence, observed at 2026-10-05T14:15:35.320Z,
contains 22 distinct pairs matching the native list. All have WorkflowStage
`Invoice`, absent Status, and September 1 invoice dates in both source-offset
and UTC representations. Stored states are 9 absent, 5 draft, 5 scheduled,
2 inspection_in_progress and 1 closed with the correct date. The preview's
allowlist mistakenly omitted the literal `Invoice` workflow stage; the local
correction maps that stage to a closed recovery candidate, with tests.

`jwt-701-september-1-proposed-recovery.csv` enumerates 9 conditional imports,
12 conditional source refreshes and 1 leave-unchanged record. This is not a
write manifest: full source payloads and fresh identity/conflict checks are
still required. The operator explicitly approved recovery of these 9 missing
and 12 stale invoices on 2026-10-05, conditional on those checks. The one
already-included invoice and all other scopes remain excluded. No repair has
been executed. The access-interruption
hypothesis remains unproven; this evidence establishes the gap, not its cause.

The post-approval bounded cache check found no cached records for the 9 missing
invoices. All 12 stale invoices have cached pre-invoice payloads with
`InvoiceTime: 0001-01-01T00:00:00`; they do not pass finalized-source validation.
Do not replay those payloads or patch only their statuses from the downloaded
summary. A fresh full-source capture and guarded ingestion are required. The
existing authenticated preview discards full payloads and has no repair action;
approval does not authorize fabricating interactive context for a background
job or changing the controlled production trial.

An authenticated, explicit-click source-download option is implemented on the
same page. It performs the same single bounded GET and exports only the 21
approved pairs, excluding the already-included invoice. Missing/duplicate source
identities, malformed IDs, nonfinal/contradictory stages, wrong business dates
and missing service-package collections reject the entire capture. The private
file includes customer/vehicle/service details; it is not a public report.
This capture is read-only and does not itself execute the approved recovery.
Full ingestion validation, fresh database conflict checks and a guarded
production writer remain prerequisites. No production repair has run.

### Full-source validation, 2026-10-05

The operator supplied the authenticated source capture taken at
2026-10-05T14:50:48.461Z. Offline validation passed for the exact 21 approved
invoice/WO pairs, excluding the already-included invoice. It contains 88 unique
per-invoice service packages and 93 unique per-invoice lines (46 labor, 47
material); all regular packages have `IsInvoicing: true`. This does not establish
complete declined-work coverage. Subsequent inspection found three explicitly
deferred packages in two invoices, documented in the follow-through section below.

For every invoice, labor-line Total less Discount equals ExtendedTotal and the
sum of ExtendedTotal equals Summary.LaborTotal. Aggregate source labor is
$2,868.46 gross, $10.00 discount, $2,858.46 net; labor-line Quantity sums to
26.94. This is internal source reconciliation, not native-report or payroll
reconciliation.

The fresh bounded read-only database comparison remains 9 absent, 12
nonterminal, and 1 correctly included. No recovery writes have occurred.

The source validation exposed a required mapping correction: actual invoice
header totals are nested in Summary. The local adapter now reads those values
before legacy top-level alternatives, preserving explicit zeros and signed
values without subtracting discounts twice. Synthetic mapping tests, existing
labor-hours tests, the uploaded-source validator, and TypeScript pass. This
mapping correction is not yet deployed. The guarded recovery writer and its
related-entity/concurrent-update protections remain unfinished; do not run the
general ingestion service blindly against these records.

The deeper read-only conflict check matched all 12 existing records to their
source Protractor GUIDs, with no conflicting WO/invoice identities; all 12 have
customer and vehicle foreign keys. For the 9 missing invoices, bounded exact
lookups found no vehicle match by source VIN for 6, and no customer match by
provider contact GUID or the existing importer's invoice-GUID identity for 9.
These are unresolved links, not proof that the people are absent under other
identities. Do not create duplicate customers merely because this exact lookup
misses. Resolving/creating related records would extend the explicit
invoice-and-service-detail write scope; existing customer/vehicle records must
not be blindly refreshed from historical snapshots.

### Approved recovery results, 2026-10-05

The operator extended approval to resolving required related records and creating
only confirmed missing customer/vehicle references within the same 21-invoice
scope. Existing personal/vehicle details remain protected.

The bounded recovery committed **14 invoices: 8 imports and 6 refreshes**, with
55 service jobs and 51 line items in canonical Postgres. It created 8 customer
references and 6 vehicles. A rollback rehearsal exercised the write path first;
the subsequent native identity check confirmed that rehearsal persisted nothing.
The actual transaction checked hashes proving that the excluded invoice and all
pre-existing related customer/vehicle rows were unchanged.

Read-only post-commit verification confirmed all 14 statuses, September 1
business dates, child counts, source-matched header amounts and unique customer
identity links. Those 14 invoices total **$1,821.21 net labor** and **$7,142.79
invoice sales**. This remains source-internal reconciliation, not a claim that
all native report totals reconcile. A repeat read-only plan recognized all 14
as already applied. No upstream writes, worker activation, index builds,
migrations, other-shop/date repairs or Mongo history/cache rewrites occurred.

The 22-row native sample is now **15 included, 6 nonterminal and 1 absent**.
Seven were deliberately held:

| Work order | Reason |
|---|---|
| 701008322 | Stored service detail is not represented in the captured source |
| 701008296 | Vehicle identifier is only 6 characters; identity needs validation |
| 701008265 | Conflicting vehicle association |
| 701008325 | Conflicting vehicle association |
| 701008327 | Vehicle identifier is only 7 characters; identity needs validation |
| 701008306 | Conflicting vehicle association |
| 701008340 | Vehicle identifier is only 2 characters; identity needs validation |

Short identifiers are not proof of an invalid invoice. These holds concern safe
vehicle association; they must not become a general reporting rule excluding
vehicle-less ROs or unknown VINs. Resolve source identities and the unmatched
service detail before further writes; do not force-close or discard lines.

`jwt-701-september-1-recovery-results.csv` is the execution audit, superseding the
earlier proposal for current status. The full source file stays out of Git.
New customer references include both native contact identities and compatible
invoice identities, with personal fields unchanged during identity finalization.
Their final JSON structure and unique invoice links were verified.

Only the verified invoice Summary and nested Contact mapping corrections and
their regression tests were pushed for deployment. The broader unfinished labor
reporting work was not published with that narrow release. Deployment confirmation
was received on 2026-10-05: the narrow mapping release is live. The pilot remains incomplete: the held records, broader historical
coverage and native financial reconciliation still need resolution.

### Follow-through investigation and recovery, 2026-10-05 (intermediate state)

Further bounded inspection distinguished missing VINs from different VINs. The
previously linked vehicles on the three association holds all had empty VINs.
Matching historical source ServiceItem IDs and vehicle details established safe
continuity for three additional recoveries: 701008296, 701008265 and 701008325.
For 701008325, the invoice was linked to the existing exact-VIN vehicle; neither
vehicle record was merged or modified. Rollback rehearsal and post-commit
verification passed.

The canonical extractor also revealed deferred packages in the supplied full
source. The first repair pass had considered only ServicePackages. The two
deferred packages and five lines for already-recovered 701008342 were appended,
with the invoice header hash unchanged. Future recovery now uses the canonical
regular/deferred extractor and reserves new child identities before upsert.

Current result: **17 approved invoices recovered**, plus the excluded correct
invoice, giving **18 of 22 included; 3 nonterminal and 1 absent**. The 17 recovered
invoices have 72 service jobs and 79 lines, including deferred work, and match
source header totals of **$2,228.67 net labor and $8,639.41 invoice totals**.
Existing customer/vehicle records and the excluded invoice remain unchanged.

Four specific exceptions remain:
- 701008306: stored link is a VIN-less 2012 Chevy Silverado; the source invoice
  identifies a 2008 Chevrolet Silverado 1500 with a full VIN. No historical
  source vehicle identity was available to establish continuity.
- 701008340: source is a 2025 side-by-side without a valid VIN. Its short lookup
  value collides with an unrelated 2002 Chevy vehicle; do not reuse that record.
- 701008322: the deferred sway-bar package IS in the source deferred collection
  and must stay. The old completed $29.95 Brake System Evaluation is absent from
  the entire captured invoice.
- 701008327: vehicle continuity is established, but the old zero-dollar Digital
  Vehicle Inspection ID is absent from the entire source; a new DVI identity is
  present. Do not merge them merely because their titles match.

These are now specific association/obsolete-record decisions, not generic VIN
or source-access blockers. No archive or deletion has been performed.

### Final approved September 1 recovery, 2026-10-05

The operator approved source-based vehicle resolution and preservation-by-archive
of the two obsolete packages. The guarded transaction was rehearsed with a forced
rollback before committing all four remaining invoices:

- 701008306 links to a newly created source-VIN 2008 Silverado reference.
  The previously linked 2012 vehicle remains unchanged.
- 701008340 is imported without a verified vehicle link or fabricated VIN.
  The unrelated short-lookup vehicle remains unchanged.
- 701008322 retains the deferred sway-bar package. The old $29.95 Brake System
  Evaluation and its line are soft-archived.
- 701008327 uses the source DVI identity; the old zero-dollar DVI is soft-archived.

Only the archive marker changed on the obsolete job/line rows: all other columns,
including original amounts and historical source data, were hash-verified
unchanged. Active reporting queries exclude soft-archived jobs.

Final read-only verification passed for **21 recovered invoices**, **91 active
service packages**, and **100 active lines**, including all three deferred
packages. Header amounts match the capture: **$2,858.46 labor and $10,114.27
invoice totals**. Customer identities resolve uniquely. Existing customer and
vehicle records and the excluded correct invoice remain unchanged.
All **22 native identities are now included on September 1**; none are absent or
nonterminal. A repeat read-only recovery plan returns 21 already-applied outcomes.
The final manifest and refreshed CSV are the current audit, superseding earlier
intermediate counts above. No holds remain in this approved cohort.

The raw labor reporting query was also checked read-only for that day with an
eight-second database deadline. It returns 22 closed ROs, but currently supports
only 2 ROs / 4 sold hours, 2 ROs / 7.6 presented hours, and no net-covered ROs.
These are coverage-limited engine values, not the day's actual labor totals.
The source-evidence helper currently requires both regular and deferred
collections before returning any measures; only two captured invoices contain
the deferred collection. Sold evidence should be independently evaluated for
verified invoicing packages without pretending omitted deferred work is zero.
Missing header/package discount allocation must still be disclosed; matching
captured Summary.LaborTotal alone is not native-report certification.

In this capture, Summary.NetTotal equals parts plus labor plus sublet; other
charges are added separately with tax to reach GrandTotal. Do not include other
charges twice when checking invoice arithmetic.

The broader pilot remains incomplete: further September recovery is outside
the approved day, source coverage/calculation rules still need refinement, and
full-enterprise execution remains unverified. Enterprise performance remains
deferred until the history discrepancy is addressed, per the operator's direction.

### September bulk recovery authorization and implementation

The operator subsequently approved one automated recovery scope for the
remaining location 701 September candidates, rather than daily approvals.
The fixed manifest contains 235 remaining identities; September 1 and other
locations/months are excluded. The invoice-number-only ambiguity starts held.

The existing operator page now has Run/Resume and Pause controls. A single
user-initiated session collects bounded relay pages, then processes one invoice
transaction per authenticated request. Progress, source evidence and a renewable
cross-instance lease are stored durably in private operator collections.
Closing the tab stops further requests; reopening and resuming uses saved state.
This is browser-driven authenticated execution, not an unattended background
worker or a bypass of callback/trial/stop policies.

Safe records commit automatically. Changed identities, absent source records,
unrepresented service details and ambiguous associations are held without
blocking other candidates. Unexpected database/provider failures pause the job.
No automatic archives, merges or existing customer/vehicle updates are allowed
under the monthly path. Valid invoices without a usable VIN may retain a null
vehicle link. Each committed invoice verifies source amounts, business date,
active child counts and preservation hashes inside its transaction.

Successful source payloads are removed from the private staging collection once
their durable outcome is recorded; canonical invoice raw payloads remain.
Held source evidence is retained privately for investigation. Public progress
contains operational outcomes only, never customer or vehicle payloads.
Completion means every candidate received an outcome, not that every candidate
was repaired or native labor financial totals were reconciled.

Production release verified live on 2026-10-05. The unauthenticated API returns
401 and the operator page redirects to login. Release-tree typechecking and
recovery engine, route, lease/checkpoint and client-session tests passed.
The signed-in panel was not visually verified; its session behavior was tested
with mocked requests. No monthly recovery was launched by the agent: starting
requires the operator's authenticated Run September recovery action.
The full reporting pilot remains open pending recovery outcomes and reconciliation.

### First bulk-run blocker and correction, 2026-10-05

The first production attempt paused at collection offset zero, before any invoice
repair. The matching production transport event reported
`upstream_response_too_large` for shop 227. A month-wide invoice request was not
made safe by the supplied pagination parameters.

Collection now advances automatically through September 2–30 in single-day date
windows, persists the next day, and does not treat an empty day as completion.
Candidate date matching excludes adjacent-day records from source staging.
The existing relay limit, whole-run record limit, authenticated transport,
collect-before-repair ordering and per-invoice protections remain intact.
The observed offset-zero checkpoint can resume without clearing state.
Unknown nonzero legacy collection checkpoints stop for review rather than
silently being reinterpreted.

Size-limit failures now have a specific operator-facing message. Typechecking
and the recovery smoke suite passed, including date boundaries, empty days,
day checkpoints, lease behavior and retained errors. Actual recovery remains
unverified until an authenticated resumed run retrieves and processes its source.

The daily-window correction was verified live in production on 2026-10-05;
the unauthenticated recovery endpoint still rejects access with HTTP 401.
The operator must refresh the page and resume the paused job to continue.

The operator's subsequent attempt at approximately 18:39 UTC remained at
collection offset zero. A bounded read-only check found the provider-wide
oversized-response cooldown from 18:14:51.960 UTC still active until
18:44:51.960 UTC (13:44:51.960 Central). The revised daily request had not
reached the provider. No protection was reset, no invoice repair had run, and
the appropriate next action is an authenticated resume after the cooldown.

A subsequent read-only check at 18:52 UTC found collection had advanced through
September 2–4: 65 source rows scanned, next day September 5, repair cursor zero.
No invoice repairs had begun. The provider cooldown was no longer active.
Production logs showed priority fleet-pacer admission rejection at 18:49:13 UTC;
this is a pre-dispatch queue rejection, not an oversized response or proof of
invalid source data.

The correction retries only the exact pre-dispatch pacer-deadline result, up to
six admission attempts with 1/2/4/8/16-second waits. Every attempt still uses the
real interactive context and normal shared transport controls. HTTP errors,
timeouts, circuit breaks, policy denials and thrown errors are not retried.
Exhausted queue contention gets a specific saved error. Release-tree typecheck
and the complete invoice-preview/recovery test suite passed. The narrow
correction has been pushed for production deployment; live verification and
authenticated recovery remain pending. The signed-in UI was not visually
verified; the preview browser was redirected to the dashboard.

Production deployment of the queue-admission retry correction was subsequently
verified live on 2026-10-05. The deployed merge retained all four correction
files unchanged; the unauthenticated recovery endpoint returned HTTP 401.
At 19:18:44 UTC, a fresh bounded read confirmed no active provider cooldown or
probe lease, 65 source rows scanned, next collection day September 5, repair
cursor zero, and the job still paused. An authenticated operator resume is
required; no recovery writes were initiated during deployment verification.

After the operator resumed, a bounded read at 19:27:42 UTC found 492 source
rows scanned, next collection day September 28, repair cursor zero, and a
paused job. September 2–27 collection checkpoints had completed. The provider
cooldown and probe lease were absent. At 19:26:17 UTC, the production client
logged an invoice `upstream_error` for shop 227 on a priority request. Earlier
queue rejections were followed by successful daily reads, consistent with the
deployed queue retry correction working. The final error was a relay upstream
read failure; its underlying cause is not established by the available log.
No timeout/response limit or safety control was changed. Resume retries the
September 28 collection step; September 29–30 and all invoice repairs remain
pending. Do not describe collected rows as repaired or reconciled invoices.

### September batch completion, 2026-10-05

The operator reported completion. The durable job is complete, with 580 source
rows scanned and exactly one outcome for each of the 235 approved candidates:
217 applied and 18 held. Source-row counts are not distinct repaired-invoice
counts and do not establish native population reconciliation.

`jwt-701-september-recovery-results.json` records the final outcomes and a
bounded, read-only verification. Every applied record uniquely matches its
approved WO, has an active terminal status, matches its expected UTC business
date, retains its recovery digest, and has customer/vehicle link presence or
an explicitly documented unknown vehicle. Fifty-six applied records have
documented unknown vehicle identity and remain unlinked to a vehicle; this is
not permission to invent or merge vehicle identities.

| Remaining hold | Count |
|---|---:|
| Customer name candidate needs identity resolution | 9 |
| Unusable vehicle identity | 2 |
| Ambiguous vehicle | 2 |
| Existing service detail absent from the fresh source | 2 |
| Final source identity/date/structure/financial validation | 2 |
| Ambiguous stored invoice identity | 1 |

Verification did not repeat repairs, merge identities, delete history, or
claim native financial/child-detail reconciliation. Held source evidence
remains private for investigation. The broader pilot remains incomplete:
exception resolution, financial/coverage reconciliation and the previously
documented enterprise execution limitations are still outstanding.

### Read-only post-recovery reconciliation, 2026-10-05

`jwt-701-september-reconciliation.json` compares all 602 native invoice/credit
identities against canonical data, with exact identity batches and read-only
five-second SQL deadlines. It also records a private-source investigation of
all 18 held cases without exporting customer contact or vehicle identifiers.

| September 701 measure | Result |
|---|---:|
| Native ordinary invoices | 598 |
| Included ordinary invoices, exact date/status | 580 |
| Held ordinary invoices | 18 |
| Native ordinary-invoice labor | $53,158.75 |
| Stored labor for the 580 included invoices | $24,146.72 |
| Older included invoices with incorrect zero labor | 216 |
| Verified source/native labor on those 216 | $28,160.12 |
| Native labor on the 18 held invoices | $851.91 |
| Native credits, not included in the tested population | 4 / −$539.98 |

All 238 recovered invoice headers (21 earlier plus 217 in the batch) match
native labor amounts. All 216 mismatches are older included records with
stored zero labor, and all 216 have identity/date-matched canonical source
snapshots whose Summary.LaborTotal agrees with the native export. Their
correction would be a **new, separately authorized write scope**; none was
performed. Native Labor Total is still not a certified net/discount allocation.

The current source-evidence metric implementation supports sold hours for
125 of the 580 included invoices: 103.61 hours, exactly matching the native
hours on those same invoices. The other 455 are rejected by its requirement
for a deferred collection: 320 sources have null and 135 omit the field.
Regular invoice packages are present. This is an availability-contract issue,
not evidence of zero sold hours. It must be investigated separately from the
existing hours backfill; that backfill does not repair header sales or the
all-or-nothing deferred-collection gate. Certified net coverage remains zero.

Held-case findings:
- Nine customer holds share one native contact identity and three active
  same-name candidates. Neither provenance nor the checked stored source
  contact field establishes a match. No candidate was chosen or merged.
- Four vehicle holds all lack a full source VIN. Two existing invoices have
  no matching candidate vehicle; two have ambiguous existing associations.
  No link was cleared, invented or changed.
- RO 701008206 has an unmatched $0 DVI-audit reminder line. Its instruction-like
  description is source data, not authorization to delete it.
- RO 701008469 has an unmatched completed Axle Shaft Seal job and two $72.49
  part lines. They were not assumed duplicates or archived.
- ROs 701008339 and 701009048 have native/header labor of $0, but labor lines
  respectively carry Total $562.50 and $353.69, Discount $0 and ExtendedTotal
  $0. The latter explicitly mentions warranty. The strict Total − Discount =
  ExtendedTotal check rejects these; this is not missing invoice identity.
  No discount was invented and no validation rule was bypassed.
- RO 701008434 lacks staged source because it was deliberately held up front.
  Its invoice-number lookup instead finds draft WO 701006724. Number equality
  does not establish that these are the same invoice.

Reproduce the assessment using the native CSV with
`scripts/extract-jwt-september-native.py`, then run
`scripts/investigate-jwt-september-results.ts` and
`scripts/check-jwt-september-source-evidence.ts` with the existing server-only
test stub. These are read-only production queries; no provider requests,
repairs, payroll work, index changes or migrations are executed.

### Separately approved header correction, 2026-10-05 21:37 UTC

The operator explicitly approved correction of the 216 older invoice labor
totals after the read-only assessment. The fixed manifest was fingerprinted,
canonical JWT membership and every source identity/date/amount were rechecked,
and an atomic rollback rehearsal restored all rows exactly before application.

The source snapshots are closed WorkOrder records at WorkflowStage Invoice;
all have InvoiceNumber 0. Identity therefore requires the exact work-order
number, matching provider GUID, native UTC date and native labor amount, not
that unavailable invoice-number field. A conflicting nonzero invoice number
still fails validation. The 33 negative native ordinary-invoice labor amounts
were preserved, not clamped to zero or treated as separate credit invoices.

Application changed only labor_total, the existing object-shaped raw_data's
normalized laborTotal mirror, and updated_at. Full protected-row hashes
confirmed all other fields, including source payloads, customer/vehicle links,
status, other money fields and provenance, remained unchanged. No jobs or
lines were updated or removed. The approved 216 changes committed atomically.

Independent post-commit reads verified **all 580 included ordinary invoices**
against the native export: **$52,306.84**, zero header-labor mismatches. The
correction was **+$28,160.12**. The 18 held invoices ($851.91 native labor) and
four credits (−$539.98 native labor) were not changed. Hours availability and
net-discount verification remain separate blockers; this is not a completed
full-pilot reconciliation.

Audit files: `jwt-701-labor-header-correction-plan.json`,
`jwt-701-labor-header-correction-rehearsal.json`,
`jwt-701-labor-header-correction-applied.json`, and
`jwt-701-labor-header-correction-verification.json`. The earlier September
reconciliation JSON remains the immutable pre-correction approval baseline.
The correction tool defaults to read-only and refuses a changed manifest,
missing/mismatched rehearsal, changed rows or conflicting source evidence.

### Independent sold-hours availability validation, 2026-10-05

The updated reader no longer requires a declined-work collection to establish
sold hours from explicitly invoicing regular packages. Unknown regular
collections or hours still fail closed; known deferred twins remain deduplicated
and excluded from sold hours. Presented hours and net remain unavailable when
deferred evidence is incomplete. Non-invoicing drafts are excluded.

Bounded read-only validation of all 580 included September invoices at location
701 found 580 supported sold-hour records totaling **566.44 hours**, matching
the native export both overall and invoice by invoice (zero mismatches).
The native 598 ordinary invoices total 583.55 hours; the remaining **17.11
hours belong to the 18 held invoices**, not fabricated zeroes in the report.
No production data was changed in this validation. Net coverage remains zero.

`jwt-701-september-sold-hours-check.json` records the source evidence. Its
old-header-mismatch fields describe the immutable pre-correction baseline, not
the current corrected headers; use the separate post-correction verification
for current header reconciliation.

New report executions use execution version 3 to avoid reusing old calculated
results. Existing pinned results remain unchanged. Local calculation and
compatibility tests do not themselves deploy the code or verify signed-in UI.

### Reporting-only production release, 2026-10-05 22:16 UTC

Production lacked the labor-reporting foundation as well as the independent
sold-hours fix. A 14-file reporting-only release was therefore built on the
fetched production branch, preserving unrelated production changes rather
than pushing the divergent workspace tree. No recovery scripts, repair
operations, schema migrations or unrelated integration changes were shipped.

Render reports release commit
`8d190f07b70c4f15affa1faba19f8e13041e41b8` live on `mos-tools`, deployment
`dep-db21sc3l550s73buijh0`. Reporting-specific tests and typechecking passed in
the exact release tree. The local broader prebuild hit its five-minute command
limit without a reported failure; Render subsequently completed its build and
activated the release.

Post-release HTTP checks against the service URL returned 200 for `/` and
`/api/extension/version`, and 401 for unauthenticated `/api/reports/kpis`.
The health endpoint also requires authentication, so these are not assertions
of database health or verification of the signed-in reporting UI.

New report executions use the new calculations. Existing pinned results remain
historical snapshots and must not be rewritten. The 18 held ordinary invoices,
four credit invoices, discount certification and broader pilot coverage remain
outstanding; deploying this release does not mark the full pilot complete.

An administrator can reach the action through the Protractor Trial sidebar entry →
JWT invoice recovery preview. The action stays blocked if the current trial
does not permit authenticated interactive requests.

Reproduce the candidate file with:
`python scripts/preview-jwt-labor-recovery.py <native-csv> <identity-diff-json> <output-csv>`.
The input identity diff is produced by the bounded comparison script; its
local default output is `/tmp/jwt-701-identity-diff.json`.
Offline regression tests cover scope exclusion, signed discount packages,
credit exclusion, missing identities, no customer-field export, and the
unverified/no-write status.

1. Align native invoice identities/statuses/business dates with stored ROs to
   explain the observed population discrepancy. Trace ordinary negative
   discount packages and credit invoices into cached API evidence to establish
   allocation without double subtraction. Obtain separate disposition evidence
   for declined/presented work, which the supplied sales export does not contain.
2. Extend validation of the canonical cache read path beyond the September
   location sample. Recovery is limited to 8 seconds, sequential scoped batches,
   and matching invoice business dates; incomplete recovery remains partial.
3. Assess and authorize the existing historical labor-hours repair (task 995),
   not a duplicate backfill. Its script only fills all-null job hour columns
   from positive child labor sums; it cannot repair missing declines, missing
   line hours, zero-hour provenance or discount allocation. Do not execute it
   merely to make report coverage green.
4. Resolve the full JWT enterprise/year timeout before release, likely with
   bounded durable partitioned execution or an operator-reviewed indexing plan.
   Verify complete results within the reporting contract, not a shortened range
   disguised as success. The preview rendered the reporting shell, but no
   signed-in interactive report run was verified.

## Final deferred phase: ADP Workforce Now

No ADP connection or ingestion was attempted. Define loaded cost components
(wages, overtime, employer taxes, benefits, leave and other burden), effective
historical periods, stable employee matching across locations, and allocation
of paid time/cost to ROs including nonproductive/shared time. Current rates and
generic Protractor TotalCost cannot substitute for these decisions.
