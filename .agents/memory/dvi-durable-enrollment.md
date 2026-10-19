---
name: Durable DVI enrollment safety
description: Why durable push routing must survive rollback independently of admission.
---

Treat enrollment into durable DVI tracking as permanent routing ownership.
Rollback disables new admissions, not the routing to the durable authority.

**Why:** Routing a previously enrolled target back to the legacy writer bypasses
an unresolved operation's gate and can duplicate or overwrite an upstream write
that is still executing. A timed-out call is not proof of termination.

**How to apply:** Preserve enrollment across rollback releases and retain all
operation keys/target gates. Provider capability verification, storage provisioning,
and client activation require separate operator approval; never use shared
application storage to test the protocol.

Browser request identity must be committed before sending, and an uncertain
target gate must survive draft edits. Even a completed operation does not
authorize an edited replacement under the current ownership contract.

**Why:** A lost response cannot distinguish an unreceived request from a write
still executing. Clearing the local marker or minting a new key after edits
would conceal that ambiguity; server target discovery remains authoritative
when another device has no local marker.

**How to apply:** Keep browser records free of findings and credentials. Use
authenticated scope and exact verified targets, fail closed on storage/status
errors, and do not add automatic local expiry or resend-based recovery.

Recovery authorization must retain the first verified package revision rather
than replacing it with the latest reconciliation observation.

**Why:** A fresh read can match saved content after an advisor changes and changes
it back. Resetting the baseline revision on every reconciliation would erase that
evidence and incorrectly authorize a subsequent findings write.

**How to apply:** Require provider concurrency protection and an unchanged
verified baseline; absent a separately verified termination capability, previously
admitted ambiguous attempts remain blocked even after their content appears.

The user identified Car Experts Protractor as a test shop on 2026-10-18.

**Why:** This is user-provided environment context, not something inferred from
shop records or credentials.

**How to apply:** Use Car Experts as the candidate for an explicitly authorized
synthetic provider pilot. Its test-shop designation alone does not authorize
database provisioning, changes to existing repair orders, or durable enrollment.

The user subsequently approved database setup and creating/editing a dummy
repair order in that test shop for the synthetic pilot.

**Why:** The approval is limited to testing, not enabling durable pushes for
customers or widening fleet transport permissions.

**How to apply:** Keep the pilot scoped to its dummy records and preserve the
separate enrollment and transport-policy approval boundaries.

The user also approved restricted test access through the existing connection,
limited to Car Experts test records.

**Why:** An operator synthetic pilot needs explicit transport authorization; it
must not pretend to be a customer request or silently widen fleet access.

**How to apply:** Use a bounded, once-only harness with pre-recorded synthetic
IDs through the existing relay. Do not change the shared fleet scope or enroll
the shop based on this approval.

The synthetic Protractor pilot returned decimal amounts as numbers, retained
labor lines when sent an empty line collection, and returned no body after an
accepted inspection POST. Its impossible If-Match/Note probe was inconclusive:
the response succeeded but the Note did not persist.

**Why:** These observations do not prove a safe normalizer, deletion contract,
conditional-write contract, or upstream termination.

**How to apply:** Require exact readback and an independently writable sentinel
for concurrency probes. Do not certify the capability adapter from this pilot;
consult the pilot evidence document for limitations before further testing.

The supplied Protractor integration guide warns against API edits while staff
actively edit a work order and forbids removing service packages/lines from
Type=WorkOrder. The pilot's Header.LastModifiedTime did not advance with its
inspection changes.

**Why:** Neither the existing timestamp nor a local lock establishes the required
provider-side concurrency contract.

**How to apply:** Keep durable enrollment closed until a supported exclusive or
conditional-write contract and upstream termination evidence are established.

Offline projection/normalization work may proceed while provider safety
confirmation is pending, but it must not install a verified capability adapter.

**Why:** The user explicitly approved advancing offline implementation rather
than waiting for provider confirmation; this was not approval to enable writes.

**How to apply:** Keep live label enumeration, writable-payload certification,
and concurrency/termination evidence distinct from passing fixture tests.
Independently sourced setup labels cannot be replaced with values echoed by
inspection upserts.
