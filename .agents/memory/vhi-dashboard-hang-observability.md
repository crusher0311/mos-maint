---
name: VHI dashboard hang is invisible in logs
description: Why a hung dashboard VHI/plan build leaves no log trace, and where the timeout protection does/doesn't exist
---

# Dashboard VHI build hangs are unobservable

The dashboard plan/VHI build (`app/dashboard/vehicles/[vin]/plan/page.tsx`) gathers
upstream data (Protractor vehicle/deferred/canned-jobs, CARFAX, DataOne, plus two
unindexed Mongo `events` `$toUpper` scans) with **no overall deadline and no
per-call timeout**. Consequence for debugging:

- A true hang emits **no** completion log and **no** `[upstream-timeout]` log — it
  just spins until the user gives up. **Absence of a slow-load log ≠ absence of an
  incident.** Don't conclude "it's not happening" from quiet logs.
- `slow_plan_load_logs` (Mongo) only records loads that **finish** at/above a
  threshold; it caps the value (~25s) and never sees real hangs. It was dormant
  (a handful of Jan records) during a live "keeps happening" complaint.
- Better Stack ingests only a fraction of info-level `[Plan]` breadcrumbs (heavy
  sampling) — you'll see a few Cache HIT lines, not every build.

**Where protection exists:** `lib/with-upstream-timeout.ts`
(`withUpstreamTimeout(promise, ms, label, fallback)` — races a timeout, returns
fallback, logs one `[upstream-timeout] <label> exceeded <ms>ms` warn) is now wired
into BOTH the extension routes (`/api/extension/plan`, `/ro-context`, canned-jobs)
AND the dashboard plan page build. So a future stall on the dashboard should emit
an `[upstream-timeout]` line instead of spinning silently — search that label
first. NOTE the helper uses `Promise.race` and does NOT cancel the slow op; it
just stops waiting, so the underlying call still finishes in the background.

**Why it mattered:** the dashboard web page (what shops actually stare at) was
originally left unprotected while the extension was fixed, so it could spin to
300s+ with no log trace.

**How to apply:** to make dashboard hangs both impossible and observable, wrap the
dashboard build's upstream calls in `withUpstreamTimeout` with per-call budgets and
an overall ceiling (~25-30s, matching the loading UI's promise), rendering
cached/partial data on timeout. Query Better Stack live via ClickHouse HTTP
(`BETTERSTACK_QUERY_*` env, all set in this repl): POST SQL to
`https://$HOST`, `SELECT dt, raw FROM remote(<source>_logs) WHERE raw ILIKE ...`.
