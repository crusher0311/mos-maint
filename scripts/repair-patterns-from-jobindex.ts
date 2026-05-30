import { getDb } from "../lib/mongo";
import { getDb as getPgDb } from "../lib/db/drizzle";
import { normalizedWorkOrders } from "../lib/db/schema/normalized";
import { and, gt, sql } from "drizzle-orm";
import { updateRepairPatternBatch } from "../lib/repair-patterns";

async function backfill() {
  const db = await getDb();
  const jobIndex = db.collection("job_index");
  const pg = getPgDb();

  console.log("Building VIN to mileage lookup...");

  const vinMileage = new Map<string, { mileage: number; enterpriseId?: string }>();
  const workOrders = await pg
    .select({
      vin: sql<string | null>`${normalizedWorkOrders.vehicle}->>'vin'`,
      odometerIn: normalizedWorkOrders.odometerIn,
      enterpriseId: normalizedWorkOrders.enterpriseId,
    })
    .from(normalizedWorkOrders)
    .where(
      and(
        gt(normalizedWorkOrders.odometerIn, 1000),
        sql`${normalizedWorkOrders.vehicle}->>'vin' is not null`,
      ),
    );

  for (const wo of workOrders) {
    const vin = wo.vin;
    const odo = wo.odometerIn ?? 0;
    if (vin) {
      const existing = vinMileage.get(vin);
      if (!existing || odo > existing.mileage) {
        vinMileage.set(vin, { mileage: odo, enterpriseId: wo.enterpriseId ?? undefined });
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
