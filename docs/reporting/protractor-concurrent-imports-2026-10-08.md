# October 8 concurrent Protractor imports

The operator approved a 14-month history import for MOS 538 and explicitly
requested concurrent JWT recovery rather than postponement. The operator then
confirmed all included shops closed and approved immediate early starts.

Runtime release: `3eff57539eda6f22476b17b011f4f72795771444`.
Both jobs stop by October 9, 2026 at 05:00 America/Chicago.
No fleet-wide horizon, rate limit, general-worker suspension or background
scope was widened.

- Shop 538: history from 2025-08-08 through 2026-10-08, inclusive.
  Independent 1,000-request maximum; same atomic physical fleet pacer.
  Render preparation: `job-db42k0o473hc73ceb9cg` (succeeded).
  Render import: `job-db42l12j9qps73fudvu0`.
  State: `operator_history_import_jobs`, ID `shop538-history-2026-10-08`.
  Permission: `api_rate_limits` physical transport document, `shopHistory`.
  First observed progress: 11 imported invoices, zero reported failures.
- JWT: Render continuation `job-db42m2qjnfac73bagi10`.
  Existing job/checkpoint `jwt-overnight-2026-10-07` retained.
  At handoff: 354 completed batches, 49 pending, 419/1,000 requests consumed,
  5,908 corrected, 1,528 already matching, 1,929 held.
  Earlier waiting jobs were canceled before creating this immediate replacement.

The preparation scripts and independent workers retain incomplete pages.
No implicit reauthorization after cutoff. Thin history list payloads require
review rather than unrestricted detail fan-out. Runtime financial recovery is
unchanged except the approved dated quiet-hour exception.

Preflight reconciliation found an unrelated work-order number equal to an older
invoice number. Read-only reconciliation was corrected to require exact source
GUID provenance before uniqueness, without hiding genuine duplicates. That
operator-tool correction was tested locally and used to verify the handoff;
it is not needed by the running deployed workers.

Verification: typecheck, shop-history atomic admission/scope/context tests,
existing JWT physical-admission and recovery suites, and Render full build.
History/JWT budgets are separate, and genuine callbacks retain access.
