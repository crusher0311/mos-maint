# Local multi-record batching validation

Production unchanged; no population, deployment, flags or migration executed.

## Changes

- PostgreSQL inventory and verification read at most ten records per page, in
  the original C-collated cursor order. Candidates are limited before full-row
  serialization. Each row retains the 16 MiB cap; the returned contiguous prefix
  is capped at 32 MiB. Server-side intermediate work is bounded to ten candidates,
  not to 32 MiB; the wire cap is not a total PostgreSQL memory guarantee.
- Inventory commits sources, distinct identities, references, counts, cursor and
  sequential digest together using one bounded statement. One transaction commits
  the batch or none of it. Tick step accounting counts documents, not batches.
- Verification compares all page keys/digests to retained evidence, preserving
  changed/new source rejection and sequential digest equivalence.
- Mongo enumeration and final per-identity projection retain their single-record
  paths. Exact loads are unchanged; no cross-tick source cache was added.

## Evidence

PostgreSQL 17.6 disposable full-shop fixture:
20,000 synthetic source documents/identities completed inventory, verification
and final projection in 186,336 ms over 2,401 ticks. All 20,000 correctly remained
unresolved without financial reviews. Real PostgreSQL reporting writes were
used, but source retrieval was synthetic and no network latency was injected.
This is a correctness/scale test, NOT a production completion estimate.

The regular suite passed on PostgreSQL 16.10, including actual PostgreSQL paging
over 23 rows, exact single-row digest equivalence, shared identities, atomic
rollback/replay, step/deadline safeguards and existing authorization tests.
Three 12 MiB rows return a two-row prefix followed by the remaining row; a
17 MiB row raises the existing oversized-source error, never silently disappears.

With 20 ms artificial reporting RTT, ten inventory records share eight reporting
exchanges rather than eight per record. Source-network cost is excluded from this
specific measurement. TypeScript checking passed with the final assertions.

## Reproduce

`bash tests/run-reporting-projection-worker.sh` runs regular checks.
`bash tests/run-reporting-projection-worker.sh --batch-scale` adds the 20,000-record
full-shop fixture with a four-minute outer test bound. All connections use a
temporary Unix-socket PostgreSQL instance, ambient credentials are stripped,
and network egress is denied.

## Remaining proof

A fresh bounded live pilot is needed to measure actual inventory gain. Mongo
enumeration, complete verification/project time under network latency, feed
catch-up, and financial review completeness remain separate gates. Do not enable
reports because an unreviewed synthetic build reached its complete phase.
