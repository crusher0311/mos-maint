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
