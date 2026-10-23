# Coordinated release readiness — 2026-10-23

Read-only review; no push, deployment, service creation, credential linking or
export activation performed.

## Verified state

- GitHub main and the live web/callback services are at
  `ad56fc491260de75415388a49893ece6c5791685`.
- Local reviewed HEAD `3c39db60` is 54 commits ahead, with 2,279 changed files,
  including 2,186 asset deletions and unrelated reporting implementation.
- Working tree was clean when reviewed.
- Web and callback services auto-deploy from main; neither had a deployment
  in progress. A full push is not an export-only release.
- Both historical backfill workers remain suspended on their separate release
  branch, with older live builds. Do not update or resume them for exports.
- No dedicated export worker exists.
- Web's effective configured export flag and reporting build/read flags are off.
  This is Render configuration evidence, not a running-process environment read.
- Staged restricted PG credentials are verified but linked to no services or
  Render environment. The export encryption key is absent.

## Release decision

Infrastructure is staged; a release candidate has not been isolated or fully
built. Do not label the whole local main deploy-ready on the strength of export
tests. Recommend a narrow candidate based on the live web revision, containing
only export PG state/connection, isolated worker, required script entries and
their tests. Preserve the local reporting work and assets decision for separate
review; do not reset or rewrite the user's working branch.

Before proposing deployment:

1. Assemble the narrow candidate outside the workspace and inspect its exact diff
   and dependencies against the live baseline.
2. Run its release/prebuild/build checks with production credentials stripped.
   Verify its dedicated-PG and isolated worker tests; don't substitute tests run
   against a different broad-main tree.
3. Prepare a separately approved secure encryption key (distinct from the PG
   password and per-destination signing secrets), shared only by intended web
   and export worker processes.
4. Review how to release web without unintentionally rebuilding the callback
   service, and pin exact service revisions/auto-deploy settings as authorized.
5. Obtain approval for credential linkage, disabled release and creation of the
   proposed $25/month export worker. Keep it suspended while its feature flag
   is off; disabled startup intentionally exits.
6. Commission worker/scheduler and any recipient only under separate activation
   approval. Never resume the general background workers for this feature.

No full production build or long crash-suite rerun was performed during this
readiness review. Existing PG17 SQL/login checks passed earlier; they do not
replace candidate-specific build verification.

Restricted evidence:
`generated-artifacts/reporting-snapshots/export-release-readiness-20261023.json`.
It records sanitized service/commit/configuration status, not credentials.
