import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = String(session.shopId);

  const shopRows = await sql`SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
  const shop = shopRows[0];
  const settings = shop?.settings || {};

  const DEFAULT_WORKFLOW_STAGES = ["InspectionInProgress", "Unassigned", "WorkAuthorized", "EstimateCompleted"];
  const allowedStages = settings.preferences?.workflowStages || DEFAULT_WORKFLOW_STAGES;

  const protractorWOs = await sql`
    SELECT DISTINCT ON (pwo.vin)
      pwo.work_order_id,
      pwo.work_order_number,
      pwo.vin,
      pv.year,
      pv.make,
      pv.model,
      pv.engine,
      COALESCE(pwo.company_name, pwo.contact_name, 'Unknown Customer') as customer_name,
      COALESCE(pwo.workflow_stage, pwo.status, 'Open') as status,
      COALESCE(pwo.odometer, pv.odometer) as odometer,
      pwo.fetched_at
    FROM protractor_work_orders pwo
    LEFT JOIN protractor_vehicles pv ON pwo.vin = pv.vin AND pwo.shop_id = pv.shop_id
    WHERE pwo.shop_id = ${shopId}
      AND pwo.vin IS NOT NULL AND pwo.vin != ''
      AND pwo.workflow_stage = ANY(${allowedStages})
    ORDER BY pwo.vin, pwo.fetched_at DESC
  `;

  const workOrders = protractorWOs.map((wo: any) => ({
    workOrderId: wo.work_order_id,
    workOrderNumber: wo.work_order_number,
    vehicle: {
      vin: wo.vin,
      year: wo.year,
      make: wo.make,
      model: wo.model,
      engine: wo.engine,
    },
    customerName: wo.customer_name,
    status: wo.status,
    odometer: wo.odometer,
  }));

  return NextResponse.json({ workOrders });
}
