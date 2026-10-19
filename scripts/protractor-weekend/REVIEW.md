# Held campaign review (no replay)

Run on an approved host with read access to the campaign Mongo database and the
canonical PostgreSQL database. Confirm the configured databases refer to the
same environment; do not start the application or campaign runner for this review.
The development Mongo connection is shared with production.

```
node --import tsx scripts/protractor-weekend/review.ts --read-only protractor-weekend-2026-10-17 139 2026-10-16
```

This standalone command does not import the campaign runner, ingestion service,
or provider client. There is no apply mode. It disables slow-query persistence
in this process before opening connections. It reads one stored campaign shop,
1–7 explicit campaign days, at most 20 pages / 500 unique invoices / 500 scoped
receipts, with five-second database statement limits and a 125-second process
deadline. Cap/deadline/scope/page-digest failures exit nonzero without a preview.
Narrow the days when capped; never interpret a failed review as zero missing data.
Output contains operational identifiers, digests and package keys, not customer
payloads, prices or credentials. Handle it as internal evidence.

## Reading the preview

- `verified-existing-missing-index`: archived raw digest agrees with the receipt
  (if present), both ownership stores were checked, an owned invoice exists,
  expected job identities are usable and specific Protractor index keys are absent.
  A single matching job does **not** imply the whole invoice is indexed.
- `ambiguous-prior-ingestion`: processing/prior-ambiguous receipt, or uncertain
  receipt from the campaign's recorded prior job. Current invoice presence does
  not establish whether a previous ingestion completed. No replay candidate.
- `pre-ingestion-check-failed`: an ownership/index check **during this review**
  failed. It does not prove that an earlier ingestion never happened.
- `unreceipted-unknown`: no receipt or owned invoice found. Older held-day
  checkpoints do not persist the failure stage; absence is not proof of a failed
  pre-ingestion check. Correlate sanitized historical logs separately if needed.
- Other holds identify conflicts, thin raw job evidence, missing raw evidence,
  unknown/held receipt states, missing owned invoices or conflicting ownership.

The report includes every unique archived invoice in scope and every scoped
receipt not linked to one. Repeated invoices across pages are counted separately
as occurrences but reviewed once. Receipts are campaign-wide identities: an
invoice may reference a receipt from a different day; that receipt is shown but
not added to the scoped receipt count. Held days without archived pages remain
visible with zero pages, not “repaired” or “complete.” Day checkpoint unresolved
counts are historical counters, not unique invoice counts, and are not summed
into the receipt conservation equation.

## Approval boundary

The repair preview is **not executable** and proves no financial correction is
needed. A separately approved repair must re-read raw digests, both ownership
stores, receipts and index keys, then insert only still-missing index entries.
Never update existing index amounts, normalized financial data, receipts,
checkpoints or campaign permissions. Never replay ingestion on ambiguous receipts.
Provider recovery reads, production writes and campaign extensions each require
explicit approval. Invoice-hours financial reconstruction is a separate process.

Reads are sequential, not a cross-database snapshot. Receipt changes detected
during review abort the report; any future approved action still needs fresh
checks. A database timeout remains a hold. Do not add a provider fallback.

Offline regression checks:

```
node --import tsx --test tests/protractor-held-review.test.ts
```
