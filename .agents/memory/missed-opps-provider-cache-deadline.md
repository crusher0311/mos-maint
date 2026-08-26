---
name: Missed Opportunities provider-cache deadline
description: Production lesson on separating report request latency from optional Protractor enrichment and VHI-plan coverage.
---

Treat Protractor cache recovery in Missed Opportunities as optional enrichment under one shared, database-enforced deadline. If it is slow, return the report using canonical normalized ticket data rather than letting enrichment consume the request lifetime.

**Why:** A production request completed server-side with HTTP 200 but took about 58 seconds and appeared failed to the user. Roughly 54 seconds came from provider-cache enrichment, especially the raw invoice cache; report-cache read and core evaluation were fast. Bounding the full enrichment stage reduced a same-data computation to about 8 seconds.

**How to apply:** Include display-number recovery and all package/invoice cache reads in the same budget, enforce deadlines at Mongo/Postgres, log each lookup, and fail open. Diagnose report completeness separately: expired/mileage-incompatible VHI plan caches can make most ROs unevaluable even after latency is fixed.