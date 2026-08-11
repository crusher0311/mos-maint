---
name: Negative cache over stale positive entries
description: When a failed refresh negative-caches onto the same doc as positive cache data, it must clear the stale data field.
---

Rule: if a "failed fetch" backoff marker is stored on the same document as the positive cache entry (Tekmetric vehicle/customer caches; pattern likely reused elsewhere), recording a failure MUST `$unset` the stale `data` field.

**Why:** the backoff gate checks `!doc.data` (a doc with data reads as positive → never gated → same failing live fetch repeats every sync tick), and the failure path bumps `cachedAt` for the TTL index — leaving stale `data` behind would make expired data look fresh to readers. Caught by completion code review 2026-08-11; regression test lives in the tekmetric-negative-cache smoke test.

**How to apply:** any collection that mixes positive entries and negative-cache markers — on failure, transition the doc fully to a negative entry (clear payload, keep failCount/retryAfter/cachedAt); on success, restore payload and `$unset` backoff fields.
