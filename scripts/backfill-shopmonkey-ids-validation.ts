/**
 * One-off operator backfill (task #1033): re-detect Shopmonkey ids for the
 * three shops connected before ID validation existed (165, 195, 312) and
 * persist validated locationId/companyId + idsValidation status.
 *
 * Mirrors the "redetect" action in app/api/settings/shopmonkey/route.ts.
 * PROD write (dev Mongo IS prod). Dry-run by default; pass --apply to write.
 */
import { getDb } from "../lib/mongo";
import { discoverIdsFromKey } from "../lib/integrations/shopmonkey/auth";
import { assessIdConsistency } from "../lib/integrations/shopmonkey/id-validation";

const SHOP_IDS = [165, 195, 312];
const APPLY = process.argv.includes("--apply");

async function main() {
  const db = await getDb();
  for (const shopId of SHOP_IDS) {
    const shop = await db
      .collection("shops")
      .findOne({ shopId: { $in: [String(shopId), shopId] } });
    if (!shop) {
      console.error(`[${shopId}] shop doc NOT FOUND — skipping`);
      continue;
    }
    const name = shop.name ?? shop.shopName ?? "?";
    const sm = shop.shopmonkey ?? {};
    console.log(
      `[${shopId}] ${name}: stored locationId=${sm.locationId ?? "null"} companyId=${sm.companyId ?? "null"} idsValidation=${sm.idsValidation?.status ?? "none"}`,
    );
    if (!sm.apiKey) {
      console.error(`[${shopId}] no stored shopmonkey.apiKey — skipping`);
      continue;
    }

    const discovered = await discoverIdsFromKey(sm.apiKey);
    if (!discovered.locationId && !discovered.companyId) {
      console.error(`[${shopId}] discovery returned no ids (rate-limited/forbidden?) — skipping`);
      continue;
    }
    console.log(
      `[${shopId}] discovered locationId=${discovered.locationId} companyId=${discovered.companyId}`,
    );

    const set: Record<string, any> = { "shopmonkey.idsDetectedAt": new Date() };
    if (discovered.locationId) {
      set["shopmonkey.locationId"] = discovered.locationId;
      set["shopmonkey.locationIdSource"] = "auto";
    }
    if (discovered.companyId) {
      set["shopmonkey.companyId"] = discovered.companyId;
      set["shopmonkey.companyIdSource"] = "auto";
    }
    const validation = assessIdConsistency(
      {
        locationId: discovered.locationId,
        companyId: discovered.companyId,
        locationIdSource: "auto",
        companyIdSource: "auto",
      },
      discovered,
    );
    set["shopmonkey.idsValidation"] = {
      status: validation.status,
      notes: validation.notes,
      checkedAt: new Date(),
    };
    console.log(
      `[${shopId}] validation status=${validation.status} notes=${JSON.stringify(validation.notes)}`,
    );

    if (!APPLY) {
      console.log(`[${shopId}] DRY RUN — would $set ${Object.keys(set).join(", ")}`);
      continue;
    }
    const res = await db
      .collection("shops")
      .updateOne({ shopId: { $in: [String(shopId), shopId] } }, { $set: set });
    console.log(`[${shopId}] APPLIED (matched=${res.matchedCount}, modified=${res.modifiedCount})`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
