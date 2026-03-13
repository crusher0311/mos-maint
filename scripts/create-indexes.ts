import { getDb } from "../lib/mongo";

async function createIndexes() {
  const db = await getDb();

  const indexes = [
    { collection: 'carfax_reports', index: { shopId: 1, vin: 1 }, name: 'shopId_vin' },
    { collection: 'protractor_callback_events', index: { objectId: 1, objectType: 1, operation: 1, processed: 1, shopId: 1, processedAt: 1 }, name: 'dedup_lookup' },
    { collection: 'tekmetric_work_orders', index: { shopId: 1, workOrderId: 1 }, name: 'shopId_workOrderId' },
    { collection: 'tekmetric_work_orders', index: { workOrderId: 1 }, name: 'workOrderId' },
    { collection: 'dataone_cache', index: { squish: 1 }, name: 'squish' },
    { collection: 'job_index', index: { 'job.title': 1, 'vehicle.make': 1, 'vehicle.model': 1, performedAt: -1, shopId: 1 }, name: 'job_search_compound' },
    { collection: 'protractor_work_orders', index: { shopId: 1, vin: 1, 'Header.LastModifiedTime': -1 }, name: 'shopId_vin_lastModified' },
    { collection: 'protractor_work_orders', index: { shopId: 1, workflowStage: 1 }, name: 'shopId_workflowStage' },
    { collection: 'events', index: { provider: 1, type: 1 }, name: 'provider_type' },
  ];

  for (const idx of indexes) {
    try {
      const result = await db.collection(idx.collection).createIndex(idx.index as any, { name: idx.name, background: true });
      console.log(`✓ ${idx.collection}: ${idx.name} — ${result}`);
    } catch (e: any) {
      console.log(`✗ ${idx.collection}: ${idx.name} — ${e.message}`);
    }
  }

  console.log('\nDone. All indexes created.');
  process.exit(0);
}

createIndexes().catch(e => { console.error(e); process.exit(1); });
