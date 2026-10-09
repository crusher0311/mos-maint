# Unified workspace / QA / production release

## Source and exclusions

Candidate branch: `release/catchup-2026-10-09`.
**Status: blocked; do not push to QA or production yet.**
It starts from the complete workspace, preserves both GitHub branch ancestries,
and includes the technician fix and the merged QR/AppFueled work.
Production's remote-only commits were verified patch-equivalent before ancestry
reconciliation. QA was merged normally; conflicts retained newer workspace
provider isolation, labor evidence, and the confirmed system-wide AppFueled
contract. No force push is needed.

Unfinished visit-based DVI is held off by a shared UI/API release constant.
Existing Auto DVI remains available. Enterprise history remains default-off;
Shop Workflow remains a per-location platform-admin opt-in.
Application builds no longer invoke the extension publishing script.

## Separate storage prerequisites

- QA also receives `0036_extension_location_sessions.sql`. Both columns were
  confirmed present in the production PostgreSQL connection by read-only query.
  Verify QA's actual backing store before rollout; do not assume it shares it.
- `0037_enterprise_vehicle_history.sql` introduces a policy table and supporting
  indexes. They are absent from the production connection checked here.
  This does not authorize creating them. Keep enterprise sharing disabled;
  follow the existing enterprise-history runbook for separately approved
  migration, existing-index review and concurrent index creation.
- No database migration, feature activation, provider request, historical
  repair, or extension-store submission is part of this code synchronization.
- Burnett's existing rows still require separately reconciled, approved repair.

## Verification

- All prebuild regression commands passed in credential-free, network-denied
  processes. The smoke suite resumed at the print-queue test after correcting
  the local native-loader environment; earlier successful suites were unchanged.
- Initial TypeScript checking passed before the production build regenerated
  all route declarations. The required **post-build** typecheck then failed
  with 39 invalid API-route exports (test helpers such as `__deps`).
  These must move to companion modules and their tests must be updated without
  changing handler behavior. Do not suppress the generated checks.
- 32 additional targeted tests passed, including DVI release holds, technician
  mapping, branding, workflow roles, QR targets and the AppFueled VHI webhook.
- Enterprise-history service and UI regressions passed.
- Lockfile, direct-database access, authentication and extension-gate checks
  passed. Existing stale database-allowlist warnings are not new violations.
- Shop Workflow rendered in an offline fixture. Authenticated live QA flows
  have not been checked for this candidate.
- The optimized production bundle completed successfully. This is not sufficient
  for release: Next is configured to skip build-time TypeScript errors, and the
  explicit post-build typecheck above remains a blocking gate.
- No QA/main push, candidate tag, production promotion, or local-main
  fast-forward was performed. Finish the route-export repair and revalidate
  before freezing the candidate and proceeding below.

## Promotion procedure — user-initiated pushes only

Do not promote until the full build gate passes.

1. Fetch `origin main qa`. Confirm neither remote has advanced beyond the
   candidate's ancestry. If it has, reconcile and revalidate first.
2. Freeze the candidate commit as `SHA=$(git rev-parse release/catchup-2026-10-09)`.
3. Push **only QA**: `git push origin "$SHA":refs/heads/qa`.
4. Verify Render's QA deployment reports **live at that exact SHA**. Check
   startup/build logs, auth, AppFueled contract, QR compatibility, workflow
   opt-in, and that visit DVI / enterprise sharing remain disabled.
5. Only after successful QA verification:
   `git push origin "$SHA":refs/heads/main`.
6. Confirm production Render is live at the identical SHA, including relevant
   worker deployment status. GitHub accepting a push is not live verification.
7. Fast-forward local main to that tested commit; never reset away local work.

Keep QA/main equal in code, not environment configuration. Future changes
should start from their reconciled ancestry rather than new selective copies.
