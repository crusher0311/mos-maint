# Normal Protractor history operations

This change is local until separately released. It neither changes production
configuration nor unsuspends any existing worker.

## Operating path

Platform Admin → Protractor History manages automatic history for connected,
non-cancelled Protractor shops. Empty rollout selection means all eligible shops;
an explicit selection supports gradual deployment. Operators confirm seven-day
business hours, the history horizon and optional timezone fallback. Saved shop
timezone takes precedence; invalid/missing timezone blocks execution.

Controls enqueue, retry without resetting cursors, pause and resume. Queuing
does not override hours, rate limits or the emergency stop. Settings are
revision-checked; loading a page never starts work. Settings and dispatch
authority share the existing physical transport document.

The dedicated worker is `scripts/protractor-fleet-history-worker.ts`. Its
startup switch is `PROTRACTOR_FLEET_HISTORY_WORKER_ENABLED=true`; absent means
disabled. It refuses execution outside Render. Do not run it in this workspace:
development Mongo is production. Deploy it separately from the web process;
do not revive legacy unrestricted workers as part of this rollout.

One renewable fleet lease allows one history runner across replicas. Each tick
selects at most the configured one-to-three shops sequentially, oldest attempted
first, and runs one existing checkpointed chunk per shop. Health-ping failures
defer admission. Failure backoff grows to one hour. History admission is capped
at 500 physical requests per grant, with no refund for failed requests.

Every request must pass the physical relay admission boundary, current account
binding, config revision, shop pause/cancellation, business hours and emergency
stop. The grant expires without renewal; opening has a five-minute admission
margin. In-flight network/local writes may finish after pausing. Neither pause
nor queue clears a checkpoint writer marker or steals an active shop backfill.
Stale activity beyond 30 minutes can reach the canonical engine's existing
atomic lease reclaim; a checkpoint writer marker still blocks that recovery.
Callbacks and interactive requests retain their separate authority.

## Release gates

Local verification: `bash tests/run-protractor-fleet-history.sh`. The Mongo
test starts and destroys its own loopback database; it requires `mongod` on PATH.
The runner excludes configured credentials and denies external network traffic.

Run offline policy, transport, Mongo and UI regressions and production build.
Review deploy target and existing DB indexes before release. Default controls
remain disabled. Enable a small rollout first, verify actual cursor advancement,
callback delay, database load and shutdown at opening, then widen through the
UI without code/secret edits per shop. Worker startup is one-time deployment
configuration, not a per-shop gate.

This implementation does not create indexes or migrate the canonical progress
store. Mongo/PG progress routing and existing ingestion idempotency remain.
