---
name: Tire DOT reporting boundaries
description: Retained DOT occurrences, reconciliation population and production approval boundary.
---
Tire DOT reporting uses raw Tekmetric part evidence; repeated DOT values represent
separate recorded entries, not duplicates to remove. Reconciliation needs one row
per location/provider invoice, including missing-DOT exceptions.

**Why:** The verified source example contained two identical DOT strings for two
tires, and the user compares invoice numbers with a separate Tekmetric export.

**How to apply:** Never infer identifiers from inspections or normalize DOTs to
numbers. Never treat bounded samples or retained-store traversal as certified
upstream coverage. Production setup and activation require separate approval;
isolated report work must not modify either design prototype.

Verify the public development URL, not only localhost, when offering the report
fixture for user testing.

**Why:** The workspace's root development URL continued serving the retired
workflow artifact even when the report fixture was healthy on local port 5000.
A localhost screenshot incorrectly suggested that the user's preview was fixed.

**How to apply:** Use a separately exposed, browser-safe port for isolated
fixtures when artifact routing owns the root. Verify the exact public URL in a
browser before sharing it; do not alter design artifacts to resolve routing.

Reconcile enterprise Sales Details by location/invoice identity before using
stored close-date filters to claim missing invoices.

**Why:** HEART's exported dates are CDT, and stored snapshots can have missing or
different finalization dates despite exact agreement on all financial fields.
The export is an all-invoice population, not tire-sale coverage.

**How to apply:** Keep amount agreement separate from DOT-field availability and
posted-status completeness. Unresolved indexed associations are not proof that
an invoice is absent from every raw store. See the pre-release validation findings
for the observed gaps; do not present fixture success as real-data readiness.

Do not require a normalized association before searching raw Tekmetric invoices.

**Why:** A direct raw invoice-number search located 70 invoices the normalized
lookup had left unresolved, with exact agreement on all financial fields.

**How to apply:** Treat normalized IDs as an optional lookup accelerator, never
as the population boundary for DOT evidence or a prerequisite for raw discovery.

Do not mark an invoice unambiguously reconciled merely because one raw copy
matches the export when another retained copy disagrees.

**Why:** HEART's August export matched one copy of two invoices while alternate
raw copies had zero amounts. Selecting the convenient copy would hide conflicts.

**How to apply:** Preserve both copies as an exception, and keep linked negative
sales entries separate from ordinary tire invoices until their document type
is established.

Pilot invoice-list evidence may retain vehicleId without VIN or a nested vehicle.
Do not treat report-wide missing VINs as missing vehicles in Tekmetric.

**Why:** A read-only comparison found VINs in the operational work-order cache
for most sampled invoices whose pinned pilot payload omitted vehicle information.
The same operational cache omitted DOT fields even for invoices whose pilot
evidence contained DOTs, so it is not a wholesale replacement evidence source.

**How to apply:** Any VIN enrichment must verify same-shop, work-order and
vehicle identity, preserve provenance, and retain the pinned DOT evidence.
Empty captured DOT arrays still do not prove what the provider UI contains.

Shop-local reporting dates must pin each location's IANA timezone and preserve
legacy UTC executions. Changing the timezone label alone is not a correction.

**Why:** The user expects Central business dates, including CST/CDT transitions.
The existing October pilot was verified against UTC boundaries; those counts
cannot establish complete coverage of a shifted local calendar month.

**How to apply:** Resolve new zones from authorized shop settings, distinguish
local executions in cache identity and exports, and disclose unverified boundary
coverage until a separately approved collection verifies the local interval.

Distinguish absent DOT properties from explicit empty arrays and UI evidence.

**Why:** A confirmed HEART tire invoice displays four DOTs in Tekmetric while
its retained tire part omits the property entirely; an older retained invoice
still contains populated and empty arrays. Zero arrays found is not zero DOTs
recorded by the shop.

**How to apply:** Compare capture timestamps and source channels before asserting
capture loss. A newer UI/API value alone does not prove it existed at snapshot time.

Equal Tekmetric RO update timestamps do not certify equal DOT completeness.

**Why:** An approved detailed invoice read returned four DOT entries that were
absent from the retained payload, while both shared the same provider RO
`updatedDate`. The detail endpoint can expose these entries.

**How to apply:** Track evidence completeness separately from modification time.
Do not infer endpoint exclusion or “no recorded DOTs” from field-omitting cached
payloads; recovery and any preservation/clear policy require explicit review.

A slow standalone recovery loop does not reserve Tekmetric capacity.

**Why:** HEART recovery hit HTTP 429 despite sequential requests with a
1.1-second delay; normal traffic shares that provider budget.

**How to apply:** Stop on rate limits, preserve checkpoints, and coordinate
continuation with shared capacity or a reviewed quiet window. Never erase
uncertain-attempt markers to make a recovery appear resumable.

Shared-budget admission is not proof that Tekmetric will accept the request.

**Why:** The coordinated HEART continuation still received HTTP 429 after
additional successful reads. Active shared bucket traffic was verified, but
the cause of the remaining provider throttling was not established.

**How to apply:** Honor provider throttling even after a slot grant. Stop the
operator recovery instead of bypassing coordination or guessing a higher cap.

An off-hours scheduled worker must not repeatedly reschedule shared work that
an explicitly approved daytime worker is eligible to process.

**Why:** Read-only investigation on 2026-10-31 found both modes sharing the same
lease and next-eligible time. Normal daytime attempts can push that time forward
between manual pages. The bounded manual job exited successfully after its time
budget with incomplete progress; exact attribution of idle time was not logged.

**How to apply:** Check scheduled eligibility before claiming shared provider
work, while retaining atomic lease ownership, cooldowns and manual budgets.
Test normal/manual interleaving, and distinguish platform job start, command
start and first page progress when explaining elapsed time.

Real Tekmetric invoice-list responses can contain `authorized: null` jobs even
when posted dates, jobs, and parts arrays are present.

**Why:** Boolean-only fixtures hide the distinction between missing approval
evidence and an explicit decline in real provider payloads.

**How to apply:** Preserve null as unknown, never coerce it into approval or
decline. Keep candidate tire invoices visible as exceptions without counting
unknown-authorized parts as sold. Use sanitized source-shape fixtures; local
mock success alone is not proof of live provider compatibility.

DOT preservation carries omitted fields only on uniquely matched current
shop/RO/job/part identities with unchanged quantity; explicit arrays remain
authoritative and carried evidence must be labeled as unconfirmed.

**Why:** Whole-payload updates can omit DOTs, but unconditional merging would
also undo genuine clears or resurrect removed tire lines.

**How to apply:** Use the same policy for both canonical stores; do not activate
background enrichment or write isolated recovered evidence into production
without separate rollout approval.

Treat daytime two-pass failures as possible source changes, not automatically
worker defects. Retained webhook copies are corroboration, not a substitute for
the exact second-pass response.

**Why:** A read-only investigation found a newer provider modification timestamp
on the first unverified invoice after a partially verified page. The cached
webhook also omitted DOT fields that the list capture included, including on
other invoices whose verification had passed. That channel difference alone
cannot explain a list-to-list mismatch.

**How to apply:** Preserve bounded, sanitized mismatch evidence before proposing
changes to verification. Distinguish padded provider-list totals from invoices
inside the report date range, and do not certify an abandoned generation.
