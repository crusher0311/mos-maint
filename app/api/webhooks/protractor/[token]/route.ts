import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  fetchVehicleById,
  fetchWorkOrderById,
  upsertProtractorVehicleSnapshot,
  upsertProtractorWorkOrderSnapshot,
} from "@/lib/integrations/protractor";
import { attributeRevenueFromWorkOrder } from "@/lib/enterprise";
import { extractJobIndexFromWorkOrder, computeJobHash } from "@/lib/job-index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function findShopByToken(token: string) {
  const db = await getDb();
  return db
    .collection("shops")
    .findOne({ protractorWebhookToken: token }, { projection: { shopId: 1, name: 1 } });
}

function resolveVin(payload: any): string | null {
  const vin =
    payload?.VIN ??
    payload?.vin ??
    payload?.ServiceItem?.VIN ??
    payload?.serviceItem?.vin ??
    null;
  return vin ? String(vin).trim().toUpperCase() : null;
}

export async function GET(req: NextRequest, ctx: { params: { token: string } }) {
  const token = ctx.params?.token || "";
  if (!token) return NextResponse.json({ error: "missing token" }, { status: 400 });

  const isPing = req.nextUrl.searchParams.has("ping");
  const shop = await findShopByToken(token);
  if (!shop) return NextResponse.json({ error: "invalid token" }, { status: 401 });

  if (isPing) {
    return NextResponse.json({ ok: true, shopId: shop.shopId, tokenValid: true });
  }
  return NextResponse.json({ ok: true, shopId: shop.shopId });
}

