---
name: Held index repair maintenance boundary
description: Approval and quiescence constraints for repairs spanning Mongo and PostgreSQL.
---
Index-only repair approval must be separate from read-only held-campaign review
and ingestion permissions, and must bind exact archived evidence and package keys.
Require explicitly confirmed writer quiescence before applying.

**Why:** PostgreSQL ownership and Mongo archives, receipts and index rows have no
shared transaction. Fresh sequential checks cannot exclude changes after the last
read, and index presence after a lost response cannot prove which writer inserted it.

**How to apply:** Keep production execution operator-approved; do not interpret a
held campaign as proof that callbacks and other writers have drained. Preserve
receipts, checkpoints and existing financial corrections; reconcile ambiguous
commits by key presence rather than replaying ingestion.

Two-store metadata repair retries must verify earlier completed receipts even
while a later entry in the same plan owns a durable unresolved-operation fence.
Only that exact plan's completed entries may be acknowledged under the fence;
all new operations and normal readers/writers remain blocked.

**Why:** A fail-closed global fence otherwise prevents recovery from reaching the
partially committed entry when replay begins at the first entry in a plan.

**How to apply:** Verify complete post-state plus both store receipts, never
just matching metadata. Do not drop the fence or silently extend expired write
approval to make recovery proceed. Local cooperative fencing is not proof that
production readers and writers enforce it.
