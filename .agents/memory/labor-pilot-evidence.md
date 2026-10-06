---
name: Labor pilot source evidence boundaries
description: JWT labor reporting must distinguish stored closed ROs from validated hours, discounts and complete dispositions.
---

Clean Protractor telemetry does not authorize unattended backfill under the
callback/interactive-only live policy.

**Why:** The overnight preflight found healthy recorded traffic while the
persisted live contract still required suspended workers. Historical completed
cursors also predated the report months and did not prove later completeness.

**How to apply:** Add explicit scoped background authorization before scheduling;
never impersonate interactive traffic or reset broad cursors as a shortcut.
Confirm the canonical telemetry store and freshness before treating zero rows
as zero usage; Mongo index names can differ from the monitor's assumed names.

The user approved JWT-only overnight recovery, with existing fleet limits,
other workers stopped, checkpoints, protected holds and a hard morning stop.

**Why:** This permits a narrow scheduled recovery, not general backfill
reactivation or broader provider privileges.

**How to apply:** Keep other shops and jobs out of the new authorization. The
approval does not authorize identity merges, history deletion, clearing held
financial exceptions or impersonating interactive traffic.

Do not treat the persisted canary's “workers suspended” confirmation as proof
that Render workers are currently suspended.

**Why:** The ordinary evening power schedule resumed both workers while the
confirmation remained true. The JWT-only overnight approval requires keeping
those workers stopped.

**How to apply:** Check live Render service states, suspend the general workers
and disable their power scheduler for the approved isolated run. Verify the
scheduler setting in the deployed process, not just the saved environment.

Legacy JWT history can store a provider invoice GUID in the human RO-number
field. A native WO-number miss is not proof of a missing invoice.

**Why:** Read-only August sampling found this convention across JWT locations;
sampled rows retained the GUID as their primary Protractor invoice source ID
but had no raw invoice payload. A number-only recovery would risk duplicates.

**How to apply:** Resolve final source GUIDs against existing records before
creating anything. Hold conflicting GUID/number matches; preserve child links
and never resolve the conflict by merging or deleting history automatically.

Sold-hours coverage must be independent from complete declined-work coverage.

**Why:** Native comparisons verified sold hours on closed Protractor invoices
whose deferred collections were null or omitted, while regular invoicing
packages remained complete.

**How to apply:** Require explicit IsInvoicing evidence when declined-work
coverage is incomplete. Keep presented hours and uncertified net unavailable;
retain deferred-twin deduplication, missing-hour guards and signed-money rules.

JWT's labor pilot requires January 2026 onward where supported, with August onward the required baseline. ADP Workforce Now is explicitly the final deferred phase.

**Why:** The source assessment found closed ROs throughout 2026 while job-hour and declined-work ingestion were incomplete. Normalized zero discount defaults and source zero labor costs do not prove zero actual discounts or loaded costs.

**How to apply:** Keep unsupported labor measures unavailable and display covered-RO counts beside supported subtotals. Require native discount/refund and cost evidence before claiming reconciliation or GP. Historical hours recovery is operator-gated and does not fix disposition or discount gaps.

Do not equate a recovered invoice population with fully repaired reporting
fields, or missing deferred-work evidence with zero sold hours.

**Why:** Post-recovery native reconciliation found the recovered headers
matched, while older already-included invoices still had zero labor despite
correct canonical source totals. Null/absent deferred collections separately
blocked otherwise present regular-package evidence. Native warranty/no-charge
examples also had positive Total, zero Discount and zero ExtendedTotal.

**How to apply:** Compare old and recovered populations separately, keep
sold/presented availability distinct, and validate no-charge semantics without
inventing discounts. Correcting older included rows requires its own write
scope; it was not part of missing/stale-invoice recovery approval.

Closed Protractor WorkOrder snapshots may have WorkflowStage Invoice and a
real InvoiceTime but InvoiceNumber 0. Ordinary invoice labor totals may also
be negative.

**Why:** Native-export comparisons independently confirmed both shapes;
requiring a populated invoice-number field or positive labor excluded valid
corrections.

**How to apply:** A zero invoice number on a WorkOrder snapshot needs exact
native WO number, provider GUID, date and amount matches. Reject conflicting
nonzero numbers; do not extend this exception to Invoice payloads. Preserve
signed amounts and distinguish ordinary invoices from actual credit invoices.

Native service-package exports can represent discounts as negative Labor Total
on ordinary invoice packages, separately from Credit Invoice rows. Invoice Total
repeats across packages. Labor Cost can be zero or negative and is not evidence
of fully loaded cost.

**Why:** The supplied August–September 2026 JWT native export showed these
representations, which invalidate gross-only sums and naive payroll assumptions.

**How to apply:** Preserve signed labor contributions, never subtract discount
packages twice, and reconcile package and invoice identities before asserting
net-sales parity. A sales export alone does not prove declined-work coverage.

Authenticated JWT invoice-preview evidence showed records returned by the
Invoice endpoint with invoice numbers and invoice dates but `Type: WorkOrder`.
Match native identities independently of this object type; neither a matching
identity nor endpoint membership alone certifies terminal status.

