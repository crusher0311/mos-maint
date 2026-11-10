# Tekmetric line concurrency prevention (local only)

This change prevents updated Tekmetric writers from independently creating two
normalized line rows for the same shop, service job, line type and provider ID.
It does not repair duplicates, introduce production indexes, activate recovery,
or change Protractor identity resolution.

## Write contract

- Resolve raw legacy IDs and type-prefixed IDs as aliases within one line type.
  Labor and part IDs never share a lookup merely because their numbers match.
- Hold a transaction-scoped advisory lock across lookup and write. Re-read after
  acquiring it; return the winning line ID to ingestion and shadow writes.
- Preserve existing legacy local IDs. If more than one candidate matches, fail
  explicitly even on the unchanged-content path; do not pick an arbitrary row.
- Verify shop/job/work-order scope and provider ownership. A late local primary
  key collision on the insert-only path must not overwrite another record.
- Bound lock waiting to two seconds and each SQL statement to five seconds.
  Failed writes roll back; callers receive the existing ingestion error result.
- The new writer transaction is atomic, but a post-commit response loss may still
  require the caller's normal retry. This is not a freshness-ordering fix.

## Rollout limitations

Advisory locks coordinate only participating writers. Old/unmodified processes
can still create duplicates. Before rollout, inventory every active Tekmetric
normalized writer and verify all have upgraded or are safely stopped; do not
resume old workers or change their configuration without operator approval.

This scope does not deduplicate service jobs, payments, or the same provider
line already spread across duplicate service-job parents. A previously mixed
labor/part row cannot always be reconstructed safely from local state alone.
Existing ambiguous data requires a separately approved evidence-based repair;
no delete or unique-index installation is part of this fix.

## Local verification

Run `bash tests/run-tekmetric-line-concurrency.sh`. It strips credentials,
blocks external network access, creates marked disposable PostgreSQL with TCP
disabled, and cleans it up on exit. It uses real schema enums, parent/child
foreign keys, ingestion, adapter and writer; Mongo shadows use an in-memory
double. Coverage includes concurrent creates, stable canonical shadow identity,
sequential skips, labor/part namespace separation, legacy IDs and hash updates,
ambiguous existing rows, scope conflicts, and lock timeout/retry behavior.

Also run the existing normalized-parent identity, FK skip-path, callback
normalization runtime, invoice compatibility and evidence-preservation checks,
plus TypeScript checking. Full release build checks and any production rollout
remain separate from this local implementation.
