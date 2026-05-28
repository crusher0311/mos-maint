import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { getDb as getSupabaseDb } from "@/lib/db/drizzle";
import { enhanceCorrections } from "@/lib/db/schema/enhance-corrections";
import { getDb as getMongoDb } from "@/lib/mongo";
import { desc, eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function _POST(request: NextRequest) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: corsHeaders });
  }

  const { shopId, corrections, provider } = body;

  if (!corrections || !Array.isArray(corrections) || corrections.length === 0) {
    return NextResponse.json(
      { error: "shopId and corrections array required" },
      { status: 400, headers: corsHeaders }
    );
  }

  // Single shop-resolution boundary: the extension keeps sending the raw
  // provider/SMS shop ID, but the server resolves it to the canonical
  // mosShopId exactly once at the edge (Task #300).
  const guard = await guardExtensionShopRequest(request, {
    smsShopId: shopId,
    provider,
    requiredFeatures: ["enhance_notes"],
    featureLabel: "Enhance Notes",
    corsHeaders,
  });
  if (!guard.ok) return guard.response;

  const mosShopId = guard.mosShopId;

  try {
    const rows = corrections.map((c: any) => ({
      mosShopId,
      taskName: c.taskName || "",
      aiSuggested: c.aiSuggested,
      advisorWrote: c.advisorWrote,
      advisorEmail: guard.user!.email,
    }));

    const db = getSupabaseDb();
    await db.insert(enhanceCorrections).values(rows);

    getMongoDb().then(mongoDB => {
      const docs = rows.map(r => ({ ...r, createdAt: new Date() }));
      mongoDB.collection("enhance_corrections").insertMany(docs).catch(err => {
        console.warn("[Enhance Corrections] MongoDB dual-write failed:", err.message);
      });
    }).catch(() => {});

    console.log(`[Enhance Corrections] Saved ${rows.length} corrections for mosShop=${mosShopId} (raw=${shopId}) by ${guard.user!.email}`);

    return NextResponse.json({
      success: true,
      saved: rows.length,
    }, { headers: corsHeaders });
  } catch (err: any) {
    console.error("[Enhance Corrections] Error:", err.message);
    return NextResponse.json(
      { error: "Failed to save corrections" },
      { status: 500, headers: corsHeaders }
    );
  }
}

async function _GET(request: NextRequest) {
  const shopId = request.nextUrl.searchParams.get("shopId");
  const provider = request.nextUrl.searchParams.get("provider");

  const guard = await guardExtensionShopRequest(request, {
    smsShopId: shopId,
    provider,
    requiredFeatures: ["enhance_notes"],
    featureLabel: "Enhance Notes",
    corsHeaders,
  });
  if (!guard.ok) return guard.response;

  const mosShopId = guard.mosShopId;

  try {
    const db = getSupabaseDb();
    const rows = await db
      .select({
        taskName: enhanceCorrections.taskName,
        aiSuggested: enhanceCorrections.aiSuggested,
        advisorWrote: enhanceCorrections.advisorWrote,
      })
      .from(enhanceCorrections)
      .where(eq(enhanceCorrections.mosShopId, mosShopId))
      .orderBy(desc(enhanceCorrections.createdAt))
      .limit(30);

    return NextResponse.json({
      success: true,
      corrections: rows,
    }, { headers: corsHeaders });
  } catch (err: any) {
    console.error("[Enhance Corrections] Error:", err.message);
    return NextResponse.json(
      { error: "Failed to fetch corrections" },
      { status: 500, headers: corsHeaders }
    );
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const GET = withExtensionErrorMarker(_GET as any);
export const POST = withExtensionErrorMarker(_POST as any);
