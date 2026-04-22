/**
 * Companion to tekmetric-webhook-coverage-analysis.ts.
 * Dumps ONE recent payload per event category so we can see the actual schema
 * Tekmetric sends. This tells us which fields are reliably populated and
 * therefore which API follow-up calls we can safely skip.
 */

import { MongoClient } from "mongodb";

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
  if (/inspection.*marked complete|marked complete.*inspection/i.test(s)) return "Inspection.Complete";
  if (/approved \d+ job\(s\) and declined/i.test(s)) return "Customer.JobsApprovedDeclined";
  if (/^Payment made by/i.test(s)) return "Payment.Made";
  if (/^Purchase Order #.+ marked received/i.test(s)) return "PO.Received";
  if (/^Appointment/i.test(s)) return "Appointment.Other";
  if (/Repair Order/i.test(s)) return "RO.Other";
  return "Other";
}

function topLevelKeys(obj: any, prefix = "", depth = 0, max = 3): string[] {
  if (!obj || typeof obj !== "object" || depth > max) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(`${path} {`);
      out.push(...topLevelKeys(v, path, depth + 1, max).map((s) => "  " + s));
    } else if (Array.isArray(v)) {
      out.push(`${path}[${v.length}]${v[0] && typeof v[0] === "object" ? " (objects)" : v[0] !== undefined ? " " + JSON.stringify(v[0]).slice(0, 60) : ""}`);
    } else {
      const valStr = v === null ? "null" : typeof v === "string" ? `"${(v as string).slice(0, 60)}"` : String(v);
      out.push(`${path}: ${valStr}`);
    }
  }
  return out;
}

async function main() {
  const username = process.env.MONGODB_USERNAME;
  const password = process.env.MONGODB_PASSWORD;
  const uri = `mongodb+srv://${username}:${encodeURIComponent(password!)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("mos-maintenance-mvp");

  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const sample = await db
    .collection("tekmetric_webhook_logs")
    .find({ receivedAt: { $gte: since } })
    .sort({ receivedAt: -1 })
    .limit(3000)
    .toArray();

  const seen = new Set<string>();
  for (const doc of sample) {
    const cat = normalizeEventType(String(doc.eventType ?? ""));
    if (seen.has(cat)) continue;
    seen.add(cat);

    console.log(`\n========== ${cat} ==========`);
    console.log(`raw eventType: ${String(doc.eventType).slice(0, 100)}`);
    console.log(`receivedAt: ${doc.receivedAt}`);
    console.log(`Top-level data keys:`);
    for (const line of topLevelKeys(doc.data, "data", 0, 3)) {
      console.log(`  ${line}`);
    }
  }

  // Also count shops collection breakdown
  const tekShopCount = await db.collection("shops").countDocuments({ "tekmetric.shopId": { $exists: true } });
  const tekShopActiveCount = await db.collection("shops").countDocuments({
    "tekmetric.shopId": { $exists: true },
    $or: [{ active: true }, { active: { $exists: false } }],
  });
  const totalShops = await db.collection("shops").countDocuments({});
  console.log(`\n========== SHOP COUNT RECONCILIATION ==========`);
  console.log(`Total shops in collection:                ${totalShops}`);
  console.log(`Shops with tekmetric.shopId configured:   ${tekShopCount}`);
  console.log(`...active (or no active flag):            ${tekShopActiveCount}`);

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
