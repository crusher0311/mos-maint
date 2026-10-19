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
