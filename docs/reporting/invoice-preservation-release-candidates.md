# Prepared invoice-preservation release candidates

## Status

**Background compatibility follow-up:** a narrow, separately pinned source-hours
candidate is now prepared. See
[background compatibility evidence](invoice-background-hours-compatibility.md)
for the candidate, portable patch, exact-lockfile validation and remaining
approval boundaries. The inventory below describes the original candidates,
not a claim that the older background adapter already generated hours.

Prepared and tested locally. **Not pushed or deployed.** Production reporting
settings, database permissions, backfills and repair data remain unchanged.
No production provider requests or live worker startup occurred.

The web/callback baseline and background-worker baseline differ by hundreds of
files. Separate local candidates avoid silently upgrading the background
worker's entire application history as part of this narrow release.

## Candidate inventory

| Intended services | Local branch | Candidate commit | Live baseline |
|---|---|---|---|
| Web and callback worker | `release/invoice-preservation-web-20261019` | `77310a4179d6a4b0651131091531c87cbccff8cc` | `fe244d68b9fabd5b7a8a4173404271b7962736b9` |
| Background worker | `release/invoice-preservation-background-20261019` | `d035f50e598f6877a8b941fdf0301502f4750336` | `8d190f07b70c4f15affa1faba19f8e13041e41b8` |

These are different histories, not interchangeable versions of main. Do not
force-push either or merge the older background history over newer application
work. A future rollout must explicitly choose service-specific commit/branch
pinning or an approved reconciliation onto a common baseline.

## Included changes

- Retain permitted, previously verified invoice identity/date on incomplete
  final snapshots, without preserving stale hours.
- Persist mapped invoice metadata on work-order creation.
- Include sanitized native payloads on PostgreSQL work-order updates.
- Fetch the prior metadata/shop identity needed by preservation.
- Reject ambiguous or cross-native-identity owners in lookup and atomic writes.
- Add preservation/retention and real-PostgreSQL identity-safety regressions.

The web candidate contains two additional existing one-line type corrections
in weekend-import eligibility checks. Its first typecheck failed on these
baseline errors; the existing workspace corrections were copied, reviewed and
validated. No scheduler logic or live scheduler settings changed.

The background candidate additionally includes the final-invoice predicate
dependency that was absent in its older baseline.

No fleet aggregation changes, repair executors, migrations, private data,
dependency manifests/lockfile changes, workflow-board features or extension
packages are included.

## Completed checks

| Check | Web/callback candidate | Background candidate |
|---|---|---|
| Preservation and raw-retention regression | Passed | Passed |
| Actual writer with disposable PostgreSQL: identity collision, atomic veto, retries | Passed | Passed |
| TypeScript check | Passed after baseline fixes | Passed |
| Configured callback-worker smoke | Passed | Not applicable |
| Worker entrypoint static bundle, external packages left external | Passed | Passed |
| Entire `npm run build`, including prebuild regression suite and Next production compilation | Passed | Not a web-release validation target |

Tests used removed production credentials and denied external egress; disposable
PostgreSQL/fixture loopback was allowed. Native library paths needed by canvas
were retained. Workers were not started against real integrations.

Nonblocking build warnings included an existing route runtime-literal warning
and stale Browserslist data. Static worker bundles warned about existing direct
eval usage in slow-query instrumentation.

Dependency limitation: both candidates used the existing workspace installation.
The web lockfile exactly matches the workspace lockfile. The older background
lockfile differs for `@emnapi/runtime` and `detect-libc`; a fresh install against
that lockfile was not performed. Therefore the background tests do not establish
a successful exact-lockfile Render installation.

## Important repair-readiness limitation

The older background adapter does not generate the newer `invoiceHours`
metadata. Its narrow candidate can retain a previously verified identity/date
but will leave hours unavailable when it cannot regenerate them. This is
fail-safe behavior, **not sufficient to guarantee continued complete reporting
after a metadata repair**.

Before treating the pilot repair as ready, address and test this older-worker
compatibility explicitly (a narrow generation backport or an approved baseline
upgrade). Do not hide it by carrying stale hours forward or silently including
the hundreds of unrelated baseline changes.

The guarded repair executor, fresh execution-time checks, canonical/shadow
consistency and explicit repair approval are still separate requirements.
Fleet-query database permission setup also remains separate.

## Retained release evidence

Incremental Git bundles and validation logs:
`generated-artifacts/release-candidates/invoice-preservation-20261019/`

Both bundles were verified. They require their listed baseline commits.
They and the logs are excluded from normal Git/deployment artifacts. The local
release branches also retain the candidate commits independently of temporary
worktree directories.

The workspace itself was not reset, switched to an older commit or pushed.
Temporary candidate worktrees are outside the workspace to avoid contaminating
source scanners.
