import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    if (!shopId) {
      return NextResponse.json({ error: "No shop associated" }, { status: 400 });
    }

    const db = await getDb();
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { "protractor.cannedJobMappings": 1, "protractor.manualCannedJobs": 1, "protractor.hiddenJobIds": 1 } }
    );

    return NextResponse.json({
      mappings: shop?.protractor?.cannedJobMappings || {},
      manualJobs: shop?.protractor?.manualCannedJobs || [],
      hiddenJobIds: shop?.protractor?.hiddenJobIds || [],
    });
  } catch (err: any) {
    console.error("[Canned Job Mappings] GET Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

type ManualJob = {
  id: string;
  title: string;
  description?: string;
};

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    if (!shopId) {
      return NextResponse.json({ error: "No shop associated" }, { status: 400 });
    }

    let body: { mappings?: Record<string, string[]>; manualJobs?: ManualJob[]; hiddenJobIds?: string[] };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { mappings, manualJobs, hiddenJobIds } = body;
    if (!mappings || typeof mappings !== "object") {
      return NextResponse.json({ error: "Invalid mappings format" }, { status: 400 });
    }

    const db = await getDb();
    const updateFields: Record<string, any> = {
      "protractor.cannedJobMappings": mappings,
      "protractor.cannedJobMappingsUpdatedAt": new Date(),
    };

    if (Array.isArray(manualJobs)) {
      updateFields["protractor.manualCannedJobs"] = manualJobs;
    }

    if (Array.isArray(hiddenJobIds)) {
      updateFields["protractor.hiddenJobIds"] = hiddenJobIds;
    }

    await db.collection("shops").updateOne(
      { shopId },
      { $set: updateFields }
    );

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("[Canned Job Mappings] POST Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
