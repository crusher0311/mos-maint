---
name: JWT eligible-first recovery
description: Quiet-window scheduling and explicit mid-run handoff constraints for JWT recovery.
---

Select among all eligible pending shops; never let one closed shop block open
shops. Deferred batches remain pending with their own page checkpoints.

**Why:** The original sequential run waited until midnight behind one shop while
six other shops had 156 eligible batches. The user approved a controlled
stop/resume, not bypassing quiet hours or refreshing the API budget.

**How to apply:** Treat the legacy cursor as the earliest incomplete window,
not a count of completed work. Use the completed-window ledger for progress.
Before a handoff, confirm the old Render job has terminated and reconcile the
checkpoint. Require explicit one-use approval; preserve consumed admissions,
recorded holds, source snapshots, and the original morning cutoff.

Treat the active window separately from the earliest incomplete cursor during
reconciliation after out-of-order processing.

**Why:** A timeout happened on an August page while the cursor still pointed to
an earlier deferred September window; using the cursor missed unrecorded
candidates on the actual interrupted page.

Confirmed rolled-back timeouts should defer work, not turn it into permanent
holds or stop all other shops. Ambiguous financial commits must still fail closed.

**Why:** The user reported repeated overnight failures and explicitly said JWT
is only ten shops, with several more Protractor shops needing recovery.

**How to apply:** Preserve per-window pages, bound delayed retries, keep
exhausted work visibly unresolved, and never renew a night or refund requests
without explicit operator authorization.

During reconciliation, intersect candidate business numbers with the exact
Protractor source GUID before requiring a unique row.

**Why:** A newly imported October work-order number equaled an older August
invoice number, falsely making an already-corrected GUID-keyed row ambiguous.

**How to apply:** Keep all matching-provenance duplicates ambiguous; never select
the first row or relax source/date/header validation. This is a read-only
disambiguation rule, not permission to merge or delete records.

A same-window stopped-permit handoff may match its compare-and-swap filter
without modifying the permission document. Require a matched row, not a changed
row, while still requiring the terminated predecessor and fresh one-use proof.

**Why:** Reauthorizing an already parked, identical permission failed on zero
modified rows even though the guarded comparison matched successfully.

One-off closed-shop approval must cover invoice and transaction rechecks, not
just scheduler selection. Preserve deadline and ownership checks at every stage.

**Why:** An early start passed selection but immediately stopped inside invoice
processing because an additional quiet-hour guard still used the usual schedule.
