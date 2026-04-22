import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getAuthErrorStatus, getUserShopIds } from "@/lib/extension-auth";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
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

export async function POST(request: NextRequest) {
  const auth = await validateExtensionToken(request);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json(
      { error: auth.error || "Unauthorized" },
      { status: getAuthErrorStatus(auth), headers: corsHeaders }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: corsHeaders });
  }

  const { shopId, corrections } = body;

  if (!shopId || !corrections || !Array.isArray(corrections) || corrections.length === 0) {
    return NextResponse.json(
      { error: "shopId and corrections array required" },
      { status: 400, headers: corsHeaders }
    );
  }

  // Cross-shop access check: caller must own the shop they're writing for
  // (platform admins bypass).
  const isPlatformAdmin = auth.user.role === "platform_admin";
  const userShopIds = getUserShopIds(auth.user);
  if (!isPlatformAdmin && !userShopIds.includes(String(shopId))) {
    return NextResponse.json(
      { error: "Unauthorized shop access" },
      { status: 403, headers: corsHeaders }
    );
  }

  {
    const denied = await checkShopFeatureGate(Number(shopId), ["enhance_notes"], {
      isPlatformAdmin,
      featureLabel: "Enhance Notes",
      corsHeaders,
    });
    if (denied) return denied;
  }

  try {
    const rows = corrections.map((c: any) => ({
      shopId: String(shopId),
      taskName: c.taskName || "",
      aiSuggested: c.aiSuggested,
      advisorWrote: c.advisorWrote,
      advisorEmail: auth.user!.email,
    }));

    const db = getSupabaseDb();
    await db.insert(enhanceCorrections).values(rows);

    getMongoDb().then(mongoDB => {
      const docs = rows.map(r => ({ ...r, createdAt: new Date() }));
      mongoDB.collection("enhance_corrections").insertMany(docs).catch(err => {
        console.warn("[Enhance Corrections] MongoDB dual-write failed:", err.message);
      });
    }).catch(() => {});

    console.log(`[Enhance Corrections] Saved ${rows.length} corrections for shop ${shopId} by ${auth.user.email}`);

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

export async function GET(request: NextRequest) {
  const auth = await validateExtensionToken(request);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json(
      { error: auth.error || "Unauthorized" },
      { status: getAuthErrorStatus(auth), headers: corsHeaders }
    );
  }

  const shopId = request.nextUrl.searchParams.get("shopId");
  if (!shopId) {
    return NextResponse.json({ error: "shopId required" }, { status: 400, headers: corsHeaders });
  }

  const isPlatformAdmin = auth.user.role === "platform_admin";
  const userShopIds = getUserShopIds(auth.user);
  if (!isPlatformAdmin && !userShopIds.includes(String(shopId))) {
    return NextResponse.json(
      { error: "Unauthorized shop access" },
      { status: 403, headers: corsHeaders }
    );
  }

  {
    const denied = await checkShopFeatureGate(Number(shopId), ["enhance_notes"], {
      isPlatformAdmin,
      featureLabel: "Enhance Notes",
      corsHeaders,
    });
    if (denied) return denied;
  }

  try {
    const db = getSupabaseDb();
    const rows = await db
      .select({
        taskName: enhanceCorrections.taskName,
        aiSuggested: enhanceCorrections.aiSuggested,
        advisorWrote: enhanceCorrections.advisorWrote,
      })
      .from(enhanceCorrections)
      .where(eq(enhanceCorrections.shopId, String(shopId)))
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
