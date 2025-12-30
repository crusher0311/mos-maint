import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { 
  updatePartCrossReferences, 
  upsertJobIndexEntries,
  extractJobIndexFromWorkOrder,
  JobIndexEntry 
} from "@/lib/job-index";

export const dynamic = "force-dynamic";

export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  
  try {
    const db = await getDb();
    
    let jobIndexEntries = await db.collection<JobIndexEntry>("job_index")
      .find({ shopId })
      .toArray();
    
    if (jobIndexEntries.length === 0) {
      console.log(`[Parts Rebuild] No job_index entries, checking protractor_work_orders...`);
      
      const cachedWorkOrders = await db.collection("protractor_work_orders")
        .find({ shopId })
        .toArray();
      
      if (cachedWorkOrders.length === 0) {
        return NextResponse.json({ 
          ok: true, 
          message: "No work order history found. Run a Protractor sync first to cache work orders.",
          partsUpdated: 0,
          jobsScanned: 0,
          workOrdersFound: 0
        });
      }
      
      console.log(`[Parts Rebuild] Found ${cachedWorkOrders.length} cached work orders, building job index...`);
      
      const allEntries: JobIndexEntry[] = [];
      for (const wo of cachedWorkOrders) {
        const entries = extractJobIndexFromWorkOrder(shopId, wo.data || wo, "protractor");
        allEntries.push(...entries);
      }
      
      if (allEntries.length > 0) {
        const result = await upsertJobIndexEntries(allEntries);
        console.log(`[Parts Rebuild] Job index built: ${result.inserted} inserted, ${result.updated} updated`);
        jobIndexEntries = allEntries;
      }
    }
    
    if (jobIndexEntries.length === 0) {
      return NextResponse.json({ 
        ok: true, 
        message: "No service packages found in work order history.",
        partsUpdated: 0,
        jobsScanned: 0
      });
    }
    
    const partsUpdated = await updatePartCrossReferences(jobIndexEntries);
    
    return NextResponse.json({
      ok: true,
      message: `Rebuilt parts index from ${jobIndexEntries.length} jobs`,
      partsUpdated,
      jobsScanned: jobIndexEntries.length,
    });
  } catch (error) {
    console.error("[Parts Rebuild] Error:", error);
    return NextResponse.json({ 
      error: "Failed to rebuild parts index",
      details: error instanceof Error ? error.message : "Unknown error"
    }, { status: 500 });
  }
}
