import { getDb } from "../lib/mongo";
import { updateRepairPatternBatch } from "../lib/repair-patterns";

async function backfill() {
  const db = await getDb();
  const jobIndex = db.collection("job_index");
  const workOrders = db.collection("normalized_work_orders");

  console.log("Building VIN to mileage lookup...");

  const vinMileage = new Map<string, { mileage: number; enterpriseId?: string }>();
  const cursor = workOrders.find(
    {
      "vehicle.vin": { $exists: true, $ne: null },
      odometerIn: { $gt: 1000 },
    },
    { projection: { "vehicle.vin": 1, odometerIn: 1, enterpriseId: 1 } }
  );

  for await (const wo of cursor) {
    const vin = wo.vehicle?.vin;
    if (vin) {
      const existing = vinMileage.get(vin);
      if (!existing || wo.odometerIn > existing.mileage) {
        vinMileage.set(vin, { mileage: wo.odometerIn, enterpriseId: wo.enterpriseId });
      }
    }
  }
  console.log("VIN lookup:", vinMileage.size, "VINs");

  const BATCH_SIZE = 500;
  let processed = 0;
  let matched = 0;
  let patternsCreated = 0;
  let batch: any[] = [];

  const jobCursor = jobIndex
    .find({
      "vehicle.vin": { $exists: true, $ne: null },
      "vehicle.year": { $exists: true, $ne: null },
    })
    .batchSize(2000);

  for await (const job of jobCursor) {
    processed++;

    const vin = job.vehicle?.vin;
    if (!vin) continue;

    const vinData = vinMileage.get(vin);
    if (!vinData) continue;

    const title = job.job?.title || job.title;
    if (!title || title.length < 3) continue;
    
    const year = job.vehicle?.year;
    const make = job.vehicle?.make;
    const model = job.vehicle?.model;
    if (!year || !make || !model) continue;

    const lowerTitle = title.toLowerCase();
    if (lowerTitle.includes("diagnostic") || lowerTitle.includes("inspection only")) continue;

    matched++;
    batch.push({
      shopId: job.shopId,
      enterpriseId: vinData.enterpriseId || job.enterpriseId,
      year,
      make,
      model,
      mileage: vinData.mileage,
      jobTitle: title,
      laborAmount: job.totals?.laborAmount || 0,
      partsAmount: job.totals?.partsAmount || 0,
      totalAmount: job.totals?.totalAmount || 0,
      laborHours: job.totals?.laborHours || 0,
      vin,
      performedDate: job.performedAt || new Date(),
    });

    if (batch.length >= BATCH_SIZE) {
      const updated = await updateRepairPatternBatch(batch);
      patternsCreated += updated;
      batch = [];
      if (processed % 10000 === 0) {
        console.log(`Progress: ${processed} jobs | ${matched} matched | ${patternsCreated} patterns`);
      }
    }
  }

  if (batch.length > 0) {
    const updated = await updateRepairPatternBatch(batch);
    patternsCreated += updated;
  }

  console.log(`COMPLETE: ${processed} jobs processed, ${matched} matched, ${patternsCreated} patterns created`);
  process.exit(0);
}

backfill().catch(console.error);
