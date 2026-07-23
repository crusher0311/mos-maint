---
name: Canned-jobs lineless cache & push path
description: Titles-only "enriched" caches pass blank-checks but push $0 packages; push-path detail fallback must use the canned-job endpoints, not only /ServicePackageTemplate/Read.
---

Two distinct failure layers behind $0 header-only canned packages on pushed Protractor WOs:

1. **Blank-check vs lineless-check are different.** `isCannedJobsCacheContentBlank` counts a title-only item as content, so a cache where every item has a title but `lines: []` is "healthy" for search yet pushes $0 packages. Use `isCannedJobsCacheLineless` (titles present, <2% of items carry lines, ≥10 items) to detect this shape; on hit, serve the cache but background re-enrich, gated by `linesRefreshAttemptedAt` (24h) to avoid loops.

2. **Push-path fallback used only the wrong endpoint.** `createProtractorWorkOrder`'s template fallback called only `fetchServicePackageTemplateDetail` (`/ServicePackageTemplate/Read/{id}`) which 404s for canned-job IDs — the same wrong-endpoint bug fixed earlier in the enrichment path but not in the push path. Correct chain: `fetchCannedJobDetail` → `fetchCannedJobDetailViaTemplate` → `fetchServicePackageTemplateDetail`.

**Why:** cache-side fixes and push-side fixes drift apart because the same canned-job detail logic exists in both places; check BOTH whenever a detail-endpoint bug is found.

**How to apply:** any enrichment/cache write must pass `wouldDowngradeCannedJobsCache` (never replace a line-bearing cache with a line-less batch, never replace non-empty with empty). Empty pushes now emit a structured `[Create WO] WARN: pushing header-only $0 package` console.error and return `packagesWithoutLines` to callers/wizard — keep that contract when touching the create-WO response shape.
