# Tekmetric overnight reconciliation — implementation status

**Not operational. Do not schedule or enable this code.**

The user approved broader invoice reconciliation, including automatic corrections
and removal of jobs/parts that are absent from a complete authoritative detail
response. This is not a DOT-only refresh.

## Implemented foundation

- Explicit per-shop timezone/window checks, failing closed for invalid settings.
- Bounded tick/request/response limits and no immediate retry after HTTP failure.
- Authority/window rechecks after capacity waits and provider reads.
- Complete-child validation: omission cannot authorize deletion.
- Full-payload evidence hashing that preserves array order, repeated DOT strings,
  and leading zeros.
- A dependency-injected worker core with revision conflict checks and a required
  atomic replacement/completion contract.

Nine offline policy/core tests and TypeScript pass. These tests use injected
dependencies; they do **not** prove database atomicity, distributed leasing,
provider transport behavior, or integration with production ingestion.

## Required before this is a working feature

1. Durable fenced claims, retry/cooldown state, per-shop fairness and checkpoints.
2. Changed-record discovery with a pinned upper bound and overlap, recent-record
   verification, and bounded rotating historical verification.
3. A worker-only provider transport with enforced shared admission, cancellation,
   response bounds and actual request accounting for every detail/enrichment call.
4. Real correction adapters for the project's canonical store configurations.
   Existing retained raw data and normalized entities can live in different stores;
   a PostgreSQL transaction alone cannot atomically replace both.
5. Fence ordinary ingestion against older in-flight parent **and child** writes.
   Checking the source revision before a correction alone is insufficient: an
   older ingestion may write its children after the corrected parent commits.
6. Replace/tombstone only invoice-owned jobs, lines and payments from explicit
   complete collections. Do not delete shared customer or vehicle records.
7. Gate affected reporting publication until correction and derived-data updates
   are consistent, retaining pinned/saved result semantics.
8. Dedicated worker entry point, status reporting, installation documentation,
   and real database crash/concurrency tests. No work on the web-serving process.

The existing normalization service's local transactional mode is explicitly
Protractor-only. Its general path can perform extra enrichment and auxiliary
writes, and upsert-only child handling does not establish removal correctness.
Do not wire it directly into this worker and describe that as safe reconciliation.

No schema installation, production enrollment, provider request, or live
correction was performed while building this foundation.
