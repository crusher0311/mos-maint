# Same-shop printing production release

## Release evidence — 2026-10-06

- Production service: Render `mos-tools`, `srv-d55jaqkhg0os73a5dd8g`.
- Verified prior live revision and remote `main` baseline:
  `6ee66563400296ffac921057571f7891a0d0195f`.
- Released revision: `f40c9146200b5877133ab5840a16cf5e50524a71`.
- Render deployment: `dep-db2gr1c9v7es738idao0`, **live**
  at `2026-10-06T15:19:17.337252Z`.
- The release was prepared in an external temporary worktree by cherry-picking
  `ffa87d8378d49d5044a3a1c9ff684d09738ad0d7` onto the verified baseline.
  Its six-file diff contains only the existing correction, tests, documentation,
  and associated memory update. All baseline history, including newer labor
  reporting and recovery work, remains an ancestor.
- Re-fetched `main` immediately before the normal, non-force push; no concurrent
  change was present. Render auto-deployed; no duplicate manual trigger was sent.

## Prerequisites and validation

Read-only inspection found both `authentication_method` and `parent_token_hash`
as text columns on production `public.extension_sessions`. The checked database
was matched to the production web service's linked environment-group database
target without printing credentials. No migration or data repair was performed.

These commands passed on the exact integrated release tree:

- `npm run test:extension-location-switching` (server switching, sticker session,
  actual worker/panel message handlers, shared resolver)
- `npm run test:extension-secure-sessions`
- `npm run test:extension-enterprise-access`
- `npm run test:extension-shop-lookup`
- `npm run test:sticker-config-cache`
- `npm run prebuild` (including principal-scope and related auth suites)
- `npx tsc --noEmit --incremental false`
- `git diff --check`

Local test processes excluded Replit preview-domain signals to match the
production build environment; extension auto-publication was disabled locally.
No running service policy was changed. Render's production build also completed.
Its postbuild log explicitly confirmed that extension publication was skipped
because CWS credentials were not configured. No extension version changed.

The compatibility fixtures prove eligible same-shop requests return the original
bearer and original token-specific expiry with zero session issuance. They also
cover invalid/revoked/expired credentials, ambiguous legacy assignments, mapping
conflicts/outages, and retained cross-location authorization restrictions.

## Live checks and limits

- Public homepage: HTTP 200 and screenshot showed the normal MOS.Tools landing
  page. Public extension-version endpoint: HTTP 200 (not release-SHA evidence).
- Unauthenticated switch-location POST: HTTP 401, `TOKEN_MISSING`, as expected.
- `/api/health` remained protected and returned HTTP 401 without a login; this
  was not counted as a successful database-health probe.
- Both new running replicas logged Ready at 15:19:07 UTC.
- Runtime-only log inspection required actual instance labels, excluding
  prebuild output. The initial 100-error sample contained 95 expired-token
  feature requests, four sticker auto-booking-not-enabled messages, and one
  Tekmetric customer-enrichment access-denied error. Expired-token traffic was
  also present before release; production logs are not error-free.
- Targeted runtime searches after rollout found no extension-session lookup
  failures, `LOCATION_LOOKUP_FAILED`, or errors mentioning either prerequisite
  column. This is a bounded observation, not proof of every authenticated flow.
- Both background workers remained suspended with their prior deployment
  `8d190f07b70c4f15affa1faba19f8e13041e41b8`; no sibling deployment started.
  Worker schedules, flags, and configuration were not changed.

## Browser verification handoff

The existing affected-browser verification task (#1316) remains the owner of
real Chrome and physical-print evidence; no duplicate task is needed.
Use release `f40c9146` for that verification. **Before signing out, reinstalling,
or replacing the affected still-valid login**, test immediate and Customize
printing, original shop branding, two-tab routing, and worker restart.
Record the installed extension version and result. A fresh login alone does not
verify the older-session regression. The affected browser, original session,
and physical printer were not accessible during deployment and remain pending.

Rollback reference only: prior live deployment `dep-db2cinflk1mc738p1kf0`,
revision `6ee66563400296ffac921057571f7891a0d0195f`.
No rollback was performed. Re-check current production before any rollback so
subsequent production changes are not unintentionally removed.
