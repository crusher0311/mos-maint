# Fleet query optimization — local verification

## Result

The guarded query now completes on the saved 215,655-work-order snapshot without
raising resource limits. No production connection or provider API was used.
The feature remains disabled.

| Saved local dataset | Observed query time | Unknown identities | Verified invoices in period |
| --- | ---: | ---: | ---: |
| Current stored metadata | 3,815 ms | 209,889 | 0 |
| Simulated owner separation | 2,692 ms | 209,871 | 0 |

Both complete summary objects were compared programmatically with independently
computed location diagnostics from the same saved capture and matched exactly.
The old guarded query exceeded its 64 MB temporary-file limit on both datasets.
These timings are observations on local PostgreSQL 16.10, not production
PostgreSQL 17.6 performance guarantees.

## Change and invariants

Invoice identities are already shop-scoped. A correlated LATERAL subquery now
evaluates one complete shop closure at a time, with OFFSET 0 retaining the
execution boundary. It avoids retaining fleet-wide intermediate results at once.

This is **one SQL statement**, not application fan-out, paging, or a series of
independently timed requests. The statement retains one consistent snapshot,
one admission lock and one 35-second statement timeout across every location.
The original authorization checks, 200-location scope bound and complete-result
validation remain in force. Any location error aborts the entire statement;
no partial response is accepted.

Unchanged safeguards:

- 64 MB temporary-file limit.
- 2 MB work_mem and hash_mem_multiplier=1.
- Zero parallel workers and database-wide single-report admission.
- Read-only transaction, lock timeout and request deadline.
- Cross-date duplicate vetoes, missingness, unknown identities and independent
  sold/presented coverage rules.

An arbitrarily large or complex single location can still exceed the budget.
Such a request must fail explicitly; this change does not promise unlimited scale.

## Regression checks

- Nine disposable PostgreSQL tests passed, including the real status enum,
  admission/permission behavior, mixed invoice/unknown populations, aliases,
  authorization isolation, oversized-location handling and cancellation.
- The large fixture now also exercises 210,000 long row IDs with multiple
  UUID-shaped source aliases under the unchanged resource guard. Its ten-row
  aggregate remains below 8 KB and matches the independent diagnostic.
- TypeScript and the invoice service/summary/authorized-location suites passed.
- The preserved real-data snapshot was restored and analyzed locally; both
  current and simulated datasets passed the actual guarded query.

The UI was not changed and the signed-in production UI was not verified.

## Still blocked

The production role's temp_file_limit permission remains unresolved. A separately
approved production preflight must inspect the new plan under the actual
PostgreSQL 17 configuration. The requested period still lacks verified invoice
evidence; a faster correct query does not create that evidence or justify averages.
Nothing was enabled, deployed or repaired.
