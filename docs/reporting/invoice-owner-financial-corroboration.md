# Nine-owner accounting corroboration plan

## Approval status and current decision

**DRAFT — operator approval pending. All nine owners remain HOLD.**
No authoritative financial amounts have been established. This plan requests
accounting evidence, not permission to prefer a newer retained copy. No provider
access, database capture, production write, ingestion replay, or application
startup is authorized by this document.

Plan approval permits review of operator-supplied accounting records offline.
It does **not** authorize retrieving those records from the provider. Provider
access and production writes each require a separate, explicit approval.

## Immutable evidence binding

This plan is bound to the following exact checked-in inputs (SHA-256):

| File in `docs/reporting/` | SHA-256 |
| --- | --- |
| invoice-owner-financial-resolution.md | `09132cacd395097cb5c22b14e54c783304f522b5e1b25dce6452a5bcb340eca9` |
| invoice-owner-financial-eligibility.md | `cb500b07c7565e8fa0dd84ade9a9406769c6c967945c5d540ac37f363e90f136` |
| invoice-owner-financial-resolution.json | `14fc90e889e6d40ddae5e0310c8ac44abde3bfd815e33721dbd6ab6e14d28f6e` |

The JSON capture input digest is
`51f8b9f20895ed986e49d08d335f16ec67f18fe857fa9a329c7fb3dcd3a514f4`.
PostgreSQL snapshot: `390661481:390661481:`, captured
2026-10-19 03:22:08.47628 UTC; Mongo cutoff:
2026-10-19T03:21:59.102Z. These are not one cross-store atomic snapshot.

For each full owner hash below, its evidence comprises the exact matching
`owners` entry and **all** matching `children` entries in that pinned JSON,
including full child IDs, parent hash, stored values, field classifications,
native fields, every proof digest and every retained copy occurrence. No
deduplication, replacement, or stripping of vetoes is permitted. Prefixes are
display labels only; hashes are not executable provider IDs. If any input hash
changes, stop and obtain a new evidence-bound review rather than carrying
approval forward.

## Accounting packet required for every owner

An authorized shop accounting reviewer supplies:

1. A secure identity crosswalk tying the full owner/parent/child hashes to the
   shop, provider work order, invoice number, revision and line/package IDs.
   Keep raw customer and vehicle identifiers out of Git. Ambiguous mapping
   means HOLD; do not search broadly or infer identity from matching amounts.
2. The issued invoice and relevant earlier revisions, posting/journal evidence,
   and any linked credit, void, refund, reopening or reissue records. Include
   event IDs, effective accounting dates, posting dates, timezone and status.
   Capture/export timestamps do not establish accounting chronology.
3. A field-level explanation of each transition: old and new values, quantity,
   unit and extended amounts, currency, rounding policy, event/reason, and
   whether the change preceded posting or belongs to a later accounting event.
   Cost conflicts also require inventory valuation/COGS entries, linked vendor
   invoice or cost-adjustment records, and the cost basis effective at posting.
   A current vendor price or invoice PDF alone does not prove historical cost.
4. For each document: a protected stable reference, content SHA-256, source,
   revision, custodian, retrieval time and relation to the retained proof
   digests. Retain originals securely; commit only sanitized evidence.
5. Accounting reviewer sign-off on the event represented by the requested
   reporting amount. Separate original sale from later corrections; if both
   are legitimate events, do not collapse them into a single overwritten value.

No proposed causal explanation below is a finding. Small differences, zeros,
agreement with storage, majority copies and newest timestamps are not authority.
Payments may corroborate an event but are never balancing targets for jobs or
lines. Preserve missing versus zero, native total versus extended total, and
zero quantity versus default-one derived hours.

## Evidence-bound owner decisions and targeted requests

All decisions below are **HOLD / authoritative amounts unset / repair denied**.
The requested evidence must explain every conflicted field in the pinned
children, not only the illustrative amounts in this table.

