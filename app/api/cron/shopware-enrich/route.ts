import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { shopWareRequest } from "@/lib/integrations/shopware/client";
import type { ShopWareVehicle, ShopWareCustomer } from "@/lib/integrations/shopware/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;
const DEFAULT_BATCH_SIZE = 500;

function isAuthorized(req: NextRequest): boolean {
  if (!CRON_SECRET) return true;
  const header = req.headers.get("authorization");
  const param = req.nextUrl.searchParams.get("secret");
  return header === `Bearer ${CRON_SECRET}` || param === CRON_SECRET;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const batchSize = Math.min(
    Number(req.nextUrl.searchParams.get("batch") || DEFAULT_BATCH_SIZE),
    2000
  );

  const db = await getDb();

  const swShops = await db
    .collection("shops")
    .find(
      { "shopware.tenantId": { $exists: true, $ne: null } },
      { projection: { shopId: 1, "shopware.tenantId": 1, "shopware.swShopId": 1 } }
    )
    .toArray();

  if (swShops.length === 0) {
    return NextResponse.json({ ok: true, message: "No Shop-Ware shops found" });
  }

  const results: any[] = [];

  for (const shop of swShops) {
    const mosShopId = Number(shop.shopId);
    const tenantId = shop.shopware.tenantId;

    const rosToEnrich = await db
      .collection("shopware_repair_orders")
      .find({
        mosShopId,
        vin: null,
        vehicleId: { $ne: null },
      })
      .sort({ updatedAt: -1 })
      .limit(batchSize)
      .project({ roId: 1, vehicleId: 1, customerId: 1 })
      .toArray();

    if (rosToEnrich.length === 0) {
      results.push({ shopId: mosShopId, enriched: 0, remaining: 0, message: "All ROs enriched" });
      continue;
    }

    const vehicleIds = [...new Set(rosToEnrich.map((r) => r.vehicleId).filter(Boolean))] as number[];
    const customerIds = [...new Set(rosToEnrich.map((r) => r.customerId).filter(Boolean))] as number[];

    const cachedV = await db
      .collection("shopware_vehicles")
      .find({ mosShopId, vehicleId: { $in: vehicleIds } })
      .toArray();
    const cachedC = await db
      .collection("shopware_customers")
      .find({ mosShopId, customerId: { $in: customerIds } })
      .toArray();

    const vMap = new Map<number, any>();
    const cMap = new Map<number, any>();
    cachedV.forEach((v) => vMap.set(v.vehicleId, v));
    cachedC.forEach((c) => cMap.set(c.customerId, c));

    const uncachedV = vehicleIds.filter((id) => !vMap.has(id));
    const uncachedC = customerIds.filter((id) => !cMap.has(id));

    let vFetched = 0;
    let vFailed = 0;
    for (const vid of uncachedV) {
      try {
        const v = await shopWareRequest<ShopWareVehicle>(
          `/tenants/${tenantId}/vehicles/${vid}`,
          {},
          mosShopId
        );
        vMap.set(vid, v);
        await db.collection("shopware_vehicles").updateOne(
          { mosShopId, vehicleId: vid },
          {
            $set: {
              mosShopId,
              tenantId,
              vehicleId: vid,
              vin: v.vin?.toUpperCase() ?? null,
              year: v.year ? parseInt(String(v.year), 10) : null,
              make: v.make ?? null,
              model: v.model ?? null,
              licensePlate: v.plate_number ?? null,
              syncedAt: new Date(),
            },
          },
          { upsert: true }
        );
        vFetched++;
      } catch {
        vMap.set(vid, { _failed: true });
        vFailed++;
      }
    }

    let cFetched = 0;
    let cFailed = 0;
    for (const cid of uncachedC) {
      try {
        const c = await shopWareRequest<ShopWareCustomer>(
          `/tenants/${tenantId}/customers/${cid}`,
          {},
          mosShopId
        );
        cMap.set(cid, c);
        await db.collection("shopware_customers").updateOne(
          { mosShopId, customerId: cid },
          {
            $set: {
              mosShopId,
              tenantId,
              customerId: cid,
              firstName: c.first_name ?? null,
              lastName: c.last_name ?? null,
              name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim(),
              email: c.email ?? null,
              phone: c.phone_number ?? c.mobile_number ?? null,
              syncedAt: new Date(),
            },
          },
          { upsert: true }
        );
        cFetched++;
      } catch {
        cMap.set(cid, { _failed: true });
        cFailed++;
      }
    }

    const bulkOps: any[] = [];
    for (const ro of rosToEnrich) {
      const v = vMap.get(ro.vehicleId);
      if (!v || v._failed) continue;
      const c = cMap.get(ro.customerId);
      const vin = v.vin?.toUpperCase?.() ?? null;
      const customerName =
        c && !c._failed
          ? `${c.first_name ?? c.firstName ?? ""} ${c.last_name ?? c.lastName ?? ""}`.trim()
          : null;

      bulkOps.push({
        updateOne: {
          filter: { _id: ro._id },
          update: {
            $set: {
              vin,
              vehicleMake: v.make ?? null,
              vehicleModel: v.model ?? null,
              vehicleYear: v.year ? parseInt(String(v.year), 10) : null,
              ...(customerName ? { customerName } : {}),
            },
          },
        },
      });
    }

    if (bulkOps.length > 0) {
      await db.collection("shopware_repair_orders").bulkWrite(bulkOps);
    }

    const remaining = await db
      .collection("shopware_repair_orders")
      .countDocuments({ mosShopId, vin: null, vehicleId: { $ne: null } });

    const dashboardReady = await db
      .collection("shopware_repair_orders")
      .countDocuments({
        mosShopId,
        state: { $in: ["estimate", "in_progress"] },
        vin: { $ne: null },
        deleted: { $ne: true },
      });

    results.push({
      shopId: mosShopId,
      batch: rosToEnrich.length,
      enriched: bulkOps.length,
      vehiclesFetched: vFetched,
      vehiclesCached: cachedV.length,
      vehiclesFailed: vFailed,
      customersFetched: cFetched,
      customersCached: cachedC.length,
      customersFailed: cFailed,
      remaining,
      dashboardReady,
    });

    console.log(
      `[SW Enrich] Shop ${mosShopId}: enriched ${bulkOps.length}/${rosToEnrich.length}, ` +
        `vehicles ${vFetched} fetched / ${cachedV.length} cached, ` +
        `customers ${cFetched} fetched / ${cachedC.length} cached, ` +
        `remaining: ${remaining}, dashboard-ready: ${dashboardReady}`
    );
  }

  return NextResponse.json({
    ok: true,
    duration: `${Date.now() - startTime}ms`,
    results,
  });
}
