# Stored raw invoice sample: read-only recovery preview

## Scope

User-approved capture of up to 20 invoice identities across JWT's ten shops.
Completed with exactly two identities per shop (MOS IDs 227–236), 40 retained
payload copies, no provider requests and no production writes.

Selection was a convenience sample: the first two closed normalized rows per
shop with missing/null invoice evidence. It was not random, not limited to the
requested reporting period, and is not representative evidence for a fleet-wide
recovery percentage.

The capture queried PostgreSQL normalized rows and provider cache, plus Mongo
normalized rows and provider cache. No import archive pages were read. The
PostgreSQL reads shared a read-only repeatable-read transaction; the Mongo reads
were sequential observations, not an atomic cross-store snapshot.

Reads used one connection/pool per database, five-second statement/query limits,
bounded copy counts, a three-minute capture deadline checked between shops,
and pauses between identities. No broad backfill or application startup ran.

## Results

| MOS shop | Complete evidence candidates | Held |
|---|---:|---:|
| 227 | 2 | 0 |
| 228 | 2 | 0 |
| 229 | 2 | 0 |
| 230 | 1 | 1 |
| 231 | 2 | 0 |
| 232 | 2 | 0 |
| 233 | 1 | 1 |
| 234 | 2 | 0 |
| 235 | 2 | 0 |
| 236 | 0 | 2 |
| **Total** | **16** | **4** |

The 16 complete candidates had agreeing usable raw copies in PostgreSQL and
Mongo normalized records, despite missing normalized invoice-report metadata.
They provide direct evidence that some reporting metadata can be reconstructed
from data already stored, without another provider import.

The four held identities had no retained PostgreSQL native payload in the
selected normalized row. They had Mongo normalized/cache copies, but those did
not establish a positive native invoice number. The preview correctly left
them held; closed status and an invoice-ID alias cannot fill that gap.

One of the complete candidates has presented hours greater than sold hours,
demonstrating recoverable declined/deferred labor in this supplied sample.
That is not a fleet-wide assessment of deferred-work coverage.

**All 16 verified candidates are outside September 18–October 17, 2026.**
This sample does not establish a usable denominator or averages for that
requested reporting period. Unknown-date records must not be silently removed
from that report on the basis of this sample.

## Verification and retained inputs

The offline preview was rerun with source credentials removed and outbound
networking denied. It returned:

- `complete_candidate`: 16
- `held`: 4 (`missing_positive_invoice_number`)
- `repairAuthorized`: false

The private input, status and sanitized summary are preserved under
`generated-artifacts/reporting-snapshots/sample20.rkG3A9/`.
The directory is excluded from Git and deployments; files were created with
private permissions. Raw payloads must not be published as a report attachment.

These are supplied-copy candidates, not proof of complete historical peer
closure. Additional aliases, archived copies, financial holds and existing
ownership conflicts must still be checked before any actual metadata repair.

## Next step

Use a bounded stored-record recovery preview that includes recent-period
examples and the relevant retained identity peers/archives. Keep reconstruction
separate from production writes, and retain all conflict/financial vetoes.
The successful sample justifies pursuing stored-data recovery, not another
Protractor import or a blind fleet-wide update.

No deployment, metadata repair, financial correction or feature activation
was performed.
