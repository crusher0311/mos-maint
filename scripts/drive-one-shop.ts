import { getDb } from "../lib/mongo";
import { backfillShopChunk } from "../app/api/cron/tekmetric-backfill/route";

async function main() {
  const shopId = Number(process.argv[2]);
  if (!Number.isFinite(shopId)) {
    console.error("usage: tsx scripts/drive-one-shop.ts <shopId>");
    process.exit(1);
  }
  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId });
  const tek = shop?.tekmetric?.shopId ?? shop?.tekmetricShopId;
  if (!tek) {
    console.log(JSON.stringify({ shopId, status: "no_tek_link" }));
    process.exit(0);
  }
  const t0 = Date.now();
  try {
    const result = await backfillShopChunk(db, shopId, Number(tek));
    console.log(JSON.stringify({ shopId, status: "ok", ms: Date.now() - t0, ...result }));
  } catch (err: any) {
    console.log(JSON.stringify({ shopId, status: "threw", ms: Date.now() - t0, error: String(err?.message || err).slice(0, 300) }));
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
