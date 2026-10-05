# DVI customer engagement evidence

Missed Opportunities treats customer engagement separately from recommendation
source/severity. Evidence is scoped to the MOS shop and the provider's immutable
repair-order ID; VINs, display RO numbers, and latest inspections are not joins.

## Verified Tekmetric contracts

- Received webhook wording: `[customer name] viewed their inspection for Repair
  Order #[number]`. Its flat RO contains `id`, `shopId`, and
  `repairOrderNumber`. Validate that the sentence's number matches the payload.
  The prefix is a customer's name, not the literal word "customer".
- Estimate views use a different sentence and must not count. Candidate dotted
  event names in older local documentation were never confirmed.
- The user-supplied **Share Link to Repair Order** API documentation lists
  `shareItem` values `ESTIMATE`, `INSPECTION`, `INVOICE`, a caller-supplied
  `shareDate`, and separate returned `estimateShareDate`,
  `inspectionShareDate`, and `invoiceShareDate`.
- A valid `inspectionShareDate` supports **Sent**, meaning **Tekmetric recorded
  inspection sharing**, not independently verified SMS/email delivery. It is a
  provider-recorded share time and may be set through the API by an integrator.
  No share-link write endpoint is called by this feature.
- An inspection-view webhook supports **Viewed**. Its timestamp is when MOS
  received the event. Neither the receipt time nor RO `updatedDate` establishes
  the exact time the customer viewed it.

## States and exclusions

Both sent and viewed independently support positive, explicit negative,
unknown, and verified unsupported states. Current Tekmetric ingestion emits
only positives or unknown. No verified explicit-negative or unsupported
contract was found for the other existing providers; they remain unknown,
not "Not tracked". Do not guess fields or invent unsupported declarations.

Inspection completion, link availability/generation, estimate/invoice shares,
estimate views, VHI views, and ambiguous legacy `customerViewedDvi*` fields are
not evidence. A confirmed view never creates a send time. A missing date never
means "Not sent". User-confirmed webhook-menu correction: inspection sent is
not offered as a webhook event in the menu they checked.

## Storage and report behavior

The existing Tekmetric work-order cache holds application-owned earliest
positive timestamps outside the replaceable provider `data` snapshot.
Atomic minimum merges preserve evidence on duplicates and out-of-order events.
Ingestion also captures sharing on no-change normalized RO runs.
The repository honors the existing Tekmetric cache canonical-store and shadow
configuration. This feature changes no cutover flags or schema.

Report enrichment selects at most 300 provider IDs in a single cache query,
bounded by the remaining optional-enrichment budget and a one-second cap.
Mongo maxTimeMS and PostgreSQL transaction-local statement_timeout bound
database work; the outer deadline also bounds pool/connection waits. Failures
yield unknown rather than fail the report. No upstream fetches are initiated.
Already-cached inspectionShareDate may be read without reconstructing history.

New report caches retain evidence. Legacy/saved versions normalize absent
evidence to unknown until refreshed; their original report version is retained.
Refreshing a report does not scan historical webhook logs or backfill events.
