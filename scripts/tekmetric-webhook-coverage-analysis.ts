/**
 * Step 1 of TEKMETRIC_5K_SCALING_PLAN.md — Webhook coverage analysis.
 *
 * READ-ONLY. Analyzes `tekmetric_webhook_logs` to determine empirically:
 *   1. Per-shop event volume and recency (silent shops = broken webhooks)
 *   2. Per-event-type field completeness (do payloads actually carry milesIn,
 *      vin, customerName, etc., or do we still need follow-up API calls?)
 *   3. Total event volume by type across all shops
 *
 * Run:
 *   npx tsx scripts/tekmetric-webhook-coverage-analysis.ts
 *
 * Output:
 *   - Console report
 *   - JSON dump at scripts/output/tekmetric-webhook-coverage-<timestamp>.json
 */

import { MongoClient } from "mongodb";
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
const SILENT_THRESHOLD_HOURS = 24;
const SAMPLE_SIZE_PER_TYPE = Number(process.env.SAMPLE_SIZE_PER_TYPE || 500);

type FieldStats = {
  total: number;
  withField: Record<string, number>;
};

/**
 * Tekmetric stores `eventType` as a free-text human description that includes
 * dynamic fragments (RO numbers, customer emails). Normalize to a stable
 * category so we get a usable taxonomy.
 */