**Why:** Requiring `Type: Invoice` hid useful identity matches in the successful
read. The screenshot demonstrates access, not financial or closure reconciliation.

**How to apply:** Keep identity comparison separate from closure validation;
do not repair normalized statuses based solely on this preview.

The user reports that Protractor shut off API access until the adapter was
rebuilt, and suspects this caused the JWT native-versus-stored population gap.
The interruption dates and causal link to specific missing invoices are not
yet verified.

**Why:** Restored access does not establish that history missed during an
interruption was recovered.

**How to apply:** Investigate missing invoice identities and their dates against
the access interruption before proposing scoped, operator-approved recovery.
Do not treat this hypothesis as proof that report filters and mappings are correct.

JWT live evidence uses `WorkflowStage: Invoice` (singular), with `Status` absent
and object `Type: WorkOrder`, for native-export-matched invoices.

**Why:** A terminal-stage allowlist containing only Closed/Invoiced/Paid
incorrectly held every record in the authenticated sample.

**How to apply:** Distinguish workflow stage from object type. Recognize the
verified Invoice stage for scoped recovery candidates; still require native
identity/date matching and full source validation before any repair.

A Protractor cache row can say `Invoiced` at the top level while its cached
raw payload still has the sentinel invoice date `0001-01-01T00:00:00`.

**Why:** The scoped recovery preflight found this mismatch in all cached stale
records. A terminal cache label did not establish a finalized invoice payload.

**How to apply:** Validate the raw source stage, invoice timestamp and service
details against fresh evidence. Never replay a pre-invoice payload or repair
only header status/date from a summary export.

Use a complete matching VIN as the primary physical-vehicle evidence; distinguish
an empty stored VIN from a genuinely different VIN. Short Lookup values are not
unique VINs and can collide across unrelated vehicles.

**Why:** Scoped recovery found blank-VIN duplicate references and a generic
lookup shared by a side-by-side and a truck. Requiring provider IDs to match
unnecessarily blocks real VIN matches, but treating short lookups as VINs joins
unrelated vehicles.

**How to apply:** Prefer exact full VINs; for blank VIN continuity require stable
source vehicle identity plus matching vehicle details. Preserve existing vehicle
records rather than blindly merging them.

A legitimate finalized invoice may have no usable VIN or verified vehicle link.
Do not exclude it from reporting or attach it to an unrelated vehicle solely
to satisfy a lookup.

**Why:** The operator approved retaining an unknown-VIN side-by-side invoice
without assigning the truck that shared its short lookup value.

**How to apply:** Keep vehicle identity unavailable while retaining confirmed
invoice identity, dates, customer linkage and financial evidence.
Post-recovery verification must distinguish documented unknown-vehicle cases
from accidentally missing links; requiring every invoice to have a vehicle
incorrectly rejects this approved reporting population.

Bulk recovery should require one scope authorization, not repeated daily or
per-invoice approvals. Safe records proceed automatically and conflicts are
reported as exceptions.

**Why:** The operator rejected a repeated preview/approve workflow for routine
recovery. Production's controlled read policy still requires genuine
authenticated, shop-bound interactive requests; an approved bulk scope does not
authorize fabricating callback or interactive contexts in background jobs.

**How to apply:** Preserve provider policy while automating bounded requests and
durable checkpoints. Keep explicit permission requirements for identity merges,
obsolete-history archives and scope expansion.

Use automatic bounded date windows for Protractor invoice-list recovery; do not
assume `take`/`skip` make a month-sized request small.

**Why:** A September-wide request with `take=25` failed with the relay's
`upstream_response_too_large` before the first recovery checkpoint. The prior
single-day source capture succeeded. Raising relay limits is not authorized.

**How to apply:** Collect daily windows automatically before repair, preserve
the collection day on resume, and show the specific source-size blocker if
even a daily response exceeds the existing cap.

Before asking an operator to retry a corrected request, check persisted provider
cooldowns; deployment does not clear them.

**Why:** After the oversized request was corrected, the operator's next attempt
still could not reach Protractor because the original provider-wide safety
cooldown was active. The generic source error obscured that distinction.

**How to apply:** Read the cooldown state without changing it, explain the
eligible retry time, and do not treat a locally blocked request as a failed
test of the new source-query shape.

Do not infer unchanged recovery progress or a repeated provider failure from
the generic source-error banner alone.

**Why:** After the initial cooldown, three daily collections succeeded before
fleet admission contention paused the runner with the same banner. The durable
checkpoint showed progress that the earlier screenshots did not establish.

**How to apply:** Read the saved day, scan count and repair cursor alongside
transport logs before recommending another retry or changing query shape.

Historical recovery must reconcile against both regular and deferred source
collections, while billed totals remain limited to invoiced work.

**Why:** Regular-only recovery omitted known deferred packages and incorrectly
treated an existing deferred repair as absent from source.

**How to apply:** Reuse the canonical deduplicating extractor; verify deferred
status and child counts separately from invoice header amounts.
