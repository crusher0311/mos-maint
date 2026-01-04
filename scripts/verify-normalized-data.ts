#!/usr/bin/env npx tsx
import { MongoClient, Db } from 'mongodb';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const MONGODB_URI = process.env.MONGODB_URI || '';

interface VerificationResult {
  collection: string;
  totalCount: number;
  byShop: Record<number, number>;
  bySource: Record<string, number>;
  issues: string[];
}

interface IntegrityCheckResult {
  orphanedServiceJobs: number;
  orphanedLineItems: number;
  missingVehicleRefs: number;
  missingCustomerRefs: number;
  duplicateSourceIds: number;
}

async function connectToMongo(): Promise<Db> {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  return client.db();
}

async function getCollectionStats(db: Db, collectionName: string): Promise<VerificationResult> {
  const collection = db.collection(collectionName);
  
  const totalCount = await collection.countDocuments({ deletedAt: null });
  
  const byShopAgg = await collection.aggregate([
    { $match: { deletedAt: null } },
    { $group: { _id: '$shopId', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]).toArray();
  
  const byShop: Record<number, number> = {};
  for (const item of byShopAgg) {
    byShop[item._id] = item.count;
  }
  
  const bySourceAgg = await collection.aggregate([
    { $match: { deletedAt: null } },
    { $group: { _id: '$provenance.sourceSystem', count: { $sum: 1 } } }
  ]).toArray();
  
  const bySource: Record<string, number> = {};
  for (const item of bySourceAgg) {
    bySource[item._id || 'unknown'] = item.count;
  }
  
  const issues: string[] = [];
  
  const nullProvenanceCount = await collection.countDocuments({ 
    deletedAt: null,
    'provenance.sourceSystem': null 
  });
  if (nullProvenanceCount > 0) {
    issues.push(`${nullProvenanceCount} documents missing provenance.sourceSystem`);
  }
  
  const nullShopIdCount = await collection.countDocuments({ 
    deletedAt: null,
    shopId: null 
  });
  if (nullShopIdCount > 0) {
    issues.push(`${nullShopIdCount} documents missing shopId`);
  }
  
  return {
    collection: collectionName,
    totalCount,
    byShop,
    bySource,
    issues
  };
}

async function checkDuplicateSourceIds(db: Db, collectionName: string): Promise<number> {
  const collection = db.collection(collectionName);
  
  const duplicatesAgg = await collection.aggregate([
    { $match: { deletedAt: null } },
    { $unwind: { path: '$provenance.sourceIds', preserveNullAndEmptyArrays: false } },
    {
      $group: {
        _id: {
          sourceSystem: '$provenance.sourceSystem',
          sourceId: '$provenance.sourceIds.id',
          sourceIdType: '$provenance.sourceIds.type'
        },
        count: { $sum: 1 }
      }
    },
    { $match: { count: { $gt: 1 } } },
    { $count: 'duplicates' }
  ]).toArray();
  
  return duplicatesAgg[0]?.duplicates || 0;
}

async function checkReferentialIntegrity(db: Db): Promise<IntegrityCheckResult> {
  const serviceJobs = db.collection('normalized_service_jobs');
  const workOrders = db.collection('normalized_work_orders');
  
  const orphanedServiceJobsAgg = await serviceJobs.aggregate([
    { $match: { deletedAt: null } },
    {
      $lookup: {
        from: 'normalized_work_orders',
        localField: 'workOrderId',
        foreignField: '_id',
        as: 'wo'
      }
    },
    { $match: { wo: { $size: 0 } } },
    { $count: 'count' }
  ]).toArray();
  
  const orphanedServiceJobs = orphanedServiceJobsAgg[0]?.count || 0;
  
  const missingVehicleRefsAgg = await workOrders.aggregate([
    { $match: { deletedAt: null, vehicleId: { $ne: null } } },
    {
      $lookup: {
        from: 'normalized_vehicles',
        localField: 'vehicleId',
        foreignField: '_id',
        as: 'vehicle'
      }
    },
    { $match: { vehicle: { $size: 0 } } },
    { $count: 'count' }
  ]).toArray();
  
  const missingVehicleRefs = missingVehicleRefsAgg[0]?.count || 0;
  
  const missingCustomerRefsAgg = await workOrders.aggregate([
    { $match: { deletedAt: null, customerId: { $ne: null } } },
    {
      $lookup: {
        from: 'normalized_customers',
        localField: 'customerId',
        foreignField: '_id',
        as: 'customer'
      }
    },
    { $match: { customer: { $size: 0 } } },
    { $count: 'count' }
  ]).toArray();
  
  const missingCustomerRefs = missingCustomerRefsAgg[0]?.count || 0;
  
  let duplicateSourceIds = 0;
  const allCollections = [
    'normalized_vehicles', 
    'normalized_customers', 
    'normalized_work_orders', 
    'normalized_service_jobs',
    'normalized_payments',
    'normalized_inspections',
    'normalized_recommendations'
  ];
  for (const coll of allCollections) {
    duplicateSourceIds += await checkDuplicateSourceIds(db, coll);
  }
  
  return {
    orphanedServiceJobs,
    orphanedLineItems: 0,
    missingVehicleRefs,
    missingCustomerRefs,
    duplicateSourceIds
  };
}

async function compareWithLegacyJobIndex(db: Db): Promise<void> {
  console.log('\n=== Comparing with Legacy job_index ===\n');
  
  const jobIndex = db.collection('job_index');
  const normalizedWorkOrders = db.collection('normalized_work_orders');
  
  const legacyByShop = await jobIndex.aggregate([
    { $group: { _id: '$shopId', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]).toArray();
  
  const normalizedByShop = await normalizedWorkOrders.aggregate([
    { $match: { deletedAt: null } },
    { $group: { _id: '$shopId', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]).toArray();
  
  const legacyMap = new Map(legacyByShop.map(i => [i._id, i.count]));
  const normalizedMap = new Map(normalizedByShop.map(i => [i._id, i.count]));
  
  const allShops = new Set([...legacyMap.keys(), ...normalizedMap.keys()]);
  
  console.log('Shop ID\t\tLegacy\t\tNormalized\tCoverage');
  console.log('-------\t\t------\t\t----------\t--------');
  
  for (const shopId of Array.from(allShops).sort((a, b) => a - b)) {
    const legacy = legacyMap.get(shopId) || 0;
    const normalized = normalizedMap.get(shopId) || 0;
    const coverage = legacy > 0 ? ((normalized / legacy) * 100).toFixed(1) : 'N/A';
    console.log(`${shopId}\t\t${legacy}\t\t${normalized}\t\t${coverage}%`);
  }
}

async function main() {
  console.log('=== Normalized Data Verification Tool ===\n');
  
  const db = await connectToMongo();
  
  const collections = [
    'normalized_vehicles',
    'normalized_customers',
    'normalized_work_orders',
    'normalized_service_jobs',
    'normalized_payments',
    'normalized_inspections',
    'normalized_recommendations',
  ];
  
  console.log('=== Collection Statistics ===\n');
  
  for (const collName of collections) {
    const stats = await getCollectionStats(db, collName);
    console.log(`\n${stats.collection}:`);
    console.log(`  Total: ${stats.totalCount}`);
    console.log(`  By Source: ${JSON.stringify(stats.bySource)}`);
    console.log(`  By Shop (top 5): ${JSON.stringify(Object.entries(stats.byShop).slice(0, 5))}`);
    if (stats.issues.length > 0) {
      console.log(`  Issues: ${stats.issues.join(', ')}`);
    }
  }
  
  console.log('\n=== Referential Integrity Check ===\n');
  const integrity = await checkReferentialIntegrity(db);
  console.log(`  Orphaned Service Jobs: ${integrity.orphanedServiceJobs}`);
  console.log(`  Missing Vehicle Refs: ${integrity.missingVehicleRefs}`);
  console.log(`  Missing Customer Refs: ${integrity.missingCustomerRefs}`);
  
  await compareWithLegacyJobIndex(db);
  
  console.log('\n=== Verification Complete ===');
  process.exit(0);
}

main().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
