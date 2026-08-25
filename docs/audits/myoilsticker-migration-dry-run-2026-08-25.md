# MyOilSticker migration — verified dry-run report (2026-08-25)

Read-only dry-run of `scripts/migrate-myoilsticker-users.ts` against the live
legacy data (`test` db, same cluster). Nothing was written.

| Metric | Value |
|---|---|
| Legacy users | 522 |
| Existing mos.tools users | 409 |
| Would create (new shop + owner user) | 367 |
| Email collisions (link-tag only, no changes) | 155 |
| Already migrated (resume skip) | 0 |
| Frozen → imported disabled | 0 |
| Unverified email (imported normally, flag recorded) | 366 of the 367 creates |
| Bad/non-bcrypt hash | 0 (all 522 are bcrypt `$2b$`) |
| Custom groups migrated | 1 (VW → masonvidler@gmail.com) |
| Custom groups orphaned (deleted legacy user) | 2 (Honda, Mazda) |
| `oildatas` print-history rows NOT migrated (out of scope) | 895,560 (link key: `user_id` → `users.legacyOilStickerId`) |

Reconciliation: 367 creates + 155 collisions + 0 skips = 522 ✓

Full per-account detail (every create and every collision with legacy id,
mos user id, and decision) is regenerated on each run at
`.local/myoilsticker-migration-report.json`.

The live write run is operator-gated (`--apply` +
`MIGRATE_MYOILSTICKER_CONFIRM=yes`) — see
`docs/myoilsticker-migration-runbook.md`.
