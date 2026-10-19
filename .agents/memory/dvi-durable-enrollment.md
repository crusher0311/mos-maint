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
