---
name: Normalized store money units differ by provider
description: normalized_work_orders/service_jobs totals are CENTS for tekmetric, dollars for other providers.
---
`grand_total`/`total`/`labor_total`/`parts_total` in the normalized PG store are provider-inconsistent: Tekmetric rows are stored in CENTS (adapter passes ro.total through raw), Shopmonkey/Protractor in dollars.

**Why:** live-verified (median tekmetric grand_total ≈ 51980 vs shopmonkey ≈ 268.52); a $-threshold filter or display that ignores this is off by 100x for the majority (tekmetric) of rows.

**How to apply:** scale by `CASE WHEN provenance->>'sourceSystem' = 'tekmetric' THEN 0.01 ELSE 1 END` in SQL (or ×0.01 in JS) before comparing/displaying. Also: `created_at` on normalized rows is IMPORT time, not business time — "newest N" pools are backfill-order, not recency; and declined service jobs often carry $0 totals, so never price-floor a declined filter.
