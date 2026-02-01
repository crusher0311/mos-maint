import { NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import { getSession } from "@/lib/auth";
import {
  resolveProtractorConfig,
  fetchInvoicesForVehicle,
  fetchInvoiceById,
  upsertProtractorInvoiceSnapshot,
} from "@/lib/integrations/protractor";
import {
  extractJobIndexFromWorkOrder,
  upsertJobIndexEntries,
  updatePartCrossReferences,
} from "@/lib/job-index";
import pLimit from "p-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SMS_DISPLAY_NAMES: Record<string, string> = {
  tekmetric: "Tekmetric",
  protractor: "Protractor",
  autoflow: "AutoFlow",
  shopware: "Shop-Ware",
  shopmonkey: "Shop Monkey",
  "stand-alone": "Stand-alone",
};

async function buildTekmetricPartsHistory(shopId: number) {
  const results = {
    workOrdersProcessed: 0,
    jobsIndexed: 0,
    partsIndexed: 0,
    errors: [] as string[],
  };
  
  const existingJobs = await sql`
    SELECT * FROM job_index 
    WHERE shop_id = ${String(shopId)} AND metadata->>'sourceType' = 'tekmetric'
  `;
  
  if (existingJobs.length > 0) {
    console.log(`[Parts History] Found ${existingJobs.length} existing Tekmetric jobs in index`);
    
    const partsUpdated = await updatePartCrossReferences(existingJobs as any[]);
    results.workOrdersProcessed = existingJobs.length;
    results.jobsIndexed = existingJobs.length;
    results.partsIndexed = partsUpdated;
    
    return results;
  }
  
  const workOrders = await sql`
    SELECT * FROM tekmetric_work_orders 
    WHERE shop_id = ${String(shopId)} OR shop_id = ${shopId}::text
  `;
  
  console.log(`[Parts History] Building from ${workOrders.length} Tekmetric work orders...`);
  
  const allJobIndexEntries: any[] = [];
  
  if (workOrders.length > 0 && !(workOrders[0] as any).data?.jobs) {
    console.log(`[Parts History] Work orders don't have detailed job data. Need to run job backfill first.`);
  }
  
  for (const wo of workOrders) {
    try {
      results.workOrdersProcessed++;
      
      const rawData = (wo as any).data || wo;
      
      const vehicleData = {
        vin: (wo as any).vin,
        year: (wo as any).vehicle_year || rawData.vehicle?.year,
        make: (wo as any).vehicle_make || rawData.vehicle?.make,
        model: (wo as any).vehicle_model || rawData.vehicle?.model,
      };
      
      if (rawData.jobs && Array.isArray(rawData.jobs)) {
        for (const job of rawData.jobs) {
          const entry = {
            shopId,
            workOrderId: String((wo as any).work_order_id),
            workOrderNumber: (wo as any).work_order_number,
            servicePackageId: String(job.id),
            performedAt: (wo as any).completed_date ? new Date((wo as any).completed_date) : new Date((wo as any).created_date),
            vehicle: vehicleData,
            job: {
              title: job.name || job.description || "Unknown",
              description: job.description,
              keywords: [],
            },
            lines: (job.laborItems || []).concat(job.partItems || []).map((item: any) => ({
              lineType: item.partNumber ? "part" : "labor",
              description: item.description || item.name || "",
              partNumber: item.partNumber,
              manufacturer: item.brand,
              quantity: item.quantity || 1,
              unitPrice: item.unitPrice || item.price || 0,
              extendedPrice: item.totalPrice || item.amount || 0,
            })),
            totals: {
              laborHours: job.laborHours || 0,
              laborAmount: job.laborTotal || 0,
              partsAmount: job.partsTotal || 0,
              totalAmount: job.total || 0,
            },
            metadata: {
              indexedAt: new Date(),
              sourceType: "tekmetric" as const,
            },
          };
          allJobIndexEntries.push(entry);
        }
      }
    } catch (err: any) {
      console.log(`[Parts History] Error for WO ${(wo as any).work_order_id}: ${err.message}`);
      results.errors.push(`WO ${(wo as any).work_order_id}: ${err.message}`);
    }
  }
  
  if (allJobIndexEntries.length > 0) {
    try {
      console.log(`[Parts History] Indexing ${allJobIndexEntries.length} jobs...`);
      const indexResult = await upsertJobIndexEntries(allJobIndexEntries);
      results.jobsIndexed = indexResult.inserted + indexResult.updated;
      
      const partsUpdated = await updatePartCrossReferences(allJobIndexEntries);
      results.partsIndexed = partsUpdated;
      console.log(`[Parts History] Parts indexed: ${partsUpdated}`);
    } catch (indexErr: any) {
      console.log(`[Parts History] Indexing error: ${indexErr.message}`);
      results.errors.push(`Indexing: ${indexErr.message}`);
    }
  } else {
    console.log(`[Parts History] No job entries found. Work orders may need job backfill.`);
  }
  
  return results;
}

