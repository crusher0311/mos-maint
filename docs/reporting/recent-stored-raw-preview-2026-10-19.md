# Recent-period stored invoice evidence preview

## Authorized scope and execution

Captured 100 identities: ten per JWT shop, MOS IDs 227–236. Selection used closed
normalized work orders with missing invoice-report metadata and `closed_date`
from September 18 through October 17, 2026. Close dates guided sampling only;
they were never accepted as verified invoice dates.

This was a bounded convenience sample, not a random sample or an exhaustive
identity closure. Selection did not replace duplicate/ambiguous identities.
Reads completed with existing five-second query limits, one connection per
database, per-case deadline checks, copy limits and a protected local capture.
PostgreSQL used a read-only repeatable-read transaction; Mongo observations were
sequential and not atomically synchronized with PostgreSQL.

No Protractor calls, production writes, deployment, repair or flag changes.

## Results

The credential-free, network-denied offline preview returned:

| MOS shop | Complete candidates | Held: no positive invoice number |
|---|---:|---:|
| 227 | 0 | 10 |
| 228 | 0 | 10 |
| 229 | 0 | 10 |
| 230 | 0 | 10 |
| 231 | 0 | 10 |
| 232 | 2 | 8 |
| 233 | 0 | 10 |
| 234 | 0 | 10 |
| 235 | 0 | 10 |
| 236 | 2 | 8 |
| **Total** | **4** | **96** |

All four complete candidates have verified invoice dates within the requested
period. None has presented hours greater than sold hours in the supplied copies.
They are source-evidence candidates only, not repair-authorized or a verified
fleet-wide denominator.

For every one of the 96 held identities, every captured raw copy:

- has `Type: WorkOrder`;
- has `WorkflowStage: Invoice`;
- has `InvoiceNumber: 0`;
- has an `InvoiceTime` string within the sampled period.

Their 253 captured copies contain top-level `InvoiceTime` and `InvoiceNumber`,
but no other top-level or Header field with “invoice” in its name. This does
not rule out other evidence in archives or other provider representations.
Neither stage nor timestamp establishes a positive native invoice number.

The raw copies therefore explain the immediate rejection: the positive-number
check is genuinely not satisfied by these stored snapshots. That is different
from a mapper ignoring a positive invoice number already present in them.

## Source retention

261 raw copies were captured:

- 65 PostgreSQL normalized payloads;
- 100 Mongo normalized payloads;
- 96 Mongo provider-cache payloads;
- zero PostgreSQL provider-cache payloads.

The four complete candidates account for four of the PostgreSQL copies.
Thus 61 held identities still have PostgreSQL raw payloads. Fixing raw retention
alone does not resolve the positive-number gap. The absence of PostgreSQL raw
payloads for the other 35 does not prove the historical cause of their absence.

No import archive pages were read. No claim is made that these current
normalized/cache copies include every retained historical version or alias peer.

## Interpretation and next step

The earlier sample found 16 recoverable candidates out of 20, but all were
outside the requested month. This recent-period sample has a materially
different evidence shape. Neither ratio should be projected across the fleet.

Do not weaken invoice verification, infer native invoice numbers from RO
numbers, or publish averages from just the four passing candidates.

The next useful source is already-stored final-invoice import archives for the
same held identities. A bounded exact-identity archive comparison could determine
whether those retained final copies supply the missing number and agree on
invoice date and hours. It must retain all ownership, chronology and financial
vetoes. No new provider import is justified by this preview alone.

## Retained evidence

Private inputs and completion status:
`generated-artifacts/reporting-snapshots/sample100.2EVyvd/`

The directory is excluded from Git/deployments. Files contain source data and
must not be attached publicly. The successful local preview explicitly returned
`repairAuthorized: false`, with four complete candidates and 96 held cases.
