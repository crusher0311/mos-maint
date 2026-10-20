---
name: Degraded readiness scope
description: Authorization boundary for interpreting isolated Protractor outage evidence.
---

Treat degraded-operation readiness evidence as an assessment, not authorization
to introduce offline creation, sync-back, or live failure experiments.

**Why:** The user explicitly separated the readiness review from the broader
outage-mode draft. Synthetic upsert/merge fixtures cannot establish native
provider semantics, even when every assertion passes.

**How to apply:** Keep fixture pass/fail separate from pilot go/no-go. A
characterization test can pass by reproducing unsafe behavior. Require separate
authorization and provider-side evidence before treating those flows as usable.
