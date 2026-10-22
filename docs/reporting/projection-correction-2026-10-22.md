# Reporting correction — prepared locally, not applied

The initial production installation remains unchanged. This package fixes two
issues discovered by the stricter installation tests:

1. Fresh installation now revokes PUBLIC function execution as the actual
   invalidator owner, after trigger creation and before removing temporary SET
   authority. Trigger creation itself requires EXECUTE; operational writes do not
   need that privilege after creation.
2. Hold coverage accepts opaque text review IDs, matching the registry schema.
   IDs are neither trimmed nor normalized. Blank/control-character IDs fail;
   provider source IDs remain UUIDs. Exact ID, shop, provider, inventory digest,
   revision, validity dates and unresolved holds still gate clearance.

## Existing production installation

Do **not** rerun `production-schema.sql`. The separate operator-only correction is:

`scripts/reporting-projection/correct-invalidator-execute.sql`

After separate approval, verify the database target and run it using the original
installer with role administration authority, with stop-on-error enabled. It is
transactional, uses 2-second lock and 15-second statement timeouts, verifies the
expected restricted trigger owner, temporarily restores SET membership, revokes
PUBLIC EXECUTE as owner, removes SET membership and asserts the resulting ACL.
It does not replace the function, change tables, modify invoices or reviews,
start a worker, or enable any feature.

An error requires rollback on the same connection before reuse. The correction
is repeatable. Do not restore PUBLIC access as a rollback workaround; inspect any
failure without changing privileges further.

## Code and subsequent population

The text-ID fix is application code and must reach whichever runtime performs
population before retrying. Applying SQL alone does not update deployed code.
Keep shared BUILD and READ switches off. After approval and prerequisite checks,
resume a bounded shop-227 operator population from durable checkpoints, using
the merged traffic-progress fix and restricted builder role.

Inventory progress is not publication readiness. Missing independent review,
coverage, current feed or verification must remain unresolved/unpublished.
No automatically generated review or approval is part of this package.

## Local verification

`bash tests/run-reporting-projection-worker.sh` checks fresh installation and the
exact correction under a non-superuser installer, repeated correction, effective
ACL denial for API/builder/operational roles, and working invalidation afterward.
Worker tests exercise text IDs through the real KPI path, UUID compatibility,
unknown/altered IDs, wrong shop/digest, invalid source IDs, holds and expiry.
All test data is synthetic in disposable Unix-socket PostgreSQL clusters.
