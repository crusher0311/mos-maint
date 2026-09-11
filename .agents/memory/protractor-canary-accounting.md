---
name: Protractor canary accounting
description: Safety and audit tradeoffs for bounded fleet canaries
---

Count physical admission at the Mongo confirmation, never from runtime logs. Do not refund an admission after a lost confirmation response or a subsequent local cancellation.

**Why:** Once confirmation commits, the caller may have dispatched even if the coordinator never receives its result. Refunding would permit more real requests than the agreed budget. Render build smoke tests also emit mocked transport telemetry.

**How to apply:** Preserve conservative accounting across retries and failures. Keep terminal causes immutable, use Mongo time at the write boundary, and keep the physical safety record outside rate-limit TTL deletion. Legacy traffic without a canary remains compatible; a completed canary never silently becomes unrestricted traffic.