---
name: Public report mileage policy
description: Public VHI projection and customer reading safety boundaries.
---

Public VHI visits and customer mileage submissions must never trigger paid CARFAX requests, including detached stale-while-revalidate work. Use cached history/estimates only.

**Why:** Permanent QR links are revisited without a shop employee present; anonymous traffic must not create billable lookups.

**How to apply:** Keep cache-only CARFAX enforced at the actual build call, not merely at the public route's estimate read.

Customer-entered mileage is an unverified actual reading with separate provenance, not an RO reading. Never write it back to an SMS provider or disguise it as a technician reading. Apply sane bounds and a monotonic floor before using it.

**Why:** The requested customer feature explicitly excludes SMS write-back and requires shops/on-call to distinguish customer input from shop readings.

**How to apply:** Preserve the source and timestamp when using customer readings in subsequent plans. Administrative correction of mistyped high readings requires a separate authorized workflow.
