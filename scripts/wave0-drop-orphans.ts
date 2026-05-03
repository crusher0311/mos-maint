import { getDb, getMongoClient } from "../lib/mongo";

const CONFIRMED_ORPHANS = [
  "webhook_events",
  "serviceevents",
  "vehicleschedules",
  "inspectionfindings",
  "analyses",
  "oeschedules",
  "LKP_VIN_MAINTENANCE",
  "LKP_YMM_MAINTENANCE",
  "DEF_MAINTENANCE_EVENT",
] as const;

const RECLASSIFIED = [
  "password_resets",
  "services_by_ymm",
  "tickets",
  "shop_users",
  "workflow_runs",
] as const;

interface CollectionEntry {
  exists: boolean;
  count?: number;
  sampleIds?: string[];
  firstDocKeys?: string[];
  sampleError?: string;
  firstDocError?: string;
  dropped?: boolean;
  droppedAt?: string;
  dropError?: string;
}

interface Report {
  runAt: string;
  dryRun: boolean;
  confirmedOrphans: Record<string, CollectionEntry>;
  reclassified: Record<string, CollectionEntry>;
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const db = await getDb();
  const existing = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);

  const report: Report = {
    runAt: new Date().toISOString(),
    dryRun,
    confirmedOrphans: {},
    reclassified: {},
  };

  for (const name of [...CONFIRMED_ORPHANS, ...RECLASSIFIED]) {
    const bucket: Record<string, CollectionEntry> = (CONFIRMED_ORPHANS as readonly string[]).includes(name)
      ? report.confirmedOrphans
      : report.reclassified;

    if (!existing.includes(name)) {
      bucket[name] = { exists: false };
      continue;
    }
    const col = db.collection(name);
    const count = await col.estimatedDocumentCount();
    const entry: CollectionEntry = { exists: true, count, sampleIds: [], firstDocKeys: [] };

    try {
      const sample = await col.find({}).limit(3).project({ _id: 1 }).toArray();
      entry.sampleIds = sample.map((s) => String(s._id));
    } catch (e: unknown) {
      entry.sampleError = errMessage(e);
      console.warn(`WARN sample read failed for ${name}: ${entry.sampleError}`);
    }
    try {
      const first = await col.findOne({});
      entry.firstDocKeys = first ? Object.keys(first).slice(0, 20) : [];
    } catch (e: unknown) {
      entry.firstDocError = errMessage(e);
      console.warn(`WARN first-doc read failed for ${name}: ${entry.firstDocError}`);
    }
    bucket[name] = entry;
  }

  console.log("=== SNAPSHOT ===");
  console.log(JSON.stringify(report, null, 2));

  if (!dryRun) {
    console.log("\n=== DROPPING CONFIRMED ORPHANS ===");
    for (const name of CONFIRMED_ORPHANS) {
      const entry = report.confirmedOrphans[name];
      if (!entry?.exists) {
        console.log(`SKIP ${name} (does not exist)`);
        continue;
      }
      try {
        const ok = await db.collection(name).drop();
        console.log(`DROPPED ${name} (count=${entry.count}) -> ${ok}`);
        entry.dropped = true;
        entry.droppedAt = new Date().toISOString();
      } catch (e: unknown) {
        const msg = errMessage(e);
        console.log(`FAILED ${name}: ${msg}`);
        entry.dropped = false;
        entry.dropError = msg;
      }
    }
  }

  console.log("\n=== FINAL REPORT ===");
  console.log(JSON.stringify(report, null, 2));

  const client = await getMongoClient();
  await client.close();
}

main().catch((e: unknown) => {
  console.error(errMessage(e));
  process.exit(1);
});
