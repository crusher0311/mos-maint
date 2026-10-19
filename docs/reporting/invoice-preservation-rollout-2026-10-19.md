# Targeted invoice preservation rollout — 2026-10-19

## Authorized scope

Release the narrow preservation/raw-retention and source-hours compatibility
changes. Pin both older background services to their narrow branch and keep
them suspended. No invoice repairs, database grants, provider catch-up runs,
feature enablement or extension publishing.

## Git and service settings

- GitHub `main` advanced normally, without force-push, from `fe244d68` to
  `77310a4179d6a4b0651131091531c87cbccff8cc`.
- The older-worker release is
  `b35fde9b044564e7326f2af06aa6161f64703794`, published on
  `release/invoice-background-20261019`.
- Both `mos-maint-background-v2` and `backfill-drain-worker` were verified
  suspended, changed from `main` to that branch, and verified still suspended.
  Auto-deploy settings were unchanged.
- Only after both pins were confirmed was `main` advanced. Web and callback
  Render builds started for the intended commit.
- The development workspace was not reset or pushed wholesale.

## Final verification

The portable reviewed background patch was reconstructed on its pinned parent
and verified using a reverse patch check. Its new generator blob exactly matches
the reviewed patch. It deliberately matches the pinned web policy, not newer
workspace reporting semantics.

Both candidates passed real-adapter compatibility, retention, disposable
PostgreSQL identity/atomicity, typecheck, applicable worker regressions and
worker static bundles. The actual generic background worker entrypoint was
also bundled. The web runtime source is unchanged from the candidate that
passed the earlier complete production build.

The background lockfile installation succeeded with 1,078 packages. Because
temporary storage exhausted its quota during the first install, the isolated
dependency installation lives under ignored generated output on the workspace
disk and is linked into the external worktree. It is not the workspace's shared
dependency installation and neither lockfile nor manifest was changed.

## Runtime status boundary

The read-only monitor confirmed both intended deployments **live**:

- Callback worker: 2026-10-19 16:19:23 UTC (11:19 AM Central).
- Web: 2026-10-19 16:32:37 UTC (11:32 AM Central).
- Both ran release commit `77310a4179d6a4b0651131091531c87cbccff8cc`
  according to Render deployment metadata.
- Both background workers remained suspended on their approved narrow branch
  at the final 16:32:43 UTC check.

An unauthenticated request to the web service's `/api/health` returned HTTP 401.
This does not verify its database health checks or signed-in reporting UI.
Authentication was not bypassed and no production test data was written.

Live status evidence is written to:
`generated-artifacts/invoice-rollout/deployment-status.json`.
Final local check results are in that same ignored directory.

**A branch pin is not a worker deployment.** The suspended workers' previously
deployed images remain the old release until a later approved deployment.
Do not resume them merely to complete this rollout. Before any reporting repair,
verify all actual writer revisions, including these workers and any scheduled
resume path. Never interpret the web/callback deployment as all-writer readiness.

The offline repair executor still has no production PostgreSQL/Mongo adapter.
Fresh evidence/ownership/financial checks and execution approval remain
separate gates.
