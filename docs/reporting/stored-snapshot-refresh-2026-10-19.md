# Stored-record snapshot refresh — 2026-10-19

## Authorization and execution

Approved: bounded read-only recapture from existing PostgreSQL/Mongo records.
No Protractor requests, production data writes, grants, deployment or activation.
No application server was started.

The ten JWT locations (227–236) were captured in one PostgreSQL repeatable-read,
read-only transaction beginning **2026-10-19 11:17:44.279686 UTC**.
Source queries used a five-second statement timeout, one PostgreSQL connection,
250-row payload batches and 50 ms pauses. Limits remained 100,000 records per
shop and 500,000 fleet records.

Sequential retained-archive reads were limited to the three owner-review shops,
two previously approved campaigns, indexed ranges, five-page batches and at most
2,000 pages per campaign/shop. They read 198 pages containing 4,735 invoice
occurrences. Mongo and PostgreSQL are not one cross-store atomic snapshot.

## Refreshed evidence

- **215,655** stored work orders across ten locations.
- The structural closure still contains **26 parents / 36 owners / 329 children**.
- All 329 child value records survive the local what-if reassignment unchanged,
  with no missing rows or broken job links.
- Owner reconciliation still produces 26 verified-complete invoice-evidence
  records, eight date conflicts and two missing-positive-invoice-number results.
  All 26 verified dates are outside the requested September 18–October 17 period.
  This is an evidence reconciliation, not approval of financial amounts.

## Reporting results on the local copy

| Local calculation | Verified invoices in period | Unresolved invoice identities | Averages |
| --- | ---: | ---: | --- |
| Current stored metadata, independent location calculations | 0 | 209,889 | Unavailable |
| Simulated owner separation, independent location calculations | 0 | 209,871 | Unavailable |

These are offline diagnostic aggregates, not a production fan-out implementation.
Zero verified invoices does **not** mean there were no real invoices. The count
describes what the reporting evidence can establish. The owner correction changes
18 unresolved identities but does not make this reporting period usable.
The existing combined query still correctly trips its 100,000-row safety cap.

## New runtime blocker

Subsequently resolved **locally** by partitioning intermediate work within the
same guarded SQL statement. See invoice-fleet-local-optimization.md. The failure
record below describes the original query and must remain attached to the capture.

The opt-in guarded query failed with SQLSTATE **53400** on the real-data local
snapshot. A second run against the preserved dump confirmed specifically
**temporary file size exceeds temp_file_limit**, on both current metadata and
the simulated owner-separation table.

Settings were unchanged: 64 MB temporary files, 2 MB work_mem, zero parallel
workers, one-report admission and a 35-second statement timeout. Limits were
not raised or bypassed. The initial local validator had analyzed the fleet
tables before executing the guarded query.

The disposable database uses PostgreSQL 16.10; production is PostgreSQL 17.6.
This is a release-blocking local result, not an executed production benchmark.
Obtaining the production SET permission alone does not establish deployability.

## Preserved local input

Protected capture: `generated-artifacts/reporting-snapshots/capture.G6Umcl/`.
The dump is about 41 MB, excluded from Git and deployment; files are mode 0600.
Dump SHA-256:
`2d9b8041c334eb2919638032f1a7e1cc0cf23410b616f7361414b2c5e6417a45`.

The directory includes validation logs, closure references and explicit
`validationExitCode: 1`. Do not label the overall validator successful: it stopped
at the guarded query before its remaining assertions. Subsequent local-only
diagnostics supplied the simulated-location result above.

This is the captured **report-column/child-audit dataset**, not a complete raw
provider-payload archive for every fleet work order. Do not claim it can answer
all native invoice questions without additional bounded source evidence.

## Next step

Optimize and test the aggregate against this saved input within the existing
resource limits. Do not recapture production to iterate on the query. Missing
invoice metadata and held accounting evidence remain separate prerequisites
for verifying usable report numbers.
