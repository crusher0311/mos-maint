# Shared guided RO creation and DVI handoff

Dashboard and workflow Create New RO entry points use the same wizard and concern
assistant. Local check-in remains separately labeled; it is not a native RO.

Optional arrival photos are captured during vehicle entry. The browser retains
up to 12 JPEG/PNG/WebP files, each at most 4 MiB, in shop-and-advisor-scoped
IndexedDB. They upload only after confirmed RO creation and DVI permission checks.
They appear as arrival documentation, not checklist findings or completed evidence.

The original creation payload and request ID are frozen before submission.
The server records admission before provider I/O. Repeated requests only read the
saved outcome; they never replay the provider create. Late success can be recorded
after an HTTP timeout. Process-death ambiguity remains pending for operator review:
absence of a saved success does not authorize another creation.

After confirmation, photo retries and Continue to DVI cannot create another RO.
The handoff reads the exact current-shop native ID and official number, rejects
closed orders, imports the visit under concurrency checks, then opens its DVI.
It does not send native inspection results, publish customer links, authorize jobs,
or automatically mark any inspection complete.

Persistence uses additive Mongo collections with built-in unique primary keys.
No historical repair, production migration or rollout activation is included.
Arrival media documents are bounded below Mongo's document limit; deterministic
IDs make concurrent retries insert-only rather than overwriting evidence.

Verification uses disposable Mongo, denied external networking, actual route and
UI tests, and the offline browser fixture. Live native creation and signed-in
production use require a separately approved rollout; this implementation does
not claim to have exercised them.
