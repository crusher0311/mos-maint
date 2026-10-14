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