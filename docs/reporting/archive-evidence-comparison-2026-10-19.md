# Retained archive comparison for 96 held invoice identities

## Outcome

All **96** previously held identities had matching retained archive copies that
supplied usable invoice evidence. Combining them with the four already complete
cases makes **100 of 100 sampled identities** locally verifiable for the
September 18–October 17, 2026 period.

This verifies the supplied sample, not all JWT invoices, fleet-wide coverage,
complete historical identity closure, or authorization to repair production.

## Read scope and bounds

Compared the exact held identities from the earlier 100-case capture against:

- `protractor-weekend-2026-10-17`
- `invoice-evidence-recovery-2026-10-17`

Queries used the shop/campaign `_id` range plus exact selected invoice IDs.
Only matched identities were retained. Whole matched pages were read to verify
their stored SHA-256 digest; unrelated invoice payloads were discarded.

Limits remained five seconds per query, one Mongo connection, at most 50
matching pages per shop/campaign, 200 page reads overall, 100 invoices per page,
20 retained copies per identity and a three-minute deadline per invocation.
There were no provider calls, database writes or deployments.

The first invocation stopped at the 10 MB combined local-capture limit after
17 page reads. Its incomplete status was preserved. The continuation reused
fully completed shop scopes and processed remaining shops separately, keeping
each local preview input below 10 MB. It restarted only the incomplete shop
scope from the original stored-copy capture, avoiding ambiguous partial merges.

Totals: 74 distinct matched pages, 79 page reads including the five repeated
pages from the interrupted shop, 172 matched archived invoice occurrences,
and all 96 selected identities matched. Every processed page digest passed.
Both invocations used the same archive capture-time cutoff.

## Local verification

The final preview ran with source credentials removed and network access denied.
For each identity it compared retained current copies and archive occurrences
using the existing reconciliation rules. No date/identity/hour conflict was
discarded to force a passing result; no positive-number requirement was relaxed.

The 96 recovered cases and four previously complete cases were then passed to
the invoice reporting aggregator as a **local sample-only what-if**:

| Metric | Sample result |
|---|---:|
| Verified invoices in requested period | 100 |
| Unknown invoice population in this supplied sample | 0 |
| Invoices with complete sold-hour evidence | 100 |
| Invoices with complete presented-hour evidence | 100 |
| Invoices with presented hours greater than sold | 38 |
| Sold labor hours | 84.36 |
| Presented labor hours | 264.07 |
| Average sold hours per sampled invoice | 0.8436 |
| Average presented hours per sampled invoice | 2.6407 |

Do not display these as JWT enterprise totals or averages. Selection was a
convenience sample of ten rows per shop, guided by normalized close date. Actual
invoice dates were independently verified from source evidence before counting.

The sample's hashed identities do not overlap the retained 26-parent ownership
review. This is only a comparison to that specific saved review, not general
financial clearance or proof of no other conflicting peers.

## What this establishes

The current work-order snapshots' `InvoiceNumber: 0` did not establish that no
invoice existed. Retained final-invoice archive copies supplied the missing
evidence for all selected held identities. The stored archives are therefore a
useful recovery source before considering additional provider requests.

Reporting metadata remains unchanged in production. Raw-retention corrections
and query improvements alone will not populate these existing missing fields.

## Retained artifacts

Successful per-shop inputs, summary and offline validation:
`generated-artifacts/reporting-snapshots/archive96.wn5KHB/`

The earlier partial capture remains separately marked incomplete:
`generated-artifacts/reporting-snapshots/archive96.wGHDg0/`

These files contain private source payloads and are excluded from Git and
deployment. Do not publish them as downloadable report attachments.

## Recommended next step

Prepare an evidence-only repair plan for these 100 sampled identities:
bind each proposed metadata value to the captured source digests and original
target state; identify all target owners/aliases; preserve ownership, financial,
date and hour vetoes; require a fresh same-state check before any write.

The plan must not modify invoice financial rows, job/line/payment amounts,
native invoice numbers or native dates. Production execution and deployment
require separate approval. Fleet-query runtime permissions and target-version
preflight remain separate release gates.
