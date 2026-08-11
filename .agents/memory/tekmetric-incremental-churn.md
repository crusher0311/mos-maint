---
name: Tekmetric incremental sync churn
description: Budget-denied fetch retry storm made 2-min incremental cycles run 7-17h and overlap; the guards that fixed it
---

**Rule:** the Tekmetric incremental sync (2-min cron, runs inline on web) must never retry budget-denied vehicle/customer fetches every tick, never exceed a wall-clock deadline, and never overlap itself.

**Why:** by 2026-08-11 cycles ran 7-17 HOURS (1.6k-5.1k API calls each, overlapping), causing the daytime p95 spikes users felt as "extension timeouts" — AFTER the new-shop fullpage gate (smart-timing fallback window) was already working. The trigger was uncached vehicles whose live fetch was denied by the background rate budget, logged, and retried on every tick with no negative cache (~320k failed fetches/week).

**How it's guarded now (lib/integrations/tekmetric/incremental-sync.ts):**
- Negative cache on the existing `tekmetric_vehicle_cache`/`tekmetric_customer_cache` docs (no `data` field; `failCount` + `retryAfter`, exp backoff 5m→4h, cleared by successful cache writes; 24h TTL index GCs them).
- `TEKMETRIC_INCREMENTAL_DEADLINE_MS` (default 90s) checked at batch boundaries AND inside the per-RO loop; terminal sweep skipped past deadline.
- In-process `cycleInFlight` guard (per-process only, not a distributed lock).
- Fair rotation cursor (in-memory, sorted by shopId) so deadline-deferred tail shops run FIRST next tick — without it, steady deadline hits permanently starve the tail.

**Watch for:** `DEADLINE HIT (N shops deferred)` in the cycle completion log line; the real long-term fix is still the second Tekmetric API key / moving background sync off web.
