---
name: Callback claim mismatch
description: Diagnose deterministic skipped claims before increasing callback runtime or provider capacity.
---

High skipped-claim counts can reflect incompatible selection and winner rules,
not provider congestion or competing workers.

**Why:** A read-only production simulation found selected, unattempted callbacks
blocked by a different same-object winner that had already exhausted its retry
allowance. Increasing worker time alone cannot resolve that mismatch.

**How to apply:** Reproduce both selection and authoritative winner choice from
one bounded read snapshot, including exhausted rows and terminal precedence.
Distinguish this from lease contention and live-arrival races. Preserve terminal
ordering, ownership fences, and retry limits when designing a correction; never
blindly ignore an exhausted terminal event to replay an older update.