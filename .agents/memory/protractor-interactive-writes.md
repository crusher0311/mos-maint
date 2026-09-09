---
name: Protractor interactive writes
description: Wizard/user-facing Protractor writes must be priority-lane, retry-capped, deadline-bounded, and idempotent via client-pinned UUIDs.
---

Rule: any user-facing (interactive) Protractor write must (1) run on the priority fetch lane with retries capped ~1, (2) be wrapped in a route-level deadline with the frontend timeout set above it, and (3) retain a client retry key that deterministically pins the upstream record IDs. Full-work-order replacement writes report success only when the exact pinned ID is present in the write response or a follow-up read; accepted-but-unconfirmed writes remain retryable with the same identity.

**Why:** Protractor upserts by ID, so pinned UUIDs make retries duplicate-safe. Background-lane defaults can let backfill traffic starve a wizard click into an indefinite spinner. The exact-ID confirmation pattern was production-validated by a controlled add that completed once, displayed success only after confirmation, and appeared exactly once upstream.

**How to apply:** Keep ordinary/background read limits unchanged. Give prerequisite interactive reads enough caller headroom above the relay's upstream ceiling, cap priority read/write retries, never broaden SOAP fallback beyond its known compatibility error, and validate any client-supplied identity before deriving scoped upstream IDs.
