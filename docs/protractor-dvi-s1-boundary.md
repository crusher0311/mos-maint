# S1 local boundary — design review record and storage proposal

This implementation was checked against the S1 plan and foundation evidence.
It implements **contracts and an offline synthetic harness only**. No operator
approval, production persistence, provider verification or rollout is implied.
The review gate for actual persistence/UI remains open.

## Identity and admission decisions

- Canonical identity is `(shopId, workflowVisitId)`, not VIN, RO number, a
  vehicle container or an enterprise match. Local intake IDs survive ticket
  confirmation. Provider identity is taken exclusively from the current-shop
  workflow board, after the existing intake exact-ID protocol confirms it.
- A manual/null source can advance to one verified Protractor GUID. Once set,
  it cannot change, disappear or move to a different workflow visit. Same GUID
  in another shop is a different scope. Repeated VIN/RO never joins records.
- Existing `bindTicket` conflict rules remain in force. Its permitted imported
  duplicate merge now retains retired workflow IDs as aliases. An imported
  visit with a DVI admission cannot be discarded; explicit reconciliation is
  required. No results are auto-merged. Aliases resolve historical references,
  not authority: writes use the surviving current-shop canonical ID.
- Existing `executeIntake`/`recoverTicket` own all ticket admissions and stage
  recovery. The new coordinator does not invoke them or any provider. Pending
  or uncertain tickets block new binding admission. The synthetic harness
  demonstrates the two services together, including exact-ID recovery after a
  lost upstream response with no attempted-stage replay.

## Two-store protocol

1. Fresh trusted authority, exact shop, open workflow visit, board revision and
   inspection revision are required. Client provider IDs, VIN/RO identity and
   attachment references are rejected by the strict request schema.
2. Board CAS appends a bounded admission carrying request ID, SHA-256 digest,
   opaque actor ID, canonical identity, aliases and both expected revisions.
   Existing intake intents/jobs and capacity remain unchanged.
3. The inspection repository applies a local transaction: check expected
   revision, identity and unique aliases/provider key, preserve results, append
   event(s) and receipt, advance inspection revision. It must not overwrite the
   whole existing result set from a stale board.
4. A lost acknowledgment is recovered by exact request receipt. A different
   digest/actor conflicts. A different request cannot take over an unresolved
   admission. An unavailable store returns pending-local-finalization, not
   permission to allocate another visit or send a ticket write.

There is **no two-store atomicity claim**. A board change or permission
revocation can race an inspection transaction. This slice creates metadata
only, not permission to edit, publish or apply provider work. Future consumers
must recheck current membership, open status and canonical source at each
action; changed/closed identities require reconciliation, never blind replay.
Repository I/O adapters must impose deadlines; none are installed here.

## Permission precedence (version 1)

Trusted current-shop membership is mandatory even on receipt retries.
Technician publication denial wins over every allow, including multi-role
accounts and enterprise/individual grants. Next, any explicit restriction
wins. Enterprise-governed capabilities require enterprise allow; local and
individual allows cannot silently override governance. Otherwise explicit
enterprise, individual and local grants precede role defaults. Owner,
manager and advisor defaults allow read/edit/sensitive/future publication;
technician defaults allow read/edit only. Unknown/no roles default deny.
These are tested contract defaults, not activated shop configuration.

Publication permission is distinct from product release: the existing
`VISIT_DVI_RELEASE_ENABLED = false` remains unchanged. No attachment access,
public report, route, UI, search/export or legacy permission behavior is
changed. S2/S4 must enforce policy at their actual sinks.

## Additive storage design for operator review — do not execute

The existing `auto_dvi_visit_records` store in
`lib/data/repositories/auto-dvi.ts` is VIN-keyed and remains untouched. Do not
implement this contract by calling its VIN-container mutation methods.

Propose a new versioned workflow inspection store:

- unique `(shop_id, workflow_visit_id)` canonical record and CAS revision;
- unique `(shop_id, alias_id)` across canonical IDs **and** retired aliases;
- partial unique `(shop_id, provider, provider_work_order_id)` for non-null IDs;
- unique `(shop_id, request_id)` receipt, immutable digest/actor and original
  expected/admitted/inspection revisions;
- append-only events keyed by correlation ID plus event kind, with opaque
  actor, fixed source/reason, before/after identity and alias references.
  No customer names, VINs, notes, prices, URLs, tokens or error payloads.

The repository transaction must enforce these keys together, not as
read-then-write uniqueness checks. `applyBindingAdmission` is the pure
transaction specification; the test adapter serializes it in memory.
Workflow admissions remain part of the existing board CAS. A future adapter
must validate stored schema/version and clone data at boundaries.

Retain unresolved admissions indefinitely until explicit resolution. Never TTL
idempotency receipts or aliases while referenced; archive only after legal and
operational retention approval, preserving immutable lookup/tombstone keys.
Events are append-only; the 5,000 receipt/event/admission bounds fail closed
pending archival review. Existing board audit, size, job and visit caps remain.
No index creation, migration, backfill or archive is included.

## Coordination and validation

Existing proposed customer/vehicle and enterprise-match work owns candidate
discovery and relationship evidence. It must return suggestions only; it cannot
grant cross-shop writes, reuse foreign IDs or bypass this binding protocol.
This slice adds no search/matching service and creates no competing task.
The legacy VIN visit model/repository and release routes are not replaced.

Offline command:

```
node --import tsx --test tests/auto-dvi-workflow-binding.test.ts tests/shop-dispatch-intake.test.ts tests/auto-dvi-visits.test.ts tests/auto-dvi-visit-routes.test.ts
```

No application bootstrap is needed or authorized for these tests.
