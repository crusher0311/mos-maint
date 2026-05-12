/**
 * Repair carfax_reports rows that were silently corrupted by the
 * pre-2026-05-12 snapshot bug.
 *
 * Symptom in Mongo:
 *   - `ok: true`
 *   - `serviceRecords: null` (or [])
 *   - `raw.errorMessages.errors[0].code` set (typically 107 or 302)
 *
 * Background: `fetchCarfaxLive` used to ignore CARFAX's in-band error
 * envelope (HTTP 200 + `{ errorMessages: { errors: [...] } }`) and
 * return `ok: true` with an empty payload. `upsertCarfaxSnapshot` then
 * happily wrote that over previously-good cached data, destroying the
 * service history. ~709 docs platform-wide were affected before the
 * fix landed.
 *
 * What this script does:
 *   - Find all matching rows.
 *   - Flip them to `ok: false` and stamp `lastErrorAt`,
 *     `lastErrorMessage`, plus `repairedAt: now`. We do NOT try to
 *     resurrect the lost serviceRecords (we'd need a fresh CARFAX
 *     fetch for that — the next on-demand request will do it
 *     organically once the new preservation logic is in place).
 *   - Idempotent: rows already flipped (have `repairedAt`) are
 *     skipped.
 *
 * Usage:
 *   npx tsx scripts/repair-corrupted-carfax-snapshots.ts          # dry run
 *   npx tsx scripts/repair-corrupted-carfax-snapshots.ts --apply  # write
 *   npx tsx scripts/repair-corrupted-carfax-snapshots.ts --apply --shop=63
 */

import "dotenv/config";
import { getDb } from "@/lib/mongo";

async function main() {
  const apply = process.argv.includes("--apply");
  const shopArg = process.argv.find((a) => a.startsWith("--shop="));
  const shopId = shopArg ? Number(shopArg.split("=")[1]) : null;

  const db = await getDb();
  const coll = db.collection("carfax_reports");

  const filter: any = {
    ok: true,
    "raw.errorMessages.errors.code": { $exists: true },
    $or: [
      { serviceRecords: null },
      { serviceRecords: { $size: 0 } },
    ],
    repairedAt: { $exists: false },
  };
  if (shopId != null && Number.isFinite(shopId)) filter.shopId = shopId;

  const total = await coll.countDocuments(filter);
  console.log(
    `[repair-carfax] candidates: ${total}${shopId != null ? ` (shop ${shopId})` : ""}`,
  );

  // Per-code breakdown so we can sanity-check before applying.
  const codeBreakdown = await coll
    .aggregate([
      { $match: filter },
      { $unwind: "$raw.errorMessages.errors" },
      {
        $group: {
          _id: {
            code: "$raw.errorMessages.errors.code",
            message: "$raw.errorMessages.errors.message",
          },
          count: { $sum: 1 },
          shops: { $addToSet: "$shopId" },
        },
      },
      { $sort: { count: -1 } },
    ])
    .toArray();

  console.log("[repair-carfax] by error code:");
  for (const row of codeBreakdown) {
    console.log(
      `  code=${row._id.code} count=${row.count} shops=${row.shops.length} — "${row._id.message}"`,
    );
  }

  if (!apply) {
    console.log(
      "\n[repair-carfax] DRY RUN — re-run with --apply to flip ok:true -> ok:false and stamp lastErrorAt.",
    );
    return;
  }

  const now = new Date();
  const cursor = coll.find(filter, {
    projection: { shopId: 1, vin: 1, "raw.errorMessages.errors": 1, fetchedAt: 1 },
  });

  let processed = 0;
  let updated = 0;
  for await (const doc of cursor) {
    processed += 1;
    const errs = doc?.raw?.errorMessages?.errors;
    const first = Array.isArray(errs) && errs.length > 0 ? errs[0] : null;
    const code = first?.code != null ? String(first.code) : "?";
    const message = (first?.message && String(first.message)) || "Unknown CARFAX error";
    const errorString = `CARFAX ${code}: ${message}`;

    const res = await coll.updateOne(
      { _id: doc._id },
      {
        $set: {
          ok: false,
          error: errorString,
          lastErrorAt: doc.fetchedAt instanceof Date ? doc.fetchedAt : now,
          lastErrorMessage: errorString,
          rawError: doc.raw ?? null,
          repairedAt: now,
          repairReason: "in-band-error-overwrite-bug-2026-05-12",
        },
      },
    );
    if (res.modifiedCount > 0) updated += 1;

    if (processed % 50 === 0) {
      console.log(`[repair-carfax] processed=${processed} updated=${updated}`);
    }
  }

  console.log(
    `\n[repair-carfax] done — processed=${processed} updated=${updated}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[repair-carfax] crashed:", err);
    process.exit(1);
  });
