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
