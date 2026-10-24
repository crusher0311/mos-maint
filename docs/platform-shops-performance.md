# All Shops: split reads and verification

## Contract and dependencies

`GET /api/platform-admin/shops` retains its enriched response for Users and
HoverCode callers. `?view=core` returns the complete fleet, without usage,
backfill, audit or owner queries. `?view=summary` hydrates optional values;
`?view=history&shopId=…` retrieves expanded-row email history. Every mode
authorizes the platform-admin session before reading data.

Core owns name, stable row identity, enterprise, integration configuration,
billing/subscription/card state, trial dates, review decisions and features.
These drive global KPIs, all filters, grouping and bulk eligibility. None
are taken from a cached summary. The browser merges only usage/backfill
fields and rejects older response generations after refresh or mutation.
Existing mutation handlers still reload authoritative core data.

Usage and backfill values are null/loading until retrieved; failed reads
are explicitly unavailable, not zero. Successful empty counts are zero.
Email history is fetched on expansion, merges both numeric/string IDs,
retains legacy trial reminders and deduplicates cron records within 60s.
Mongo `$firstN` caps accumulation at ten per stored identity (Mongo 5.2+);
the final merged history is capped at ten.

## Cache and safety

Expensive read-only usage and zero-counter fallback queries use a 30-second
process-local cache, 64 entries maximum, 20,000 result rows maximum per
entry, with in-flight promise coalescing. Keys include identity store and
fleet scope; fallback keys also include the zero-counter subset. Failures
are not cached. Backfill status and email reads remain fresh after actions.
Monthly keys include the calendar month. Caches do not span processes.
Mongo optional queries/fallbacks have 5-second server execution limits.
Scoped Postgres VIN aggregation uses a transaction-local 5-second statement
timeout. Existing unscoped callers retain their previous query semantics.
No backfill state is written by any read.

## Isolated evidence (not production measurements)

Commands (no credentials, external network blocked):

```
env -i PATH="$PATH" HOME="$HOME" NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' node --import tsx --test tests/platform-shops-read.test.ts
env -i PATH="$PATH" HOME="$HOME" PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' node --import tsx --test tests/platform-shops-browser.test.ts
node_modules/.bin/tsc --noEmit --incremental false
```

The initial API baseline bundled the original route, with the
same synthetic stores as the changed route: 1,000 shops, mixed IDs, 100,000
audit records and 120ms delay per optional read. Initial observed timings:
blocking baseline 264ms; split core 22ms; first summary 266ms; repeat summary
145ms. Timing varies with host load; test output records each run. Synthetic
history evaluates sorting and bounded versus unbounded accumulation, but
does not simulate Mongo's query planner or physical IO.
The committed regression uses a frozen model of that original dependency
graph (nine optional parallel reads, then fallback) so merging this change
does not silently turn the baseline into the new route. A subsequent full
original-route run measured 321ms baseline, 20ms core, 283ms first summary,
157ms repeat summary; browser usable rows took 3,054ms.

The browser mounts the actual All Shops component against the actual GET
handler with synthetic stores. With summaries explicitly held unresolved,
1,000 rows became available in 3,717ms (includes browser bundle/DOM work).
It verifies searching while loading, expanded history, retained rows and
scroll during refresh, retained search on success/failure, unavailable
summaries, and rejection of an older core response after a newer edit.
The unrelated DataStatusPanel is stubbed; the authenticated Next layout is
not booted. This is not a live signed-in production UI check.

## Rollout checks (operator-owned, not executed here)

1. Compare `[platform-shops-read]` authentication/core/individual summary/
   fallback/total timings and browser usable-row latency on the same fleet.
   Logs contain only static stage names, duration and success flags.
2. Verify KPI/review counts and enterprise grouping against the old response,
   including PG-canonical identity mode and mixed numeric/string Mongo IDs.
3. Verify completed/stale/error backfill states and real nonzero counters,
   then repeat within/after the 30-second cache TTL.
4. Verify expand/email history and a successful rename/review/billing action.
5. Check Mongo version supports `$firstN`; examine actual query plans and
   existing index definitions with an approved read-only session before
   recommending an index. No query-plan evidence was collected here, so
   there is no index migration recommendation.

No deployment, live datastore queries, index installation, repair,
backfill or canonical setting change was performed. The dominant production
bottleneck remains unmeasured.
