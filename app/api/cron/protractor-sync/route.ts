import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import {
  resolveProtractorConfig,
  fetchActiveWorkOrders,
  fetchWorkOrderById,
  fetchVehicleById,
  upsertProtractorWorkOrderSnapshot,
  upsertProtractorVehicleSnapshot,
} from "@/lib/integrations/protractor";
import { NormalizedIngestionService } from "@/lib/normalized-ingestion";
import pLimit from "p-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(req: NextRequest) {
  if (process.env.DISABLE_PROTRACTOR_SYNC === "true") {
    return NextResponse.json({ 
      ok: true, 
      message: "Protractor sync disabled via DISABLE_PROTRACTOR_SYNC environment variable",
      disabled: true 
    });
  }

  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();

  try {
    const shops = await sql`
      SELECT * FROM shops 
      WHERE (protractor->>'apiKey' IS NOT NULL AND protractor->>'apiKey' != '')
         OR (protractor_api_key IS NOT NULL AND protractor_api_key != '')
         OR (protractor->>'connectionId' IS NOT NULL AND protractor->>'connectionId' != '')
         OR (protractor_connection_id IS NOT NULL AND protractor_connection_id != '')
    `;

    const results: { shopId: number; synced: number; removed: number; vehiclesUpdated?: number; error?: string }[] = [];
    const syncedVinsPerShop: { shopId: number; vins: string[] }[] = [];

    for (const shop of shops as any[]) {
      const shopId = Number(shop.shop_id);
      const config = await resolveProtractorConfig(shopId);
      
      if (!config.configured) continue;

      try {
        const activeResult = await fetchActiveWorkOrders(shopId, { readInProgress: true });
        
        if (!activeResult.ok || !activeResult.workOrders) {
          results.push({ shopId, synced: 0, removed: 0, error: activeResult.error });
          continue;
        }

        const activeWOs = activeResult.workOrders;
        const activeGuids = new Set(activeWOs.map(wo => wo.ID));
        const INVOICED_STAGES = ["Invoiced", "Invoice", "Void", "Closed", "Complete", "Completed"];
        
        const stageCounts: Record<string, number> = {};
        for (const wo of activeWOs) {
          const stage = wo.WorkflowStage || (wo as any).Status || "Unknown";
          stageCounts[stage] = (stageCounts[stage] || 0) + 1;
        }
        console.log(`[Cron] Shop ${shopId} - WorkflowStage counts:`, stageCounts);

        let vehiclesUpdated = 0;
        const shopSyncedVins: string[] = [];
        const limit = pLimit(3);

        const detailedWOs = await Promise.all(
          activeWOs.map((wo) =>
            limit(async () => {
              try {
                const detailResult = await fetchWorkOrderById(shopId, wo.ID);
                if (detailResult.ok && detailResult.workOrder) {
                  return detailResult.workOrder;
                }
              } catch (err) {
                console.log(`[Cron] Failed to fetch WO ${wo.ID} details`);
              }
              return wo;
            })
          )
        );

        for (const wo of detailedWOs) {
          const stage = wo.WorkflowStage || (wo as any).Status || "";
          let vin = wo.ServiceItem?.VIN?.toUpperCase() || (wo as any).VIN?.toUpperCase();
          let vehicle = wo.ServiceItem;
          
          if (!vin && wo.ServiceItemID) {
            try {
              const vehicleResult = await fetchVehicleById(shopId, wo.ServiceItemID);
              if (vehicleResult.ok && vehicleResult.vehicle?.VIN) {
                vin = vehicleResult.vehicle.VIN.toUpperCase();
                vehicle = vehicleResult.vehicle;
                console.log(`[Cron] Shop ${shopId} - Recovered VIN ${vin} for WO ${wo.WorkOrderNumber} via ServiceItemID fallback`);
              }
            } catch (err) {
              console.log(`[Cron] Shop ${shopId} - Failed to fetch vehicle for WO ${wo.WorkOrderNumber}:`, err);
            }
          }
          
          if (vin) {
            await upsertProtractorWorkOrderSnapshot(shopId, wo);
            
            if (vehicle) {
              await upsertProtractorVehicleSnapshot(shopId, vin, vehicle);
              
              const currentOdometer = (wo as any).InUsage ?? vehicle.Usage ?? (wo as any).Odometer ?? vehicle.Odometer;
              
              const workOrderSource = {
                provider: "protractor",
                workOrderId: String(wo.ID),
                workOrderNumber: wo.WorkOrderNumber,
                status: stage || "Open",
                addedAt: new Date().toISOString(),
              };

              const existingVehicleRows = await sql`
                SELECT * FROM vehicles WHERE shop_id = ${String(shopId)} AND vin = ${vin}
              `;
              const existingVehicle = existingVehicleRows[0] as any;

              if (existingVehicle) {
                const existingSources = existingVehicle.status?.sources || [];
                const sourceIndex = existingSources.findIndex(
                  (s: any) => s.provider === "protractor" && String(s.workOrderId) === String(wo.ID)
                );
                
                let updatedSources;
                if (sourceIndex >= 0) {
                  updatedSources = [...existingSources];
                  updatedSources[sourceIndex] = workOrderSource;
                } else {
                  updatedSources = [...existingSources, workOrderSource];
                }

                const statusData = {
                  active: true,
                  sources: updatedSources,
                  updatedAt: new Date().toISOString(),
                };

                await sql`
                  UPDATE vehicles SET
                    year = COALESCE(${vehicle.Year ?? null}, year),
                    make = COALESCE(${vehicle.Make ?? null}, make),
                    model = COALESCE(${vehicle.Model ?? null}, model),
                    license_plate = COALESCE(${vehicle.LicensePlate ?? null}, license_plate),
                    last_mileage = COALESCE(${currentOdometer ?? null}, last_mileage),
                    protractor_id = COALESCE(${vehicle.ID ?? null}, protractor_id),
                    status = ${JSON.stringify(statusData)}::jsonb,
                    updated_at = NOW()
                  WHERE id = ${existingVehicle.id}
                `;
              } else {
                const statusData = {
                  active: true,
                  sources: [workOrderSource],
                  updatedAt: new Date().toISOString(),
                };

                await sql`
                  INSERT INTO vehicles (
                    shop_id, vin, year, make, model, license_plate, last_mileage, protractor_id, status,
                    created_at, updated_at
                  ) VALUES (
                    ${String(shopId)}, ${vin}, ${vehicle.Year ?? null}, ${vehicle.Make ?? null}, ${vehicle.Model ?? null},
                    ${vehicle.LicensePlate ?? null}, ${currentOdometer ?? null}, ${vehicle.ID ?? null},
                    ${JSON.stringify(statusData)}::jsonb, NOW(), NOW()
                  )
                `;
              }
              vehiclesUpdated++;
              shopSyncedVins.push(vin);
            }
            
            if (INVOICED_STAGES.some(s => stage.toLowerCase().includes(s.toLowerCase()))) {
              await sql`
                UPDATE protractor_work_orders SET
                  workflow_stage = 'Invoiced',
                  status = 'Invoiced',
                  closed_at = NOW(),
                  updated_at = NOW()
                WHERE shop_id = ${String(shopId)} AND (work_order_guid = ${wo.ID} OR data->>'ID' = ${wo.ID})
              `;
            }
          }
        }

        const cachedWOs = await sql`
          SELECT * FROM protractor_work_orders
          WHERE shop_id = ${String(shopId)}
            AND (workflow_stage IS NULL OR workflow_stage = '' OR workflow_stage NOT IN ('Invoiced', 'Invoice', 'Void', 'Closed', 'Complete', 'Completed'))
        `;

        let removedCount = 0;
        for (const cached of cachedWOs as any[]) {
          const guid = cached.work_order_guid || cached.work_order_id || cached.data?.ID;
          if (guid && !activeGuids.has(guid)) {
            await sql`
              UPDATE protractor_work_orders SET
                workflow_stage = 'Invoiced',
                status = 'Invoiced',
                closed_at = NOW(),
                updated_at = NOW()
              WHERE id = ${cached.id}
            `;
            removedCount++;
          }
        }

        results.push({ shopId, synced: detailedWOs.length, removed: removedCount, vehiclesUpdated });
        
        if (shopSyncedVins.length > 0) {
          syncedVinsPerShop.push({ shopId, vins: shopSyncedVins });
        }
        
        try {
          const workOrdersForNormalized = detailedWOs.filter(wo => wo.ServiceItem?.VIN);
          
          if (workOrdersForNormalized.length > 0) {
            const shopData = await sql`SELECT enterprise_id FROM shops WHERE shop_id = ${String(shopId)}`;
            const enterpriseId = (shopData[0] as any)?.enterprise_id as string | undefined;
            
            const { getDb } = await import("@/lib/mongo");
            const db = await getDb();
            const ingestionService = new NormalizedIngestionService(
              db,
              'protractor',
              shopId,
              enterpriseId,
              { dualWriteToJobIndex: false, dualWriteToRepairPatterns: true }
            );
            
            const result = await ingestionService.ingestWorkOrderBatchWithAllEntities(workOrdersForNormalized);
            console.log(`[Cron] Protractor sync normalized: shop ${shopId}, WOs: ${result.workOrders.created}/${result.workOrders.updated}/${result.workOrders.skipped}, payments: ${result.payments.created}, inspections: ${result.inspections.created}, recommendations: ${result.recommendations.created}`);
          }
        } catch (normErr: any) {
          console.log(`[Cron] Protractor sync normalized ingestion error for shop ${shopId}:`, normErr.message);
        }
      } catch (err: any) {
        results.push({ shopId, synced: 0, removed: 0, error: err.message });
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[Cron] Protractor sync completed in ${duration}ms:`, results);

    console.log(`[Cron] Starting Protractor pregeneration, CRON_SECRET set: ${!!CRON_SECRET}`);
    if (CRON_SECRET) {
      try {
        const baseUrl = process.env.RENDER_EXTERNAL_URL 
          || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null)
          || `http://localhost:${process.env.PORT || 5000}`;
        
        console.log(`[Cron] Protractor pregeneration baseUrl: ${baseUrl}`);
        
        const protractorShops = await sql`
          SELECT shop_id, protractor, protractor_api_key, protractor_connection_id FROM shops
          WHERE (protractor->>'apiKey' IS NOT NULL AND protractor->>'apiKey' != '')
             OR (protractor_api_key IS NOT NULL AND protractor_api_key != '')
             OR (protractor->>'connectionId' IS NOT NULL AND protractor->>'connectionId' != '')
             OR (protractor_connection_id IS NOT NULL AND protractor_connection_id != '')
        `;
        
        console.log(`[Cron] Found ${protractorShops.length} Protractor shops for pregeneration`);
        
        const INTERNAL_SECRET = process.env.INTERNAL_WORKER_SECRET || "mos-prefetch-worker-2024";
        
        let triggeredCount = 0;
        for (const shop of protractorShops as any[]) {
          const shopId = shop.shop_id;
          if (!shopId) continue;
          
          try {
            const vehiclesRes = await fetch(`${baseUrl}/api/internal/prefetch-vehicles?shopId=${shopId}&limit=50`, {
              headers: { 'x-internal-secret': INTERNAL_SECRET }
            });
            
            if (!vehiclesRes.ok) {
              console.log(`[Cron] Protractor Shop ${shopId}: Failed to fetch vehicles (${vehiclesRes.status})`);
              continue;
            }
            
            const { rows } = await vehiclesRes.json();
            const vins = (rows || [])
              .map((v: any) => v.vin)
              .filter((v: string) => v && v.length === 17);
            
            console.log(`[Cron] Protractor Shop ${shopId}: ${vins.length} VINs for pregeneration`);
            
            if (vins.length > 0) {
              triggeredCount++;
              fetch(`${baseUrl}/api/internal/plan-pregenerate`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${CRON_SECRET}`,
                },
                body: JSON.stringify({ shopId, vins }),
              }).catch(err => console.log(`[Cron] Plan pregenerate failed for shop ${shopId}:`, err.message));
            }
          } catch (shopErr: any) {
            console.log(`[Cron] Protractor Shop ${shopId} pregenerate error:`, shopErr.message);
          }
        }
        console.log(`[Cron] Triggered plan pre-generation for ${triggeredCount}/${protractorShops.length} Protractor shops with vehicles`);
      } catch (pregenerateErr: any) {
        console.error(`[Cron] Protractor pregenerate error:`, pregenerateErr.message);
      }
    }

    return NextResponse.json({
      ok: true,
      duration: `${duration}ms`,
      shops: results
    });
  } catch (err: any) {
    console.error("[Cron] Protractor sync error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
