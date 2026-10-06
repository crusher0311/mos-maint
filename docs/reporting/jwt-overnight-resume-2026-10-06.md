# JWT guarded resume — October 6, 2026

## Read-only reconciliation

The October 5 run started at 10:00 p.m. Central and paused at 10:04 p.m.
It recorded 231 corrected, 84 already matching, and 267 held invoices.
All 231 corrected invoices were checked against the archived provider source,
native manifest, canonical PG header and raw-data labor mirror. All passed;
their signed labor totals sum to $45,345.89. This does not establish net-sales,
hours, full coverage or overall pilot reconciliation.

The holds include 232 missing/ambiguous identities and 35 missing stored
business dates. No held invoice is authorized for an identity or date repair.

## Cause and fix

The failed request never reached the relay. Its log was
`protractor_fleet_pacer_deadline`, after 372 ms, while preceding requests
returned 200. The saved permit consumed 23 of 1,000 requests.
In the live-policy contention fallback, JavaScript compared consumed admissions
against `null` (the unlimited live allowance), treated it as zero and returned
early. Exclude live policies from this bounded-budget comparison. All actual
lease, spacing, stop, deadline, relay and finite recovery-budget gates remain.
An offline repository regression forces one contended acquisition and confirms
the next attempt acquires normally.

## Next authorized window

October 6 at 10 p.m. through October 7 at 5 a.m. Central, once only.
The explicit `--resume-2026-10-06` runner uses a new child job, preserving the
paused parent and its archived evidence. Its starting scope is the original
cursor 24, page zero (shop 228, September 29), plus the deferred shop 233,
September 1 window at the end. Changed parent evidence blocks activation.

The new permit carries the 23 consumed requests forward against the same
1,000-request ceiling. It cannot replace an active permit or increase the
original allowance. It only replaces the expected expired, stopped parent
permit. Completed windows and the 267 held invoices are not replayed.

A shop outside its quiet window now waits without advancing its checkpoint;
it is not silently skipped. Actual Render worker suspension is checked before
the grant and each day, and the general-worker scheduler must remain disabled.
Provider failures retain a bounded diagnostic reason and pause the unfinished
page. Unexpected database errors still pause. Source pages are archived before
any guarded financial writes. All original exclusions remain, including the
whole location 701 September window, credit records and missing invoices.

## Activation confirmed

- Production commit `6ee66563400296ffac921057571f7891a0d0195f` is live in
  deployment `dep-db2cinflk1mc738p1kf0`; its full production build passed.
- Render job `job-db2cptu0tbcc738pfif0` is running since
  `2026-10-06T10:27:03Z`, independently of the workspace/browser.
- Persisted child job `jwt-overnight-2026-10-06` is `scheduled`, linked to
  `jwt-overnight-2026-10-05`, with start `2026-10-07T03:00:00Z` and expiry
  `2026-10-07T10:00:00Z`. Its cursor zero refers to the *remaining-work list*;
  the original parent's cursor 24 is preserved.
- Both general workers remain suspended. The deployed scheduler returns
  `skipped:disabled`; production root returns HTTP 200.
- A presence-only runtime probe verified the inherited management credential
  and disabled-scheduler setting needed for runtime safety checks.
- Fleet-pacer, operator-stop/contended-live, resume-scope, failure-checkpoint,
  and overnight-policy tests passed, as did both checkout typechecks.
- No new provider recovery requests or financial writes were run during this
  daytime investigation. A preview screenshot showed only the unsigned/loading
  dashboard; no signed-in report UI was verified or changed.

Activation is not proof of tonight's corrections. Reconcile the child job's
actual outcomes after the window; unexpected provider or database failures
still pause with the unfinished page retained.
