---
name: Protractor callback history evidence
description: How to interpret history evidence without changing callback retry semantics.
---

Keep history-application evidence separate from queue completion and transport success. A processed callback can have failed history indexing; coalesced siblings do not independently prove history application.

**Why:** Callback indexing failures were historically non-critical to queue completion. The outcome-reporting change deliberately preserves that retry/coalescing behavior rather than silently introducing provider replays. An applied result can also mean existing index content was hash-verified unchanged, not that a new write occurred.

**How to apply:** When extending callback reporting, do not derive applied status from processed/noAction, successful relay responses, or snapshot markers. Treat historical rows without explicit evidence as unknown. Changing which indexing failures trigger retries requires a separate operational decision, not an observability-only edit.

Interpret a trial's backlog by distinct shop/object identities and attempt counts, and interpret failures by stored cause and timing—not the generic dispatch-failure category.

**Why:** Notification counts overstate distinct work when callbacks are duplicated, and generic failure categories can conflate unsupported objects and local safety deadlines with actual provider errors.

**How to apply:** Separate unsupported events, missing-data results, deadline deferrals, and transport failures before recommending throughput changes. A new trial's activation floor excludes the previous cohort; never imply that starting another trial automatically recovers its backlog.

Unsupported Contact notifications must remain unresolved customer-sync work,
not successful history updates or discarded events. Automatic retry suppression
does not authorize deleting them or replaying an older trial cohort.

**Why:** No customer-sync replay contract has been approved; retrying the absent
handler wastes capacity, but treating the work as done would hide a real gap.

**How to apply:** Require an explicit customer-sync decision before releasing
held Contact work. Preserve its payload and distinguish it in outcome reporting.

Queue failure accounting and physical provider admission accounting are
separate. A known local safety deferral may undo only its queue attempt;
physical admission remains charged, even if expiry prevents dispatch.

**Why:** Safety-boundary waits are not evidence of a provider failure, while
refunding ambiguous physical admissions would undermine the trial budget.

**How to apply:** Keep deferrals owner-fenced and idempotent. A batch deadline
must stop new provider work without suppressing real evidence returned by
already-admitted work; durable completion still needs the existing owner fences.

Diagnose growing callback queues using full callback completion time, not only
relay latency, and compare work-order callbacks with vehicle callbacks.

**Why:** Production work-order callbacks were substantially slower end-to-end
than their successful relay attempts, while vehicle callbacks stayed fast.
Increasing outbound concurrency without separating these stages would also
multiply local ingestion load. Some old callbacks still progressed even while
the overall actionable queue grew, so growth did not establish a global lockup.

**How to apply:** Compare several activation-scoped snapshots, excluding retained
Contacts and exhausted retries from actionable work. Count unique objects as
well as notifications, and distinguish owner completion from coalesced siblings.
Use stage timing to establish the expensive operation before tuning capacity;
source-code fanout alone is a hypothesis, not measured causation.

Do not interpret a PG miss followed by Mongo fallback as proof of migration
drift. First-time normalization also misses both stores before creating both.

**Why:** A bounded production comparison found matching PG/Mongo identities,
with many rows created during callback processing. The Mongo fallback's
query planner chose a shop/vehicle index bounded only by shop, despite an
existing compound provider-identity index.

**How to apply:** Compare creation times and matching keys before scheduling a
backfill. Inspect the actual fallback query plan and all compound-index
prefix predicates before adding an index or retiring recovery behavior.

Prefer the redundant dotted provider-ID predicate plus the original full
`$elemMatch` over a hard index hint for callback work-order recovery.

**Why:** Bounded production hit/miss explains selected the existing compound
provider index naturally with only two keys examined. A forced hint adds
availability risk where that index is absent, while filtering on top-level
sourceSystem would exclude legacy records that omit it.

**How to apply:** Preserve the complete same-element identity match and monitor
the existing operation timing after rollout. Revisit planning only on measured
regression; do not remove legacy recovery based on this optimization.

Increase callback processing opportunity separately from provider pacing and
historical/background admission.

**Why:** The daytime queue accumulated mostly unattempted notifications despite
successful retrievals. Enabling unrelated background work would add competition
without increasing the callback worker's execution window.

**How to apply:** Prefer an isolated worker-budget change first. Include setup
and pre-admission waits in short scheduler deadlines; retain durable completion
for already-admitted work. Scheduler headroom is nominal, not a hard guarantee
when database persistence stalls.