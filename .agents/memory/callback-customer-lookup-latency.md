---
name: Callback customer lookup latency
description: Local Mongo natural-key fallback can dominate callback timeouts even when Protractor is responding quickly.
---

Trace callback normalization before blaming provider latency or increasing
request limits. Canonical Postgres operation does not eliminate the shadow
Mongo customer lookup on a Postgres miss.

**Why:** Production timeout telemetry showed a roughly 29-second customer
natural-key read while the provider fetch took about two seconds. Live index
inspection and a bounded planner-only check found the lookup using only a
shop-level index, filtering customer provenance within that shop. The shipped
source-lookup index did not match the queried provenance fields.

**How to apply:** Compare nested fetch, snapshot, and normalization timings;
inspect actual production index definitions and the exact natural-key query
shape before proposing an index. Do not call this a full-collection scan when
the plan is a shop-index scan. Keep live index creation and shadow-write
configuration changes operator-approved, and retain admission headroom for
local persistence as well as provider I/O.