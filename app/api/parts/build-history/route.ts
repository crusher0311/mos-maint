import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import {
  resolveProtractorConfig,
  fetchInvoicesForVehicle,
  fetchInvoiceById,
  upsertProtractorInvoiceSnapshot,
} from "@/lib/integrations/protractor";
import {
  extractJobIndexFromWorkOrder,
  extractJobIndexFromCachedWorkOrder,
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
  const db = await getDb();
  
  const results = {
    workOrdersProcessed: 0,
    jobsIndexed: 0,
    partsIndexed: 0,
    errors: [] as string[],
  };
  
  const allJobIndexEntries: any[] = [];
  
  const workOrders = await db.collection("tekmetric_work_orders")
    .find({ shopId: { $in: [String(shopId), Number(shopId)] } })
    .toArray();
  
  console.log(`[Parts History] Building from ${workOrders.length} Tekmetric work orders...`);
  
  for (const wo of workOrders) {
    try {
      results.workOrdersProcessed++;
      
      const vehicleData = {
        vin: wo.vin,
        year: wo.year,
        make: wo.make,
        model: wo.model,
      };
      
      const jobEntries = extractJobIndexFromCachedWorkOrder(shopId, wo, vehicleData);
      if (jobEntries.length > 0) {
        for (const entry of jobEntries) {
          entry.metadata.sourceType = "tekmetric";
        }
        allJobIndexEntries.push(...jobEntries);
      }
    } catch (err: any) {
      console.log(`[Parts History] Error for WO ${wo.workOrderId}: ${err.message}`);
      results.errors.push(`WO ${wo.workOrderId}: ${err.message}`);
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
  
  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId });
  
  const hasTekmetric = shop?.tekmetric?.shopId || shop?.tekmetricShopId;
  const hasProtractor = shop?.protractor?.configured || shop?.protractorConnectionId;
  
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
  
  const vehicles = await db.collection("protractor_vehicles").find({ shopId }).toArray();
  console.log(`[Parts History] Building parts database from ${vehicles.length} vehicles...`);
  
  const vehicleLimit = pLimit(2);
  
  await Promise.all(
    vehicles.map((vehicle) =>
      vehicleLimit(async () => {
        if (!vehicle.protractorId) return;
        
        try {
          results.vehiclesProcessed++;
          
          const invoicesResult = await fetchInvoicesForVehicle(shopId, vehicle.protractorId, {
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

  const shopId = Number(session.shopId);
  const db = await getDb();
  
  const invoiceCount = await db.collection("protractor_invoices").countDocuments({ shopId });
  const partsCount = await db.collection("part_cross_ref").countDocuments({ shopId });
  const jobsCount = await db.collection("job_index").countDocuments({ shopId });
  const vehicleCount = await db.collection("protractor_vehicles").countDocuments({ shopId });
  
  return NextResponse.json({
    ok: true,
    stats: {
      vehicles: vehicleCount,
      invoices: invoiceCount,
      jobs: jobsCount,
      parts: partsCount,
    },
  });
}
