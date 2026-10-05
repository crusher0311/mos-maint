# Tekmetric labor-rate default safety

The updater treats every job fetched with an RO as existing. Only literal
`true` consent authorizes job updates: `applyToAllLabor` for RO rules and
`repriceExistingCategoryLabor` for category rules. Category precedence is not
consent. A higher-priority category rule reserves its matching jobs even when
protected or when its write fails. RO override can cover consenting categories,
but cannot authorize a protected category.

## Default-only update: blocked pending provider verification

The prior `PUT /api/repair-order/{id}/summary` payload included `laborRate` and
summary fields, without job lines. Repository captures show a generic successful
summary response followed by separate job updates, but no before/after labor
comparison or documented non-cascade guarantee. Payload shape and HTTP 200 alone
do not prove that existing custom or canned prices stay unchanged.

Consequently, a changed RO default returns
`LABOR_RATE_DEFAULT_UPDATE_UNVERIFIED` without sending the summary request.
An already-matching default returns no-change. Separately consented job writes
still run, and mixed results report the blocked default operation. This applies
equally to automatic application and Apply Now; no live writes were used to test.

## Approved environment verification before re-enabling

Use an explicitly approved Tekmetric sandbox with disposable ROs, never a live
customer RO. Record full before/after labor IDs, rates, hours, totals, and default:

1. Include category-matching, unmatched, canned and custom-priced jobs with
   different labor rates; test all supported labor array representations.
2. Verify the documented provider option or endpoint for changing only the
   default. Do not assume omitting jobs prevents server-side cascades.
3. Compare every existing labor line after the default-only request and after
   reload, including inherited/default-priced lines.
4. Check empty ROs, pending/authorized jobs, failed requests, and concurrent adds.
5. Record the provider contract and reproducible sanitized fixtures. Re-enable
   only a verified default-only operation, with regression tests preserving the
   same consent and scope boundaries.

Do not infer permission from job IDs, cache age, manual Apply Now, category
presence, or override precedence. Do not restore previously changed prices as
part of this work.