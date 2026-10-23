# Coordinated normalization release candidates

Prepared and pushed as three separate release branches on 2026-10-23.
**Not deployed or enabled.**
No invoice repair or export delivery is part of this release preparation.

The approved non-force atomic push created all three remote branches. Remote
commit IDs matched the candidates below; remote main remained `ad56fc49`.
Before pushing, no Render service was configured to any candidate branch, and
the candidates' GitHub workflow was manual-only (background had no workflows).

## Candidate inventory

| Service | Local candidate branch | Base | Candidate |
| --- | --- | --- | --- |
| Web (`mos-tools`) | `release/normalization-web-20261023` | `95c1f5d2` actual live web | `a1b295a2` |
| Callback worker | `release/normalization-callback-20261023` | `ad56fc49` actual live callback worker | `112ba236` |
| Both historical workers | `release/normalization-background-20261023` | `b35fde9b` configured background release head | `ae43cd37` |

The two suspended historical workers last ran `8d190f07`; their configured
release already contains two staged preservation/compatibility commits through
`b35fde9b`. The candidate preserves these rather than reverting to the old
running image. It adds only the three-file stale-provider-version guard change.
It does not import newer reporting policy or callback recovery into those workers.

The web and callback candidates include the guard, retained-payload recovery,
and hardened schema package. They preserve their distinct baselines. Neither
candidate imports the invoice-repair tooling or unrelated main changes.
Memory-only cherry-pick conflicts retain the baseline memory index.

The export-only service remains suspended, unchanged and outside this release.

## Verification

Initially completed against isolated checkouts in `/tmp` using existing
workspace dependencies:

- Web: actual disposable PostgreSQL retry, permission and freshness tests;
  TypeScript compilation.
- Callback worker: actual disposable PostgreSQL retry/permission tests;
  callback entrypoint and pipeline tests; TypeScript compilation; worker bundle.
- Historical workers: freshness tests; pinned invoice compatibility tests using
  `--release-candidate`; retained-evidence tests; TypeScript compilation;
  incremental-entrypoint test; bundles for both worker entrypoints.
- No worker loop was started against live services.

The historical compatibility harness defaults to a different omitted-deferred
policy unless `--release-candidate` is supplied. The correctly selected pinned
policy passed; no reporting implementation was changed to make the test pass.

The web production build completed successfully (exit 0). The first attempt stopped
in a fixture subprocess because relative NODE_OPTIONS preloads were unavailable
after that subprocess changed its working directory. The retry uses absolute
preload paths without changing application code or disabling authorization tests.
The aggregate pre-build suite reached its five-minute command budget; it was
resumed at the interrupted `test:dvi-link-parsers` step and the remaining checks
passed. Production compilation then hit the local `/tmp` filesystem quota.
After deleting only disposable checkout copies and generated cache, and moving
the webpack cache into ignored generated-artifact storage, `next build` passed.
Typechecking was verified separately; Next's configured typecheck/lint skipping
was not treated as evidence that those checks ran during compilation.

The background and callback temporary checkout copies were removed after initial
verification to recover scratch space, then recreated from their saved candidate
branches for isolated lockfile checks.

All three candidates subsequently passed separate lockfile installs with
`npm ci --include=dev --legacy-peer-deps --ignore-scripts --no-audit --no-fund`
under Node 20.20.0 / npm 10.8.2. Original package and lock files were unchanged.
Each checkout was connected to its own newly installed dependency tree:

- Web and callback: PostgreSQL retry/permission tests and TypeScript passed again.
- Web: identity/freshness regression passed again.
- Callback: callback-worker regression passed again.
- Background: pinned invoice compatibility, evidence preservation, identity tests,
  TypeScript, incremental entrypoint regression and drain-worker bundling passed.

Lifecycle scripts were deliberately not executed during isolated installs.
The full web build and broader prebuild suite above used the original working
dependency tree; clean native installation remains a deployment-build check,
not a locally verified result.
An installed-version audit found all 1,017 non-optional locked package versions
matched for both web and callback candidates. The background candidate matched
1,012 of 1,013: its lock pins `detect-libc` 2.0.4 while the shared installation
has 2.1.2. The background candidate was then retested against its own 2.0.4
installation successfully. Optional/platform dependencies were excluded from
the version audit. No lockfile was changed to match the workspace.

## Deployment and activation boundaries

1. Refresh live revisions and service configuration before any approved push.
   The callback worker currently auto-deploys main; do not push main as a shortcut.
2. Complete build and exact-lockfile checks; review each baseline-to-candidate diff.
3. Obtain explicit coordinated push/deployment approval. Keep
   `PROTRACTOR_LOCAL_NORMALIZATION_RETRIES` disabled in every service.
4. Preserve the historical workers' suspension. Verify the exact prepared image
   before any separately authorized resume. Do not start old writer images.
5. Verify all canonical writers have the provider-version guard before considering
   recovery activation. A configured Git branch is not proof of a deployed image.
6. Activation, bounded recovery observation, and the retained-invoice repair each
   require their own explicit authorization; this package performs none of them.

Production schema installation was separately approved and verified empty with
API-role access denied. The SQL is review-only, never an automatic migration or
startup action. Do not reapply it as part of deploying these candidates.
