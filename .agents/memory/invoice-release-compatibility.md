---
name: Invoice release compatibility
description: Compare source-evidence backports against the pinned service release, not newer main reporting policy.
---
Backport current-source evidence generation against the explicitly pinned web
release. Do not accidentally copy later reporting policy from main into only
one service's compatibility patch.

**Why:** Testing the real older adapter against the pinned web adapter exposed
a meaningful omitted-deferred-collection policy difference from current main.
Importing the entire current reporting contract would also pull unrelated fleet
and query dependencies into the older worker.

**How to apply:** Run identical source fixtures through both real adapters and
the shared ingestion path, while keeping deliberately newer main policies
explicit. Complete sources regenerate hours; incomplete sources invalidate
hours rather than inherit a repair. Exact-lockfile installation is separate
from running tests against shared workspace dependencies.

Inventory suspended writers as well as active writers before advancing a shared
auto-deploy branch. A deliberate narrow worker branch must not be reset to main
merely to make service branch names match.

**Why:** Suspended services can still track the same auto-deploy branch as the
web app while retaining a much older baseline. Pinning the branch isolates
future code selection but does not replace the already-deployed worker image.

**How to apply:** Preserve approved suspension and branch isolation. Before
repair or a scheduled resume, verify the actual deployed worker revision, not
just the configured branch or GitHub head.
