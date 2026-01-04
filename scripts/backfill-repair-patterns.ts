import { getDb } from "../lib/mongo";
import { NORMALIZED_COLLECTIONS } from "../lib/normalized-schema";
import { updateRepairPatternBatch } from "../lib/repair-patterns";

const BATCH_SIZE = 500;

interface WorkOrder {
  shopId: number;
  enterpriseId?: number;
  vehicle?: {
    year?: number;
    make?: string;
    model?: string;
    vin?: string;
  };
  odometerIn?: number;
  odometerOut?: number;
  closedAt?: Date;
  completedAt?: Date;
  invoiceDate?: Date;
}

interface ServiceJob {
  shopId: number;
  workOrderId: string;
  title?: string;
  laborTotal?: number;
  partsTotal?: number;
  total?: number;
  laborHoursBilled?: number;
  laborHoursActual?: number;
}

async function main() {
  console.log("=== Repair Patterns Backfill ===");
  console.log("This will process existing normalized work orders to build repair patterns.");
  console.log("");
  
  const db = await getDb();
  const workOrdersCollection = db.collection<WorkOrder>(NORMALIZED_COLLECTIONS.workOrders);
  const serviceJobsCollection = db.collection<ServiceJob>(NORMALIZED_COLLECTIONS.serviceJobs);
  
  const totalWorkOrders = await workOrdersCollection.countDocuments({
    'softDelete.isDeleted': { $ne: true },
    'vehicle.year': { $exists: true, $ne: null },
    'vehicle.make': { $exists: true, $ne: null },
    'vehicle.model': { $exists: true, $ne: null },
  });
  
  console.log(`Found ${totalWorkOrders.toLocaleString()} work orders with vehicle data`);
  
  let processed = 0;
  let patternsCreated = 0;
  let skipped = 0;
  
  const cursor = workOrdersCollection.find({
    'softDelete.isDeleted': { $ne: true },
    'vehicle.year': { $exists: true, $ne: null },
    'vehicle.make': { $exists: true, $ne: null },
    'vehicle.model': { $exists: true, $ne: null },
  }).batchSize(BATCH_SIZE);
  
  let batch: any[] = [];
  
  for await (const wo of cursor) {
    processed++;
    
    const mileage = wo.odometerIn || wo.odometerOut;
    if (!mileage || mileage < 1000) {
      skipped++;
      continue;
    }
    
    const year = wo.vehicle?.year;
    const make = wo.vehicle?.make;
    const model = wo.vehicle?.model;
    const vin = wo.vehicle?.vin;
    
    if (!year || !make || !model) {
      skipped++;
      continue;
    }
    
    const performedDate = wo.closedAt || wo.completedAt || wo.invoiceDate || new Date();
    
    const serviceJobs = await serviceJobsCollection.find({
      workOrderId: (wo as any)._id,
      'softDelete.isDeleted': { $ne: true },
    }).toArray();
    
    for (const job of serviceJobs) {
      if (!job.title || job.title.length < 3) continue;
      
      const lowerTitle = job.title.toLowerCase();
      if (lowerTitle.includes('diagnostic') || lowerTitle.includes('inspection only')) {
        continue;
      }
      
      batch.push({
        shopId: wo.shopId,
        enterpriseId: wo.enterpriseId,
        year,
        make,
        model,
        mileage,
        jobTitle: job.title,
        laborAmount: job.laborTotal || 0,
        partsAmount: job.partsTotal || 0,
        totalAmount: job.total || 0,
        laborHours: job.laborHoursBilled || job.laborHoursActual || 0,
        vin,
        performedDate: new Date(performedDate),
      });
    }
    
    if (batch.length >= BATCH_SIZE) {
      const updated = await updateRepairPatternBatch(batch);
      patternsCreated += updated;
      batch = [];
      console.log(`Processed ${processed.toLocaleString()}/${totalWorkOrders.toLocaleString()} work orders, ${patternsCreated.toLocaleString()} patterns created`);
    }
  }
  
  if (batch.length > 0) {
    const updated = await updateRepairPatternBatch(batch);
    patternsCreated += updated;
  }
  
  console.log("");
  console.log("=== Backfill Complete ===");
  console.log(`Total work orders processed: ${processed.toLocaleString()}`);
  console.log(`Skipped (no mileage/vehicle): ${skipped.toLocaleString()}`);
  console.log(`Pattern updates: ${patternsCreated.toLocaleString()}`);
  
  const patternCount = await db.collection("shop_repair_patterns").countDocuments();
  console.log(`Total patterns in collection: ${patternCount.toLocaleString()}`);
  
  process.exit(0);
}

main().catch(err => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
