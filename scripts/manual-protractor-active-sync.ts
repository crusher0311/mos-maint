/**
 * One-shot: pull active (open) work orders from Protractor for every
 * configured shop and upsert them into protractor_work_orders +
 * protractor_vehicles. Used to close the 2026-05-14 → present gap
 * while Protractor's webhook delivery is silent.
 *
 * Mirrors the FIRST stage of /api/cron/protractor-sync (the part that
 * matters for dashboard visibility) but with per-shop concurrency,
 * resumable per-shop logging, and no revenue / normalized-ingestion
 * side effects so it's safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/manual-protractor-active-sync.ts            # all shops
 *   npx tsx scripts/manual-protractor-active-sync.ts --shop=116 # one shop
 *   npx tsx scripts/manual-protractor-active-sync.ts --shop=116,67 --dry
 *
 * Flags:
 *   --shop=N[,N...]   restrict to these shopIds
 *   --dry             fetch + log only; no DB writes
 *   --concurrency=N   how many shops to process in parallel (default 4)
 */
import { getDb } from "@/lib/mongo";
import {
  resolveProtractorConfig,
  fetchActiveWorkOrders,
  fetchWorkOrderById,
  fetchVehicleById,
  upsertProtractorWorkOrderSnapshot,
  upsertProtractorVehicleSnapshot,
} from "@/lib/integrations/protractor";
import pLimit from "p-limit";

function parseArgs() {
  const out: { shops: number[] | null; dry: boolean; concurrency: number } = {
    shops: null,
    dry: false,
    concurrency: 4,
  };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--shop=")) {
      out.shops = a.slice("--shop=".length).split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
    } else if (a === "--dry") {
      out.dry = true;
    } else if (a.startsWith("--concurrency=")) {
      out.concurrency = Math.max(1, Number(a.slice("--concurrency=".length)) || 4);
    }
  }
  return out;
}

async function syncShop(shopId: number, opts: { dry: boolean }) {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { shopId, skipped: true, reason: "not configured" };
  }

  const active = await fetchActiveWorkOrders(shopId, { readInProgress: true });
  if (!active.ok || !active.workOrders) {
    return { shopId, error: active.error || "fetchActiveWorkOrders failed" };
  }

  const wos = active.workOrders;
  console.log(`[shop ${shopId}] fetched ${wos.length} active WOs`);

  if (opts.dry) {
    const wonums = wos.map((w) => w.WorkOrderNumber).filter(Boolean).sort((a: any, b: any) => Number(b) - Number(a)).slice(0, 5);
    return { shopId, fetched: wos.length, recentNumbers: wonums, dry: true };
  }

  // Fetch full detail (open WOs from the list endpoint are summaries) +
  // upsert with limited per-shop concurrency to avoid hammering Protractor.
  const detailLimit = pLimit(3);
  let upserted = 0;
  let vehiclesUpserted = 0;
  let errors = 0;

  await Promise.all(
    wos.map((wo) =>
      detailLimit(async () => {
        try {
          const detail = await fetchWorkOrderById(shopId, wo.ID);
          const full = detail.ok && detail.workOrder ? detail.workOrder : wo;

          await upsertProtractorWorkOrderSnapshot(shopId, full);
          upserted++;

          let vin = full.ServiceItem?.VIN?.toUpperCase() || full.ServiceItem?.Lookup?.toUpperCase() || (full as any).VIN?.toUpperCase();
          let vehicle = full.ServiceItem;

          if (!vin && full.ServiceItemID) {
            const vr = await fetchVehicleById(shopId, full.ServiceItemID);
            if (vr.ok && vr.vehicle?.VIN) {
              vin = vr.vehicle.VIN.toUpperCase();
              vehicle = vr.vehicle;
            }
          }

          if (vin && vehicle) {
            await upsertProtractorVehicleSnapshot(shopId, vin, vehicle);
            vehiclesUpserted++;
          }
        } catch (e: any) {
          errors++;
          console.log(`[shop ${shopId}] WO ${wo.WorkOrderNumber || wo.ID} error:`, e?.message || e);
        }
      }),
    ),
  );

  return { shopId, fetched: wos.length, upserted, vehiclesUpserted, errors };
}

async function main() {
  const args = parseArgs();
  const db = await getDb();

  const filter: any = {
    $or: [
      { "protractor.apiKey": { $exists: true, $nin: [null, ""] } },
      { protractorApiKey: { $exists: true, $nin: [null, ""] } },
      { "protractor.connectionId": { $exists: true, $nin: [null, ""] } },
      { protractorConnectionId: { $exists: true, $nin: [null, ""] } },
    ],
  };
  if (args.shops) filter.shopId = { $in: args.shops };

  const shops = await db
    .collection("shops")
    .find(filter, { projection: { shopId: 1, name: 1, _id: 0 } })
    .toArray();

  console.log(`[manual-sync] starting | shops=${shops.length} | dry=${args.dry} | concurrency=${args.concurrency}`);
  for (const s of shops) console.log(`  - ${s.shopId} | ${s.name}`);
  console.log();

  const shopLimit = pLimit(args.concurrency);
  const t0 = Date.now();
  const results = await Promise.all(
    shops.map((s) => shopLimit(() => syncShop(Number(s.shopId), { dry: args.dry }))),
  );
  const ms = Date.now() - t0;

  console.log(`\n[manual-sync] done in ${(ms / 1000).toFixed(1)}s`);
  console.table(results);

  process.exit(0);
}

main().catch((e) => {
  console.error("[manual-sync] fatal:", e);
  process.exit(1);
});
