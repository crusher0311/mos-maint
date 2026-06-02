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
