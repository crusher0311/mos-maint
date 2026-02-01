import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import { 
  getRepairOrders, 
  getVehicle, 
  getCustomer,
  getRepairOrderInspections,
  TekmetricRepairOrderFull,
  TekmetricVehicle,
  TekmetricCustomer
} from "@/lib/tekmetric";
import { 
  indexTekmetricWorkOrderJobs, 
  checkAndRunBackfillForNewShops 
} from "@/lib/tekmetric-job-index";
import { NormalizedIngestionServicePg } from "@/lib/normalized-ingestion-pg";
import { upsertTekmetricWorkOrderToPostgres } from "@/lib/postgres-ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET;

function isSyncDisabled() {
  return process.env.DISABLE_TEKMETRIC_SYNC === "true";
}

const ACTIVE_STATUS_IDS = [1, 2, 3, 4];
const TERMINAL_STATUSES = ["Invoice", "Invoiced", "Posted", "Deleted", "Void"];

interface TekmetricWorkOrderSnapshot {
  shopId: number | string;
  workOrderId: string;
  workOrderNumber: number;
  vin: string;
  status: string;
  statusCode?: string;
  label?: string;
  labelColor?: string;
  customerId: number;
  vehicleId: number;
  customerName?: string;
  vehicleYear?: number;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleEngine?: string;
  odometer?: number;
  createdDate?: string;
  updatedDate?: string;
  completedDate?: string;
  fetchedAt: Date;
  data?: TekmetricRepairOrderFull;
  dviDone?: boolean;
  inspections?: any[];
}

async function upsertTekmetricWorkOrderSnapshot(
  shopId: number,
  ro: TekmetricRepairOrderFull,
  vehicle: TekmetricVehicle,
  customer?: TekmetricCustomer,
  inspections?: any[]
) {
  const vin = vehicle.vin?.toUpperCase();
  if (!vin) return;

  const statusName = ro.repairOrderStatus?.name || ro.repairOrderStatus?.code || "Open";
  const statusCode = ro.repairOrderStatus?.code || "";
  const label = ro.repairOrderCustomLabel?.name || ro.repairOrderLabel?.name || "";
  const customerName = customer ? `${customer.firstName || ""} ${customer.lastName || ""}`.trim() : null;
  const odometer = ro.milesIn || ro.milesOut || vehicle.mileageIn || vehicle.mileageOut;
  const dviDone = inspections && inspections.length > 0;
  
  const existingRows = await sql`
    SELECT dvi_done, inspections FROM tekmetric_work_orders 
    WHERE shop_id = ${String(shopId)} AND work_order_id = ${String(ro.id)}
  `;
  const existing = existingRows[0] as any;
  
  const finalDviDone = existing?.dvi_done || dviDone;
  const finalInspections = existing?.inspections || inspections || [];
  
  await sql`
    INSERT INTO tekmetric_work_orders (
      shop_id, work_order_id, work_order_number, vin, status, status_code,
      label, label_color, customer_id, vehicle_id, customer_name,
      vehicle_year, vehicle_make, vehicle_model, vehicle_engine, odometer,
      created_date, updated_date, completed_date, fetched_at, data, dvi_done, inspections,
      created_at, updated_at
    ) VALUES (
      ${String(shopId)}, ${String(ro.id)}, ${ro.repairOrderNumber}, ${vin}, ${statusName}, ${statusCode},
      ${label}, ${ro.color || ""}, ${ro.customerId}, ${ro.vehicleId}, ${customerName},
      ${vehicle.year ?? null}, ${vehicle.make ?? null}, ${vehicle.model ?? null}, ${vehicle.engine ?? null}, ${odometer ?? null},
      ${ro.createdDate ?? null}, ${ro.updatedDate ?? null}, ${ro.completedDate ?? null}, NOW(), ${JSON.stringify(ro)}::jsonb, ${finalDviDone ?? false}, ${JSON.stringify(finalInspections)}::jsonb,
      NOW(), NOW()
    )
    ON CONFLICT (work_order_id) DO UPDATE SET
      shop_id = EXCLUDED.shop_id,
      work_order_number = EXCLUDED.work_order_number,
      vin = EXCLUDED.vin,
      status = EXCLUDED.status,
      status_code = EXCLUDED.status_code,
      label = EXCLUDED.label,
      label_color = EXCLUDED.label_color,
      customer_id = EXCLUDED.customer_id,
      vehicle_id = EXCLUDED.vehicle_id,
      customer_name = EXCLUDED.customer_name,
      vehicle_year = EXCLUDED.vehicle_year,
      vehicle_make = EXCLUDED.vehicle_make,
      vehicle_model = EXCLUDED.vehicle_model,
      vehicle_engine = EXCLUDED.vehicle_engine,
      odometer = EXCLUDED.odometer,
      created_date = EXCLUDED.created_date,
      updated_date = EXCLUDED.updated_date,
      completed_date = EXCLUDED.completed_date,
      fetched_at = NOW(),
      data = EXCLUDED.data,
      dvi_done = COALESCE(tekmetric_work_orders.dvi_done, EXCLUDED.dvi_done),
      updated_at = NOW()
  `;
  
  await upsertTekmetricWorkOrderToPostgres(shopId, String(ro.id), {
    workOrderNumber: ro.repairOrderNumber,
    vin,
    status: statusName,
    statusCode,
    label,
    labelColor: ro.color || "",
    customerId: ro.customerId,
    vehicleId: ro.vehicleId,
    customerName: customerName || undefined,
    vehicleYear: vehicle.year,
    vehicleMake: vehicle.make,
    vehicleModel: vehicle.model,
    mileageIn: ro.milesIn,
    mileageOut: ro.milesOut,
    createdDate: ro.createdDate,
    closedDate: ro.completedDate,
    rawData: ro
  });
}