| Shop / owner prefix | Conflicted children | Accounting question and specific evidence needed | Independent gates retained |
| --- | ---: | --- | --- |
| 227 / bb6dc7cdf30b | 2 | Explain material price/extended total 34.29 versus 0.01 and the dependent package rollup. Supply issued-line revisions and posting or credit evidence distinguishing a pre-posting price edit, nominal charge, or later correction. | D, C, N, S, A |
| 227 / 500d59b47754 | 5 | Explain each of four material prices 0 versus 0.01 and rollup 0 versus 0.04. Supply line-level price-change authorization and invoice/journal evidence; do not dismiss four cents as rounding. | D, C, N, S, A |
| 227 / 3df04f89c259 | 3 | Explain package 354.98 versus 0, material extended totals 192.00/37.98 versus 0 and unit costs 48.00/18.99 versus 0. Supply void/reissue or edit trail, inventory/COGS evidence and complete labor membership. Resolve billed-hour 1.00 versus missing without inventing zero. | D, C, H, N, S, A |
| 227 / b72ea7beba2b | 7 | Explain package rollups 519.96, 378.84, 144.99 versus 0 and all four material price/cost conflicts. Supply revision-level package membership, posting/void/credit history and cost records. Explain omitted labor, including the native zero-quantity line; missing labor is not proof of deletion or zero hours. | D, C, H, N, S, A |
| 229 / e6b4347cecc5 | 2 | Explain extended total 373.10 versus 0 and TotalCost 207.07 versus 0 across all three retained combinations. Supply separate sales and COGS event chains; do not pick a price from one copy and cost from another without event-level evidence. | D, C, N, S, A |
| 229 / 802b3a9c7413 | 1 | Explain quantity 4.6 with TotalCost 9.71 versus 13.21 (projected unit cost 2.11 versus 2.87). Supply inventory valuation and dated cost adjustments tied to the sold line; identify whether an adjustment changes the original event or is a later event. | D, N, C, S, A |
| 229 / a4669b01d5fb | 1 | Explain quantity 6.2 with TotalCost 13.08 versus 19.10 (projected unit cost 2.11 versus 3.08). Require the same posting-time cost basis and adjustment chain, not merely current cost. | D, C, S, A |
| 230 / ee84324aca81 | 1 | First establish an issued invoice or documented non-invoiced status. Explain quantity 10 with TotalCost 49.95 versus 49.50 (projected unit cost 5.00 versus 4.95) using native precision/rounding and COGS records; do not assume rounding explains it. | I, N, C, S, A |
| 230 / 556c652c1135 | 2 | First establish invoice identity/status. Explain TotalCost 10.65 versus 17.62 and 7.19 versus 6.74 separately, with each line's quantity and cost-adjustment history. One line's explanation cannot resolve the other. | I, N, C, S, A |

Full owner bindings, in the same order:

```text
bb6dc7cdf30b2cf0172df50f7fb97fd26d7b0f53948079f7f4aabe4cb9aac754
500d59b47754242fe247f1d0c36954b0190d31f8eea1154706e43054b8aa5793
3df04f89c2593dd00381708efb38ae131be192f4bd1b6e05653e6d24a2d39e53
b72ea7beba2b521668e03851f3f11b31f7e7485f7004a6b88c00db4c8ff0efba
e6b4347cecc5f437d15680b134f4ab18f53e4fbce6701d87d637f797a75c20a2
802b3a9c741334319dd5bcbdc322e429c9ffd870f9a9536a0ed2c9f637af3243
a4669b01d5fb7c49e932ddf40400821431d126efe5db9e9dddb0148e38c8866d
ee84324aca81d6ba3be1164058c9621221c194e50244b55c397ad60dbaa83fd9
556c652c1135d7a2f73d6b0c3a05f8946132d97ad3fd93a4bd690f97308e4b7f
```

These are 24 conflicted children: seven jobs and 17 lines. Seven owners have D
(date conflict); two have I (no positive invoice number). An accounting amount
decision does not clear either gate. For D, require documented invoice issue,
posting and revision chronology explaining sentinel versus real dates. For I,
require positive invoice identity or affirmative accounting evidence of
non-invoiced status; archive absence is not proof. The separate date-conflicted
owner `b6732de57586` is not in this financial scope and remains vetoed.
All other original vetoes, including connected-parent S and approval A, survive.

## Decision procedure after evidence arrives

Verify input digests and identity first. Compare the packet against every
retained occurrence; record whether each is a pre-posting state, original posted
event, later adjustment, or unexplained state. Do not infer chronology from the
order of retained arrays. Request clarification for missing transitions.

For each owner record:

- Full owner, parent and child hashes; baseline file/input digests; all relevant
  copy digests; new document hashes and protected references.
- Each field's competing values, native units and precision, identified event,
  effective date, accepted amount **or explicitly unset**, and rationale for
  every rejected or separately retained alternative.
- Separate financial, invoice-identity, date, membership/hour and parent-closure
  gate outcomes. Explain each remaining veto; never remove it implicitly.
- Accounting reviewer, explicit approval reference and time, evidence coverage
  and unresolved questions. Approval records must identify this plan's digest.

Possible financial outcomes are corroborated-original-event,
corroborated-separate-adjustment, documented-non-invoiced, or unresolved-HOLD.
Evidence can justify an amount without making the owner repair-eligible.
If documentation is unavailable or contradictory, close the review as
unresolved-HOLD with the missing evidence named; do not fabricate authority.

## Separate approval checkpoints

1. **Plan approval (pending):** operator accepts the nine-owner scope and
   offline review of supplied accounting packets. Record approval reference,
   timestamp and plan SHA-256. No live access is included.
2. **Provider access (not requested or granted):** only if supplied records are
   insufficient, present a separate bounded read-only proposal naming exact
   mapped owner IDs, provider/shop, endpoints, required revisions, request/page
   limits, timeout, retention and stop conditions. Never substitute a fleet
   search, ingestion replay or automatic retry/backfill. Stop on ambiguous
   identity, missing audit-history support, budget exhaustion or changed scope.
3. **Production write approval (not requested or granted):** any later repair
   needs its own evidence-bound proposed old/new values, complete connected
   parent closure, fresh cross-store consistency checks, preconditions,
   rollback and explicit execution approval. This plan is not an apply manifest
   and supplies no executable IDs or write commands.

No provider or production approval should be inferred from approval of an
accounting explanation. Until checkpoint 1 is explicitly accepted, this remains
a proposed plan, not an operator-approved plan or a completed authority finding.
