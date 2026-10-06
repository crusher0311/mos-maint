# JWT one-off overnight header recovery

## Activation confirmed

- Production commit `c80e8f92d992501ebd586fe8a85ba9cad8291d76` is live
  (deployment `dep-db25nbjncjis73c96teg`).
- Render job `job-db25uhm7bikc73ciob30` is running independently of this
  workspace/browser. Its saved Mongo state is `scheduled`, cursor/page zero,
  start `2026-10-06T03:00:00Z`, expiry `2026-10-06T10:00:00Z`.
- The earlier waiting job `job-db25ehei0phs73dcbca0` was canceled before the
  repair window. The replacement started at `2026-10-06T02:39:02Z` after the
  corrected deployment went live. It uses the same saved job/checkpoint.
- Both general workers were confirmed suspended. The live
  `/api/cron/worker-power` returned `{"ok":true,"skipped":"disabled"}`.
- Production `/` returned HTTP 200. No signed-in UI verification was performed.
- Activation is not proof of completed invoice corrections. Evaluate the
  persisted results after the window; held/missing cases remain out of scope.

## Authorized operation

The user asked to fix the identity issue and activate unattended recovery.
The selected safe operation corrects verified **existing** invoice labor
headers, including legacy GUID-numbered rows. It does not create missing
invoices, rename identifiers, merge records, rewrite children, run the separate
historical-hours repair, or claim that native Labor Total is verified net labor.

Window: October 5 at 10 p.m. through October 6 at 5 a.m. America/Chicago.
There is no recurring schedule. The OS process deadline supplements the
transport expiry and the transaction cutoff.

Source scope: the previously assessed August/September export, 12,397 native
ordinary invoices / 467 daily windows. Entire location 701 September and all
credits are excluded. The first window is location 707 September 1.

## Safety and evidence

- Existing shared fleet/relay controls remain in force.
- A separate expiring background context consumes both the fleet admission
  and a finite 1,000-request recovery budget atomically.
- Each provider page is archived before corrections.
- Unexpected database/transaction failures pause the run without advancing
  the unfinished page. Only explicit identity holds and source-validation
  assertions are held; their reasons are persisted with the outcome.
- A single locked existing row must match the native number or provider GUID;
  alternate-number conflicts, missing rows and invalid identities are held.
- Source GUID, terminal status, invoice/date and signed native labor amount
  must agree. Only zero headers or already-matching headers qualify.
- Only `labor_total` and its `raw_data.laborTotal` mirror change. IDs, customer
  and vehicle links, children, history, discounts and other totals stay intact.
- No provider writes, indexes, migrations, rate-limit increases or backfill
  cursor resets.
- Failure pauses the job with a durable checkpoint; it does not force-skip a
  failed source window or refund an ambiguous admission.
- Quiet-window checks apply. Missing profiles use only the already authorized
  hard overnight window, never daytime fallback.

Operational records use job ID `jwt-overnight-2026-10-05` in
`operator_invoice_recovery_jobs`; archived source pages are in
`operator_invoice_recovery_sources`. These records contain private source
data and must remain operator-only. Use count/status projections for reporting.

Both general Render workers were found running after their evening schedule.
They were suspended, and `WORKER_SCHEDULE_DISABLED=true` was saved on the web
service. Runtime confirmation is required after the new deployment is live.
Do not re-enable those workers or the scheduler without operator approval.

## Verification

Passing: legacy/numeric identity header guards, signed amounts, terminal/date/
provider conflicts, protected-scope rejection, atomic physical admission,
context expiry, and typechecks in the task and production-based checkouts.
The production database array-binding check was read-only.

The production release is built from the previously deployed GitHub revision,
not the divergent task checkout. The release includes the separately tested
overnight transport integration.

Final-check fixes also prevent partial normalized job-hour sums from replacing
explicit unknown labor evidence. Cached invoices must have a final workflow,
matching provider identity, shop and business date before replacing historical
facts. Report execution version was advanced; existing pinned results remain
pinned. The full custom-report suite, adapter/partial-hours regression, invalid
cache regressions, operational-failure checkpoint checks and both checkout
typechecks passed. Production prebuild/build passed for the replacement release.

## Remaining scope

This is not a general missing-invoice backfill and does not guarantee that
every candidate will be corrected. Missing rows, nonterminal rows, date
conflicts, ambiguous identities and source discrepancies remain held.
After the run, reconcile its actual counts and totals against the native
export, inspect holds, and generate fresh governed report runs. Existing
pinned reports are not rewritten. Fully loaded labor cost / ADP remain deferred.
