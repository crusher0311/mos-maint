---
name: Export worker integration fixture boundaries
description: Offline process tests must preserve real lease timing and account for tsx dynamic-import loading.
---
Recovery tests should retain both the queue's stalled-job timing and the export
engine's longer lease. A recovered queue job can finish without delivering while
the old engine lease remains valid; a later scheduler wake-up is still required.

**Why:** Treating BullMQ completion alone as successful export recovery would
miss pending customer delivery state after a forced drain.

**How to apply:** Assert durable pending/checkpoint state and unchanged delivery
identity after lease expiry, not only a completed queue job.

tsx can load dynamic TypeScript imports through encoded data URLs rather than a
normal filesystem Module._load identifier.

**Why:** A path-only test preload failed to intercept the database facade; the
deny-by-default database guard caught the attempted real dependency import.

**How to apply:** Intercept a stable repository boundary as well as the facade,
and keep network and real-database import denial independent of fixture injection.
