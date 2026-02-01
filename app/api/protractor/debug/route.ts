import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import {
  resolveProtractorConfig,
  fetchActiveWorkOrders,
  fetchDeferredWork,
  resolveWorkOrderGuid,
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

  const workOrderId = req.nextUrl.searchParams.get("workOrderId");
  if (workOrderId) {
    const lookupResult = await resolveWorkOrderGuid(shopId, workOrderId);
    if (!lookupResult.ok) {
      return NextResponse.json({ error: lookupResult.error });
    }
    return NextResponse.json({ workOrder: lookupResult.workOrder, guid: lookupResult.workOrderGuid });
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

  const shopIdStr = String(shopId);
  
  const [cachedVehicles, cachedWorkOrders, cachedDeferredWork] = await Promise.all([
    sql`SELECT * FROM protractor_vehicles WHERE shop_id = ${shopIdStr}`,
    sql`SELECT * FROM protractor_work_orders WHERE shop_id = ${shopIdStr}`,
    sql`SELECT * FROM protractor_deferred_work WHERE shop_id = ${shopIdStr}`,
  ]);

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
