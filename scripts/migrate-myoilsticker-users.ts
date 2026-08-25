/**
 * MyOilSticker → mos.tools user migration (task #1181).
 *
 * DRY-RUN by default. Writing requires BOTH `--apply` and the env gate
 * `MIGRATE_MYOILSTICKER_CONFIRM=yes` (operator-gated: the dev Mongo in this
 * workspace IS the production cluster).
 *
 * Usage:
 *   npx tsx scripts/migrate-myoilsticker-users.ts                 # dry-run
 *   npx tsx scripts/migrate-myoilsticker-users.ts --limit=3       # canary dry-run
 *   MIGRATE_MYOILSTICKER_CONFIRM=yes npx tsx scripts/migrate-myoilsticker-users.ts --apply [--limit=3] [--collisions=link|skip]
 *
 * The mapping itself lives in scripts/myoilsticker-migration-mapping.ts and
 * the store-reconciling loop in scripts/myoilsticker-migration-core.ts (both
 * unit-tested). See docs/myoilsticker-migration-field-mapping.md and
 * docs/myoilsticker-migration-runbook.md.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { ObjectId } from "mongodb";
import { getDb } from "../lib/mongo";
import { getNextShopId } from "../lib/ids";
import { dualWritePgIdentity } from "../lib/db/wave4-write-mode";
import {
  insertShop as pgInsertShop,
  insertUser as pgInsertUser,
  updateUserFields as pgUpdateUserFields,
} from "../lib/data/repositories/pg/identity";
import { runMigration } from "./myoilsticker-migration-core";

const LEGACY_DB = "test";

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
}
const APPLY = process.argv.includes("--apply");
const CONFIRMED = process.env.MIGRATE_MYOILSTICKER_CONFIRM === "yes";
const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const COLLISION_MODE = (arg("collisions") ?? "link") as "link" | "skip";

async function main() {
  if (APPLY && !CONFIRMED) {
    console.error(
      "--apply requires MIGRATE_MYOILSTICKER_CONFIRM=yes (operator gate). Aborting.",
    );
    process.exit(2);
  }
  const write = APPLY && CONFIRMED;
  console.log(
    `MyOilSticker → mos.tools migration — mode: ${write ? "APPLY (writing)" : "DRY-RUN (read-only)"}, collisions: ${COLLISION_MODE}`,
  );

  const report = await runMigration(
    {
      legacyDb: await getDb(LEGACY_DB),
      mosDb: await getDb(), // mos-maintenance-mvp
      getNextShopId,
      dualWrite: dualWritePgIdentity,
      pgInsertShop: async (doc) => {
        await pgInsertShop(doc as any);
      },
      pgInsertUser: async (u) => {
        await pgInsertUser(u as any);
      },
      pgUpdateUserFields: async (id, set) => {
        await pgUpdateUserFields(id, set as any);
      },
      hashRandomPassword: () => bcrypt.hash(crypto.randomBytes(48).toString("hex"), 12),
      newUserId: () => new ObjectId(),
      log: (m) => console.log(m),
    },
    { write, limit: LIMIT, collisionMode: COLLISION_MODE },
  );

  const summary = {
    creates: report.creates.length,
    collisions: report.collisions.length,
    skippedAlreadyMigrated: report.skippedAlreadyMigrated.length,
    pgReconciled: report.pgReconciled.length,
    frozenDisabled: report.frozenDisabled.length,
    unverifiedImported: report.unverifiedImported,
    badHash: report.badHash.length,
    customGroupsMigrated: report.customGroupsMigrated,
    customGroupsOrphaned: report.customGroupsOrphaned.length,
    oildatasNotMigrated: report.oildatas.count,
  };
  console.log("\n=== Migration report summary ===");
  console.table ? console.table(summary) : console.log(summary);
  const outDir = path.join(process.cwd(), ".local");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "myoilsticker-migration-report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Full report: ${outPath}`);
  if (!write) console.log("(dry-run — nothing was written)");
  process.exit(0);
}

main().catch((err) => {
  console.error("migrate-myoilsticker-users failed:", err);
  process.exit(1);
});
