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

Match production status types and managed-database privileges in release tests.

**Why:** Text-column fixtures accepted workflow labels that the production
work-order enum rejects at query planning. The managed production role also
lacks permission to set the superuser-context temporary-file limit; a disposable
database's superuser tests cannot establish this capability.

**How to apply:** Include an enum-backed fixture and preflight the actual
runtime role. Keep budget enforcement mandatory; do not enable an unrestricted
query or grant broad database privileges to make tests pass.

A parameter-specific SET grant is not a value-bounded database quota.

**Why:** It allows any value for that parameter, including unlimited, throughout
the grantee role's sessions. The application's fixed transaction limit remains
application-enforced. Managed-provider approval of the grant is separate from
whether PostgreSQL supports its syntax.

**How to apply:** Disclose this scope before permission approval, retain fail-closed
admission, and never substitute broad admin privileges or assume customer SQL
access can grant a restricted managed-database permission.

Preserve a protected, non-deployed local capture through evidence review,
including its completion/failure status, rather than relying only on temporary
database files.

**Why:** Earlier temporary captures disappeared before verification finished,
forcing repeated production reads and changing the evidence snapshot. A summary
cannot reproduce the raw-data report.

**How to apply:** Keep sensitive generated captures out of Git and deployments;
never label a partial or failed capture complete. Prefer rerunning analysis on
the same local snapshot over requerying production.

Validate spill budgets with realistic identity/provenance widths, not just row
counts.

**Why:** A roughly 210,000-row synthetic fixture passed the resource guard, but
a similarly sized retained fleet snapshot exceeded the 64 MB temporary-file
limit. A passing high-row-count fixture alone did not establish budget fitness.

**How to apply:** Keep representative payload widths and mixed identity shapes
in local resource tests; optimize against preserved snapshots without increasing
the cap or repeating live reads.
