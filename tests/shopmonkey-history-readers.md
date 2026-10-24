# Shopmonkey history reader audit

## Coverage

- Plan-build's `job_index` fallback already reads both nested and flat titles/VINs without a provider allowlist. Shopmonkey ingest supplies its performed date and mileage. `triage.ts` consumes provider-neutral `ShopServiceHistory`; its DVI and deferred-work unions are separate and were intentionally not expanded.
- `last-performed.ts` likewise reads the shared job index without a provider switch. The new route regression exercises its actual loader with a Shopmonkey-shaped row.
- `JobIndexEntry.metadata.sourceType` now accepts Shopmonkey. `extractJobIndexFromWorkOrder` remains a Protractor-package-shaped adapter, not a Shopmonkey extractor; Shopmonkey ingestion remains in its normalized adapter.
- Open-RO mileage, VHI rebuild mileage, customer fallback, and discrepancy labeling recognize Shopmonkey. The normalized mirror lookup uses exact VIN/provider/shop scope and provider-qualified RO identifiers. It excludes soft-deleted rows.
- RO selection prefers active visits, then source service chronology (check-in for active visits; closed/completed/check-in for historical visits). Ingestion timestamps never establish recency or freshness. The bounded lookup refuses to select from more than 500 matching ROs rather than picking from an incomplete set. Regression coverage reverses ingestion and service-date ordering and checks stale/fresh behavior.
- VIN mileage selection skips mileage-less estimates in favor of a positive recorded reading, retaining that reading's true age. Explicit RO lookups never borrow mileage from another visit. Customer/context selection still includes mileage-less active estimates.
- Extension search resolves Shopmonkey vehicle context without querying Tekmetric, preserves source identity for both PG and Mongo rows, and understands flat history totals.
- PostgreSQL search already includes all providers with per-shop window ranking. Mongo's existing per-shop caps and round-robin merge now include old flat Shopmonkey rows. The compatibility query has a shop index hint and two-second budget; it does not change the existing keyword query.
- No provider write-back or new declined/deferred classification was added.

## Offline checks

Run the two new checks with external networking denied:

```sh
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' node --import tsx tests/shopmonkey-history-readers.smoke.ts
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' node --import tsx tests/shopmonkey-history-route.smoke.ts
```

Also verified: TypeScript, existing Shopmonkey ingestion, plan history merge, customer-name fallback, and last-performed matching checks.

## Live verification not performed

Fixtures use a synthetic VIN, not shop 195 customer evidence. No live plan-cache rebuild, database write, provider request, migration, index installation, or deployment was performed. Development Mongo is shared with production. After merge, an authorized operator must verify the supporting indexes, rebuild one real shop 195 VIN's plan, and compare its service anchor to the stored history. The signed-in application UI was not verified; the available preview serves an unrelated offline fixture.
