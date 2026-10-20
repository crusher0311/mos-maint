# Combined reporting, DVI, workflow and onboarding release

The operator approved releasing the combined workspace instead of a reporting-only
backport. Live repair execution, DVI provisioning/activation and Chrome Web Store
publication remain separate operations.

## Reconciliation

- Fetched GitHub main and qa. Merged main without force or history replacement;
  qa was already an ancestor of the candidate.
- Reviewed conflicts between older production backports and newer workspace
  reporting, DVI identity, callback and bounded-history implementations.
  Retained newer safeguards and nonconflicting remote changes.
- Moved enterprise settings helpers outside the Next route export boundary.
  HTTP entrypoints retain explicit session checks; shared handlers retain
  enterprise membership and category authorization.

## Read-only production prerequisites

- AppFueled connection and webhook-limit tables exist.
- Verified-date reporting index and Protractor identity GIN index are valid
  and ready.
- Invoice repair-control tables and Mongo installation record remain absent.
  No installation, repair, backfill replay or provider request was performed.
- Both fleet reporting switches remain disabled.
- Web and callback worker track main. The two suspended background workers
  remain isolated on their existing release branch; code selection must not be
  confused with deployed-image verification or permission to resume.

## Verification

- Real disposable PostgreSQL streaming fixture passed with zero spill and
  exact 120,000-invoice totals, scope/deadline/byte-cap/conflict checks.
- Isolated Protractor onboarding checks passed.
- DVI/staff/release tests passed except an outdated outcome DOM fake, subsequently
  corrected and its complete test file rerun successfully.
- CAR Experts browser fixture passed preview, lost responses, reload, explicit
  send and exact native-readback reconciliation with one synthetic send.
- Isolated pilot screenshot renders correctly. This is not verification of
  the signed-in production UI or evidence of live pilot activation.
- Full production lifecycle and native dual-store repair checks are tracked
  separately; do not treat this document as their completion or deployment receipt.
