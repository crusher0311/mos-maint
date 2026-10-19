import type { Db } from "mongodb";
import type { ReviewScope, ReviewStore } from "../../lib/protractor-held-review";

/** Only read methods are exposed. Neither campaign writers nor provider clients are imported. */
export function heldReviewStore(db: Db, pg: any): ReviewStore {
  const one = (collection: string, id: string) =>
    db.collection<any>(collection).findOne({ _id: id }, { maxTimeMS: 5000 });
  const scoped = (collection: string, scope: ReviewScope, cap: number) =>
    db.collection<any>(collection).find({
      campaignId: scope.campaignId, shopId: scope.shopId, day: { $in: scope.days },
    }, { maxTimeMS: 5000 }).sort({ _id: 1 }).limit(cap + 1).toArray();
  // UUIDs are validated by the reviewer before this exact, case-insensitive comparison.
  const exactId = (id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw Error("Invalid invoice ID");
    return new RegExp(`^${id}$`, "i");
  };
  return {
    campaign: id => one("operator_history_import_jobs", id),
    cursor: id => one("operator_history_import_jobs", id),
    receipt: id => one("operator_history_import_receipts", id),
    pages: scope => scoped("operator_history_import_pages", scope, 20),
    receipts: scope => scoped("operator_history_import_receipts", scope, 500),
    days: scope => scoped("operator_history_import_days", scope, 7),
    async ownership(shopId, invoiceId) {
      const legacy = await db.collection("normalized_work_orders").find({
        shopId: { $in: [shopId, String(shopId)] }, "provenance.sourceSystem": "protractor",
        "provenance.sourceIds.idValue": exactId(invoiceId),
      }, { projection: { _id: 1 }, maxTimeMS: 5000 }).limit(2).toArray();
      const canonical = await pg.begin(async (sql: any) => {
        await sql.unsafe("set transaction read only");
        await sql.unsafe("set local statement_timeout='5000ms'");
        return sql.unsafe(`WITH matches AS MATERIALIZED (
          SELECT id FROM normalized_work_orders WHERE shop_id=$1
          AND public.protractor_identity_keys_v1(provenance) @> ARRAY[lower($2::text)]
        ) SELECT id FROM matches LIMIT 2`, [shopId, invoiceId]);
      });
      return { canonical: canonical.map((r: any) => String(r.id)), legacy: legacy.map(r => String(r._id)) };
    },
    async index(shopId, invoiceId) {
      const rows = await db.collection("job_index").find({
        shopId: { $in: [shopId, String(shopId)] }, workOrderId: exactId(invoiceId),
      }, { projection: { servicePackageId: 1, "metadata.sourceType": 1 }, maxTimeMS: 5000 }).limit(1001).toArray();
      return rows.map(r => ({ servicePackageId: r.servicePackageId, sourceType: r.metadata?.sourceType }));
    },
  };
}
