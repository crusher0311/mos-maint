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
