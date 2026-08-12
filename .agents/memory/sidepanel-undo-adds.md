---
name: Side-panel add-to-RO undo
description: Provider constraints for undoing side-panel job adds.
---

Undo of side-panel job adds is per-provider, and providers differ in whether a delete path even exists:

- **Tekmetric**: created jobs are deleted through the page session's own API; the delete endpoint was inferred by mirroring the create call, not observed from the Tekmetric UI — before trusting it in production, sniff the page's native job-delete request.
- **Protractor**: there is no package-delete API; removal = re-POST the work order with the package filtered out (same minimal-payload builder + SOAP fallback the add uses). Treat "package already gone" as success so retries are safe.
- **Shop-Ware**: no delete path exists; adds must NOT be snapshotted — offering an undo that can't execute is worse than none.

Partial undo failures must keep the not-yet-deleted identifiers stored (rewrite the snapshot to the remaining items) — clearing on partial success permanently strands the failed items.

**Why:** an accidental add otherwise has to be removed by hand in the SMS, and a lost identifier makes that permanent.
**How to apply:** new write flows should snapshot created identifiers only when a real revert path exists, and revert loops must be all-or-nothing per snapshot with retryable remainders.
