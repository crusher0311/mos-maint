# Bounded reporting pilot: local diagnosis

## Scope and result

2026-10-22: diagnosis and isolated regression tests only. No production query,
write, migration, population, shared flag change or deployment in this diagnostic
step. The preceding authorized pilot retained 32 documents/identities, reported
busy/deferred ticks, and left the Mongo freshness timestamp at epoch.

The installation and worker suite passed against disposable PostgreSQL 16.10,
with ambient credentials removed and network egress denied:

`bash tests/run-reporting-projection-worker.sh`

## Reproduced mechanisms

### Scope contention from operational writes

The installed candidate statement trigger updates all reporting scopes for
source writes, regardless of the source row's shop. The new test holds an
unrelated-shop operational INSERT transaction open after its real trigger fires.
A single builder then returns busy with no checkpoint advance. On commit, the
same checkpoint resumes and commits exactly one document.

This proves a source of contention without needing a second builder. It does
not identify which production transaction held the scope during the pilot.
Conversely, the builder holds its scope lock across source retrieval and
per-document writes, so narrowing its transaction duration matters too.

### Per-record sequential round trips

A one-document, one-identity inventory step performs twelve reporting-side
exchanges, counting BEGIN and COMMIT. A local wrapper injects 20 ms for each
exchange and asserts the real SQL still commits one document; measured elapsed
time was 253 ms. Source reads were synthetic and are excluded.

The production PostgreSQL source additionally opens a read transaction, sets
read-only mode and its statement deadline, reads the candidate, and commits.
Indexes remove the scan/sort bottleneck but do not remove this sequential
network cost. This test is not a production throughput forecast.

### Bounded stream consumption cannot imply catch-up

The event budget is 100 per poll, with two polls per successful runtime tick.
Four ticks therefore consume at most 800 events, and time budgets/errors can
lower that maximum. The new 801-event fixture proves eight polls commit durable
tokens without marking freshness. The ninth observes exhaustion, accounts for
all 801 events without duplicates, and only then sets a fresh timestamp.

The live backlog count and consumption rate were not measured by the preceding
pilot. Epoch is consistent with safe draining; it is not proof that the driver
is broken or that the source has no data.

## Recommended next local engineering

1. Batch bounded inventory bookkeeping and source reads to reduce round trips.
   Retain byte/row/time limits, exact digest/cursor order, atomic checkpoint
   writes, replay behavior and cancellation coverage. Measure artificial network
   latency, not only local warm-database execution.
2. Design shop-scoped PostgreSQL invalidation using authoritative old and new
   ownership. Cover deletes, moves, bulk writes, joins to parent ownership,
   unknown ownership and TRUNCATE; preserve fleet-wide fallback when ownership
   cannot be proven. Production trigger changes need a separately reviewed
   migration, not an ad-hoc removal.
3. Give bounded feed catch-up its own scheduling budget and sanitized progress
   metrics rather than tying its throughput solely to inventory ticks.
   Never mark draining as fresh, skip events, extend freshness to conceal lag,
   or publish before the unchanged verification pass.

The complete verification/projection phase must also fit the existing freshness
window. Faster inventory alone does not prove deployability. Keep reads off
until end-to-end evidence and performance checks pass.
