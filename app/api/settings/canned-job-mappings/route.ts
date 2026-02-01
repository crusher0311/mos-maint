import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = String(session.shopId);
    if (!shopId) {
      return NextResponse.json({ error: "No shop associated" }, { status: 400 });
    }

    const shopResult = await sql`
      SELECT protractor_config FROM shops WHERE shop_id = ${shopId} LIMIT 1
    `;
    const protractorConfig = (shopResult[0]?.protractor_config as Record<string, unknown>) || {};

    return NextResponse.json({
      mappings: protractorConfig.cannedJobMappings || {},
      manualJobs: protractorConfig.manualCannedJobs || [],
      hiddenJobIds: protractorConfig.hiddenJobIds || [],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Canned Job Mappings] GET Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
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

    const shopId = String(session.shopId);
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

    const shopResult = await sql`SELECT protractor_config FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
    const existingConfig = (shopResult[0]?.protractor_config as Record<string, unknown>) || {};

    const updatedConfig: Record<string, unknown> = {
      ...existingConfig,
      cannedJobMappings: mappings,
      cannedJobMappingsUpdatedAt: new Date().toISOString(),
    };

    if (Array.isArray(manualJobs)) {
      updatedConfig.manualCannedJobs = manualJobs;
    }

    if (Array.isArray(hiddenJobIds)) {
      updatedConfig.hiddenJobIds = hiddenJobIds;
    }

    await sql`
      UPDATE shops SET protractor_config = ${JSON.stringify(updatedConfig)}::jsonb, updated_at = ${new Date()}
      WHERE shop_id = ${shopId}
    `;

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Canned Job Mappings] POST Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
