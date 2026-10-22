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

## Approved 60-second production pilot

2026-10-22 16:55:26 UTC: after fresh target, flag, permission, index, scoped-function
body/ACL, trigger and health checks, the restricted operator resumed MOS 227.
No migration or deployment was performed. There was no separate feed-drain
budget; runtime's normal before/after feed checks stayed inside the pilot.

The 60-second work budget completed in 60,879 ms including bounded in-flight
completion and final status reads. Thirteen ticks committed 310 documents
(12 x 25 plus 10), increasing inventory from 85 to 395 documents and from 85
to 401 identities. Every tick returned deferred; none reported busy, failed,
or complete. No financial reviews were added.

Independent readback at 16:55:34 UTC confirmed the same counts, inventory
phase/channel 0, no stored failure or publication, and epoch feed freshness.
Post-run health: one active query, no lock waiters or old idle transactions;
all 44 scoped triggers remained enabled. The pilot stopped and all connections
closed. Shared reader/builder switches stayed off; zero Protractor calls.

Compared with 53 records in the preceding approximately one-minute pilot,
310 is about 5.8 times as many. This is an observed short-run comparison, not
an end-to-end completion forecast; later channels, feed catch-up, verification,
projection and evidence review remain outstanding.

Receipts: population-batch-pilot-20261022.json and
population-stopped-20261022.json under the ignored reporting snapshot directory.
