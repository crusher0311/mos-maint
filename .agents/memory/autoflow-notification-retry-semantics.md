---
name: AutoFlow notification retry semantics
description: Why notification recovery accepts duplicate refreshes rather than replaying business work.
---

Accept bounded duplicate dashboard invalidations when an AutoFlow operation has
an ambiguous completion; do not use upstream webhook replay to repair a missing
refresh notification.

**Why:** Business writes span PostgreSQL/MongoDB and optional upstream DVI calls,
so a notification transaction cannot cover them all. Reporting a saved operation
as failed would encourage replay of customer/event work rather than just refresh
delivery. A crash-recovery notification can also run before normalization settles,
so acknowledging it as final too early can recreate the lost-refresh gap.

**How to apply:** Preserve write-ahead recovery and the distinction between
prepared and finalized notification work. Evaluate duplicate refreshes separately
from duplicate event processing when changing retry or acknowledgement behavior.