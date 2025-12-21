import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import {
  resolveProtractorConfig,
  fetchActiveWorkOrders,
  fetchDeferredWork,
} from "@/lib/integrations/protractor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  const config = await resolveProtractorConfig(shopId);
  
  if (!config.configured) {
    return NextResponse.json(
      { error: "Protractor is not configured for this shop" },
      { status: 400 }
    );
  }

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 30);

  const workOrdersResult = await fetchActiveWorkOrders(shopId, {
    startDate: startDate.toISOString().split("T")[0],
    endDate: endDate.toISOString().split("T")[0],
    readInProgress: true,
  });

  if (!workOrdersResult.ok) {
    return NextResponse.json(
      { error: workOrdersResult.error || "Failed to fetch work orders" },
      { status: 500 }
    );
  }

  const db = await getDb();
  
  const cachedVehicles = await db.collection("protractor_vehicles")
    .find({ shopId })
    .toArray();
    
  const cachedWorkOrders = await db.collection("protractor_work_orders")
    .find({ shopId })
    .toArray();
    
  const cachedDeferredWork = await db.collection("protractor_deferred_work")
    .find({ shopId })
    .toArray();

  // Fetch sample deferred work from first vehicle with ServiceItem
  let sampleDeferredWork = null;
  const workOrders = workOrdersResult.workOrders || [];
  for (const wo of workOrders.slice(0, 3)) {
    const serviceItemId = wo.ServiceItem?.ID;
    if (serviceItemId) {
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
      const deferredResult = await fetchDeferredWork(shopId, serviceItemId, {
        startDate: twoYearsAgo.toISOString().split("T")[0],
        endDate: new Date().toISOString().split("T")[0],
      });
      if (deferredResult.ok && deferredResult.deferredWork?.length) {
        sampleDeferredWork = {
          serviceItemId,
          vin: wo.ServiceItem?.VIN,
          items: deferredResult.deferredWork,
        };
        break;
      }
    }
  }

  return NextResponse.json({
    rawFromProtractor: workOrdersResult.workOrders,
    cachedVehicles,
    cachedWorkOrders,
    cachedDeferredWork,
    sampleDeferredWork,
  }, { status: 200 });
}
