/**
 * Re-index DeferredServicePackages from stored rawPayload in protractor_work_orders
 * 
 * This script extracts deferred work from already-cached work orders without making API calls.
 * Run with: npx tsx scripts/reindex-deferred-from-cache.ts
 */

import { getDb } from '../lib/mongo';
import { extractJobIndexFromWorkOrder, upsertJobIndexEntries, JobIndexEntry } from '../lib/job-index';

async function reindexDeferredWork() {
  const db = await getDb();
  
  // Get unique shopIds from protractor_work_orders (these are the Protractor shops)
  const shopIds = await db.collection('protractor_work_orders').distinct('shopId') as number[];
  
  console.log(`Found ${shopIds.length} shops with Protractor work orders\n`);
  
  let totalProcessed = 0;
  let totalDeferred = 0;
  
  for (const shopId of shopIds) {
    console.log(`\n--- Processing Shop ${shopId} ---`);
    
    // Get all work orders with rawPayload that has DeferredServicePackages.ItemCollection
    const workOrders = await db.collection('protractor_work_orders')
      .find({ 
        shopId,
        rawPayload: { $exists: true, $ne: null },
        'rawPayload.DeferredServicePackages.ItemCollection.0': { $exists: true }
      })
      .toArray();
    
    console.log(`Found ${workOrders.length} work orders with deferred packages`);
    
    let shopDeferred = 0;
    const allDeferredEntries: JobIndexEntry[] = [];
    
    for (const wo of workOrders) {
      const rawPayload = wo.rawPayload;
      
      // Extract jobs from the stored invoice data (handles both ServicePackages and DeferredServicePackages)
      const jobs = extractJobIndexFromWorkOrder(shopId, rawPayload, 'protractor');
      
      // Filter to only deferred jobs
      const deferredJobs = jobs.filter((j: JobIndexEntry) => j.isDeferred === true);
      
      if (deferredJobs.length > 0) {
        allDeferredEntries.push(...deferredJobs);
        shopDeferred += deferredJobs.length;
      }
      
      totalProcessed++;
    }
    
    // Batch upsert all deferred entries for this shop
    if (allDeferredEntries.length > 0) {
      const result = await upsertJobIndexEntries(allDeferredEntries);
      console.log(`Indexed ${shopDeferred} deferred jobs (inserted: ${result.inserted}, updated: ${result.updated})`);
    } else {
      console.log(`No deferred jobs found`);
    }
    
    totalDeferred += shopDeferred;
  }
  
  console.log(`\n========================================`);
  console.log(`Total work orders processed: ${totalProcessed}`);
  console.log(`Total deferred jobs indexed: ${totalDeferred}`);
  console.log(`========================================`);
}

// Run
reindexDeferredWork()
  .then(() => {
    console.log('\nDone!');
    process.exit(0);
  })
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
