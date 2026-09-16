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

Use bounded rejection reasons plus stable hashed event/object fingerprints for
claim investigations, rather than adding raw identifiers or extra database reads.

**Why:** Repeated start-of-batch skips could not be attributed retrospectively
from stage-only timing logs. A later matching-winner snapshot cannot prove what
happened during an earlier claim; more query load would also perturb timing.

**How to apply:** Keep telemetry observational and fail-safe. Label guarded
candidate failures as unavailable unless the existing evidence distinguishes
retry exhaustion from completion or removal; do not invent a specific cause.

Lease expiry alone does not guarantee that interrupted work will be retried.
Check whether the affected identity still appears in the bounded candidate window.

**Why:** A production follow-up found expired, unfinished claims whose entire
object histories had fallen behind the newest-candidate cutoff. Other rejected
claims recovered normally. The remaining expired leases were no longer the
admission blocker; candidate starvation prevented another attempt.

**How to apply:** Separate ownership conflicts from selection starvation. Any
older-work recovery proposal must retain the activation floor, retry limits,
terminal precedence, and physical request budget rather than simply clearing
leases or increasing runtime.

Older-work recovery must advance through raw pages before eligibility/authority
filtering, and preserve its position across deployments with fenced cursor writes.

**Why:** A fixed oldest page can be filled by siblings blocked by exhausted
terminal winners, while a process-local cursor restarts at that prefix on every
deploy. Unconditional shared-cursor updates let a delayed worker overwrite newer
progress. None of these problems is fixed by the callback's provider-work lease.

**How to apply:** Keep recovery scheduling separate from callback state. Scope
cursor metadata to the backend and activation floor, use compare-and-set for
advancement and wrap, and retain exact terminal-authority checks at claim time.