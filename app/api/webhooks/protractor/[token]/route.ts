import { NextResponse, NextRequest } from "next/server";
import { Db } from "mongodb";
import { getDb } from "@/lib/mongo";
import {
  fetchVehicleById,
  fetchWorkOrderById,
  upsertProtractorVehicleSnapshot,
  upsertProtractorWorkOrderSnapshot,
} from "@/lib/integrations/protractor";
import { attributeRevenueFromWorkOrder } from "@/lib/enterprise";
import { extractJobIndexFromWorkOrder, computeJobHash } from "@/lib/job-index";
import { triggerVhiOnWorkOrderClose, triggerVhiOnWorkOrderCreate, extractAuthorizedJobsFromProtractorRo } from "@/lib/vhi-webhook-trigger";
import { insertEvent } from "@/lib/data/repositories/events";
import { NormalizedIngestionService } from "@/lib/integrations/core/normalized-ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Test seam (Task #520): tests override these to drive the webhook handler
 * end-to-end against an in-memory Mongo without hitting the real Protractor
 * API or Postgres. `createIngestionService` is the critical one — it lets a
 * regression test assert that the WorkOrder normalization runs INLINE (and
 * therefore the row is visible to `/api/dashboard/data-v2` within the same
 * request). Production code must keep calling `__deps.createIngestionService`
 * and awaiting `ingestWorkOrderWithAllEntities` synchronously; moving it back
 * to fire-and-forget re-introduces the "RO disappears from dashboard" bug
 * that Task #517 fixed.
 */
export const __deps = {
  getDb,
  insertEvent,
  fetchWorkOrderById,
  upsertProtractorWorkOrderSnapshot,
  triggerVhiOnWorkOrderCreate,
  triggerVhiOnWorkOrderClose,
  createIngestionService: (
    db: Db,
    sourceSystem: "protractor",
    shopId: number,
    enterpriseId: string | undefined,
    options: ConstructorParameters<typeof NormalizedIngestionService>[4],
  ) => new NormalizedIngestionService(db, sourceSystem, shopId, enterpriseId, options),
};

async function findShopByToken(token: string) {
  const db = await __deps.getDb();
  return db
    .collection("shops")
    .findOne({ protractorWebhookToken: token }, { projection: { shopId: 1, name: 1 } });
}

function resolveVin(payload: any): string | null {
  const vin =
    payload?.VIN ??
    payload?.vin ??
    payload?.ServiceItem?.VIN ??
    payload?.ServiceItem?.Lookup ??
    payload?.serviceItem?.vin ??
    payload?.serviceItem?.lookup ??
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

  const db = await __deps.getDb();

  const connectionId = req.nextUrl.searchParams.get("connectionId") ?? null;
  const apiKey = req.nextUrl.searchParams.get("apiKey") ?? null;
  const objectType = req.nextUrl.searchParams.get("type") ?? null;
  const objectId = req.nextUrl.searchParams.get("id") ?? null;
  const operation = req.nextUrl.searchParams.get("operation") ?? null;

  // task #345 (W3b): events ingress is PG-canonical via the
  // repository; Mongo `events` is shadow-mirrored during soak so the
  // legacy aggregate readers (vehicle page / dashboards / debug
  // routes) still see the row until they're flipped over.
  await __deps.insertEvent({
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
      const result = await __deps.fetchWorkOrderById(shopId, objectId);
      if (result.ok && result.workOrder) {
        const woNum = result.workOrder.WorkOrderNumber || objectId;
        console.log(`[Protractor Webhook] received WO=${woNum} shop=${shopId} op=${operation}`);
        await __deps.upsertProtractorWorkOrderSnapshot(shopId, result.workOrder);
        console.log(`[Protractor Webhook] enriched WO=${woNum} (protractor_work_orders upserted)`);

        // Task #517 — Webhook normalization durability: previously the
        // webhook only wrote to `protractor_work_orders`, leaving
        // `normalized_work_orders` (what the dashboard actually reads)
        // stale until the next 2 AM cron. RO 3575 (line-item-only edit)
        // disappeared from the CAR Experts dashboard for this reason.
        // Run normalization inline before bumping `dashboard_updates`
        // so dashboard refresh truly reflects the new state.
        try {
          const shopDoc = await db.collection("shops").findOne(
            { shopId: { $in: [String(shopId), Number(shopId)] } },
            { projection: { enterpriseId: 1 } }
          );
          const enterpriseId = shopDoc?.enterpriseId as string | undefined;
          const ingestionService = __deps.createIngestionService(
            db,
            'protractor',
            shopId,
            enterpriseId,
            { dualWriteToJobIndex: false, dualWriteToRepairPatterns: true, ingestionVia: 'webhook' }
          );
          const normResult = await ingestionService.ingestWorkOrderWithAllEntities(result.workOrder);
          console.log(
            `[Protractor Webhook] normalized WO=${woNum} action=${normResult.workOrder.action} entityId=${normResult.workOrder.entityId || 'n/a'}`
          );
        } catch (normErr: any) {
          console.error(`[Protractor Webhook] normalization failed for WO=${woNum}:`, normErr?.message || normErr);
        }

        await db.collection("dashboard_updates").updateOne(
          { _id: "lastUpdate" } as any,
          { $set: { timestamp: Date.now() } },
          { upsert: true }
        );
        console.log(`[Protractor Webhook] dashboard-bumped WO=${woNum}`);

        const woStage = (result.workOrder.WorkflowStage || "").toLowerCase();
        const isCompleted = result.workOrder.Completed || 
          ["invoiced", "invoice", "posted", "completed", "closed"].some(s => woStage.includes(s));

        if (!isCompleted) {
          const woVin = (result.workOrder.ServiceItem?.VIN || result.workOrder.ServiceItem?.Lookup || "")?.toUpperCase() || null;
          const woMileageCreate = result.workOrder.InUsage || result.workOrder.ServiceItem?.Odometer || null;
          if (woVin && woVin.length >= 11 && woMileageCreate && woMileageCreate > 0) {
            __deps.triggerVhiOnWorkOrderCreate(db, {
              vin: woVin,
              shopId,
              provider: "protractor",
              roNumber: result.workOrder.WorkOrderNumber || objectId,
              mileage: woMileageCreate,
              source: "webhook",
            }).catch((err: any) =>
              console.error(`[Protractor Webhook] VHI create-build failed for VIN ${woVin}:`, err.message)
            );
          }
        }

        if (isCompleted) {
          const vin = (result.workOrder.ServiceItem?.VIN || result.workOrder.ServiceItem?.Lookup || '')?.toUpperCase() || null;
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

            const authorizedJobs = extractAuthorizedJobsFromProtractorRo(result.workOrder);
            const woMileage = result.workOrder.OutUsage || result.workOrder.InUsage || 
              result.workOrder.ServiceItem?.Odometer || null;
            __deps.triggerVhiOnWorkOrderClose(db, {
              vin,
              shopId,
              provider: "protractor",
              roNumber: result.workOrder.WorkOrderNumber || objectId,
              mileage: woMileage,
              authorizedJobs,
              source: "webhook",
            }).catch((err: any) =>
              console.error(`[Protractor Webhook] VHI auto-rebuild failed for VIN ${vin}:`, err.message)
            );
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
