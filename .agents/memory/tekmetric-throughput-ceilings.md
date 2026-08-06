---
name: Tekmetric backfill throughput ceilings
description: The hard limits on how fast Tekmetric history can be pulled, and which levers actually exist.
---

# Tekmetric throughput ceilings

When asked "is there a faster way to pull Tekmetric history?", the answer is no
within the current single-key setup. The limits are hard and already maxed:

1. **Page size capped at 100.** Probe-confirmed 2026-06-07: requesting `size=200`
   or `size=500` on `/repair-orders` returns exactly 100 items with unchanged
   `totalPages` (shop 9221 = 26,036 ROs = 261 pages either way). `PAGE_SIZE=100`
   in `full-page-backfill.ts` is already the API max. Bigger pages are impossible.

2. **Rate: 600 req/min = 10 RPS per API key** (Tekmetric documented, cited in
   `client.ts`). Local pacer caps each process at 8 RPS (80% of 10); the
   cross-process shared limiter (`shared-rate-limiter.ts`) caps the whole fleet at
   `TEKMETRIC_SHARED_RPS_CAP` (≤10). So a single process maxes ~8/sec; 10/sec only
   when two processes overlap via the shared bucket. Already at the ceiling.

3. **Per-RO N+1 is already mitigated.** The full-page loop can fan out to
   `/jobs`, `/vehicles`, `/customers` per RO on cache miss, but the bulk pre-passes
   (jobs/vehicles/customers shop-window pulls) pre-warm those caches so the per-RO
   loop avoids per-RO calls once prePassDone. Don't "fix" this — it's done.

**The single shared OAuth key is the fleet bottleneck.** All backfill processes
share ONE key. The ONLY levers for materially faster Tekmetric history:
- **Shrink `BACKFILL_HORIZON_YEARS`** (prod=5; free instant env flip; loses deep
  history — product decision). Biggest, cheapest lever. See backfill-horizon.md.
- **Add a 2nd Tekmetric credential** with key-rotation in the shared limiter
  (~doubles RPS, keeps full history) — needs code (2-credential rotation) +
  Brandon/Tekmetric to provision the key. Previously deferred (AppFueled idea).
- RPS env bump (`CAP`/`USER_RESERVE`) — already applied; only buys 5→8/sec and
  risks 429s / starves live in-app calls.

- Roster sync (appointments fan-out in the tekmetric-backfill cron) was the loudest background budget consumer (~860 exhaustions/4h fleet-wide, Aug 2026); levers now in code: peak-hours deferral (TEKMETRIC_ROSTER_PEAK_START/END_UTC), staleness cadence, appointment lookahead. Symptom of saturation: stale ro-context caches -> live interactive calls -> upstream timeouts -> negative-cached ROs ("recent timeout" logs), while interactive lane shows zero rate-limiter waits.
