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

Database-side aggregation feasibility is not live admission approval.

**Why:** Per-query spill and timeout limits do not bound fleet-wide concurrent
load, scanned pages or total database RAM. A small returned result can still
represent expensive database work.

**How to apply:** Require concurrency/admission limits and enforceable
transaction settings before replacing the live raw-row cap. Preserve explicit
unavailable results for unsupported identity/evidence shapes.

Test mixed known-invoice and alias populations, not just large unknown-only
fixtures.

**Why:** PostgreSQL can join invoice and unknown groups by shop before expanding
alias arrays, creating quadratic work even though an unknown-heavy fixture is
fast. Table statistics alone did not prevent that plan.

**How to apply:** Preserve an expansion boundary before the identity join and
exercise mixed populations under the same time/spill limits. Do not raise
limits to hide a bad join order.
