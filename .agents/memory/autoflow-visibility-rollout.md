---
name: AutoFlow visibility rollout
description: Keep provider-number ownership rollout separate from per-shop workflow visibility and use offline verification.
---

Treat AutoFlow number attachment and dashboard visibility as separate operator checks. Do not infer a missing normalized-ingestion adapter just because an AutoFlow-only dashboard is empty.

**Why:** A confirmed provider number could be absent from both aliases and the unresolved list, while successfully received events used shop-specific labels that none of the legacy active labels recognized. Ingestion success did not prove either extension identity resolution or dashboard eligibility.

**How to apply:** Recheck ownership before authenticated number attachment; review workflow semantics independently, especially appointment and administrative stages. Leave production configuration to the authorized operator and verify both results before claiming a live shop is fixed.

Use offline component fixtures for isolated browser verification, not an ordinary application boot with shared database credentials.

**Why:** Application startup can create indexes and write scheduler bookkeeping before any user action. Merely opening an apparently read-only preview is not necessarily a read-only production operation.

**How to apply:** Keep test servers fixture-only and build copies free of environment files and credentials. Do not weaken application authentication or alter production settings to get a screenshot.