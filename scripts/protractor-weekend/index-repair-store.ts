import type { Db, MongoClient } from "mongodb";
import type { RepairStore } from "../../lib/protractor-index-repair";
import { heldReviewStore } from "./review-store";
import { databaseFence } from "../../lib/invoice-repair/guarded-drivers";

export function indexRepairStore(db: Db, client: MongoClient, pg: any): RepairStore {
  return {
    ...heldReviewStore(db, pg),
    async insertOnly(manifest, rows, revalidate) {
      const fence = databaseFence(db);
      if (!fence) throw Error("Index repair requires the mandatory database boundary");
      return fence.run(async () => {
      // Refuse to create indexes in production. Existing natural-key uniqueness is required.
      const indexes = await db.collection("job_index").listIndexes({ maxTimeMS: 5000 }).toArray();
      if (!indexes.some(i => i.unique && !i.partialFilterExpression && !i.sparse &&
          JSON.stringify(i.key) === JSON.stringify({ shopId: 1, workOrderId: 1, servicePackageId: 1 })))
        throw Error("Required existing job-index uniqueness unavailable");
      const session = client.startSession();
      try {
        await pg.begin(async (sql: any) => {
          await sql.unsafe("set local lock_timeout='5000ms'");
          await sql.unsafe("set local statement_timeout='5000ms'");
          // Protect even absence/phantoms in canonical ownership during the Mongo commit.
          await sql.unsafe("LOCK TABLE normalized_work_orders IN SHARE MODE");
          session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" },
            maxCommitTimeMS: 5000 });
          await revalidate();
          for (const row of rows) {
            // Handles legacy case and mixed tenant types; never update an existing row.
            const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const existing = await db.collection("job_index").findOne({
              shopId: { $in: [manifest.scope.shopId, String(manifest.scope.shopId)] },
              workOrderId: new RegExp(`^${escape(row.workOrderId)}$`, "i"),
              servicePackageId: new RegExp(`^${escape(row.servicePackageId)}$`, "i"),
            }, { session, maxTimeMS: 5000 });
            if (existing) throw Error("Concurrent index change; hold");
          }
          await db.collection<any>("job_index").insertMany(rows, { session, ordered: true });
          // Latest reads outside the snapshot catch evidence changes during staging.
          await revalidate();
          // Explicit transaction, not withTransaction: never automatically rerun an ambiguous action.
          await session.commitTransaction();
        });
      } catch {
        if (session.inTransaction()) await session.abortTransaction().catch(() => {});
        throw Error("Repair not confirmed; reconcile exact manifest before retry. No ingestion replay.");
      } finally { await session.endSession(); }
      });
    },
  };
}
