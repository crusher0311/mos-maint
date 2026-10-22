---
name: Reporting feed progress and driver tokens
description: Why invoice inventory progress is separate from publication and how the installed Mongo driver affects durable resume.
---
Preserve bounded shadow inventory under invalidation traffic without treating
progress as report freshness. Require an unchanged verification pass and exact
source versions before publication.

**Why:** Active-shop traffic prevented even admission with single-event polling;
discarding a long inventory on every coarse revision creates another starvation
loop. Installed fleet-wide PG triggers remain an operator-owned safety boundary;
they can still prevent a stable publication window.

**How to apply:** Do not solve delayed publication by weakening triggers, expiry
or review requirements. Keep population, review and reader activation separate.
Treat narrower PostgreSQL invalidation as a separately approved change.

The installed MongoDB 6.19 driver's `tryNext()` does not cache event resume
tokens. A synthetic stream that advances `resumeToken` for every event conceals
this incompatibility.

**Why:** Persisting that property after a bounded nonempty batch can replay the
same events indefinitely. Using an unconsumed batch-end token would instead
skip evidence.

**How to apply:** Persist consumed event `_id`s; use a post-batch token only
after an observed empty batch. Recheck this behavior when changing driver
versions and keep crash/replay tests representative of the installed driver.

`LIMIT 1` does not bound source enumeration work when cursor ordering cannot
use the shop's index.
**Why:** The first production inventory read timed out with no committed source
rows; its plan scanned the shop and sorted roughly 19,000 rows for C-collated
text IDs. Native-ID order instead filtered the global primary key, which is
not a guaranteed bounded per-shop path either.
**How to apply:** Inspect actual indexes and non-executing query plans for each
source channel. Test realistic size and cross-shop skew, preserve cursor order,
and review any index installation separately; do not merely raise deadlines.
