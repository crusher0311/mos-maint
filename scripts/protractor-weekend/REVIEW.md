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

## Separately approved index-only repair

`review.ts` remains read-only. A separate command prepares one invoice at a time:

```
node --import tsx scripts/protractor-weekend/index-repair.ts --prepare CAMPAIGN SHOP DAY[,DAY] LOWERCASE-INVOICE-UUID > manifest.json
```

This requires the same read authorization as review, not permission to apply.
The manifest binds the archived page and invoice digests, both ownership stores,
current and prior receipts, campaign, cursor and day checkpoints, and exact
missing package keys. Treat it as internal operational evidence. No raw customer
payloads or financial amounts are included. Preparation never grants approval.

After explicit human approval for this exact manifest and environment, create a
separate approval JSON document with these fields:

```
{
  "operation": "insert-missing-job-index-only",
  "manifestDigest": "SHA256 of JSON.stringify(parsed manifest)",
  "approvedBy": "operator identity",
  "approvalReference": "record of explicit authorization",
  "expiresAt": "ISO timestamp no more than one hour ahead",
  "writersPaused": true,
  "environment": "operator-confirmed environment label"
}
```

Compute the digest offline using `reviewDigest` or Node's SHA-256 over
`JSON.stringify(JSON.parse(file))`. Whitespace in the file is not hashed.
The approval file is an operator attestation, not an authentication mechanism:
restrict access to the approved host, files and database credentials. The
environment label is a confirmation, not database discovery; independently
verify both configured databases before approval.

**Mandatory maintenance precondition:** pause all ingestion, callbacks,
backfills, repair jobs and other writers of the scoped archive/receipts,
ownership and job-index records, and confirm in-flight work has drained.
Do not assert `writersPaused` merely because a campaign is held. This command
does not pause services or grant permission to change campaign windows.
Mongo reads and PostgreSQL reads do not form a distributed snapshot. Fresh
checks detect observed changes, not changes after the final read; without
quiescence there is no safe apply. PostgreSQL ownership is additionally protected
by a short table SHARE lock (which blocks writes fleet-wide during the action).
Run only in the explicitly approved maintenance window.

```
node --import tsx scripts/protractor-weekend/index-repair.ts --apply-approved manifest.json approval.json CONFIRMED-ENVIRONMENT
```

Apply validates approval before connecting, re-reads the evidence, and checks it
again before staging and before commit. Missing keys may shrink (already-present
rows are preserved); new missing keys or changed evidence require a new review
and approval. The archive must include a usable service date, never today's
date as a fallback. It inserts a single transactional Mongo batch with majority
write concern and deterministic IDs. It requires the existing unique natural-key
index; it never creates indexes. Mixed-case keys and numeric/string shop IDs are
checked before insertion. Transactions/commit failures are not automatically
retried by the command. Mongo transaction support is required.

Existing job-index rows—including financial corrections—are never updated.
No normalized financial rows, receipts, campaign state, checkpoints or part
cross-references are written. No providers, ingestion or ACES enrichment run.

On timeout, connection loss or unconfirmed commit, retain the exact manifest
and approval. Reconcile by running the read-only review again. An approved rerun
rechecks all evidence and inserts only still-missing keys; `already-present`
means keys exist, **not** proof that this repair inserted them. Changed evidence
or expired approval stays held; obtain a new explicit approval, never replay
ingestion or clear receipts. There is no rollback/delete command.

Offline repair regression checks (no database or provider access):

```
node --import tsx --test tests/protractor-held-review.test.ts tests/protractor-index-repair.test.ts
```