function normalizeEventType(raw: string): string {
  if (!raw) return "(empty)";
  const s = raw.trim();
  if (/^Repair Order #\S+ created/i.test(s)) return "RO.Created";
  if (/^Repair Order #\S+ posted/i.test(s)) return "RO.Posted";
  if (/^Repair Order #\S+ completed/i.test(s)) return "RO.Completed";
  if (/^Repair Order #\S+ invoiced/i.test(s)) return "RO.Invoiced";
  if (/^Repair Order #\S+ deleted/i.test(s)) return "RO.Deleted";
  if (/^Repair Order #\S+ status updated/i.test(s)) return "RO.StatusUpdated";
  if (/viewed their inspection for Repair Order/i.test(s)) return "Customer.ViewedInspection";
  if (/inspection.*marked complete|marked complete.*inspection|InspectionComplete/i.test(s)) return "Inspection.Complete";
  if (/approved \d+ job\(s\) and declined/i.test(s)) return "Customer.JobsApprovedDeclined";
  if (/^Payment made by/i.test(s)) return "Payment.Made";
  if (/^Purchase Order #.+ marked received/i.test(s)) return "PO.Received";
  if (/^Purchase Order #.+ created/i.test(s)) return "PO.Created";
  if (/^Appointment .* deleted/i.test(s)) return "Appointment.Deleted";
  if (/^Appointment .* created/i.test(s)) return "Appointment.Created";
  if (/^Appointment .* updated/i.test(s)) return "Appointment.Updated";
  if (/^Appointment/i.test(s)) return "Appointment.Other";
  if (/Repair Order/i.test(s)) return "RO.Other";
  return "Other";
}

async function main() {
  console.log(`[${new Date().toISOString()}] starting`);
  const username = process.env.MONGODB_USERNAME;
  const password = process.env.MONGODB_PASSWORD;
  if (!username || !password) {
    console.error("Missing MONGODB_USERNAME or MONGODB_PASSWORD env vars");
    process.exit(1);
  }

  const uri = `mongodb+srv://${username}:${encodeURIComponent(password)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  console.log(`[${new Date().toISOString()}] connecting...`);
  await client.connect();
  console.log(`[${new Date().toISOString()}] connected`);
  const db = client.db("mos-maintenance-mvp");
  const totalDocs = await db.collection("tekmetric_webhook_logs").estimatedDocumentCount();
  console.log(`[${new Date().toISOString()}] total docs in collection: ${totalDocs.toLocaleString()}`);

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const silentCutoff = new Date(Date.now() - SILENT_THRESHOLD_HOURS * 60 * 60 * 1000);

  console.log(`\n=== Tekmetric Webhook Coverage Analysis ===`);
  console.log(`Lookback: ${LOOKBACK_DAYS} days (since ${since.toISOString()})`);
  console.log(`Silent threshold: ${SILENT_THRESHOLD_HOURS}h\n`);

  // --- 1. Total events per type (normalize raw eventType strings to categories) ---
  console.log(`[${new Date().toISOString()}] aggregating event types in window...`);
  const rawTypeAgg = await db
    .collection("tekmetric_webhook_logs")
    .aggregate([
      { $match: { receivedAt: { $gte: since } } },
      { $group: { _id: "$eventType", count: { $sum: 1 } } },
    ])
    .toArray();

  const categoryCounts = new Map<string, number>();
  for (const r of rawTypeAgg) {
    const cat = normalizeEventType(String(r._id ?? ""));
    categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + r.count);
  }
  const eventTypeAgg = Array.from(categoryCounts.entries())
    .map(([category, count]) => ({ _id: category, count }))
    .sort((a, b) => b.count - a.count);

  console.log(`--- Event categories (last ${LOOKBACK_DAYS}d) ---`);
  for (const row of eventTypeAgg) {
    console.log(`  ${String(row._id).padEnd(35)} ${row.count.toLocaleString()}`);
  }
  console.log(`  (${rawTypeAgg.length.toLocaleString()} unique raw eventType strings collapsed into ${eventTypeAgg.length} categories)\n`);

  console.log(`[${new Date().toISOString()}] aggregating per-shop activity...`);
  // --- 2. Per-shop event counts and last-seen ---
  // Shop linkage lives inside `data` — try common payload shapes.
  const perShopAgg = await db
    .collection("tekmetric_webhook_logs")
    .aggregate([
      { $match: { receivedAt: { $gte: since } } },
      {
        $group: {
          _id: {
            $ifNull: [
              "$data.shopId",
              {
                $ifNull: [
                  "$data.shop.id",
                  { $ifNull: ["$data.repairOrder.shopId", "$data.tekmetricShopId"] },
                ],
              },
            ],
          },
          count: { $sum: 1 },
          lastSeen: { $max: "$receivedAt" },
          eventTypes: { $addToSet: "$eventType" },
        },
      },
      { $sort: { count: -1 } },
    ])
    .toArray();

  // Hydrate with shop names from `shops` collection
  const shops = await db
    .collection("shops")
    .find({ "tekmetric.shopId": { $exists: true } })
    .project({ shopId: 1, name: 1, "tekmetric.shopId": 1 })
    .toArray();

  const shopByTekId = new Map<number, { shopId: number; name: string }>();
  for (const s of shops) {
    const tid = Number(s.tekmetric?.shopId);
    if (!isNaN(tid)) shopByTekId.set(tid, { shopId: s.shopId, name: s.name });
  }

  console.log(`--- Per-shop activity (last ${LOOKBACK_DAYS}d) ---`);
  console.log(
    `  ${"TekShop".padEnd(10)} ${"MOS".padEnd(6)} ${"Name".padEnd(35)} ${"Events".padEnd(8)} ${"LastSeen".padEnd(20)} Status`
  );

  let totalShopsConfigured = shops.length;
  let shopsWithRecentActivity = 0;
  let silentShops: { tekId: number; mosId: number | null; name: string; lastSeen: Date | null }[] = [];
  let unknownShopEvents = 0;

  // Set of tekIds that appeared in webhook stream
  const seenTekIds = new Set<number>();
  for (const row of perShopAgg) {
    const tekId = Number(row._id);
    if (isNaN(tekId)) {
      unknownShopEvents += row.count;
      continue;
    }
    seenTekIds.add(tekId);
    const meta = shopByTekId.get(tekId);
    const mosId = meta?.shopId ?? null;
    const name = meta?.name ?? "(unknown shop)";
    const isSilent = !row.lastSeen || new Date(row.lastSeen) < silentCutoff;
    if (!isSilent) shopsWithRecentActivity++;
    else silentShops.push({ tekId, mosId, name, lastSeen: row.lastSeen });
    console.log(
      `  ${String(tekId).padEnd(10)} ${String(mosId ?? "?").padEnd(6)} ${name.slice(0, 35).padEnd(35)} ${String(row.count).padEnd(8)} ${row.lastSeen ? new Date(row.lastSeen).toISOString().slice(0, 19) : "-".padEnd(20)} ${isSilent ? "SILENT" : "OK"}`
    );
  }

  // Configured shops that NEVER sent a webhook in window
  const neverSent = shops.filter((s) => {
    const tid = Number(s.tekmetric?.shopId);
    return !isNaN(tid) && !seenTekIds.has(tid);
  });

  console.log(`\n  ${neverSent.length} configured Tekmetric shops sent ZERO webhooks in window:`);
  for (const s of neverSent.slice(0, 50)) {
    console.log(`    - tekId=${s.tekmetric.shopId} mosId=${s.shopId} name=${s.name}`);
  }
  if (neverSent.length > 50) console.log(`    ... and ${neverSent.length - 50} more`);
  if (unknownShopEvents > 0) {
    console.log(`\n  ${unknownShopEvents.toLocaleString()} events had unparseable shopId (payload structure varies).`);
  }

  // --- 3. Field completeness per event type ---
  // Sample up to 2000 events per type and measure how often key fields are present.
  console.log(`\n--- Field completeness by event type (sample of up to 2000/type) ---`);

  const interestingFields = [
    "data.repairOrder.id",
    "data.repairOrder.repairOrderStatus.code",
    "data.repairOrder.milesIn",
    "data.repairOrder.milesOut",
    "data.repairOrder.customerId",
    "data.repairOrder.vehicleId",
    "data.repairOrder.repairOrderCustomerName",
    "data.vehicle.vin",
    "data.vehicle.year",
    "data.vehicle.make",
    "data.vehicle.model",
    "data.customer.firstName",
    "data.customer.lastName",
    "data.customer.email",
    "data.customer.phone",
    "data.inspection.id",
    "data.inspection.tasks",
  ];

  const stats: Record<string, FieldStats> = {};

  // Sampling strategy: pull ONE big sample of recent docs, then bucket into
  // categories ourselves. This avoids N round-trips and works against the
  // free-text eventType (no clean enum to filter on).
  const SAMPLE_TOTAL = SAMPLE_SIZE_PER_TYPE * 20;
  console.log(`[${new Date().toISOString()}] pulling sample of ${SAMPLE_TOTAL} most-recent webhook logs for field analysis...`);
  const bigSample = await db
    .collection("tekmetric_webhook_logs")
    .find({ receivedAt: { $gte: since } })
    .sort({ receivedAt: -1 })
    .limit(SAMPLE_TOTAL)
    .toArray();
  console.log(`[${new Date().toISOString()}] sampled ${bigSample.length} docs`);

  const samplesByCategory = new Map<string, any[]>();
  for (const doc of bigSample) {
    const cat = normalizeEventType(String(doc.eventType ?? ""));
    if (!samplesByCategory.has(cat)) samplesByCategory.set(cat, []);
    const arr = samplesByCategory.get(cat)!;
    if (arr.length < SAMPLE_SIZE_PER_TYPE) arr.push(doc);
  }

  for (const evt of eventTypeAgg) {
    const eventType = String(evt._id);
    const sample = samplesByCategory.get(eventType) || [];
    if (sample.length === 0) continue;

    const s: FieldStats = { total: sample.length, withField: {} };
    for (const f of interestingFields) s.withField[f] = 0;

    for (const doc of sample) {
      for (const f of interestingFields) {
        const path = f.split(".");
        let cur: any = doc;
        for (const p of path) {
          if (cur == null) break;
          cur = cur[p];
        }
        if (cur !== undefined && cur !== null && cur !== "") {
          s.withField[f]++;
        }
      }
    }

    stats[eventType] = s;
    console.log(`\n  ${eventType} (n=${s.total}):`);
    for (const f of interestingFields) {
      const pct = s.total === 0 ? 0 : Math.round((s.withField[f] / s.total) * 100);
      if (pct > 0) {
        console.log(`    ${pct.toString().padStart(3)}%  ${f}`);
      }
    }
  }

  // --- 4. Summary verdict ---
  console.log(`\n=== Summary ===`);
  console.log(`Configured Tekmetric shops:      ${totalShopsConfigured}`);
  console.log(`Shops sending webhooks:          ${seenTekIds.size}`);
  console.log(`Shops with recent (<24h) events: ${shopsWithRecentActivity}`);
  console.log(`Silent shops (no event in 24h):  ${silentShops.length}`);
  console.log(`Configured but never delivered:  ${neverSent.length}`);
  console.log(`Total events in window:          ${eventTypeAgg.reduce((a, b) => a + b.count, 0).toLocaleString()}`);

  // --- 5. Persist JSON ---
  try {
    mkdirSync(resolve(__dirname, "output"), { recursive: true });
  } catch {}
  const outPath = resolve(
    __dirname,
    "output",
    `tekmetric-webhook-coverage-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        lookbackDays: LOOKBACK_DAYS,
        silentThresholdHours: SILENT_THRESHOLD_HOURS,
        eventTypeVolume: eventTypeAgg,
        perShop: perShopAgg.map((r) => ({
          tekmetricShopId: r._id,
          mosShopId: shopByTekId.get(Number(r._id))?.shopId ?? null,
          name: shopByTekId.get(Number(r._id))?.name ?? null,
          eventCount: r.count,
          lastSeen: r.lastSeen,
          eventTypes: r.eventTypes,
        })),
        configuredButSilent: neverSent.map((s) => ({
          tekmetricShopId: s.tekmetric?.shopId,
          mosShopId: s.shopId,
          name: s.name,
        })),
        fieldCompleteness: stats,
        summary: {
          totalShopsConfigured,
          shopsWithAnyEvent: seenTekIds.size,
          shopsWithRecentEvent: shopsWithRecentActivity,
          silentShops: silentShops.length,
          configuredButZeroEvents: neverSent.length,
        },
      },
      null,
      2
    )
  );
  console.log(`\nFull report written to: ${outPath}`);

  await client.close();
}

main().catch((err) => {
  console.error("Analysis failed:", err);
  process.exit(1);
});
