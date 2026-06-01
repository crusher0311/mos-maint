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

**Where protection exists vs not:** `lib/with-upstream-timeout.ts`
(`withUpstreamTimeout(promise, ms, label, fallback)` — races a timeout, returns
fallback, logs one `[upstream-timeout] <label> exceeded <ms>ms` warn) is wired into
the **extension** routes only (`/api/extension/plan`, `/ro-context`, canned-jobs).
The **dashboard** plan page never got it. In prod the only caught stalls are
Tekmetric RO fetches >6s on the extension — which degrade gracefully there.

**Why:** the same 30s+ upstream-hang symptom was already fixed for the extension
panel; the dashboard web page (what shops actually stare at) was left unprotected,
so it can spin to 300s+.

**How to apply:** to make dashboard hangs both impossible and observable, wrap the
dashboard build's upstream calls in `withUpstreamTimeout` with per-call budgets and
an overall ceiling (~25-30s, matching the loading UI's promise), rendering
cached/partial data on timeout. Query Better Stack live via ClickHouse HTTP
(`BETTERSTACK_QUERY_*` env, all set in this repl): POST SQL to
`https://$HOST`, `SELECT dt, raw FROM remote(<source>_logs) WHERE raw ILIKE ...`.
