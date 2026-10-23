# Export-only release candidate

Prepared locally on 2026-10-23. The dedicated release branch has now been pushed;
the disabled web deployment is live and runtime-verified. See
`scripts/protractor-export-pg/disabled-deployment.md` for rollout state.

- Live baseline: `ad56fc491260de75415388a49893ece6c5791685`.
- Candidate commit: `ae1445a4`.
- Local reference: `release/protractor-export-pg-20261023`.
- Isolated checkout: `/tmp/mos-export-release-20261023`.
- Scope: 36 files, export PG repository/connection, dedicated worker, related
  tests/docs and three package scripts. Lockfile change is TypeScript dev
  classification only; no new package version.
- Reporting code, callback routes, app API routes, cron definitions, main
  startup, workspace configuration and attachment deletions are unchanged
  from the live baseline.
- Main workspace branch was not switched or reset.

## Candidate verification

Passed against this exact candidate:

- 29 focused export prerequisites, lifecycle, engine, transport and synthetic
  receiver tests.
- PostgreSQL 17.6 disposable fixture: dedicated login, no shared credential
  fallback, authority checks, non-superuser installer, restricted grants,
  schema validation, compare-and-swap, leases, retries and retention.
- Diff whitespace check and excluded-scope comparison.
- Complete `npm run build` lifecycle, including prebuild checks and Next.js
  production compilation/prerendering: explicit exit 0. Candidate tracked
  source remained unchanged after the build.

- Real PostgreSQL 17 + Redis crash/lease/retry suite: explicit exit 0,
  13 tests passed, none skipped or failed, approximately 16 minutes. Verified
  real startup/drain deadlines, Redis restart, receiver rejection and six
  forced-crash commit boundaries with durable recovery.

Both run with production credentials removed. Full build retains only native
library/runtime paths and explicitly denies external network traffic.
Fixture suite uses its own local-only network guard and disposable stores.
Dependencies are shared through a node_modules symlink, not installed afresh;
the candidate has no dependency-version changes. The untracked symlink is not
part of the release.

Local candidate verification is complete. Deployment and activation still
require approval and the staged runtime configuration described in
`scripts/protractor-export-pg/release-readiness.md`. No Render service,
credentials, flags, worker suspension or deployment configuration changed
during preparation.
