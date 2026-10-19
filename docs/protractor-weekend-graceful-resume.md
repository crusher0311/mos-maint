# Local graceful page resume

The weekend child receives the parent's absolute hard deadline. Before each
invoice it reserves 130 seconds: the unchanged 120-second invoice watchdog plus
10 seconds of margin. If that time is unavailable it saves the next invoice
position and accumulated unresolved count against the immutable page digest.
Only after acknowledgment does it send a drained IPC yield message and exit.

The runner accepts a yield only after a zero exit and a persisted marker for
its current owner. It leaves the day/page unchanged, clears the failure streak,
closes the provider grant in `finally`, and rotates to another shop. Yield is
not reported as a completed page. The next visit resumes from the page
checkpoint; existing receipt checks still protect previously committed or
ambiguous work if the process died before saving a new checkpoint.

The hard page and invoice timeouts remain. A genuinely stuck invoice can still
time out and leave a held receipt. Historical held days and processing receipts
are not reset, replayed or marked successful by this change. Operator stop,
callback activity, lease, request-budget and campaign-expiry checks remain.

Offline tests exercise worker yield/resume, retained partial-write uncertainty,
checkpoint acknowledgment failure, and a real IPC subprocess returning a yield
to the runner. Existing failure, fairness and expiry regression suites also run.

## Approved production handoff — October 19, 2026 UTC

The operator approved a prerequisite check and controlled restart. The identity
index was valid, the existing worker artifact matched the expected base, and
the prior runner was the only active one-off job. Its campaign admissions were
stopped at 04:16:28 UTC. It drained and exited successfully without cancellation,
forced lease clearing, or a forced process kill.

Replacement job `job-dbapj9rbc2fs73ca52r0` was created on the existing callback
worker service. Its bootstrap verifies original file hashes and installs the
tested runner, ingester, entry point, lookup, scheduling, and held-failure
modules. The replacement claimed the campaign at 04:18:03 UTC.

Live verification observed:

- New completed invoice imports after the replacement claimed ownership.
- Grove Street / shop 163 emitted `weekend_page_yielded` at 04:20:29 UTC.
- Its September 10 page remained unchecked, with a durable next-invoice
  position of 2 and zero unresolved items accumulated before that checkpoint.
- Its shop checkpoint remained on the same day/page, status `progressing`,
  with zero failures. The four previously held dates remained held.
- Subsequent processing continued for other shops.

This proves initial live yield and continued fleet work, not yet a complete
return-to-that-page resume cycle or fleet completion. Offline tests cover resume
behavior. Request use was preserved at 2,797 during handoff and later advanced
to 2,803; the cap remains 10,000 and expiry remains October 19 at 10:00 UTC
(5 AM Central). No old processing receipt or held day was replayed or cleared.

This was an isolated one-off runner handoff, not a main-app deployment or a
release of the regular worker artifact. No further history window, budget
increase, repair, or restart is authorized by this handoff.
