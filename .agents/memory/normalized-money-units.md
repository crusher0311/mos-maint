---
name: Normalized store money units differ by provider
description: normalized_work_orders.grand_total is CENTS for tekmetric; normalized_service_jobs money columns are DOLLARS for every provider.
---
Money units are table- AND provider-inconsistent in the normalized PG store: `normalized_work_orders.grand_total` is CENTS for Tekmetric (dollars for Shopmonkey/Protractor), but `normalized_service_jobs` `total`/`labor_total`/`parts_total` are DOLLARS for ALL providers (including Tekmetric).

**Why:** live-verified twice — median tekmetric grand_total ≈ 96681 vs the same ROs' service-job sums ≈ 988 (100× gap is at the WO level only); scaling job-level values by 0.01 produced $1.80 line items against a correct $1,642.80 total.

**How to apply:** scale ONLY `grand_total` by `CASE WHEN provenance->>'sourceSystem' = 'tekmetric' THEN 0.01 ELSE 1 END`; never scale service-job money columns. Also: `created_at` on normalized rows is IMPORT time, not business time — "newest N" pools are backfill-order, not recency; and declined service jobs often carry $0 totals, so never price-floor a declined filter.
