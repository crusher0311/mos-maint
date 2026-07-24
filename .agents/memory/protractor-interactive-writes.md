---
name: Protractor interactive writes
description: Wizard/user-facing Protractor writes must be priority-lane, retry-capped, deadline-bounded, and idempotent via client-pinned UUIDs.
---

Rule: any user-facing (interactive) Protractor write must (1) run on the priority fetch lane with retries capped ~1, (2) be wrapped in a route-level `withUpstreamTimeout` returning 504 + a retryable message, (3) have a frontend AbortController timeout set ABOVE the server deadline, and (4) pin a client-generated UUID as the Protractor record ID so a post-timeout retry upserts the same record.

**Why:** Protractor `POST /Contact/{id}` and `/WorkOrder/{id}` upsert by ID, so pinned UUIDs make retries duplicate-safe. Background-lane defaults (6 exponential retries, no deadline anywhere, SOAP with no socket timeout) let backfill traffic starve a wizard click into an indefinite spinner — this bit the New Work Order wizard's Create Customer step.

**How to apply:** the client's create functions take optional interactive opts (priority/maxRetries/pinned id/SOAP timeout) — background callers unchanged. Dashboard routes follow the pattern; extension `/api/extension/protractor/create-*` routes still use background defaults (follow-up exists). SOAP helpers need explicit `req.setTimeout`. Validate any client-supplied ID as a UUID before using it in a path.
