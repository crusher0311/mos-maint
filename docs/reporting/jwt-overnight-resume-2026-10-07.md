# JWT guarded resume — October 7, 2026

User authorized an earlier start because shops will be closed:
October 7, 6 p.m. Central to October 8, 5 a.m. Central.
This is a one-time dated exception, not a standing daytime backfill policy.
The regular per-shop quiet-window checks remain. At preflight, the first shop
was eligible from 7 p.m. Central, so a 6 p.m. runner will wait.

The command is:
`NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' ./node_modules/.bin/tsx scripts/run-jwt-overnight.ts --resume-2026-10-07`

## Scope and guardrails

- New child of the paused October 6 run; immutable parent outcome fingerprint,
  manifest, parent identity, counters and checkpoint are checked.
- 403 remaining day-windows, beginning with shop 230 on September 18.
- All 1,118 parent result keys are excluded, including held invoices.
- Saved partial source page is reused and its digest verified before processing.
  Four recorded outcomes are skipped. The remaining 39 candidates comprise
  26 requiring correction and 13 currently matching; current matches do not
  prove historical correction attribution.
- Carry forward 65 consumed admissions against the unchanged 1,000 ceiling.
  Only the matching expired, stopped permit can be replaced.
- Financial scope, protected location 701 September, validation holds,
  relay pacing, morning stop, quiet windows and suspended general workers remain.
- Bounded database retries apply only after confirmed rollback; ambiguous
  commit/connection failures pause. No active daytime history workers are enabled.

## Preflight evidence

Fresh read-only reconciliation again verified 387 corrections, 150 matches,
zero mirror discrepancies and zero duplicate outcomes. All 42 source pages
passed their digests. Counters match the saved results.
Parent-scope validation passed against production data.
Overnight retry/hold/header/resume tests, transport policy/context tests and
typechecking passed.

Activation must be verified separately after the production build is live.
Running or scheduled is not proof of completed corrections; reconcile the
child after it stops.
