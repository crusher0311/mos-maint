/**
 * Task #277 one-shot cleanup.
 *
 * Removes VIN-billing data left behind by Task #271. Task #271 deleted the
 * VIN gating UI / purchase flow / admin controls but intentionally left the
 * underlying fields in place so nothing in flight would explode. They are now
 * unread by the app and can be dropped from the DB:
 *
 * Per-shop fields (`shops` collection):
 *   - shop.trialVinLimit
 *   - shop.billing.vinLimit
 *
 * Billing settings (`platform_settings { type: "billing" }`):
 *   - vinPack100Product/PriceId, vinPack100VinCount, vinPack100Price
 *   - vinPack250Product/PriceId, vinPack250VinCount, vinPack250Price
 *   - vinPack500Product/PriceId, vinPack500VinCount, vinPack500Price
 *   - trialVinLimit
 *   - defaultVinLimit
 *   - skipTrialBonusVins
 *
 * Standalone trial doc (`platform_settings { key: "trial" }`): deleted whole.
 *
 * Idempotent: $unset on a missing field is a no-op, and the trial doc delete
 * is a no-op once it's gone. Safe to re-run.
 */
import { getDb } from "@/lib/mongo";

async function run() {
  const db = await getDb();

  const shopsRes = await db.collection("shops").updateMany(
    {},
    {
      $unset: {
        trialVinLimit: "",
        "billing.vinLimit": "",
      },
    },
  );
  console.log(
    `[task-277] shops: matched=${shopsRes.matchedCount} modified=${shopsRes.modifiedCount}`,
  );

  const billingRes = await db.collection("platform_settings").updateOne(
    { type: "billing" },
    {
      $unset: {
        vinPack100ProductId: "",
        vinPack100PriceId: "",
        vinPack100VinCount: "",
        vinPack100Price: "",
        vinPack250ProductId: "",
        vinPack250PriceId: "",
        vinPack250VinCount: "",
        vinPack250Price: "",
        vinPack500ProductId: "",
        vinPack500PriceId: "",
        vinPack500VinCount: "",
        vinPack500Price: "",
        trialVinLimit: "",
        defaultVinLimit: "",
        skipTrialBonusVins: "",
      },
    },
  );
  console.log(
    `[task-277] platform_settings/billing: matched=${billingRes.matchedCount} modified=${billingRes.modifiedCount}`,
  );

  const trialRes = await db
    .collection("platform_settings")
    .deleteOne({ key: "trial" });
  console.log(
    `[task-277] platform_settings/{key:"trial"}: deleted=${trialRes.deletedCount}`,
  );
}

run()
  .then(() => {
    console.log("[task-277] cleanup complete");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[task-277] cleanup failed:", err);
    process.exit(1);
  });
