---
name: Release and build verification
description: Index of Git/Render release safety, isolated checks, native dependencies, and TypeScript/build pitfalls.
---

Use the existing release and validation guidance before publishing or diagnosing a failed build:

- [Render production deployment](render-prod-deploy.md): main auto-deployment and live-commit verification.
- [Git credential helpers](github-push-credential-helper.md): managed push restrictions.
- [Replit package-lock URLs](replit-proxy-urls-in-lockfile.md): workspace proxy URLs are not reachable in Render.
- [Release checkout scanning](release-checkout-scanning.md): keep isolated releases outside the workspace.
- [Offline release checks](offline-release-checks.md): hanging test processes, timing-dependent failures, native loader paths and cache quotas.
- [Next typecheck restart race](next-typecheck-restart-race.md): generated route types and cache cleanup.
- [Route exports](route-file-exports.md): Next route modules cannot export arbitrary test seams.
- [Client-safe shared modules](client-safe-shared-modules.md): browser imports must not transitively load server code.
- [server-only test seams](server-only-untestable-under-tsx.md): isolate pure logic for tsx tests.
- [Repository migration test seams](repo-migration-test-seams.md): preserve fake-store boundaries in prebuild checks.
- [Smoke version pins](smoke-version-pin-blocks-deploys.md): exact version assertions block unrelated releases.
- [Merge-marker verification](merge-marker-verifier.md): decorative comment separators can trigger false positives.
- [Long-running jobs](long-running-jobs-need-workflow.md): use managed workflows or tracked background tasks, not shell detachment.

**Why:** These related release pitfalls previously occupied separate entries in the main memory index, reducing room for product constraints.

**How to apply:** Follow the link relevant to the observed failure; this is a navigation index, not evidence that a historical condition still exists.
