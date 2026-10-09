---
name: Instance-scoped provider isolation
description: Safety rules for denying one runtime replica access to an external provider without disabling unrelated traffic.
---

An instance deny policy must resolve the same stable, platform-defined replica identity operators place in the deny list. Do not fall back to a generic hostname or service identity when that value is absent; a configured policy without its authoritative identity must fail closed.

**Why:** A plausible fallback can silently treat the blocked replica as a different allowed identity. Also, acknowledging a callback after a best-effort replay marker can strand it, and replaying only the provider fetch can omit callback-specific terminal side effects.

**How to apply:** Evaluate the local policy before retries, limits, breakers, or network I/O. For denied callbacks, write the complete replayable event shape atomically before returning success, then drain it through the same admission and semantic processing path on an allowed replica. Test the real denied-handler-to-allowed-queue lifecycle, including non-provider traffic remaining available.

Interactive Protractor reads need the authenticated, shop-bound interactive capability even when they are read-only and use priority scheduling.

**Why:** Production's callback-only policy rejected the workflow staff review and import revalidation before any upstream request; priority does not grant permission.

**How to apply:** Establish interactive scope after session, shop and role checks for both review and save-time revalidation. Keep final persisted admission checks intact; never disable callback safety policy to fix a missing request context.