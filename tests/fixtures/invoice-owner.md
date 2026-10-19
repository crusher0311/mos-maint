# Offline invoice-owner regression

Run from the repository root:

```sh
npm run test:invoice-owner-offline
```

Requires the installed Node dependencies and PostgreSQL `initdb`/`pg_ctl` on
PATH (run as a non-root user). No Docker, existing database, snapshot file,
provider access or production credentials are needed. The runner clears inherited
environment variables, initializes a fresh temporary cluster, listens only on
its private Unix socket, enforces a 90-second test timeout, and stops/removes
the cluster on exit. A preload denies TCP (including loopback), TLS, HTTP,
fetch, DNS and UDP; only the exact disposable PostgreSQL socket is allowed.
Do not run the test file directly without this runner.

`invoice-owner.ts` constructs minimal **synthetic** records, not sanitized
customer exports. Work-order numbers, IDs, hours and dates are invented.
The shared report model is also used by the operator validator; the tests
execute the real `INVOICE_HOURS_SQL` in PostgreSQL.

The independent oracle expects:

| Scope | Invoices | Sold hours | Presented hours | Unknown |
| --- | ---: | ---: | ---: | ---: |
| Selected period | 3 | 22 | 30 | 2 |
| All dates | 5 | 50 | 62 | 2 |
| All dates, shop 1 | 4 | 37 | 45 | 2 |
| All dates, shop 2 | 1 | 13 | 17 | 0 |

The unresolved owners have missing invoice numbers and conflicting copies.
They keep averages unavailable without turning missing hours into zeros.
Separate assertions check every owner's hours, child ownership and immutable
hash preservation, legitimate cross-shop number reuse, rejected same-shop
collisions and cross-shop children, deferred hours, soft deletion, and both
older and future out-of-period invoices.

## Operator boundary

`scripts/run-invoice-owner-report.sh` and
`scripts/validate-invoice-owner-report.ts` remain bounded, read-only operator
tools that require an explicitly reviewed closure and source-store access.
They are **not** invoked by this test command. Their
`/tmp/invoice-owner-closure.json` input is an operator prerequisite, never a
regression-test fixture. This suite does not authorize source access, live
repairs, deployment, or changes to child financial rows.