export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  console.log(`[Parts History] Session shopId: ${session.shopId}, parsed: ${shopId}`);
  
  const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${String(shopId)}`;
  const shop = shopRows[0] as any;
  
  const hasTekmetric = shop?.tekmetric_shop_id || shop?.tekmetric?.shopId;
  const hasProtractor = shop?.protractor_configured || shop?.protractor?.configured;
  
  let smsIntegration = "stand-alone";
  if (hasTekmetric) {
    smsIntegration = "tekmetric";
  } else if (hasProtractor) {
    smsIntegration = "protractor";
  }
  
  const smsDisplayName = SMS_DISPLAY_NAMES[smsIntegration] || smsIntegration;
  
  if (smsIntegration === "tekmetric") {
    const results = await buildTekmetricPartsHistory(shopId);
    
    if (results.workOrdersProcessed === 0) {
      return NextResponse.json(
        { error: "No Tekmetric work orders found. Please sync your shop data first." },
        { status: 400 }
      );
    }
    
    return NextResponse.json({
      ok: true,
      message: `Built parts history from ${results.workOrdersProcessed} work orders`,
      invoicesFetched: results.workOrdersProcessed,
      ...results,
    });
  }
  
  if (smsIntegration !== "protractor") {
    return NextResponse.json(
      { error: `Parts history builder is coming soon for ${smsDisplayName}. Currently available for Tekmetric and Protractor shops.` },
      { status: 400 }
    );
  }
  
  const config = await resolveProtractorConfig(shopId);
  
  if (!config.configured) {
    return NextResponse.json(
      { error: "Protractor is not configured for this shop. Please set up your Protractor integration first." },
      { status: 400 }
    );
  }

  const endDate = new Date();
  const fiveYearsAgo = new Date();
  fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
  
  const results = {
    vehiclesProcessed: 0,
    invoicesFetched: 0,
    jobsIndexed: 0,
    partsIndexed: 0,
    errors: [] as string[],
  };
  
  const allJobIndexEntries: any[] = [];
  
  const vehicles = await sql`SELECT * FROM protractor_vehicles WHERE shop_id = ${String(shopId)}`;
  console.log(`[Parts History] Building parts database from ${vehicles.length} vehicles...`);
  
  const vehicleLimit = pLimit(2);
  
  await Promise.all(
    vehicles.map((vehicle: any) =>
      vehicleLimit(async () => {
        if (!vehicle.protractor_id) return;
        
        try {
          results.vehiclesProcessed++;
          
          const invoicesResult = await fetchInvoicesForVehicle(shopId, vehicle.protractor_id, {
            startDate: fiveYearsAgo.toISOString().split("T")[0],
            endDate: endDate.toISOString().split("T")[0],
          });
          
          if (!invoicesResult.ok || !invoicesResult.invoices?.length) {
            return;
          }
          
          console.log(`[Parts History] ${vehicle.vin}: ${invoicesResult.invoices.length} invoices`);
          
          const invoiceLimit = pLimit(2);
          const detailedInvoices = await Promise.all(
            invoicesResult.invoices.map((inv) =>
              invoiceLimit(async () => {
                const detailResult = await fetchInvoiceById(shopId, inv.ID);
                if (detailResult.ok && detailResult.invoice) {
                  return detailResult.invoice;
                }
                return inv;
              })
            )
          );
          
          for (const invoice of detailedInvoices) {
            await upsertProtractorInvoiceSnapshot(shopId, invoice);
            results.invoicesFetched++;
            
            try {
              const invoiceAsWorkOrder = {
                ...invoice,
                ServiceItem: { 
                  ...invoice.ServiceItem,
                  VIN: vehicle.vin,
                  Year: vehicle.year,
                  Make: vehicle.make,
                  Model: vehicle.model,
                },
              };
              const jobEntries = extractJobIndexFromWorkOrder(shopId, invoiceAsWorkOrder, "protractor");
              if (jobEntries.length > 0) {
                allJobIndexEntries.push(...jobEntries);
              }
            } catch (indexErr: any) {
              console.log(`[Parts History] Job index error for invoice ${invoice.ID}: ${indexErr.message}`);
            }
          }
        } catch (err: any) {
          console.log(`[Parts History] Error for ${vehicle.vin}: ${err.message}`);
          results.errors.push(`${vehicle.vin}: ${err.message}`);
        }
      })
    )
  );
  
  if (allJobIndexEntries.length > 0) {
    try {
      console.log(`[Parts History] Indexing ${allJobIndexEntries.length} jobs...`);
      const indexResult = await upsertJobIndexEntries(allJobIndexEntries);
      results.jobsIndexed = indexResult.inserted + indexResult.updated;
      console.log(`[Parts History] Job index: ${indexResult.inserted} inserted, ${indexResult.updated} updated`);
      
      const partsUpdated = await updatePartCrossReferences(allJobIndexEntries);
      results.partsIndexed = partsUpdated;
      console.log(`[Parts History] Part cross-references: ${partsUpdated} parts updated`);
    } catch (indexErr: any) {
      console.log(`[Parts History] Job indexing error: ${indexErr.message}`);
      results.errors.push(`Job indexing: ${indexErr.message}`);
    }
  }
  
  console.log(`[Parts History] Complete: ${results.vehiclesProcessed} vehicles, ${results.invoicesFetched} invoices, ${results.partsIndexed} parts`);
  
  return NextResponse.json({
    ok: true,
    message: `Built parts history from ${results.invoicesFetched} invoices across ${results.vehiclesProcessed} vehicles`,
    ...results,
  });
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = String(session.shopId);
  
  const invoiceCountRows = await sql`SELECT COUNT(*)::int as count FROM protractor_invoices WHERE shop_id = ${shopId}`;
  const partsCountRows = await sql`SELECT COUNT(*)::int as count FROM part_cross_ref WHERE shop_id = ${shopId}`;
  const jobsCountRows = await sql`SELECT COUNT(*)::int as count FROM job_index WHERE shop_id = ${shopId}`;
  const vehicleCountRows = await sql`SELECT COUNT(*)::int as count FROM protractor_vehicles WHERE shop_id = ${shopId}`;
  
  return NextResponse.json({
    ok: true,
    stats: {
      vehicles: vehicleCountRows[0].count,
      invoices: invoiceCountRows[0].count,
      jobs: jobsCountRows[0].count,
      parts: partsCountRows[0].count,
    },
  });
}
