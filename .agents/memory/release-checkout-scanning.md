---
name: Release checkout scanning
description: Keep temporary release copies outside the workspace so broad source checks do not scan them
---

Temporary storage quotas can be exhausted despite free space reported by `df`.

**Why:** Isolated Next.js release output can prevent post-merge log creation with
EDQUOT (system error -122) before the setup script even runs.

**How to apply:** Verify a small temporary-file write. After preserving candidate
commits, bundles and validation logs, remove only disposable build output.
Do not delete source worktrees or evidence, or rewrite setup logic to mask a
filesystem quota failure.
Keep temporary QA release checkouts outside the application workspace.

**Why:** the data-access guard traverses nested release copies even under `.local`, treating older checkout files as new direct-database violations. Worktree metadata may also disappear across environment restores while the files remain.

**How to apply:** use a temporary directory outside the workspace for release preparation, and verify the Git root before any push. When broad checks report violations entirely inside copied releases, relocate those copies rather than weakening the source guard.

Clean-environment release tests still need native runtime library paths.

**Why:** Removing inherited environment variables can make canvas-based sticker tests fail on a missing `libuuid.so.1` even though the library is already installed. This is a local test-environment failure, not evidence that the application change is broken.

**How to apply:** Keep database/provider credentials out of release tests, but supply verified native library directories to the test process. Resume from the failed check without repeating already-passing suites; do not change production configuration to repair a local loader failure.

Check each writer's deployed baseline before assembling a narrow multi-service
release.

**Why:** A background worker can lag far behind the web service. Releasing the
web baseline to every worker can introduce substantial unrelated changes;
backporting only preservation can also leave an older adapter unable to
regenerate new reporting metadata.

**How to apply:** Separate narrow backports from explicitly approved baseline
upgrades. Test real adapter compatibility and exact dependency provenance, not
just shared mocked ingestion tests. Do not imply separate-baseline candidates
can both be promoted as the same main-branch commit.
