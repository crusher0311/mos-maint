import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { updatePartCrossReferences, JobIndexEntry } from "@/lib/job-index";

export const dynamic = "force-dynamic";

export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = session.shopId;
  
  try {
    const db = await getDb();
    
    const jobIndexEntries = await db.collection<JobIndexEntry>("job_index")
      .find({ shopId })
      .toArray();
    
    if (jobIndexEntries.length === 0) {
      return NextResponse.json({ 
        ok: true, 
        message: "No job index entries found. Run a Protractor sync first to populate the job index.",
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
