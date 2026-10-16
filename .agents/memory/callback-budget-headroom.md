---
name: Callback budget headroom
description: Keep completion time separate from callback admission time when tuning throughput.
---

Callback admission budgets must leave room for already-admitted work to finish
before the scheduler times out. Provider request headroom alone is insufficient.

**Why:** A proposed 45-second trial left only five seconds under the scheduler
timeout, while observed callback processing p95 was about 7.6 seconds. The user
approved a smaller increase instead. Admission deadlines do not abort durable
completion, so the remaining margin is not a guaranteed completion bound.

**How to apply:** Compare live callback-duration distributions against the
scheduler timeout and lease before extending budgets. Keep pacing, concurrency,
retry limits, and held-history restrictions unchanged during isolated budget
trials. Evaluate timeout/overlap and interactive latency alongside throughput.

Compare callback timing records against the caller's budget, not a single global
threshold.

**Why:** Production comparison windows contained minute-drain deadline batches
alongside much longer completed batches. The periodic sync caller has a longer
budget but emits the same timing format, without caller identity. Treating all
long batches as minute-drain overruns would produce a false regression finding.

**How to apply:** Correlate timing with scheduler invocations where possible.
Otherwise report mixed-caller latency and attribution limits explicitly; do not
claim a specific admission-budget violation from completion duration alone.

Separate actively processed callback age from superseded-record age when
measuring queue freshness.

**Why:** Durable completion also closes older duplicate notifications. Their
received-to-completed ages can inflate a delay distribution, while raw completed
row counts overstate provider work. Successful HTTP responses can coexist with
hours-old callbacks and expensive local persistence.

**How to apply:** Report attempted, non-superseded callback latency separately;
compare stage timings for fetch, persistence, and completion without summing
nested timing totals. A batch's normal admission-deadline exit is not itself
an upstream timeout or evidence that unfinished work was discarded.

Initial callback pipelining must overlap different shops only, not arbitrary
callback objects, and remain opt-in with a two-slot first trial.

**Why:** A WorkOrder and ServiceItem can update the same vehicle despite having
different callback object IDs. The user approved building configurable overlap,
not enabling production or relaxing provider safeguards. More slots may increase
database contention without increasing permitted provider capacity.

**How to apply:** Keep same-shop work serial through durable completion, retain
the single dedicated worker instance and existing fleet transport guards, and
measure a two-slot trial before considering three or four. Deployment and live
enablement require separate approval.