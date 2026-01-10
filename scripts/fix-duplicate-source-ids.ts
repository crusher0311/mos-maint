#!/usr/bin/env npx tsx
// Fix duplicate source IDs in normalized_work_orders collection
// Usage: npx tsx scripts/fix-duplicate-source-ids.ts
// WARNING: Run with DRY_RUN=true first to preview changes

import { getDb } from '../lib/mongo';

const DRY_RUN = process.env.DRY_RUN !== 'false';

async function fixDuplicates() {
  console.log('Fixing duplicate source IDs in normalized_work_orders...');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'LIVE'}\n`);
  
  const db = await getDb();
  const collection = db.collection('normalized_work_orders');
  
  // Find duplicates by shopId + source system + source ID VALUE (correct field!)
  const duplicates = await collection.aggregate([
    { $unwind: '$provenance.sourceIds' },
    { $match: { 'provenance.sourceIds.idValue': { $exists: true, $ne: null } } },
    { 
      $group: { 
        _id: { 
          shopId: '$shopId', 
          sourceSystem: '$provenance.sourceSystem',
          sourceIdValue: '$provenance.sourceIds.idValue'
        }, 
        count: { $sum: 1 },
        docs: { $push: { _id: '$_id', updatedAt: '$updatedAt', version: '$version' } }
      } 
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } }
  ]).toArray();
  
  console.log(`Found ${duplicates.length} duplicate source ID groups\n`);
  
  if (duplicates.length === 0) {
    console.log('No duplicates found. Exiting.');
    process.exit(0);
  }
  
  let totalToRemove = 0;
  
  for (const dup of duplicates) {
    console.log(`Duplicate: shopId=${dup._id.shopId}, sourceIdValue=${dup._id.sourceIdValue}, count=${dup.count}`);
    
    // Sort by version desc, then updatedAt desc - keep the newest
    const sorted = dup.docs.sort((a: any, b: any) => {
      if (b.version !== a.version) return b.version - a.version;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    
    const toDelete = sorted.slice(1).map((d: any) => d._id);
    totalToRemove += toDelete.length;
    
    if (!DRY_RUN && toDelete.length > 0) {
      const result = await collection.deleteMany({ _id: { $in: toDelete } });
      console.log(`  Removed ${result.deletedCount} duplicates, kept version ${sorted[0].version}`);
    } else {
      console.log(`  Would remove ${toDelete.length} duplicates, keeping version ${sorted[0].version}`);
    }
  }
  
  console.log(`\n${DRY_RUN ? 'Would remove' : 'Removed'} ${totalToRemove} total duplicates`);
  
  if (DRY_RUN) {
    console.log('\nTo apply changes, run with: DRY_RUN=false npx tsx scripts/fix-duplicate-source-ids.ts');
  }
  
  // Show final stats
  const finalCount = await collection.countDocuments();
  console.log(`\nCurrent document count: ${finalCount}`);
  
  process.exit(0);
}

fixDuplicates().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
