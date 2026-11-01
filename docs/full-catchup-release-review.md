# Full workspace catch-up review

Review date: 2026-11-01.

## Pinned scope

- GitHub `main`: `7ce48fb607860c87ff201b7bed047a696d402dff`.
- Reviewed workspace: `6cd46fb462d524f39ae120a6dac555724d2f9300`.
- Net difference: 168 files, 7,520 additions, 277 deletions.
- No dependency lockfile, SQL migration, Render configuration, or file deletion
  is in this difference.
- Includes Tire DOT reporting, AI usage safeguards, DVI policy/recording,
  intake context, extension access/Shopmonkey fixes, tests and documentation.

The histories diverge because earlier releases were selectively copied or
cherry-picked. A direct force-push is not acceptable. Any subsequent catch-up
must preserve GitHub's history and reconcile to the reviewed tree. Fetch and
check for new upstream changes immediately before publication.

## Operational boundaries

- New Tire DOT executions use pinned shop-local zones; old UTC executions retain
  their meaning. Current pilot evidence does not establish complete local-month
  boundary coverage. Production speedup has not been measured.
- No new SQL schema is required by this net change. The reporting-index
  installation document records earlier installation, not a current health
  check or authorization to reinstall.
- DVI recording requires explicit recording shop enrollment, approved storage
  capacity/indexes, codecs and a separately supervised worker. Publishing this
  code does not authorize enrollment or launching that worker.
- Native DVI delivery and customer report origins must meet the approved
  publication configuration. Existing pilot configuration must be checked
  before relying on that workflow after release.
- AI usage defaults to bounded database delivery. Durable journaling requires
  an approved persistent disk and `OPENAI_USAGE_SPOOL_DIR`; do not set that
  variable to an ephemeral path as part of code deployment.
- The extension source manifest changes from 1.35.12 to 1.35.14. Git deployment
  does not publish Chrome Web Store changes. Current store version must be
  checked before any separate submission; never infer it from this manifest.
- No provider collection, export, backfill, credential change or feature
  activation is authorized by this review.

## Verification

The reviewed workspace already passed the full TypeScript check, 23 focused
Tire DOT tests, custom-report regressions and offline Tire DOT browser checks.

Additional combined checks use an isolated checkout, with credentials removed
and external network access denied:

- Full `npm run build`, including the repository's complete prebuild chain.
- Changed non-browser unit tests initially passed 128 of 131 cases. Three
  failures were stale test fixtures: missing authenticated session, missing
  browser session discriminator/authentication state, and a source assertion
  predating authoritative Tekmetric support alongside Shopmonkey.
- Only the two affected test files were corrected. Their complete six-test
  rerun passed. No runtime behavior or authorization assertion was removed.
  These test files are not invoked by the running prebuild chain.

The first full build was interrupted by a workspace restart before an exit
result; it is not a passing build. Its temporary log did not survive. The build
was restarted with durable, Git/deployment-excluded logs and explicit
completion status in `generated-artifacts/full-catchup-review/`.

The restarted full build and prebuild chain exited zero, compiling successfully
and generating all 256 static pages. Next skips its built-in type validation;
the separate post-build TypeScript check also exited zero. Its log and exit
receipt are retained alongside the build output.

GitHub main was freshly fetched after verification and still matches the pinned
baseline above. The reviewed runtime source remains pinned
to the commit above; the candidate also includes the two test-only corrections
and this review document.

Local release checks are complete. Offline results do not verify production
configuration or the signed-in production UI. No code has been pushed by this
review. A full catch-up push must preserve upstream history, retain all existing
activation gates, and leave Chrome Web Store submission separate.
