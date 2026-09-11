---
name: Protractor callback history evidence
description: How to interpret history evidence without changing callback retry semantics.
---

Keep history-application evidence separate from queue completion and transport success. A processed callback can have failed history indexing; coalesced siblings do not independently prove history application.

**Why:** Callback indexing failures were historically non-critical to queue completion. The outcome-reporting change deliberately preserves that retry/coalescing behavior rather than silently introducing provider replays. An applied result can also mean existing index content was hash-verified unchanged, not that a new write occurred.

**How to apply:** When extending callback reporting, do not derive applied status from processed/noAction, successful relay responses, or snapshot markers. Treat historical rows without explicit evidence as unknown. Changing which indexing failures trigger retries requires a separate operational decision, not an observability-only edit.