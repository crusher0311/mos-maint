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

Prefer read-only, identity-specific filtering over permanent suppression of
siblings or a global recent-history lookback.

**Why:** An old exhausted terminal can fall outside a recent-history window.
Persistently suppressing another event based on a read snapshot also creates
recovery races unless every recovery writer shares the identity fence. The
chosen correction intentionally leaves unresolved notifications unchanged.

**How to apply:** Keep prefilter work capped and retain the final claim fence.
Measure selection overhead after deployment; fewer skipped claims alone is not
proof of better throughput. Do not interpret filtered events as completed or
recovered history.