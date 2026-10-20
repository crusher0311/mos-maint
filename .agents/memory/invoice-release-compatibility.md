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

Do not use membership in the web service's shared environment group as the
complete writer inventory.

**Why:** The backfill-drain service was absent from that membership list despite
being an independently deployed writer requiring the same compatibility checks.

**How to apply:** Reconcile environment-group discovery with the known service
inventory and explicitly check omitted writers, including suspended services.

Repository-wide discovery also includes QA and retired services; membership is
not proof that they share the repair's data target.

**Why:** The live repository inventory contains both primary production workers
and separate QA/legacy services. Treating discovery as rollout authorization
would widen a narrow repair release or reactivate a retired process.

**How to apply:** Verify each candidate's data-target and resume policy before
reviewing writer coverage. Never deploy/resume old services merely to make the
verification inventory pass, or silently omit them without evidence.
