/** Serial local ingestion only. A hung invoice kills this child, not the runner. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getDb } from "../lib/mongo";
import { AVID_HISTORY as P } from "../lib/protractor-avid-history-policy";
import { createIngestionService } from "../lib/integrations/core/normalized-ingestion";
import { extractJobIndexFromWorkOrder } from "../lib/job-index";
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
async function main() {
  assert.ok(process.env.RENDER && !process.env.REPLIT_DEV_DOMAIN && !process.env.REPL_ID);
  assert.equal(process.env.NORMALIZED_INGEST_WRITE_CONCURRENCY, "1");
  const [pageId, owner] = process.argv.slice(2);
  assert.ok(pageId?.startsWith(`${P.jobId}:`) && owner);
  const db = await getDb(), pages = db.collection<any>("operator_history_import_pages"),
    receipts = db.collection<any>("operator_history_import_receipts");
  const page = await pages.findOne({ _id: pageId, shopId: P.shopId }, { maxTimeMS: 5000 });
  assert.ok(page && hash(page.invoices) === page.digest);
  const service = createIngestionService(db, "protractor", P.shopId, undefined,
    { ingestionVia: "backfill", dualWriteToJobIndex: true, dualWriteToRepairPatterns: false });
  let pending = 0;
  for (const invoice of page.invoices) {
    const watchdog = setTimeout(() => process.exit(75), 120000);
    try {
      assert.ok(Date.now() < Date.parse(P.end) - 60000);
      const job = await db.collection<any>("operator_history_import_jobs").findOne(
        { _id: P.jobId, owner, stopped: false, status: "running" }, { maxTimeMS: 5000 });
      const rate = await db.collection<any>("api_rate_limits").findOne(
        { _id: "protractor-physical-transport-v1" }, { maxTimeMS: 5000 });
      assert.ok(job && !rate.operatorStop.active && rate.avidHistory.runId === job.runId &&
        !rate.avidHistory.stopped && rate.canary.generation === rate.avidHistory.canaryGeneration);
      assert.match(invoice.ID, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
      const id = `${P.jobId}:${hash(invoice.ID.toLowerCase())}`;
      const prior = await receipts.findOne({ _id: id }, { maxTimeMS: 5000 });
      if (prior?.status === "imported") continue;
      // A killed child may have committed part of the invoice. Never blindly
      // replay that ambiguous operation or let it block unrelated invoices.
      if (prior?.status === "processing") { pending++; continue; }
      if (Number(invoice.Total) > 0 &&
        extractJobIndexFromWorkOrder(P.shopId, invoice, "protractor").length === 0) {
        pending++;
        await receipts.updateOne({ _id: id }, { $set: {
          jobId: P.jobId, shopId: P.shopId, day: page.day, status: "thin",
          sourceDigest: hash(invoice), updatedAt: new Date(),
        } }, { upsert: true });
        continue;
      }
      await receipts.updateOne({ _id: id }, { $set: {
        jobId: P.jobId, shopId: P.shopId, day: page.day, status: "processing",
        sourceDigest: hash(invoice), startedAt: new Date(),
      } }, { upsert: true });
      const result = await service.ingestWorkOrderWithAllEntities(invoice);
      if (!result.workOrder.success || ![...result.serviceJobs, ...result.lineItems,
        ...result.payments, ...result.inspections, ...result.recommendations].every(r => r.success)) {
        pending++; // retain processing: some writes may already have committed
        continue;
      }
      await receipts.updateOne({ _id: id, status: "processing" },
        { $set: { status: "imported", completedAt: new Date() } });
    } finally { clearTimeout(watchdog); }
    await new Promise(r => setTimeout(r, 150));
  }
  await pages.updateOne({ _id: pageId }, { $set: { imported: pending === 0, pending, checkedAt: new Date() } });
}
main().then(() => process.exit(0)).catch(() => {
  console.error("avid_invoice_child_stopped; exact receipt retained"); process.exit(75);
});
