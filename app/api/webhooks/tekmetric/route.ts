import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { indexTekmetricWorkOrderJobs } from "@/lib/tekmetric-job-index";
import { getVehicle, getCustomer } from "@/lib/tekmetric";
import { invalidateCachedPlan } from "@/lib/plan-cache";
import { triggerVhiOnWorkOrderClose, triggerVhiOnWorkOrderCreate, extractAuthorizedJobsFromTekmetricRo } from "@/lib/vhi-webhook-trigger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TERMINAL_STATUSES = ["invoice", "invoiced", "posted", "deleted", "void", "closed"];

function forwardWebhook(body: any, sourceHost: string) {
  const targets = (process.env.WEBHOOK_FORWARD_TARGETS || "").split(",").map(t => t.trim()).filter(Boolean);
  if (targets.length === 0) return;

  for (const target of targets) {
    if (sourceHost && target.includes(sourceHost)) continue;

    const url = target.startsWith("http") ? target : `https://${target}/api/webhooks/tekmetric`;
    const forwardUrl = url.includes("/api/webhooks/tekmetric") ? url : `${url}/api/webhooks/tekmetric`;

    fetch(forwardUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-From": sourceHost || "unknown",
        "X-Webhook-Forward": "true",
      },
      body: JSON.stringify(body),
    }).then(res => {
      console.log(`[Tekmetric Webhook] Forwarded to ${forwardUrl}: ${res.status}`);
    }).catch(err => {
      console.warn(`[Tekmetric Webhook] Forward to ${forwardUrl} failed: ${err.message}`);
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const db = await getDb();

    const isForwarded = req.headers.get("x-webhook-forward") === "true";
    const sourceHost = req.headers.get("host") || "";

    if (!isForwarded) {
      forwardWebhook(body, sourceHost);
    }
    
    console.log("[Tekmetric Webhook] Received event:", JSON.stringify(body, null, 2).slice(0, 1000));
    
    const eventType = body.event || body.eventType || body.type || "";
    const data = body.data || body.payload || body;
    
    // Handle both nested (data.repairOrder) and flat (data is the repair order) structures
    const repairOrder = data.repairOrder || body.repairOrder || 
      (data.id && data.repairOrderNumber && data.shopId ? data : null);
    
    const isInspectionComplete = 
      eventType.toLowerCase().includes("inspection") && 
      (eventType.toLowerCase().includes("complete") || eventType.toLowerCase().includes("marked complete"));
    
    const isCustomerViewed = 
      eventType.toLowerCase().includes("customer") && 
      eventType.toLowerCase().includes("viewed");
    
    const isRepairOrderUpdate = 
      eventType.toLowerCase().includes("repairorder") ||
      eventType.toLowerCase().includes("repair_order") ||
      eventType.toLowerCase().includes("ro.") ||
      repairOrder;
    
    const isInvoicePosted = 
      eventType.toLowerCase().includes("posted") ||
      eventType.toLowerCase().includes("invoiced") ||
      eventType.toLowerCase().includes("invoice");
    
    console.log(`[Tekmetric Webhook] Parsed - eventType: "${eventType}", repairOrder found: ${!!repairOrder}, isRepairOrderUpdate: ${isRepairOrderUpdate}`);
    
    if (repairOrder) {
      const roId = repairOrder.id;
      const roNumber = repairOrder.repairOrderNumber;
      const tekmetricShopId = repairOrder.shopId;
      const statusName = repairOrder.repairOrderStatus?.name || "";
      const statusCode = repairOrder.repairOrderStatus?.code || "";
      
      console.log(`[Tekmetric Webhook] RO Update: #${roNumber} (ID: ${roId}), Status: ${statusName} (${statusCode})`);
      
      const isTerminal = TERMINAL_STATUSES.some(s => 
        statusName.toLowerCase().includes(s) || 
        statusCode.toLowerCase().includes(s)
      );
      
      if (isTerminal || isInvoicePosted) {
        console.log(`[Tekmetric Webhook] RO #${roNumber} is terminal/invoiced, updating cache immediately`);
        
        const cached = await db.collection("tekmetric_work_orders").findOne({
          workOrderId: String(roId)
        });
        
        if (cached && !cached.jobsIndexed && cached.vin) {
          const shop = await db.collection("shops").findOne({
            "tekmetric.shopId": tekmetricShopId
          });
          
          if (shop) {
            try {
              const jobsIndexed = await indexTekmetricWorkOrderJobs(
                Number(shop.shopId),
                tekmetricShopId,
                roId,
                roNumber,
                {
                  vin: cached.vin,
                  year: cached.vehicleYear,
                  make: cached.vehicleMake,
                  model: cached.vehicleModel,
                  engine: cached.vehicleEngine
                },
                new Date().toISOString(),
                cached.odometer ?? cached.data?.milesOut ?? cached.data?.milesIn ?? null
              );
              
              console.log(`[Tekmetric Webhook] Indexed ${jobsIndexed} jobs for RO #${roNumber}`);
              
              await db.collection("tekmetric_work_orders").updateMany(
                { workOrderId: String(roId) },
                { $set: { jobsIndexed: true } }
              );
            } catch (err: any) {
              console.error(`[Tekmetric Webhook] Job indexing failed for RO #${roNumber}:`, err.message);
            }
          }
        }
        
        const result = await db.collection("tekmetric_work_orders").updateMany(
          { workOrderId: String(roId) },
          { 
            $set: { 
              status: statusName || "Posted",
              statusCode: statusCode || "POSTED",
              closedAt: new Date(),
              updatedAt: new Date()
            }
          }
        );
        
        console.log(`[Tekmetric Webhook] Updated ${result.modifiedCount} cache entries for RO #${roNumber} to ${statusName || "Posted"}`);
      } else {
        // Always upsert the work order row from whatever the webhook payload contains, so that
        // a missing vehicle/customer never leaves us with no row at all. Vehicle/customer
        // enrichment runs after the upsert and patches in whatever it can fetch.
        const existingWO = await db.collection("tekmetric_work_orders").findOne({
          workOrderId: String(roId)
        });

        const shop = await db.collection("shops").findOne({
          "tekmetric.shopId": tekmetricShopId
        });

        const newLabel = repairOrder.repairOrderCustomLabel?.name || repairOrder.repairOrderLabel?.name || null;
        const DVI_LABEL_RE = /\binsp|dvi\b|\bmulti.?point|\bcourtesy.check|\bcomplimentary.check/i;
        const dviFromLabel = newLabel && DVI_LABEL_RE.test(newLabel);
        const newOdometer = repairOrder.milesIn || repairOrder.milesOut;
        const payloadCustomerName =
          repairOrder.customerName ||
          (repairOrder.customer?.firstName || repairOrder.customer?.lastName
            ? `${repairOrder.customer.firstName || ''} ${repairOrder.customer.lastName || ''}`.trim()
            : null);

        const setFields: any = {
          workOrderNumber: roNumber,
          tekmetricShopId,
          status: statusName,
          statusCode,
          label: newLabel,
          labelColor: repairOrder.color || null,
          updatedAt: new Date(),
          fetchedAt: new Date(),
        };
        if (shop?.shopId != null) setFields.shopId = String(shop.shopId);
        if (newOdometer && newOdometer > 0) setFields.odometer = newOdometer;
        if (payloadCustomerName) setFields.customerName = payloadCustomerName;
        if (repairOrder.customerId != null) setFields.customerId = repairOrder.customerId;
        if (dviFromLabel && !existingWO?.dviDone) setFields.dviDone = true;

        const setOnInsert: any = {
          workOrderId: String(roId),
          createdAt: new Date(),
        };

        const upsertResult = await db.collection("tekmetric_work_orders").updateOne(
          { workOrderId: String(roId) },
          { $set: setFields, $setOnInsert: setOnInsert },
          { upsert: true }
        );
        const wasInsert = !!upsertResult.upsertedId;
        console.log(
          `[Tekmetric Webhook] Upserted RO #${roNumber}: ${wasInsert ? 'INSERT' : 'UPDATE'} status=${statusName}, label=${newLabel}, odometer=${newOdometer || 'unchanged'}, customer=${payloadCustomerName || 'unchanged'}, shop=${shop?.shopId || 'unknown'}`
        );

        // Enrich with vehicle + customer data if we're missing it. Fetches are independent and run
        // in parallel; partial failures still preserve whatever data did come back.
        const needsVehicle = !!repairOrder.vehicleId && !(existingWO?.vin);
        const needsCustomer =
          !!repairOrder.customerId &&
          !(existingWO?.customerName && existingWO.customerName !== "Unknown Customer") &&
          !payloadCustomerName;

        if (shop && (needsVehicle || needsCustomer)) {
          const [vehicleResult, customerResult] = await Promise.allSettled([
            needsVehicle ? getVehicle(repairOrder.vehicleId) : Promise.resolve(null),
            needsCustomer ? getCustomer(repairOrder.customerId, shop?.shopId ? Number(shop.shopId) : undefined) : Promise.resolve(null),
          ]);

          const enrichFields: any = {};
          let enrichedVin: string | null = null;
          let enrichedMileage: number | null = null;

          if (vehicleResult.status === 'fulfilled' && vehicleResult.value) {
            const vehicle: any = vehicleResult.value;
            if (vehicle.vin) {
              enrichedVin = String(vehicle.vin).toUpperCase();
              enrichFields.vin = enrichedVin;
            }
            if (vehicle.year != null) enrichFields.vehicleYear = vehicle.year;
            if (vehicle.make) enrichFields.vehicleMake = vehicle.make;
            if (vehicle.model) enrichFields.vehicleModel = vehicle.model;
            if (vehicle.engine) enrichFields.vehicleEngine = vehicle.engine;
            const vehicleMileage = vehicle.mileageIn || vehicle.mileageOut;
            if (!enrichFields.odometer && !setFields.odometer && vehicleMileage > 0) {
              enrichFields.odometer = vehicleMileage;
              enrichedMileage = vehicleMileage;
            }
          } else if (vehicleResult.status === 'rejected') {
            console.error(`[Tekmetric Webhook] Vehicle enrichment failed for RO #${roNumber}, vehicleId=${repairOrder.vehicleId}:`, (vehicleResult.reason as any)?.message);
          }

          if (customerResult.status === 'fulfilled' && customerResult.value) {
            const customer: any = customerResult.value;
            const fullName = `${customer.firstName || ''} ${customer.lastName || ''}`.trim();
            if (fullName) enrichFields.customerName = fullName;
          } else if (customerResult.status === 'rejected') {
            console.error(`[Tekmetric Webhook] Customer enrichment failed for RO #${roNumber}, customerId=${repairOrder.customerId}:`, (customerResult.reason as any)?.message);
          }

          if (Object.keys(enrichFields).length > 0) {
            enrichFields.updatedAt = new Date();
            await db.collection("tekmetric_work_orders").updateOne(
              { workOrderId: String(roId) },
              { $set: enrichFields }
            );
            console.log(`[Tekmetric Webhook] Enriched RO #${roNumber} with: ${Object.keys(enrichFields).filter(k => k !== 'updatedAt').join(', ')}`);
          }

          // Trigger VHI build once we have vin + mileage (from payload, existing row, or enrichment)
          const finalVin = enrichedVin || existingWO?.vin;
          const finalMileage =
            (newOdometer && newOdometer > 0 ? newOdometer : null) ||
            enrichedMileage ||
            (existingWO?.odometer || null);
          if (finalVin && finalMileage && finalMileage > 0) {
            triggerVhiOnWorkOrderCreate(db, {
              vin: finalVin,
              shopId: Number(shop.shopId),
              provider: "tekmetric",
              roNumber: String(roNumber),
              mileage: finalMileage,
              source: "webhook",
            }).catch((err: any) =>
              console.error(`[Tekmetric Webhook] VHI create-build failed for VIN ${finalVin}:`, err.message)
            );
          }
        } else if (existingWO?.vin && newOdometer && newOdometer > 0 && shop) {
          // Existing row already has vehicle info; just trigger VHI on mileage update
          triggerVhiOnWorkOrderCreate(db, {
            vin: existingWO.vin,
            shopId: Number(shop.shopId),
            provider: "tekmetric",
            roNumber: String(roNumber),
            mileage: newOdometer,
            source: "webhook",
          }).catch((err: any) =>
            console.error(`[Tekmetric Webhook] VHI create-build on update failed for VIN ${existingWO.vin}:`, err.message)
          );
        }

        if (!shop) {
          console.warn(`[Tekmetric Webhook] No MOS shop found for tekmetric.shopId=${tekmetricShopId}; row was upserted with shopId=unknown`);
        }
      }
      
      try {
        const shop = await db.collection("shops").findOne(
          { "tekmetric.shopId": tekmetricShopId },
          { projection: { shopId: 1 } }
        );
        
        if (shop) {
          const cachedWO = await db.collection("tekmetric_work_orders").findOne(
            { workOrderId: String(roId) },
            { projection: { vin: 1, odometer: 1 } }
          );
          
          const vin = cachedWO?.vin;
          
          if (vin) {
            if (isTerminal || isInvoicePosted) {
              await invalidateCachedPlan(db, vin, Number(shop.shopId));
              console.log(`[Tekmetric Webhook] Invalidated plan cache for VIN ${vin} (shop ${shop.shopId})`);

              const authorizedJobs = extractAuthorizedJobsFromTekmetricRo(repairOrder);
              triggerVhiOnWorkOrderClose(db, {
                vin,
                shopId: Number(shop.shopId),
                provider: "tekmetric",
                roNumber: String(roNumber),
                mileage: cachedWO?.odometer || repairOrder.milesIn || repairOrder.milesOut || null,
                authorizedJobs,
                source: "webhook",
              }).catch((err: any) =>
                console.error(`[Tekmetric Webhook] VHI auto-rebuild failed for VIN ${vin}:`, err.message)
              );
            }
          }
        }
      } catch (err: any) {
        console.error(`[Tekmetric Webhook] VHI trigger failed for RO #${roNumber}:`, err.message);
      }
    }
    
    if (isInspectionComplete) {
      const repairOrderId = data.repairOrderId || data.repair_order_id || data.roId;
      const inspectionData = data;
      
      if (repairOrderId) {
        const result = await db.collection("tekmetric_work_orders").updateMany(
          { workOrderId: String(repairOrderId) },
          { 
            $set: { 
              dviDone: true,
              dviCompletedAt: new Date(),
              lastInspection: inspectionData
            },
            $push: { 
              inspections: {
                ...inspectionData,
                receivedAt: new Date()
              } 
            }
          }
        );
        console.log(`[Tekmetric Webhook] Marked RO ${repairOrderId} as DVI complete. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);
        
        // Invalidate plan cache since DVI results affect recommendations
        try {
          const woForDvi = await db.collection("tekmetric_work_orders").findOne(
            { workOrderId: String(repairOrderId) },
            { projection: { vin: 1, shopId: 1 } }
          );
          if (woForDvi?.vin && woForDvi?.shopId) {
            await invalidateCachedPlan(db, woForDvi.vin, Number(woForDvi.shopId));
            console.log(`[Tekmetric Webhook] Invalidated plan cache for DVI complete on VIN ${woForDvi.vin}`);
          }
        } catch (err: any) {
          console.error(`[Tekmetric Webhook] DVI plan cache invalidation failed:`, err.message);
        }
      }
    }
    
    if (isCustomerViewed) {
      const repairOrderId = data.repairOrderId || data.repair_order_id || data.roId;
      
      if (repairOrderId) {
        await db.collection("tekmetric_work_orders").updateOne(
          { workOrderId: String(repairOrderId) },
          { 
            $set: { 
              customerViewedDvi: true,
              customerViewedDviAt: new Date()
            }
          }
        );
        console.log(`[Tekmetric Webhook] Customer viewed DVI for RO ${repairOrderId}`);
      }
    }
    
    await db.collection("tekmetric_webhook_logs").insertOne({
      eventType,
      data,
      rawBody: body,
      receivedAt: new Date()
    });
    
    await db.collection("dashboard_updates").updateOne(
      { _id: "lastUpdate" } as any,
      { $set: { timestamp: Date.now() } },
      { upsert: true }
    );
    
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("[Tekmetric Webhook] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET() {
  const targets = (process.env.WEBHOOK_FORWARD_TARGETS || "").split(",").map(t => t.trim()).filter(Boolean);
  return NextResponse.json({ 
    status: "Tekmetric webhook endpoint active",
    events: [
      "InspectionComplete",
      "CustomerViewedInspection",
      "RepairOrder.Posted",
      "RepairOrder.Invoiced",
      "RepairOrder.Updated"
    ],
    forwardingTo: targets.length > 0 ? targets : "none",
    webhookUrl: process.env.REPLIT_DEV_DOMAIN 
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/api/webhooks/tekmetric`
      : "/api/webhooks/tekmetric"
  });
}
