# Runbook: MyOilSticker → mos.tools live migration (operator-gated)

Task #1181 delivered the tooling + a verified dry-run. **The write run is a
separate operator action** — do not run `--apply` from an isolated/dev
environment casually: this repl's Mongo IS the production cluster.

Script: `scripts/migrate-myoilsticker-users.ts`
Mapping doc: `docs/myoilsticker-migration-field-mapping.md`

## 1. Pre-flight

```bash
# Fresh dry-run — review counts, collisions, unmappable fields
npx tsx scripts/migrate-myoilsticker-users.ts
# Full JSON report: .local/myoilsticker-migration-report.json
```

Check:
- `creates` + `collisions` + `skippedAlreadyMigrated` ≈ 522
- Collision list looks right (each is link-tag-only; existing accounts untouched)
- `badHash` is empty (otherwise those accounts import disabled)

## 2. Canary

```bash
MIGRATE_MYOILSTICKER_CONFIRM=yes npx tsx scripts/migrate-myoilsticker-users.ts --apply --limit=3
```

Verify one canary account:
- Log in at mos.tools with the legacy email + legacy password → should work.
- Sticker settings page shows migrated size/colors/interval/schedule URL.

## 3. Full run

```bash
MIGRATE_MYOILSTICKER_CONFIRM=yes npx tsx scripts/migrate-myoilsticker-users.ts --apply
```

Idempotent/resumable: re-running skips everything already tagged
(`legacyOilStickerId`), so a crash mid-run is safe to just re-run.

## 4. Verification queries (mongosh, db `mos-maintenance-mvp`)

```js
db.users.countDocuments({ legacySource: "myoilsticker" })          // ≈ 522 (creates + linked)
db.shops.countDocuments({ legacySource: "myoilsticker" })          // ≈ creates count
db.users.countDocuments({ legacySource: "myoilsticker", mustChangePassword: true }) // = frozen/badHash count
// spot-check a shop's sticker config
db.shops.findOne({ legacySource: "myoilsticker" }, { name:1, stickerConfig:1, carfax:1, timezone:1 })
```

## 4b. Interrupted run / resume behavior

Simply rerun the same command. The rerun:

- reuses a shop that was inserted before a crash (same `legacyOilStickerId`)
  instead of allocating a duplicate;
- for records already complete in Mongo, **replays the PG identity mirror
  writes** (shop/user inserts are `ON CONFLICT DO NOTHING`; the collision tag
  update is a plain SET), so a crash between the Mongo write and its PG
  mirror can never strand a customer without a PG identity row. Reconciled
  records appear in the report as `pgReconciled`.

This behavior is covered by `npm run test:myoilsticker-migration-resume`.

## 5. Rollback (delete-by-created-flag)

Only records the migration **created** carry `legacyMigrationCreated: true`.
Collision-linked pre-existing users never get that flag — they only carry the
tags — so the delete below cannot select them:

```js
// remove ONLY migration-created shops + users
db.shops.deleteMany({ legacyMigrationCreated: true, legacySource: "myoilsticker" })
db.users.deleteMany({ legacyMigrationCreated: true, legacySource: "myoilsticker" })
// un-tag linked pre-existing users (do NOT delete them — they have no
// legacyMigrationCreated flag, so the deletes above never touch them)
db.users.updateMany(
  { legacySource: "myoilsticker", legacyMigrationCreated: { $exists: false } },
  { $unset: { legacySource: "", legacyOilStickerId: "", legacyMyOilSticker: "" } }
)
```

If PG identity dual-write was active, mirror the deletes in the PG `users` /
`shops` tables by the same ids.

## Notes

- `oildatas` (~896k print-history rows) is NOT migrated; follow-up can join
  via `oildatas.user_id` → mos `users.legacyOilStickerId`.
- Legacy billing state is only recorded in `legacyMyOilSticker` metadata;
  Stripe/billing setup for migrated shops is a separate effort.
- app.myoilsticker.com stays up until decommissioned separately.
