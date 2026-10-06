---
name: GitHub push vs credential helper
description: gitPush fails with DANGEROUS_CONFIG while the repo's credential.helper is set; remove, push, restore.
---
The repo's `.git/config` carries a credential.helper that echoes `$GITHUB_TOKEN`. The managed GitHub push refuses to run while any credential helper is configured (DANGEROUS_CONFIG).

**Why:** helper could read the injected bearer token from the environment.

**How to apply:** `git config --local --unset-all credential.helper`, run the push, then restore the helper exactly (`!f() { echo username=crusher0311; echo "password=$GITHUB_TOKEN"; }; f`) so the user's own git flows keep working. Note: memory files live on the branch being worked on.

For exact-tree Git Data API pushes from CodeExecution, do not depend on its
`readFile` callback for hidden paths or on Node's `Buffer` in durable scope.
Encode validated workspace files with `shellExec` and send the base64 directly
to GitHub's blob API with `encoding: "base64"`.

**Why:** The sandbox rejected `.agents` reads, omitted `Buffer`, and normalized
the separator in `git diff --name-status`, causing repeated preparation failures
before any GitHub write.

**How to apply:** Get paths with `git diff --name-only`, validate them against a
strict path allowlist/pattern, base64 each file, create blobs and a tree from the
known GitHub parent tree, and require the resulting tree SHA to equal the local
validated tree before updating `main`.

Large Git tree manifests should be written as JSON to a temporary file and
loaded with `readFile` using an explicit byte budget, not parsed from shell
stdout in CodeExecution.

**Why:** Shell-output normalization can remove tab separators, and large tree
listings can be truncated despite a requested output budget.

**How to apply:** Compare the full local manifest with GitHub's recursive tree,
upload only changed blobs, and retain the exact-tree SHA check before pushing.

GitHub connector permissions and the repository's existing Git publishing
credentials can differ. A healthy connector may read the repository but reject
Git Data API writes with `Resource not accessible by integration`, while the
already-configured Git push path remains authorized.

**Why:** A narrow production release was blocked at API tree creation but
succeeded through a normal, non-force Git push without permission changes.

**How to apply:** Do not assume that reconnecting OAuth will fix an installation
permission restriction. Check the existing authorized Git publishing path
without reading credentials or changing helpers. Preserve concurrent upstream
changes and never force-push to work around a rejected update.

Pin a release to the fetched remote branch's commit, not a later read of
`FETCH_HEAD`, and verify the resulting tree changes exactly the intended paths.

**Why:** This workspace has concurrent task-remote fetches; `FETCH_HEAD` is
shared transient state and can cease to refer to the production branch.

**How to apply:** Resolve `origin/main` to an immutable SHA, preserve its other
files, check the release diff against an explicit allowlist, and use a normal
non-force push so concurrent production changes reject rather than disappear.