export async function GET(req: NextRequest) {
  if (isSyncDisabled()) {
    return NextResponse.json({
      ok: true,
      message: "Tekmetric sync disabled via DISABLE_TEKMETRIC_SYNC environment variable",
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
      WHERE tekmetric->>'shopId' IS NOT NULL 
         OR tekmetric_shop_id IS NOT NULL
    `;

    const results: { shopId: number; tekmetricShopId: number; synced: number; removed: number; jobsIndexed?: number; error?: string }[] = [];
    const syncedVinsPerShop: { shopId: number; vins: string[] }[] = [];
    
    await checkAndRunBackfillForNewShops();

    for (const shop of shops as any[]) {
      const shopId = Number(shop.shop_id);
      const tekmetricShopId = shop.tekmetric?.shopId || shop.tekmetric_shop_id;
      
      if (!tekmetricShopId) continue;

      try {
        const activeWOs: TekmetricRepairOrderFull[] = [];
        const vehicleCache = new Map<number, TekmetricVehicle>();
        const customerCache = new Map<number, TekmetricCustomer>();
        const shopSyncedVins: string[] = [];
        
        let page = 0;
        let hasMore = true;
        
        while (hasMore) {
          const response = await getRepairOrders(tekmetricShopId, {
            repairOrderStatusId: ACTIVE_STATUS_IDS,
            page,
            size: 100,
            sortDirection: 'DESC'
          });
          
          console.log(`[Tekmetric] Shop ${shopId}: Fetched page ${page}, got ${response.content.length} ROs`);
          activeWOs.push(...response.content);
          
          hasMore = !response.last;
          page++;
          
          if (page > 10) break;
        }

        const statusCounts: Record<string, number> = {};
        for (const ro of activeWOs) {
          const status = ro.repairOrderStatus?.name || ro.repairOrderStatus?.code || "Unknown";
          statusCounts[status] = (statusCounts[status] || 0) + 1;
        }
        console.log(`[Tekmetric] Shop ${shopId} - Status counts:`, statusCounts);

        let dviCount = 0;
        for (const ro of activeWOs) {
          if (!vehicleCache.has(ro.vehicleId)) {
            try {
              const vehicle = await getVehicle(ro.vehicleId);
              vehicleCache.set(ro.vehicleId, vehicle);
            } catch (err) {
              console.log(`[Tekmetric] Failed to fetch vehicle ${ro.vehicleId}`);
              continue;
            }
          }
          
          if (!customerCache.has(ro.customerId)) {
            try {
              const customer = await getCustomer(ro.customerId);
              customerCache.set(ro.customerId, customer);
            } catch (err) {
            }
          }
          
          const vehicle = vehicleCache.get(ro.vehicleId);
          const customer = customerCache.get(ro.customerId);
          
          if (vehicle?.vin) {
            await upsertTekmetricWorkOrderSnapshot(shopId, ro, vehicle, customer, []);
            shopSyncedVins.push(vehicle.vin.toUpperCase());
          }
        }

        const activeWoIds = activeWOs.map(wo => String(wo.id));
        
        const cachedWOs = await sql`
          SELECT * FROM tekmetric_work_orders 
          WHERE shop_id = ${String(shopId)} AND status NOT IN ('Invoice', 'Invoiced', 'Posted', 'Deleted', 'Void')
        `;

        let removedCount = 0;
        let indexedJobsCount = 0;
        for (const cached of cachedWOs as any[]) {
          if (!activeWoIds.includes(cached.work_order_id)) {
            await sql`
              UPDATE tekmetric_work_orders SET
                status = 'Invoiced',
                closed_at = NOW(),
                updated_at = NOW()
              WHERE id = ${cached.id}
            `;
            removedCount++;
            
            const retryCount = cached.job_index_retry_count || 0;
            if (cached.vin && !cached.jobs_indexed && retryCount < 3) {
              try {
                const jobsIndexed = await indexTekmetricWorkOrderJobs(
                  shopId,
                  tekmetricShopId,
                  Number(cached.work_order_id),
                  cached.work_order_number,
                  {
                    vin: cached.vin,
                    year: cached.vehicle_year,
                    make: cached.vehicle_make,
                    model: cached.vehicle_model,
                    engine: cached.vehicle_engine
                  },
                  cached.completed_date || new Date().toISOString()
                );
                
                if (jobsIndexed > 0) {
                  indexedJobsCount += jobsIndexed;
                  await sql`
                    UPDATE tekmetric_work_orders SET
                      jobs_indexed = TRUE,
                      job_index_retry_count = 0,
                      updated_at = NOW()
                    WHERE id = ${cached.id}
                  `;
                  console.log(`[Tekmetric] Indexed ${jobsIndexed} jobs for WO #${cached.work_order_number}`);
                } else {
                  await sql`
                    UPDATE tekmetric_work_orders SET jobs_indexed = TRUE, updated_at = NOW()
                    WHERE id = ${cached.id}
                  `;
                }
              } catch (err: any) {
                console.log(`[Tekmetric] Failed to index jobs for WO ${cached.work_order_id} (attempt ${retryCount + 1}): ${err.message}`);
                await sql`
                  UPDATE tekmetric_work_orders SET
                    job_index_retry_count = COALESCE(job_index_retry_count, 0) + 1,
                    job_index_last_error = ${err.message},
                    job_index_last_attempt = NOW(),
                    updated_at = NOW()
                  WHERE id = ${cached.id}
                `;
              }
            }
          }
        }

        await sql`
          UPDATE shops SET
            tekmetric = jsonb_set(COALESCE(tekmetric, '{}')::jsonb, '{lastSync}', ${JSON.stringify(new Date().toISOString())}::jsonb),
            updated_at = NOW()
          WHERE shop_id = ${String(shopId)}
        `;

        results.push({ 
          shopId, 
          tekmetricShopId, 
          synced: activeWOs.length, 
          removed: removedCount,
          jobsIndexed: indexedJobsCount
        });
        
        if (shopSyncedVins.length > 0) {
          const uniqueVins = [...new Set(shopSyncedVins)];
          syncedVinsPerShop.push({ shopId, vins: uniqueVins });
        }
        
        try {
          const workOrdersForNormalized = activeWOs
            .filter(ro => vehicleCache.has(ro.vehicleId) && vehicleCache.get(ro.vehicleId)?.vin)
            .map(ro => {
              const vehicle = vehicleCache.get(ro.vehicleId);
              const customer = customerCache.get(ro.customerId);
              return {
                ...ro,
                vehicle: vehicle,
                customer: customer,
              };
            });
          
          if (workOrdersForNormalized.length > 0) {
            const shopData = await sql`SELECT enterprise_id FROM shops WHERE shop_id = ${String(shopId)}`;
            const enterpriseId = (shopData[0] as any)?.enterprise_id as string | undefined;
            
            const ingestionService = new NormalizedIngestionServicePg(
              'tekmetric',
              shopId,
              enterpriseId,
              { dualWriteToJobIndex: false, dualWriteToRepairPatterns: true }
            );
            
            const result = await ingestionService.ingestWorkOrderBatchWithAllEntities(workOrdersForNormalized);
            console.log(`[Cron] Tekmetric sync normalized: shop ${shopId}, WOs: ${result.workOrders.created}/${result.workOrders.updated}/${result.workOrders.skipped}, payments: ${result.payments.created}, inspections: ${result.inspections.created}, recommendations: ${result.recommendations.created}`);
          }
        } catch (normErr: any) {
          console.log(`[Cron] Tekmetric sync normalized ingestion error for shop ${shopId}:`, normErr.message);
        }
      } catch (err: any) {
        console.error(`[Tekmetric] Shop ${shopId} sync error:`, err.message);
        results.push({ 
          shopId, 
          tekmetricShopId, 
          synced: 0, 
          removed: 0, 
          error: err.message 
        });
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[Cron] Tekmetric sync completed in ${duration}ms:`, results);

    if (CRON_SECRET) {
      try {
        const baseUrl = process.env.RENDER_EXTERNAL_URL 
          || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null)
          || `http://localhost:${process.env.PORT || 5000}`;
        
        const tekmetricShops = await sql`
          SELECT shop_id, tekmetric FROM shops
          WHERE tekmetric->>'shopId' IS NOT NULL
        `;
        
        console.log(`[Cron] Found ${tekmetricShops.length} Tekmetric shops for pregeneration`);
        
        const INTERNAL_SECRET = process.env.INTERNAL_WORKER_SECRET || "mos-prefetch-worker-2024";
        
        let triggeredCount = 0;
        for (const shop of tekmetricShops as any[]) {
          const internalShopId = shop.shop_id;
          const tekShopId = shop.tekmetric?.shopId;
          if (!internalShopId) continue;
          
          try {
            const vehiclesRes = await fetch(`${baseUrl}/api/internal/prefetch-vehicles?shopId=${internalShopId}&limit=50`, {
              headers: { 'x-internal-secret': INTERNAL_SECRET }
            });
            
            if (!vehiclesRes.ok) {
              console.log(`[Cron] Shop ${internalShopId}: Failed to fetch vehicles (${vehiclesRes.status})`);
              continue;
            }
            
            const { rows } = await vehiclesRes.json();
            const vins = (rows || [])
              .map((v: any) => v.vin)
              .filter((v: string) => v && v.length === 17);
            
            console.log(`[Cron] Shop ${internalShopId} (tek: ${tekShopId}): ${vins.length} VINs for pregeneration`);
            
            if (vins.length > 0) {
              triggeredCount++;
              fetch(`${baseUrl}/api/internal/plan-pregenerate`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${CRON_SECRET}`,
                },
                body: JSON.stringify({ shopId: internalShopId, vins }),
              }).catch(err => console.log(`[Cron] Plan pregenerate failed for shop ${internalShopId}:`, err.message));
            }
          } catch (shopErr: any) {
            console.log(`[Cron] Shop ${internalShopId} pregenerate error:`, shopErr.message);
          }
        }
        console.log(`[Cron] Triggered plan pre-generation for ${triggeredCount}/${tekmetricShops.length} Tekmetric shops with vehicles`);
      } catch (pregenerateErr: any) {
        console.error(`[Cron] Tekmetric pregenerate error:`, pregenerateErr.message);
      }
    }

    return NextResponse.json({
      ok: true,
      duration: `${duration}ms`,
      shops: results
    });
  } catch (err: any) {
    console.error("[Cron] Tekmetric sync error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
