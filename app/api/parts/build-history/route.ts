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
  upsertJobIndexEntries,
  updatePartCrossReferences,
} from "@/lib/job-index";
import pLimit from "p-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  const config = await resolveProtractorConfig(shopId);
  
  if (!config.configured) {
    return NextResponse.json(
      { error: "Protractor is not configured for this shop" },
      { status: 400 }
    );
  }

  const db = await getDb();
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
