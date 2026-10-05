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