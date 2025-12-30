// app/api/jobs/open-work-orders/route.ts
// Get open work orders with full details for Job Lookup feature

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = session.shopId;
  const db = await getDb();

  const shop = await db.collection("shops").findOne(
    { shopId: { $in: [String(shopId), Number(shopId)] } },
    { projection: { preferences: 1 } }
  );

  const DEFAULT_WORKFLOW_STAGES = ["InspectionInProgress", "Unassigned", "WorkAuthorized", "EstimateCompleted"];
  const allowedStages = shop?.preferences?.workflowStages || DEFAULT_WORKFLOW_STAGES;

  const protractorWOs = await db.collection("protractor_work_orders").aggregate([
    {
      $match: {
        shopId: { $in: [String(shopId), Number(shopId)] },
        vin: { $ne: null, $type: "string" },
        workflowStage: { $in: allowedStages }
      }
    },
    { $sort: { fetchedAt: -1 } },
    {
      $group: {
        _id: "$vin",
        latest: { $first: "$$ROOT" }
      }
    },
    { $replaceRoot: { newRoot: "$latest" } },
    {
      $lookup: {
        from: "protractor_vehicles",
        let: { vin: "$vin", shopIdNum: Number(shopId), shopIdStr: String(shopId) },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $or: [
                    { $eq: ["$shopId", "$$shopIdNum"] },
                    { $eq: ["$shopId", "$$shopIdStr"] }
                  ]},
                  { $eq: ["$vin", "$$vin"] }
                ]
              }
            }
          },
          { $limit: 1 }
        ],
        as: "vehicle"
      }
    },
    { $unwind: { path: "$vehicle", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        workOrderId: "$workOrderId",
        workOrderNumber: "$workOrderNumber",
        vin: "$vin",
        year: { $ifNull: ["$vehicle.year", null] },
        make: { $ifNull: ["$vehicle.make", null] },
        model: { $ifNull: ["$vehicle.model", null] },
        engine: { $ifNull: ["$vehicle.engine", null] },
        customerName: { $ifNull: ["$companyName", { $ifNull: ["$contactName", "Unknown Customer"] }] },
        status: { $ifNull: ["$workflowStage", { $ifNull: ["$status", "Open"] }] },
        odometer: { $ifNull: ["$odometer", { $ifNull: ["$vehicle.odometer", null] }] },
        fetchedAt: "$fetchedAt"
      }
    },
    { $sort: { fetchedAt: -1 } }
  ]).toArray();

  const workOrders = protractorWOs.map(wo => ({
    workOrderId: wo.workOrderId,
    workOrderNumber: wo.workOrderNumber,
    vehicle: {
      vin: wo.vin,
      year: wo.year,
      make: wo.make,
      model: wo.model,
      engine: wo.engine,
    },
    customerName: wo.customerName,
    status: wo.status,
    odometer: wo.odometer,
  }));

  return NextResponse.json({
    ok: true,
    workOrders,
    count: workOrders.length,
  });
}
