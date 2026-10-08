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
