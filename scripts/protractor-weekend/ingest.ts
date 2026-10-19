import assert from "node:assert/strict";
import { getClient } from "../../lib/db/drizzle";
import { HISTORY_EXISTING_INVOICE_SQL, historyFailureCode } from "../../lib/protractor-history-existing-invoice";
import { createIngestionService } from "../../lib/integrations/core/normalized-ingestion";
import { extractJobIndexFromWorkOrder } from "../../lib/job-index";
import { WEEKEND } from "../../lib/protractor-weekend-policy";
import { pilotInvoiceIds } from "../../lib/protractor-afton-pilot-report";
import { assertOwner, collections, hash, runtime, sleep } from "./shared";
import { sanitizedHeldFailure, type HeldFailureStage } from "../../lib/protractor-held-failure";

/** Both stores are checked; never overwrite an existing invoice or financial correction. */
async function existingInvoice(shopId: number, invoice: any, stage: (value: HeldFailureStage) => void): Promise<boolean> {
  stage("mongo_duplicate_check");
  const { db } = await collections();
  const ids = [...new Set([invoice.ID, invoice.ID.toLowerCase(), invoice.ID.toUpperCase()])];
  const mongo = await db.collection("normalized_work_orders").findOne({
    shopId, "provenance.sourceSystem": "protractor", "provenance.sourceIds.idValue": { $in: ids },
  }, { projection: { _id: 1 }, maxTimeMS: 5000 })
    ;
  if (mongo) return true;
  stage("postgres_duplicate_check");
  const rows = await getClient().begin(async sql => {
    await sql.unsafe("set transaction read only");
    await sql.unsafe("set local statement_timeout='5000ms'");
    return await sql.unsafe(HISTORY_EXISTING_INVOICE_SQL, [shopId, invoice.ID.toLowerCase()]);
  });
  return rows.length > 0;
}
export async function ingestPage(pageId: string, owner: string) {
  let stage: HeldFailureStage = "unknown";
  try {
    return await ingestPageWithEvidence(pageId, owner, value => { stage = value; });
  } catch (error) {
    // main exits immediately after this rejects; drain IPC before rethrowing.
    if (process.send) await new Promise<void>(resolve => {
      process.send!({ event: "weekend_ingest_failed",
        ...sanitizedHeldFailure({ stage, code: historyFailureCode(error) }) }, () => resolve());
    });
    throw error;
  }
}

async function ingestPageWithEvidence(pageId: string, owner: string, stage: (value: HeldFailureStage) => void) {
  runtime();
  assert.ok(pageId.startsWith(`${WEEKEND.id}:`));
  const { pages, receipts, jobs, db } = await collections();
  const page = await pages.findOne({ _id: pageId }, { maxTimeMS: 5000 });
  assert.ok(page && page.campaignId === WEEKEND.id && hash(page.invoices) === page.digest);
  pilotInvoiceIds(page.invoices);
  const { job } = await assertOwner(owner, page.shopId);
  const entry = job.shops.find((s: any) => s.shopId === page.shopId);
  const service = createIngestionService(db, "protractor", page.shopId, undefined,
    { ingestionVia: "backfill", dualWriteToJobIndex: true, dualWriteToRepairPatterns: false });
  let unresolved = 0;
  for (const invoice of page.invoices) {
    stage("unknown");
    const watchdog = setTimeout(() => process.exit(75), 120000);
    try {
      await assertOwner(owner, page.shopId);
      const id = `${WEEKEND.id}:${page.shopId}:${hash(invoice.ID.toLowerCase())}`;
      const prior = await receipts.findOne({ _id: id }, { maxTimeMS: 5000 });
      if (prior && ["imported", "present"].includes(prior.status)) continue;
      if (prior) { unresolved++; continue; } // ambiguous/held evidence is never replayed
      if (entry.priorJobId) {
        const old = await receipts.findOne({
          _id: `${entry.priorJobId}:${hash(invoice.ID.toLowerCase())}`,
        }, { projection: { status: 1 }, maxTimeMS: 5000 });
        if (old?.status === "processing" || old?.status === "thin") {
          unresolved++;
          await receipts.insertOne({ _id: id, campaignId: WEEKEND.id, shopId: page.shopId,
            day: page.day, status: "prior-ambiguous", sourceDigest: hash(invoice) });
          continue;
        }
      }
      const expected = extractJobIndexFromWorkOrder(page.shopId, invoice, "protractor");
      const exists = await existingInvoice(page.shopId, invoice, stage);
      stage("unknown");
      if (exists) {
        const indexed = !expected.length || await db.collection("job_index").findOne({
          shopId: page.shopId, workOrderId: { $in: [invoice.ID, invoice.ID.toLowerCase(), invoice.ID.toUpperCase()] },
        }, { projection: { _id: 1 }, maxTimeMS: 5000 });
        const status = indexed ? "present" : "existing-needs-index-review";
        if (!indexed) unresolved++;
        await receipts.insertOne({ _id: id, campaignId: WEEKEND.id, shopId: page.shopId,
          day: page.day, status, sourceDigest: hash(invoice), completedAt: new Date() });
        if (indexed) await jobs.updateOne({ _id: WEEKEND.id, owner },
          { $max: { verifiedPresentAt: new Date() } });
        continue;
      }
      if (Number(invoice.Total) > 0 && !expected.length) {
        unresolved++;
        await receipts.insertOne({ _id: id, campaignId: WEEKEND.id, shopId: page.shopId,
          day: page.day, status: "thin", sourceDigest: hash(invoice) });
        continue;
      }
      await receipts.insertOne({ _id: id, campaignId: WEEKEND.id, shopId: page.shopId,
        day: page.day, status: "processing", sourceDigest: hash(invoice), startedAt: new Date() });
      stage("ingestion");
      const result = await service.ingestWorkOrderWithAllEntities(invoice);
      stage("ingestion_verification");
      const indexed = !expected.length || await db.collection("job_index").findOne({
        shopId: page.shopId, workOrderId: { $in: [invoice.ID, invoice.ID.toLowerCase(), invoice.ID.toUpperCase()] },
      }, { projection: { _id: 1 }, maxTimeMS: 5000 });
      if (!result.workOrder.success || !indexed ||
        ![...result.serviceJobs, ...result.lineItems, ...result.payments,
          ...result.inspections, ...result.recommendations].every(r => r.success)) {
        unresolved++; continue;
      }
      stage("receipt_completion");
      const completed = await receipts.updateOne({ _id: id, status: "processing" },
        { $set: { status: "imported", completedAt: new Date() } });
      if (completed.matchedCount === 1) await jobs.updateOne({ _id: WEEKEND.id, owner },
        { $max: { importedInvoiceAt: new Date() } });
    } finally { clearTimeout(watchdog); }
    await sleep(250);
  }
  stage("unknown");
  await assertOwner(owner, page.shopId);
  await pages.updateOne({ _id: pageId }, { $set: {
    checked: true, imported: unresolved === 0, unresolved, checkedAt: new Date(),
  } });
  await jobs.updateOne({ _id: WEEKEND.id, owner }, { $set: { lastProgressAt: new Date() } });
}
