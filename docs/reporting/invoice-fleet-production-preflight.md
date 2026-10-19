# Read-only production preflight — 2026-10-19

## Scope and target

User approved permission and query-plan inspection only. No report was executed,
no production setting or data was changed, and nothing was deployed or enabled.

The connection was resolved from the production Render web service, combining
its linked environment group with service overrides and applying the app's
DATAONE_DATABASE_URL-before-DATABASE_URL precedence. The host/database matched
the configured production Supabase target. Credentials were consumed only in
the checking process and were not logged.

The new feature setting was absent. The feature remains off by default.
The database reports PostgreSQL 17.6; the inspection connection was read-only,
limited to one connection, a 5-second statement timeout and a 1-second lock
timeout.

## Blocking findings

1. **Temporary-disk enforcement permission.** The actual reporting role can read
   normalized work orders, but is not a superuser and has no SET privilege on
   temp_file_limit. This parameter has superuser context and the observed limit
   was unlimited (-1). The new admission wrapper would therefore fail before
   running its aggregate. Do not bypass this guard or grant broad superuser
   access. A narrowly authorized way to enforce the budget is required.

   Other inspected parameters have user context. A false
   has_parameter_privilege result alone does not mean ordinary user-context
   settings are forbidden; do not misreport all settings as blocked.

2. **Enum compatibility.** EXPLAIN of the current application SQL failed with
   SQLSTATE 22P02: invalid input value for enum work_order_status: "open".
   The unknown-row status checks compare directly to text policy labels, while
   the production column is an enum. The existing disposable fixtures use text
   and missed this incompatibility.

## Hypothetical corrected plan

A temporary query string cast the two unknown-row status comparisons to text.
This was not applied to application code. EXPLAIN (FORMAT JSON), without
ANALYZE, then succeeded for JWT locations 227–236 and 2026-09-18 through
2026-10-17. It did not execute the report.

- The plan returns ten location rows.
- The verified-date, unknown-population and invoice-identity reporting indexes
  exist, are valid/ready, and appear in the plan.
- Alias expansion appears as a separate ProjectSet; resolution uses a merge
  join on identity rather than expanding aliases after a same-shop cross-product.
- This plan used the inspected session's existing planner configuration, not
  the proposed 2 MB/zero-parallel resource settings. It includes a parallel
  Gather. It is not proof of runtime, spill use, or performance under the new
  limits. Estimated row counts and costs are not observed invoice counts or
  elapsed time.

No new index is justified by this inspection alone. An unrelated invalid broad
provenance index was observed but was not touched.

## Next approval

Local follow-up: the two status comparisons now cast to text, and the large
offline fixture uses the application's real status enum. The original preflight
above remains a historical record; no production query was rerun as part of
this local fix. See invoice-fleet-database-setup-proposal.md for the separate,
unapplied permission proposal.

Fix enum handling locally and add a production-shaped enum fixture. Separately
prepare a least-privilege budget-enforcement plan compatible with the managed
database. Any production permission/configuration change, full report execution,
deployment or activation needs separate approval. Invoice evidence corroboration
remains a separate functional-release requirement.
