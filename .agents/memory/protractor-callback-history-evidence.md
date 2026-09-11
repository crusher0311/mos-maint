---
name: Protractor callback history evidence
description: How to interpret history evidence without changing callback retry semantics.
---

Keep history-application evidence separate from queue completion and transport success. A processed callback can have failed history indexing; coalesced siblings do not independently prove history application.

**Why:** Callback indexing failures were historically non-critical to queue completion. The outcome-reporting change deliberately preserves that retry/coalescing behavior rather than silently introducing provider replays. An applied result can also mean existing index content was hash-verified unchanged, not that a new write occurred.

**How to apply:** When extending callback reporting, do not derive applied status from processed/noAction, successful relay responses, or snapshot markers. Treat historical rows without explicit evidence as unknown. Changing which indexing failures trigger retries requires a separate operational decision, not an observability-only edit.

Interpret a trial's backlog by distinct shop/object identities and attempt counts, and interpret failures by stored cause and timing—not the generic dispatch-failure category.

**Why:** A read-only production trial audit found that most pending notifications were never attempted, many were duplicates, and most residual failures were unsupported contact events or admission deadlines at trial expiry rather than provider errors.

**How to apply:** Separate unsupported events, missing-data results, deadline deferrals, and transport failures before recommending throughput changes. A new trial's activation floor excludes the previous cohort; never imply that starting another trial automatically recovers its backlog.