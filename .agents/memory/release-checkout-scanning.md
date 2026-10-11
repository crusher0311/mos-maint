---
name: Release checkout scanning
description: Keep temporary release copies outside the workspace so broad source checks do not scan them
---
Keep temporary QA release checkouts outside the application workspace.

**Why:** the data-access guard traverses nested release copies even under `.local`, treating older checkout files as new direct-database violations. Worktree metadata may also disappear across environment restores while the files remain.

**How to apply:** use a temporary directory outside the workspace for release preparation, and verify the Git root before any push. When broad checks report violations entirely inside copied releases, relocate those copies rather than weakening the source guard.

Clean-environment release tests still need native runtime library paths.

**Why:** Removing inherited environment variables can make canvas-based sticker tests fail on a missing `libuuid.so.1` even though the library is already installed. This is a local test-environment failure, not evidence that the application change is broken.

**How to apply:** Keep database/provider credentials out of release tests, but supply verified native library directories to the test process. Resume from the failed check without repeating already-passing suites; do not change production configuration to repair a local loader failure.