export async function POST(req: NextRequest, ctx: { params: { token: string } }) {
  const token = ctx.params?.token || "";
  if (!token) return NextResponse.json({ error: "missing token" }, { status: 400 });

  const shop = await findShopByToken(token);
  if (!shop) return NextResponse.json({ error: "invalid token" }, { status: 401 });

  const raw = await req.text();
  let payload: any = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  const db = await getDb();

  const connectionId = req.nextUrl.searchParams.get("connectionId") ?? null;
  const apiKey = req.nextUrl.searchParams.get("apiKey") ?? null;
  const objectType = req.nextUrl.searchParams.get("type") ?? null;
  const objectId = req.nextUrl.searchParams.get("id") ?? null;
  const operation = req.nextUrl.searchParams.get("operation") ?? null;

  await db.collection("events").insertOne({
    provider: "protractor",
    shopId: shop.shopId,
    token,
    connectionId,
    apiKey: apiKey ? `${apiKey.slice(0, 8)}...` : null,
    objectType,
    objectId,
    operation,
    payload,
    raw,
    receivedAt: new Date(),
  });

  try {
    const shopId = Number(shop.shopId);

    if (objectType === "ServiceItem" && objectId && (operation === "Update" || operation === "Create")) {
      const result = await fetchVehicleById(shopId, objectId);
      if (result.ok && result.vehicle?.VIN) {
        await upsertProtractorVehicleSnapshot(shopId, result.vehicle.VIN, result.vehicle);
        console.log(`[Protractor Webhook] ${operation} vehicle snapshot for ${result.vehicle.VIN}`);
      }
    }

    if (objectType === "WorkOrder" && objectId && operation === "Delete") {
      const existingWO = await db.collection("protractor_work_orders").findOne({
        shopId: { $in: [String(shopId), Number(shopId)] },
        workOrderId: objectId
      });

      await db.collection("protractor_work_orders").updateMany(
        { shopId: { $in: [String(shopId), Number(shopId)] }, workOrderId: objectId },
        { $set: { completed: true, status: "Deleted", workflowStage: "Deleted", deletedAt: new Date(), deletedViaWebhook: true } }
      );

      if (existingWO?.vin) {
        const otherActiveWOs = await db.collection("protractor_work_orders").countDocuments({
          shopId: { $in: [String(shopId), Number(shopId)] },
          vin: existingWO.vin,
          completed: { $ne: true },
          workOrderId: { $ne: objectId }
        });

        if (otherActiveWOs === 0) {
          await db.collection("vehicles").updateOne(
            {
              $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
              vin: existingWO.vin
            },
            { $set: { "status.active": false, "status.updatedAt": new Date(), updatedAt: new Date() } }
          );
        }

        const existingVehicle = await db.collection("vehicles").findOne({
          $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
          vin: existingWO.vin
        });
        if (existingVehicle) {
          const updatedSources = (existingVehicle.status?.sources || []).filter(
            (s: any) => !(s.provider === "protractor" && String(s.workOrderId) === String(objectId))
          );
          await db.collection("vehicles").updateOne(
            { _id: existingVehicle._id },
            { $set: { "status.sources": updatedSources, "status.updatedAt": new Date() } }
          );
        }
      }

      await db.collection("dashboard_updates").updateOne(
        { _id: "lastUpdate" } as any,
        { $set: { timestamp: Date.now() } },
        { upsert: true }
      );
      console.log(`[Protractor Webhook] Deleted work order ${objectId} (WO#${existingWO?.workOrderNumber || '?'}) from dashboard`);
    } else if (objectType === "WorkOrder" && objectId) {
      const result = await fetchWorkOrderById(shopId, objectId);
      if (result.ok && result.workOrder) {
        await upsertProtractorWorkOrderSnapshot(shopId, result.workOrder);
        await db.collection("dashboard_updates").updateOne(
          { _id: "lastUpdate" } as any,
          { $set: { timestamp: Date.now() } },
          { upsert: true }
        );
        console.log(`[Protractor Webhook] Updated work order snapshot ${objectId}`);
        
        const woStage = (result.workOrder.WorkflowStage || "").toLowerCase();
        const isCompleted = result.workOrder.Completed || 
          ["invoiced", "invoice", "posted", "completed", "closed"].some(s => woStage.includes(s));

        if (isCompleted) {
          const vin = result.workOrder.ServiceItem?.VIN?.toUpperCase();
          if (vin) {
            const savedWO = await db.collection("protractor_work_orders").findOne({
              shopId,
              workOrderId: objectId
            });
            
            if (savedWO?.packageSummaries?.length > 0) {
              const attribution = await attributeRevenueFromWorkOrder(
                shopId,
                objectId,
                vin,
                savedWO.packageSummaries,
                "protractor"
              );
              if (attribution.matched > 0) {
                console.log(`[Protractor Webhook] Revenue attribution: ${attribution.matched} jobs, $${attribution.revenue.toFixed(2)}`);
              }
            }

            try {
              const jobEntries = extractJobIndexFromWorkOrder(shopId, result.workOrder, "protractor");
              let indexed = 0;
              let skipped = 0;

              for (const entry of jobEntries) {
                const contentHash = computeJobHash(entry);
                const filter = { 
                  shopId, 
                  workOrderId: entry.workOrderId, 
                  servicePackageId: entry.servicePackageId 
                };

                const existing = await db.collection("job_index").findOne(filter);
                if (existing?.contentHash === contentHash) {
                  skipped++;
                  continue;
                }

                await db.collection("job_index").updateOne(
                  filter,
                  { $set: { ...entry, contentHash } },
                  { upsert: true }
                );
                indexed++;
              }

              if (indexed > 0) {
                console.log(`[Protractor Webhook] Indexed ${indexed} jobs for WO ${objectId} (${skipped} unchanged)`);
              }

              await db.collection("protractor_work_orders").updateMany(
                { shopId: { $in: [String(shopId), Number(shopId)] }, workOrderId: objectId },
                { $set: { jobsIndexed: true, jobsIndexedAt: new Date() } }
              );
            } catch (indexErr: any) {
              console.error(`[Protractor Webhook] Job indexing error for WO ${objectId}:`, indexErr.message);
            }
          }
        }
      }
    }

    if (objectType === "Contact" && objectId && operation === "Update") {
      console.log(`[Protractor Webhook] Contact ${objectId} updated`);
    }

  } catch (err: any) {
    console.error("[Protractor Webhook] Processing error:", err.message);
  }

  return NextResponse.json({ ok: true, received: new Date().toISOString() });
}
