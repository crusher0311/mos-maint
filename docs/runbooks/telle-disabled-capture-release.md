# Telle 101 disabled capture release

Scope: MOS shop 282 / Telle store 101, the pinned 233 invoice references and
269 allowed endpoints, January 1–November 8, 2026 in America/Chicago.

This release adds operator scripts only. It does not alter application routes,
worker schedules, normal invoice selection, normalized ingestion or delivery.
It contains no repair executor, grant installer, schema migration or startup hook.
Keep the dedicated shop-635 history branch and worker unchanged.

Capture requires an isolated production process, both
PROTRACTOR_TELLE_CAPTURE_ENABLED and PROTRACTOR_TELLE_RECOVERY_ENABLED explicitly
true, and a fresh separately approved matching grant. The stopped diagnostic
grant cannot be reused. At most 500 requests / 30 minutes, existing relay admission,
no retries, duplicate-page rejection and explicit unresolved results.
The capture process revokes its own grant on ordinary success/failure; forced
termination still requires independent revocation verification. Grant expiry is
the final safety backstop.

Read-only inventory requires its separate process-local flag
TELLE_RECOVERY_INVENTORY_ENABLED. It reads all nine retained-source families with
budgets and fails on missing/unknown evidence rather than claiming completeness.
It must not be treated as a distributed snapshot or as authorization to write.

No flags, grants, source repairs, new tables or deliveries are installed by
deployment. Do not invoke scripts from service startup commands or enable flags
at service/environment-group scope.

## Before a later live capture

Obtain approval for the exact deployed revision, input hash, new run ID,
connection binding, temporary window and counters, and restricted durable staging.
The default staging files are container-local and are not durable backup.
Retrieve them through a separately reviewed secure path before the job container
is discarded; never place raw invoices in logs, chat, Git or public assets.
Confirm a fresh grant is not competing with another diagnostic.

Invoke the capture only as:
`node --require ./scripts/_stubs/server-only-stub.cjs --import tsx scripts/capture-telle-recovery.ts --approved-capture references.json generated-artifacts/private-new-directory run-id`

Private staging must use a new directory (0700, files 0600).
Partial runs are evidence only; never automatically resubmit or reuse authorization.
Review captures and fresh inventory before any separate repair approval.

The local raw-cache repair adapter and its test database tools are intentionally
excluded from this release. Credits remain a native CreditSlip review category;
neither work-order conversion nor receiver compatibility is approved here.
