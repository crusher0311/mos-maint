---
name: Demand-driven reporting compatibility
description: Product compatibility rules when moving reporting from synchronous dashboards to durable cached runs.
---

Demand-driven reporting is not only a query-execution change. Preserve immutable saved-version behavior, pinned delivery links, management of existing schedules (including legacy ones), and the full recipient scope identity used during delivery reauthorization.

**Why:** These surfaces are easy to strand when replacing a dashboard-first page or synthesizing background-worker sessions. The report can be technically cached and authorized while still showing the wrong saved version, leaking old run state across selections, or making existing deliveries impossible to manage.

**How to apply:** Any reporting lifecycle change should test opening a pinned delivery URL, switching definitions during an active run, editing then saving/running a saved version, managing a pre-existing schedule, and validating enterprise recipient scope before delivery.