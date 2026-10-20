---
name: Protractor interactive writes
description: Wizard/user-facing Protractor writes must be priority-lane, retry-capped, deadline-bounded, and idempotent via client-pinned UUIDs.
---

Rule: any user-facing (interactive) Protractor write must (1) run on the priority fetch lane with retries capped ~1, (2) be wrapped in a route-level deadline with the frontend timeout set above it, and (3) retain a client retry key that deterministically pins the upstream record IDs. Full-work-order replacement writes report success only when the exact pinned ID is present in the write response or a follow-up read; accepted-but-unconfirmed writes remain retryable with the same identity.

**Why:** Protractor upserts by ID, so pinned UUIDs make retries duplicate-safe. Background-lane defaults can let backfill traffic starve a wizard click into an indefinite spinner. The exact-ID confirmation pattern was production-validated by a controlled add that completed once, displayed success only after confirmation, and appeared exactly once upstream.

**How to apply:** Keep ordinary/background read limits unchanged. Give prerequisite interactive reads enough caller headroom above the relay's upstream ceiling, cap priority read/write retries, never broaden SOAP fallback beyond its known compatibility error, and validate any client-supplied identity before deriving scoped upstream IDs.

Post-create dashboard refresh and DVI handoff reads also need their own bounded,
shop-bound interactive context. A completed create context cannot authorize
detached follow-up work; a priority option alone does not establish that context.

**Why:** A native RO can be confirmed while its dashboard refresh and DVI intake
fail separately under the staged transport policy. Creation success is not proof
that either follow-up completed.

**How to apply:** Preserve native identity across read-only retries, retain all
transport guards, refresh the dashboard snapshot from the validated native
response, and distinguish cache-read failure from successful synchronization.
