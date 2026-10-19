# Split-invoice financial evidence resolution

## Decision

**No owner is approved for a production repair or financial rewrite.** This
review explains the discrepancies rather than selecting a preferred retained
copy. It changes no adapter, source row, report policy, backfill or index.

The [per-owner eligibility table](invoice-owner-financial-eligibility.md) covers
all 36 owners and 329 children, including owners without financial conflicts.
The accompanying JSON preserves full hashed identities, field-level stored and
retained values, sanitized native financial fields for discrepancies, copy
digests and explicit vetoes. Hashes are review references, not executable IDs.

## Capture and bounds

The final PostgreSQL repeatable-read, read-only snapshot began at
**2026-10-19 03:22:08.47628 UTC**, snapshot `390661481:390661481:`.
The Mongo capture cutoff was **2026-10-19T03:21:59.102Z**.
The previous temporary evidence was absent, so the bounded identity trace and
closure were recreated. They reproduced 26 parents, 36 owners and 329 children.

The final capture read **179 digest-verified archive pages / 4,384 payloads**:
61/1,350 for shop 227; 59/1,444 for 229; 59/1,590 for 230. The archives are
the same two campaigns documented in `invoice-owner-local-validation.md`.
Counts differ from the earlier audit because retained capture continued during
this work; the financial result still reproduces **86 matches, 219 stored/source
mismatches and 24 copy conflicts**. Do not combine these snapshots' totals.

One source connection, five-second statements, existing indexed Mongo lookups,
101-match fail-closed limits, capped archive iteration, and child immutable-hash
checks remain in place. PostgreSQL is atomic within this capture; Mongo and
PostgreSQL are **not** one atomic snapshot. No provider requests or production
writes were made. No application server was started.

## What the 219 mismatches mean

These are **overlapping field counts**, not additive child counts:

| Explanation | Field differences within the 219 rows |
| --- | ---: |
| Null versus explicit zero: 145 discounts, 40 labor rates | 185 |
| Missing versus known nonzero: 24 labor rates, 4 discounts | 28 |
| Package rollup versus stored zero: 24 labor, 40 parts, 48 total | 112 |
| Billed hours absent in store, derived from retained labor lines | 59 |
| Stored zero cost versus native TotalCost / Quantity | 60 |
| Price derived using default quantity | 4 |
| Zero quantity defaulted to one labor hour | 5 |
| Native Total versus ExtendedTotal semantics | 4 |

The 149 mismatching line discounts consist of 145 explicit native zero
discounts and four nonzero discounts. A stored null is not equivalent to either.
The 60 cost differences are not rounding noise: retained material lines have
explicit positive extended costs and positive quantities; the current adapter
divides them while the stored unit cost is zero. That explains the projection,
but does not authorize replacing the stored value.

The package monetary values are derived from lines when package totals are
absent. They are **not independently corroborated package-level amounts**.
Similarly the 59 hour differences explain missing normalized hours, not proof
that every derived hour is invoice-eligible.

Five labor lines explicitly have zero quantity; current normalization defaults
quantity to one. Four price differences use that same default denominator.
Four extended-price differences involve native `Total = 0` but negative
`ExtendedTotal`, with discounts present. The retained fields establish the
disagreement, not the accounting semantics needed to choose a value. No default
one hour, invented zero, balancing amount, or inferred correction is proposed.

## The 24 retained-copy conflicts are substantive

All **17 line conflicts** have explicit native monetary disagreements. The
**seven job conflicts** reflect line rollups and, for four packages, thinner
retained membership with a missing labor line (one of those lines has explicit
zero quantity). Three packages also have billed-hour missingness conflicts. Those three missingness conflicts
must not be converted to zero billed hours.

Examples (hashed review references):

| Owner prefix | Native evidence, not a proposed correction |
| --- | --- |
| bb6dc7cdf30b | Material price/extended total 34.29 versus 0.01 |
| 500d59b47754 | Four material lines: explicit 0 versus 0.01 each; rollup 0 versus 0.04 |
| 3df04f89c259 | Rollup 354.98 versus 0; retained material ExtendedTotal and TotalCost change |
| b72ea7beba2b | Three job rollups 519.96, 378.84, 144.99 versus 0; thin copies omit labor |
| e6b4347cecc5 | ExtendedTotal 373.10 versus 0; TotalCost 207.07 versus 0, including a third combination |
| 802b3a9c7413 | Quantity 4.6; TotalCost 9.71 versus 13.21 |
| a4669b01d5fb | Quantity 6.2; TotalCost 13.08 versus 19.10 |
| ee84324aca81 | Quantity 10; TotalCost 49.95 versus 49.50 |
| 556c652c1135 | TotalCost 10.65 versus 17.62, and 7.19 versus 6.74 |

These conflicts affect nine owners. All nine also have either a date or invoice
identity veto. The eighth date-conflicted owner, `b6732de57586`, has no
retained child monetary conflict, but still cannot pass the date gate.
Neither timestamps nor agreement with the current stored row identify a winner.
No accounting event or chronology explaining these changes was established by
this bounded evidence.

## Eligibility and veto legend

- **D**: retained invoice date conflict (eight owners).
- **I**: no positive invoice number (two owners); absence in scanned archives
  does not establish that an invoice never existed.
- **C**: retained monetary disagreement.
- **N**: stored null versus retained explicit zero; missingness is preserved.
- **M**: stored missing versus retained known nonzero value.
- **R**: package rollup differs from stored value; no approved rewrite.
- **H**: missing/derived hours or retained hour missingness conflict.
- **K**: retained extended-cost derivation differs from stored unit cost.
- **Q**: zero-quantity/default-hour or derived-price semantics unresolved.
- **T**: native total/extended-total accounting semantics unresolved.
- **S**: another owner under the same original parent has a veto; an owner
  cannot be split from that shared parent independently.
- **A**: separate production approval and fresh cross-store consistency checks
  are required. Passing this evidence review would not authorize writes.

Twenty-six owners still pass the strict invoice identity/date/hour reconciliation,
but that is not a child-financial approval. Thirty-five owners have their own
financial or invoice-evidence veto. `b84fae860b76` has one matching child and no
own evidence veto; it is an evidence-pass candidate, held only for separate
approval and fresh consistency checks. It is not an authorization to perform a
standalone repair within the connected owner closure. Financial classification is kept separate from production approval.
No totals across payments, jobs and lines were forced to balance.

## Reproduction and checks

After recreating the bounded closure as documented in the earlier validation:

```sh
umask 077
node --import tsx scripts/capture-invoice-owner-financial-resolution.ts \
  /tmp/invoice-owner-financial-evidence-detailed.json
node --import tsx scripts/resolve-invoice-owner-financial-evidence.ts \
  /tmp/invoice-owner-financial-evidence-detailed.json
```

Capture refuses to overwrite its input evidence file; use a new path for a fresh
read. The resolver is offline and deterministic for a given capture, with no
fixture-generated values. The checked-in JSON is the sanitized review record,
not raw customer/vehicle data or an apply manifest.

Passed existing financial-audit, owner-repair-model and stored-evidence smoke
checks. The initial `npm run typecheck` was blocked by an unrelated TS2367 at
`tests/terminal-history-browser.test.ts:122`. The completion retry includes a
numeric widening at that asynchronous queue-length check, preserving runtime
behavior while removing stale assertion narrowing. No UI changed; a browser
screenshot is not applicable.
