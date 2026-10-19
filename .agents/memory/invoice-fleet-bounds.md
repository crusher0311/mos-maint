---
name: Invoice fleet safety bounds
description: Why capped invoice closures cannot yield partial counts or live per-location retries.
---

Treat an overflowing invoice identity closure as unavailable counts and averages,
not as a lower bound of unknown invoices. Per-location combination is approved
only for the offline fixed-snapshot diagnostic, not an automatic live fallback.

**Why:** Unseen peers can resolve unknowns or veto previously valid evidence.
One bounded query per location would multiply the live request's total row
budget across a large authorized fleet. The offline exact unknown count did
not establish reliable averages.

**How to apply:** Preserve explicit capped coverage through saved reports and
delivery. Any future live partitioning needs a separately justified total
resource budget and complete same-location identity closure, not just a limit
on each individual query.
