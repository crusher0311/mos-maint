# Stored Protractor payload → invoice reporting: local trace

Follow-up: the raw-retention discrepancy identified below is now corrected and
regression-tested locally. See `raw-retention-and-repair-preview.md`. This
original trace describes the pre-correction behavior; no deployment is implied.

## Scope and evidence

Local source inspection and network-denied, credential-free smoke tests only.
No production/provider reads, writes, feature activation or deployment.
This trace explains current code behavior; it does not establish the historical
cause of every missing field in the saved fleet snapshot.

## Conversion path

1. `ProtractorAdapter.mapWorkOrder` passes the native payload to
   `invoiceHoursEvidence` and sets `customFields.invoiceHours`, including null
   when native invoice verification fails.
2. Verification requires final invoice type/stage/status, a GUID identity,
   positive native invoice number and a valid native invoice timestamp.
   Closed status and a normalized invoice-ID alias alone are not proof.
   The adapter labels any top-level source ID as `invoice_id`, even for an
   uninvoiced work order.
3. With verified identity/date, incomplete labor can still produce an evidence
   object with null hours. Thus missing labor by itself does not explain all
   652 null evidence values in the saved snapshot. Historical payloads and
   running code versions would be needed to attribute those individual nulls.
4. Sold/presented hours use regular and deferred packages, explicit dispositions,
   package/line identities and recorded hours. Conflicting hours, missing
   required identities or invoicing flags can make hours unavailable.
   Estimated hours are not substituted. Omitted deferred packages are treated
   as empty only under the existing verified-final-invoice contract; explicit
   null/malformed collections do not receive that treatment.
5. `NormalizedIngestionService` applies the local preservation helper before
   hashing or writing. A matching previously verified invoice can retain its
   identity/date after an incomplete final snapshot, but never stale hours.
   It cannot manufacture evidence for rows that never had any, and it rejects
   cross-shop, cross-identity, changed-date or nonfinal carryover.
6. The SQL reporting lane reads normalized `custom_fields.invoiceHours`.
   It does not dynamically derive fleet evidence from raw payloads. The legacy
   bounded lane optionally reads the provider cache within its recovery deadline,
   but does not persist that evidence. Deploying faster SQL alone will therefore
   not populate the missing metadata.

## Concrete raw-retention gap found

In the inspected ingestion code:

- Create supplies sanitized `rawPayload` to both normalized stores.
- Update supplies sanitized `rawPayload` to the Mongo shadow update.
- The PostgreSQL update document does **not** include `rawPayload`.
- `SupabaseDualWriter.upsertWorkOrder` serializes that supplied document into
  `raw_data` and replaces `raw_data` during conflict update.

Consequently, this PostgreSQL update path can replace a previously raw-bearing
document with normalized fields lacking the native payload. This is a confirmed
code-path discrepancy, not proof that all missing fleet evidence was caused
by it. Mongo/provider caches and immutable import archives may retain copies;
their current coverage was not checked in this local trace.

## What can be recovered without another import

Existing matched raw payloads or retained import archives can be passed through
the same invoice-evidence derivation and `reconcileStored` review. Candidates
must be bound to the same shop and source identity. Conflicting dates, hours,
ownership or financial evidence remain held. Missing number/date/finality
must not be filled from close dates, alias names or guessed zero hours.

The existing bounded preview script reads archived pages and matched stored
records without contacting Protractor. It is a candidate preview, not a writer
or complete repair authorization. Do not execute it without a new read approval.
The fleet snapshot lacks the full raw payloads needed to count recoverable
records across all ten shops.

## Verification performed

Passed locally, with outbound networking denied and source credentials absent:

- `tests/invoice-evidence-preservation.smoke.ts`: actual ingestion create/update
  paths preserve permitted identity/date without stale hours or identity leakage.
- `tests/invoice-stored-evidence.smoke.ts`: stored reconciliation rejects
  identity/date/hour conflicts and preserves older-sentinel chronology vetoes.

These existing tests do not cover PostgreSQL raw-payload retention. Add that
regression before fixing the identified discrepancy.

## Recommended next action

Build and test the PostgreSQL raw-retention correction locally, preserving
existing sanitization and shop/source identity checks. This prevents future
loss; it does not repair old rows. Prepare an evidence-only repair preview
from stored copies, with separate complete-hours, identity/date-only and held
categories. Do not modify financial rows, call Protractor, run a broad reimport,
deploy or apply a production repair as part of that local work.
