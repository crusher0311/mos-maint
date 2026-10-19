# Older background-worker invoice-hours compatibility

## Scope and candidate

Local preparation only: no provider requests, repairs, production configuration,
database changes, deployment or push. Fleet aggregation remains disabled; no
aggregation implementation or enablement flags are included in this patch.

- Parent candidate: `d035f50e598f6877a8b941fdf0301502f4750336`.
- New candidate: `5ac53824671e523701b6504079033fb22f81019c`.
- Local branch: `release/invoice-hours-background-compatibility-20261020`.
- Web/callback comparator: `77310a4179d6a4b0651131091531c87cbccff8cc`.
- Portable runtime-only patch: `patches/invoice-background-hours-generation.patch`.
  Apply only to the parent candidate, not current main. The regression test and
  isolated check runner are tracked under `tests/` and included in the new commit.

The background release still uses its older application baseline. Do not merge
that history over main or substitute it for the web release. A common-baseline
upgrade remains a separate approval, not part of this compatibility fix.

## Actual paths inspected

The older `lib/integrations/protractor/sync.ts` queues each native `source`
(invoice-list payload or fetched full invoice) in `invoicesForNormalized`, then
calls `ingestWorkOrderBatchWithAllEntities`. The core batch path calls
`ingestWorkOrderWithAllEntities`, whose parent path calls `ingestWorkOrder`.
Web `work-order-service.ts` and callback `callback-drain.ts` also enter the
all-entities path. These converge on the real adapter's `mapWorkOrder`, followed
by identity checks, `preserveInvoiceIdentity`, content hashing and parent writes.

Before this backport, the older adapter supplied `{}` for work-order custom
fields. The preservation layer could retain identity/date but deliberately
cleared hours. The fix adds only current-source invoice evidence generation,
one adapter import/assignment and an export of the existing occurrence-aware
line-key helper. Existing labor evidence and package normalization dependencies
are identical across the two pinned candidates.

The standalone generator is copied from the **pinned web candidate**, not
current main's broader reporting contract. It does not import queries,
aggregation, repair code, technician changes or newer labor mapping behavior.
In particular, both pinned candidates conservatively leave presented hours
unknown when the deferred collection is omitted. Main has a subsequent,
separate omitted-deferred policy; the regression explicitly distinguishes it.

## Safety and expected outcomes

- Complete native evidence regenerates hours on create and update. Changed
  current hours replace repaired hours; recorded zero remains zero.
- Missing hours, estimated-only hours, malformed collections, missing package
  identities/invoicing flags and conflicting duplicate copies remain unknown.
- Incomplete invoice identity can retain only a previously verified matching
  identity/date, with both hours null. Date conflicts, nonfinal payloads and
  cross-shop evidence cannot inherit it.
- Cross-native-ID and ambiguous owners still fail before parent writes; atomic
  writer guards are unchanged.
- No financial values are repaired. Existing financial reconciliation and
  execution-time vetoes are unchanged and independently regression-tested.
  Passing hours generation is not financial repair approval or fleet coverage.

This solves regeneration from complete current payloads, **not** permanent
availability from incomplete imports. Keeping old hours in the latter case
would violate the evidence contract.

## Reproduction and retained evidence

Run from an isolated checkout outside the main source tree:

1. Check out the pinned candidate with its own `node_modules` directory.
2. Run `npm ci --no-audit --no-fund` with production credentials removed.
3. Run `bash tests/run-invoice-background-compatibility.sh --release-candidate`.

The runner strips credentials, denies external egress, permits disposable
loopback PostgreSQL, and bundles worker entrypoints without starting workers.
The compatibility test uses the actual adapter and parent ingestion methods;
only storage is faked. The separate PostgreSQL regression exercises the actual
writer, natural-key collisions, atomic identity vetoes and concurrent retries.
It does not simulate provider HTTP or claim end-to-end provider verification.

Exact background installation succeeded: 1,078 packages installed, with no
manifest/lockfile changes and no workspace `node_modules` symlink. Lockfile SHA256:
`d2ecf98ac07ee721e172a430a749d58fe1180167f7e4e55e49267fe05ef14565`.
This establishes installation in the local runtime, not a Render deployment.
The web comparator uses the existing workspace installation, whose lockfile
matches that candidate.

| Check | Background | Web/callback |
|---|---|---|
| Real adapter + ingestion, 12 create/update fixtures and veto cases | Pass | Pass |
| Existing preservation/raw-retention regression | Pass | Pass |
| Disposable PostgreSQL actual-writer identity/atomicity regression | Pass | Pass |
| `npm run typecheck` | Pass | Pass |
| Background incremental entrypoint regression | Pass | Pass |
| Callback worker policy/shutdown regression | Not in older baseline | Pass |
| Static ESM worker bundle, packages external | Pass | Pass |

Workspace financial-audit, metadata-repair-plan and owner-repair-model veto
regressions also passed with credentials removed and external egress denied.
The first bundle command incorrectly named a callback entrypoint absent from
the older baseline; the runner now selects only entrypoints present in each
candidate. Both corrected bundle checks exited zero. Other passed checks
were not repeated, since no runtime source changed. Existing direct-eval
warnings in slow-query instrumentation remain nonblocking.

Logs and an incremental Git bundle are retained under the ignored directory
`generated-artifacts/invoice-background-compatibility/`. The portable patch and
tests are committed so reproduction does not depend on temporary worktrees or
ignored artifacts surviving.

Production rollout, repair execution approval, fresh retained-source financial
agreement, and database permission setup remain separate requirements.
