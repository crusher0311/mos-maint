---
name: Backfill completion tracking (per provider)
description: How "is this shop's backfill complete?" is actually determined — do not trust a single field.
---

# Backfill completion tracking

**Do not judge Tekmetric completion from one field.** The canonical "is this shop
done?" check is the 3-way OR in `app/api/cron/catchup-status/route.ts`:

```
complete = shops.tekmetricBackfillComplete === true
        || tekmetric_backfill_progress.completed === true
        || tekmetric_backfill_progress.complete === true
```

Querying `complete:true` vs `completed:true` separately is MISLEADING (they disagree:
e.g. complete:true=8 while completed:true=2) and the shops-doc flag
`tekmetricBackfillComplete` is effectively never set for Tekmetric (Protractor DOES use
its shops-doc flag `protractorBackfillComplete` as canonical). Use the catchup-status
endpoint (`GET /api/cron/catchup-status` with `Authorization: Bearer $CRON_SECRET`) for
the real count and per-shop breakdown — it also surfaces fullPageMode / prePass / errors.

**Why so few Tekmetric shops show complete** (observed 2026-06-02: 7 of 76 complete,
69 incomplete): NOT a flag-propagation bug. Two real causes:
1. ~25 shops sit in `fullPageMode` full-page reindex, which head-of-line-blocks on a few
   giant shops (see tekmetric-fullpage-completion.md) — data is indexed but `completed`
   never flips.
2. ~15 shops carry `lastError`, dominated by `[Tekmetric] Shared rate limiter saturated`
   full-page chunk errors ("chunk had errors, holding cursor (N/3)") — the API cap stalls
   chunks so cursors don't advance.

**Why it matters:** "completion isn't sticking" is the wrong diagnosis; the shops
genuinely aren't finishing because of reindex starvation + rate-limit chunk errors. Any
fix here changes prod cron logic and is operator-gated.

**Eligible-shop count caveat:** catchup-status counts only shops with a current Tekmetric
link (`tekmetric.shopId`/`tekmetricShopId`), so its total (76) and complete (7) can differ
slightly from a raw `tekmetric_backfill_progress` count (77 docs, complete:true=8) because
orphan progress rows have no linked shop.

**The full-page head-of-line fix is ALREADY in place** (`tekmetric-fullpage-backfill/route.ts`):
PER_SHOP_SLICE_MS=60s, giant-shop cap (MAX_GIANTS_PER_TICK=1 at prePassTotalPages>=1500),
and least-recently-touched ordering keyed off max(lastFullPageRunAt,lastPrePassRunAt). So
"a giant shop starves everyone" is no longer the active blocker — don't re-fix it.

**The real throughput bottleneck = the single shared Tekmetric API key (10 RPS hard cap).**
All backfill processes (date-window drain worker + full-page cron + pre-passes) run at
`'background'` priority and share ONE OAuth key via `lib/integrations/tekmetric/shared-rate-limiter.ts`.
Effective background budget = `TEKMETRIC_SHARED_RPS_CAP` (default 8, ceiling 10) minus
`TEKMETRIC_SHARED_RPS_USER_RESERVE` (default 3 RPS reserved for interactive users) ≈ 5 RPS
for ALL background backfill combined. "Shared rate limiter saturated/timed out" errors are
that cap being hit — the chunk sets lastError, holds its cursor, retries next tick
(self-healing, NOT wedged/data-loss). Years of history × dozens of shops through ~5 RPS is
simply slow; that's why only a few complete after days.

**Levers (no clean code fix — fairness is done):** (a) raise `TEKMETRIC_SHARED_RPS_CAP` 8→10
and/or lower `TEKMETRIC_SHARED_RPS_USER_RESERVE` — pure env-var config, reversible, but pushes
toward 429s / slows live in-app Tekmetric calls; (b) let the ~15 shops still in pre-pass
finish (per-RO API cost drops sharply once prePassDone); (c) get a second Tekmetric credential
to widen the pipe (external, needs Brandon/Tekmetric). All are operator/prod actions.

**Dev does NOT run these crons** (workflow logs show only dashboard polling + HostLoadSampler),
so the dev repl isn't stealing prod's Tekmetric budget despite sharing the prod Mongo/key.

**Protractor completion lives in a DIFFERENTLY-NAMED collection — the status script lies.**
Protractor progress/cursor is in collection `backfill_progress` (keyed by shopId) with
`completed:true` + the shop-doc flag `protractorBackfillComplete`. `scripts/check-backfill-status.ts`
reads `protractor_backfill_progress` (note the prefix) which is EMPTY, so it always reports
"Protractor: 0 shops" — a false zero. To get real Protractor status, query `backfill_progress`
for shops with `shops.protractor.configured:true`. Measured 2026-06-07: 29 configured, 7 complete.

**Tekmetric page size is hard-capped at 100 (probe-confirmed 2026-06-07).** Requesting
`/repair-orders?...&size=200` or `&size=500` still returns exactly 100 items with unchanged
`totalPages` — Tekmetric ignores size>100. So "pull bigger pages to go faster" is NOT available;
the only throughput levers left are RPS (already maxed at the 10/key documented cap), a 2nd API
key, or shrinking the history horizon. See tekmetric-throughput-ceilings.md.
