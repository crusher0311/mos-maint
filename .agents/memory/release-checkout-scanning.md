---
name: Release checkout scanning
description: Keep temporary release copies outside the workspace so broad source checks do not scan them
---
Keep temporary QA release checkouts outside the application workspace.

**Why:** the data-access guard traverses nested release copies even under `.local`, treating older checkout files as new direct-database violations. Worktree metadata may also disappear across environment restores while the files remain.

**How to apply:** use a temporary directory outside the workspace for release preparation, and verify the Git root before any push. When broad checks report violations entirely inside copied releases, relocate those copies rather than weakening the source guard.
