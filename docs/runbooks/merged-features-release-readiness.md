# Merged features: release readiness

## Scope

- Enterprise Tire DVI is a separate, fictional frontend demo, not a production
  DVI replacement. Its build output belongs to its own artifact.
- Shared branding changes target the existing production Shop Workflow.
- Enterprise vehicle history remains default-off. Follow
  `enterprise-vehicle-history.md` for the separately approved migration,
  supporting-index review, and staged pilot. Do not enable it during a code-only
  release or run the broad normalized-table migration against live stores.
- The extension history UI requires a separately approved, versioned Chrome Web
  Store release. Do not auto-publish during setup.
- Running Protractor history/recovery jobs are outside this release's scope.

## Verified after merge

- Post-merge setup and all four release-gating lints passed.
- Main typecheck passed after the development server completed its restart.
- Enterprise history isolated service/UI regressions passed.
- Shared-branding repository, route, palette and authorization tests passed.
- Shop dispatch HTTP/model/feature tests passed.
- Shared-branding browser fixtures passed for colorful, pale and monochrome logos.
- Tire DVI typecheck, model tests, production build and browser walkthrough passed.
  The browser test covers presentation, evidence, pricing, reset and network
  isolation.
- Both demo previews rendered successfully in screenshot checks.
- Existing workflow demo typecheck and model tests passed.

## Remaining limitation

The older Detect Dog workflow artifact's standalone `vite build` repeatedly
timed out during transformation without completing. Its development preview is
working. Bounded attempts with explicit source scanning, limited native
parallelism, and isolation from parent PostCSS did not fix it; speculative
changes were reverted. Do not call this artifact's production bundle verified.
This artifact is separate from the production Shop Workflow branding components,
which passed their targeted tests.

The root application's full production build has not been rerun for this merge.
Do not treat targeted checks as a completed production build.

## Production handoff

1. Stage the intended feature commits on the production release branch, not a
   wholesale push of workspace main, which contains other unreleased work.
2. Run the complete root release build on that exact staged revision.
3. Keep enterprise history disabled unless its storage prerequisites and
   location-specific pilot have separately been approved.
4. Publish the tire demo separately if requested.
5. Do not publish the older workflow demo until its standalone build completes.
6. Obtain explicit approval for extension submission; no CWS upload was performed.

No production push, migration, sharing enablement or background-job restart
was performed as part of this verification.
