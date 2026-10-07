---
name: Recovery accounting gap
description: Reconcile financial commits separately from Mongo outcome bookkeeping before resuming recovery.
---
Treat unrecorded, currently matching financial rows as ambiguous historical
outcomes, not proof of newly recovered revenue or proof they were untouched.

**Why:** Financial changes and recovery-result bookkeeping live in separate
stores. A pause between them can leave a committed row without an outcome.
The overnight reconciliation also found matching rows beyond its last outcome;
current values alone cannot establish when they became correct.

**How to apply:** Reconcile archived source, native evidence, canonical totals,
raw mirrors, recorded keys and counters before a new resume. Preserve holds,
avoid replaying recorded outcomes, and retain outstanding candidates within a
partially completed page. Do not use final labor totals as incremental revenue.
