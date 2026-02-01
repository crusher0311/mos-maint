import { NextRequest, NextResponse } from "next/server";
import pLimit from "p-limit";
import { sql } from "@/lib/db/postgres";
import { fetchWorkOrderById } from "@/lib/integrations/protractor";
import { getTekmetricWorkOrderWithMileage } from "@/lib/tekmetric";

const BATCH_SIZE = 3;
const BATCH_DELAY_MS = 3000;
const MAX_VEHICLES_PER_REQUEST = 20;

const recentlyCheckedOrders = new Map<string, { checkedAt: number; isClosed: boolean }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCachedResult(workOrderId: string): { isClosed: boolean } | null {
  const cached = recentlyCheckedOrders.get(workOrderId);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return { isClosed: cached.isClosed };
  }
  return null;
}

function setCachedResult(workOrderId: string, isClosed: boolean) {
  recentlyCheckedOrders.set(workOrderId, { checkedAt: Date.now(), isClosed });
  if (recentlyCheckedOrders.size > 500) {
    const now = Date.now();
    for (const [key, value] of recentlyCheckedOrders) {
      if (now - value.checkedAt > CACHE_TTL_MS) {
        recentlyCheckedOrders.delete(key);
      }
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    let shopId: string | number | undefined;
    
    try {
      const body = await request.json();
      shopId = body?.shopId;
    } catch {
      return NextResponse.json({ error: "Invalid or empty request body" }, { status: 400 });
    }
    
    if (!shopId) {
      return NextResponse.json({ error: "shopId required" }, { status: 400 });
    }

    const shopRows = await sql`
      SELECT id, tekmetric_config FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
    `;
    
    if (shopRows.length === 0) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }
    
    const shop = shopRows[0];
    const tekmetricConfig = shop.tekmetric_config as any;

    const vehicleRows = await sql`
      SELECT id, vin, mileage, odometer, last_mileage, status 
      FROM vehicles 
      WHERE shop_id = ${String(shopId)} 
        AND (status->>'active')::boolean = true 
        AND jsonb_array_length(COALESCE(status->'sources', '[]'::jsonb)) > 0
      LIMIT ${MAX_VEHICLES_PER_REQUEST}
    `;

    if (vehicleRows.length === 0) {
      return NextResponse.json({ checked: 0, closed: 0, mileageUpdated: 0 });
    }

    let checkedCount = 0;
    let closedCount = 0;
    let mileageUpdatedCount = 0;
    const closedOrders: { vin: string; workOrderId: string; provider: string; mileage?: number }[] = [];

    const workOrderChecks: Array<{
      vehicle: any;
      source: any;
      currentMileage: number;
    }> = [];

    for (const vehicle of vehicleRows) {
      const status = vehicle.status as any;
      const sources = status?.sources || [];
      const currentMileage = vehicle.mileage || vehicle.odometer || vehicle.last_mileage || 0;
      
      for (const source of sources) {
        workOrderChecks.push({ vehicle, source, currentMileage });
      }
    }

    const limit = pLimit(BATCH_SIZE);
    
    for (let i = 0; i < workOrderChecks.length; i += BATCH_SIZE) {
      const batch = workOrderChecks.slice(i, i + BATCH_SIZE);
      
      const batchResults = await Promise.all(
        batch.map(({ vehicle, source, currentMileage }) =>
          limit(async () => {
            checkedCount++;
            let isClosed = false;
            let workOrderMileage: number | undefined;

            if (source.provider === "protractor") {
              try {
                const result = await fetchWorkOrderById(shopId!, String(source.workOrderId));
                if (result.ok && result.workOrder) {
                  const wo = result.workOrder;
                  const status = (wo.Status || wo.WorkflowStage || "").toUpperCase();
                  isClosed = status === "INVOICED" || status === "INVOICE" || 
                             status === "CLOSED" || status === "VOID";
                  workOrderMileage = wo.Odometer || wo.InUsage || wo.OutUsage ||
                                     (wo as any).ServiceItems?.[0]?.Odometer ||
                                     (wo as any).ServiceItem?.Odometer;
                }
              } catch (err) {
                console.error(`Error checking Protractor WO ${source.workOrderId}:`, err);
              }
            } else if (source.provider === "tekmetric" && tekmetricConfig?.shopId) {
              try {
                const woData = await getTekmetricWorkOrderWithMileage(source.workOrderId);
                if (woData) {
                  const normalizedStatus = woData.status?.toUpperCase();
                  isClosed = normalizedStatus === "INVOICED" || normalizedStatus === "INVOICE" || 
                             normalizedStatus === "VOID" || normalizedStatus === "CLOSED";
                  workOrderMileage = woData.mileageOut ?? woData.mileageIn ?? undefined;
                }
              } catch (err) {
                console.error(`Error checking Tekmetric RO ${source.workOrderId}:`, err);
              }
            }

            return { vehicle, source, currentMileage, isClosed, workOrderMileage };
          })
        )
      );

      for (const result of batchResults) {
        const { vehicle, source, currentMileage, isClosed, workOrderMileage } = result;

        if (workOrderMileage && workOrderMileage > 0 && workOrderMileage > currentMileage) {
          await sql`
            UPDATE vehicles SET 
              mileage = ${workOrderMileage},
              mileage_source = ${source.provider},
              mileage_updated_at = NOW(),
              updated_at = NOW()
            WHERE id = ${vehicle.id}
          `;
          mileageUpdatedCount++;
        }

        if (isClosed) {
          closedOrders.push({
            vin: vehicle.vin,
            workOrderId: String(source.workOrderId),
            provider: source.provider,
            mileage: workOrderMileage
          });
          
          if (source.provider === "protractor") {
            await sql`
              UPDATE protractor_work_orders SET
                workflow_stage = 'Invoiced',
                status = 'Invoiced',
                closed_at = NOW(),
                updated_at = NOW()
              WHERE shop_id = ${String(shopId)} 
                AND (work_order_guid = ${source.workOrderId} OR data->>'ID' = ${source.workOrderId})
            `;
          }
        }
      }

      if (i + BATCH_SIZE < workOrderChecks.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    for (const order of closedOrders) {
      const vehicleRows = await sql`
        SELECT id, status FROM vehicles 
        WHERE shop_id = ${String(shopId)} AND vin = ${order.vin}
        LIMIT 1
      `;

      if (vehicleRows.length > 0) {
        const vehicle = vehicleRows[0];
        const status = vehicle.status as any || {};
        const existingSources = status.sources || [];
        const updatedSources = existingSources.filter(
          (s: any) => !(s.provider === order.provider && String(s.workOrderId) === order.workOrderId)
        );

        const hasActiveSources = updatedSources.length > 0;

        const newStatus = {
          ...status,
          active: hasActiveSources,
          sources: updatedSources,
          ...(hasActiveSources ? {} : { lastClosedAt: new Date().toISOString() }),
        };

        await sql`
          UPDATE vehicles SET 
            status = ${JSON.stringify(newStatus)}::jsonb,
            updated_at = NOW()
          WHERE id = ${vehicle.id}
        `;

        if (!hasActiveSources) {
          closedCount++;
        }
      }
    }

    return NextResponse.json({
      checked: checkedCount,
      closed: closedCount,
      mileageUpdated: mileageUpdatedCount,
      closedOrders: closedOrders.map(o => `${o.vin} (${o.provider} #${o.workOrderId})`)
    });

  } catch (error: any) {
    console.error("Check closed orders error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
