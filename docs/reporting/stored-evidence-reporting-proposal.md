# Stored-evidence invoice reporting proposal

Status: discussion proposal, not an approved production migration.

## Fresh bounded evidence — October 22, 2026

A read-only repeatable-read PostgreSQL transaction compared ten retained JWT-701
(MOS shop 227) identities against current canonical records. Each matched one
canonical owner. All ten lack `custom_fields.invoiceHours`. Seven retain a raw
payload, but none of those seven independently satisfies the current invoice
evidence contract. Three have no raw payload in that projection.

The previously captured archive cohort contains 47 retained copies across these
ten identities. Each reconciles to complete invoice identity/date and
sold/presented hours under the existing evidence contract. Adding the current
canonical raw copies to that comparison did not introduce a conflict.
Examples include 0.9 sold / 1.4 presented hours, and 0.5 sold / 1.8 presented.
These are individual source-evidence examples, not approved report averages.

Nine sample invoices date to October 1; one dates to September 19. This does not
establish evidence coverage for October 19–22 or all 19,042 unknown records.
The archive copies were from the retained local capture, not a refreshed inventory.
There was no financial-child, Mongo-owner, hold-registry or writer-attestation
clearance. This is an evidence diagnosis, not a completed repair preflight.

The expected PostgreSQL repair-control tables remain absent. No production data
was written, schema installed, report refreshed, deployment made, or provider
request issued. One connection, five-second statements and one-second lock
timeout bounded the database check.

## Why deployments alone have not solved it

The reporting paths depend on normalized invoice evidence. Preserving evidence
on subsequent updates cannot populate evidence that was never derived.
Historical final invoice copies survive in import archives even when current
operational copies cannot establish finality or hours. Repeated report runs
therefore produce the same unavailable result.

The prepared eleven repair-control tables support audited cross-store mutation.
They are not a reporting data model. Installing them alone would not populate
reporting evidence or produce averages.

## Recommended design: a rebuildable reporting projection

Keep the existing operational stores and raw archives. Add reporting-only tables
in the existing PostgreSQL database; do not replace the database, duplicate
customer/vehicle PII, or modify invoice/payment amounts.

Proposed logical tables (names provisional):

1. **Invoice facts**: generation, shop, provider, normalized invoice identity,
   verified invoice date, sold/presented hours using exact decimal storage,
   completeness, classification/reason, evidence fingerprint and parser version.
   Unique per generation/shop/provider/invoice identity.
2. **Evidence references**: fact/build reference, source-store record locator,
   source digest, capture timestamp and disposition. Reference immutable retained
   source copies rather than copying entire raw invoices into reporting tables.
   References are internal and access-controlled, never public source links.
3. **Build and coverage state**: authorized shops, inventory cutoff, parser
   version, resumable source checkpoints, pending/complete/failed status,
   examined/verified/unresolved counts, scope-completeness evidence, completion
   timestamps and currently published generation.

A separate schema or database role should allow the builder to write reporting
tables while only reading operational sources. Production grants and schema
installation require reviewed migration approval.

## Correctness and publication rules

- Reuse the current final-invoice, labor-disposition and deferred-package
  contract; do not invent a second calculation policy.
- Reconcile all relevant retained copies and identity aliases within the
  authorized shop, including out-of-period contradictory evidence.
- Preserve existing ownership, financial-consistency and reviewed-hold checks.
  A projection must not bypass a held identity simply because it avoids writes
  to the canonical row. Missing hold coverage remains explicitly unresolved.
- Classify known uninvoiced work separately from unresolved invoice identity.
  Unknown dates cannot be assigned to the selected reporting period or ignored.
- Derive from stored raw data first. Missing/conflicting evidence is explicit;
  provider recovery is a separate, bounded approval, not automatic fan-out.
- Freeze source cutoff and generation inputs. Revalidate changed sources or
  invalidate affected facts before publishing; do not combine inconsistent
  cross-store snapshots as if they were atomic.
- Publish a generation only after its declared source scope is fully enumerated
  and reconciled. Publish fact and coverage pointers together transactionally.
  Keep the previous generation available, labelled with its actual freshness,
  while a new generation builds or fails.
- Partial verified totals may be shown as diagnostics, not full-shop averages.
  Preserve current unavailable-average behavior where population is unresolved.
- Index published facts by generation/shop/invoice date. Reports should read
  compact facts, not repeatedly scan operational history and raw JSON.
- Incremental ingestion marks affected identities dirty. Rebuild those facts
  idempotently, with bounded batches and restart checkpoints. A reconciliation
  pass detects missed invalidations; deployment alone never starts a fleet job.

## Delivery and acceptance

First build a local end-to-end slice from the retained JWT-701 evidence, including
conflicts, missing dates, deferred work, duplicate identities, source changes,
held records and crash/restart behavior. Prove that local report results use the
projection, not just that rows can be extracted.

Then review the exact migration, storage estimate, least-privilege grants,
source-inventory budget and production rollout. Start with one explicitly
bounded shop and show coverage before expanding. Do not promise that ten repaired
or projected samples make a full-location report complete.

This is a proposed replacement for repeated metadata repair as the reporting
strategy, not permission to install tables, enable switches, or remove existing
reporting safeguards.
