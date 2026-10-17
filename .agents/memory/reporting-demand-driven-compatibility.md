---
name: Demand-driven reporting compatibility
description: Product compatibility rules when moving reporting from synchronous dashboards to durable cached runs.
---

Demand-driven reporting is not only a query-execution change. Preserve immutable saved-version behavior, pinned delivery links, management of existing schedules (including legacy ones), and the full recipient scope identity used during delivery reauthorization.

**Why:** These surfaces are easy to strand when replacing a dashboard-first page or synthesizing background-worker sessions. The report can be technically cached and authorized while still showing the wrong saved version, leaking old run state across selections, or making existing deliveries impossible to manage.

**How to apply:** Any reporting lifecycle change should test opening a pinned delivery URL, switching definitions during an active run, editing then saving/running a saved version, managing a pre-existing schedule, and validating enterprise recipient scope before delivery.

Incomplete data with explicit coverage is an accepted product outcome for invoice-hour reporting; it is not permission to repair history or contact providers.

**Why:** Verified invoice populations differ from terminal work-order counts; existing imports and fallback close dates cannot justify silently treating missing invoice or hour evidence as zero.

**How to apply:** Preserve that availability boundary when improving reporting. Extending source support or repairing history requires separate scope; do not repurpose the legacy closed-RO measures as invoice averages.

Reporting filters must be available independently of report execution.

**Why:** A platform-wide invoice report exceeded the bounded scan, but location
choices depended on that same report succeeding. Users could not narrow the
query to recover, and generic failure sanitization hid the actionable limit.

**How to apply:** Load authorized scope metadata without querying history. Keep
bounded-query failures distinct from SQL faults, with safe recovery guidance.
Do not remove query bounds or filter by fallback close dates to disguise an
invoice-evidence population problem.

An invoice date-range optimization must retain other representations of the same
candidate identities, even outside the requested dates.

**Why:** Dropping an out-of-range conflicting date can turn an uncertain invoice
into a falsely complete denominator. Unknown copies may also be resolved by a
verified copy outside the period.

**How to apply:** Test conflicting dates and missing-evidence copies across the
date boundary; keep unknown-population work explicit and bounded. Treat matching
partial indexes as an operator-approved rollout, not an assumed production fact.

Keep full current authorization separate from effective execution locations.

**Why:** A definition may explicitly select two shops and then filter to one.
Recompiling that definition against the one-shop execution scope incorrectly
rejects the other selected shop. Historical runs can also have a broader stored
authorization set than their displayed location rows.

**How to apply:** Revalidate definitions against full current authorization;
use the effective intersection for queries and new cache identities. Reject
empty intersections before queueing, and authorize historical reads against
their stored scope without demanding equality with the new query subset.

Reporting fixes prompted by JWT are fleet-wide, not JWT-only rollouts.

**Why:** The user explicitly clarified that JWT exposed a shared reporting issue,
not a customer-specific feature request.

**How to apply:** Apply shared reporting corrections to all eligible shops and
enterprises, preserving authorization boundaries and provider evidence requirements.