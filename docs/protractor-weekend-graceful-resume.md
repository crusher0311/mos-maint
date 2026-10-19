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

This is local code only. Applying it to the running one-off Render job requires
a separately approved handoff including all changed worker/runner/entry files.
No new history window, budget, replay, or production restart is authorized.
