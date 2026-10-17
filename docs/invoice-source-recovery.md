# Bounded invoice evidence recovery

## Approval and boundaries

The operator approved up to **1,000 Protractor requests, including retries**, on
2026-10-17, followed by another local reporting validation. This does not authorize
financial writes, production reporting-metadata repair, or publishing changes.
Captured source responses and operational checkpoints are the only production
writes made by this runner.

The inventory uses the retained disposable reporting baseline and indexed,
read-only work-order-cache lookups. Of 16,834 unresolved closed records, 14,955
mapped to dates and 1,879 remained held. Another 68 mapped records contained the
placeholder date `0001-01-01`; the dispatcher excludes those seven date groups.
The remaining **655 shop/date groups cover 14,887 target records**. These dates
are request-planning hints, not verified invoice evidence.

## Isolation and dispatch controls

- Independent `invoiceRecovery` physical-admission counter; never reset it or
  borrow the active weekend runner's permission.
- Same fleet pacer, relay requirement, operator stop, canary generation,
  callback priority, and general-worker suspension checks.
- Only JWT shops 227–236; only GET Invoice list requests, one approved day per
  active grant, page size 100, page index below 100.
- Hard expiry October 19, 2026 at 10:00 UTC. This is a one-use operator operation,
  not permanent permission or a general-purpose backfill switch.
- A renewable owner lease, connection binding, and recent activity check are
  enforced at physical dispatch. Recent callback activity defers that shop.
  Callback delays at the existing threshold yield the runner.
- At least 30 seconds between new source reads. Provider retries are disabled;
  any later attempt still consumes another physical admission.
- Existing compatible weekend archive pages are reused when their digest and
  connection binding agree. No history ingester or normalizer is invoked.

The executable is `scripts/run-invoice-source-recovery.ts`; `--preflight` checks
eligibility without creating a grant or making provider requests. Tests are in
`tests/protractor-invoice-recovery.smoke.ts`, alongside existing weekend tests.
The source-plan builder is `scripts/plan-invoice-source-recovery.sh`.

## Runtime and validation

The runner executes as an isolated Render one-off job with its tested source
files bundled into that job's filesystem. It does not publish or replace the
web service or callback worker. Initial production preflight found all ten
shops eligible and zero delayed callbacks.

Operational records use campaign prefix `invoice-evidence-recovery-2026-10-17`
in the existing operator history collections. The cumulative physical budget
lives in `api_rate_limits` under `invoiceRecovery`. The launcher refuses an
existing permission or checkpoint rather than silently resetting a prior run.
A failed or paused run requires a reviewed, budget-preserving resume.

After capture, verify the persisted budget, archive hashes, shop/connection
binding, completeness of each paginated day, and held records. Reconcile new
evidence with the original identity/hour-conflict safeguards before replaying
the full ten-shop report locally. The retained baseline deliberately omits raw
financial payloads; it must not be used to bypass those conflict checks.

Do not infer report correctness from a successful job exit. Missing source
evidence, page caps, and conflicts can still leave averages unavailable.
