import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getAuthErrorStatus } from "@/lib/extension-auth";
import { getDb } from "@/lib/mongo";

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

  try {
    const db = await getDb();
    const collection = db.collection("enhance_corrections");

    const docs = corrections.map((c: any) => ({
      shopId: String(shopId),
      taskName: c.taskName || "",
      aiSuggested: c.aiSuggested,
      advisorWrote: c.advisorWrote,
      advisorEmail: auth.user!.email,
      createdAt: new Date(),
    }));

    await collection.insertMany(docs);

    console.log(`[Enhance Corrections] Saved ${docs.length} corrections for shop ${shopId} by ${auth.user.email}`);

    return NextResponse.json({
      success: true,
      saved: docs.length,
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

  try {
    const db = await getDb();
    const collection = db.collection("enhance_corrections");

    const corrections = await collection
      .find({ shopId: String(shopId) })
      .sort({ createdAt: -1 })
      .limit(30)
      .toArray();

    return NextResponse.json({
      success: true,
      corrections: corrections.map(c => ({
        taskName: c.taskName,
        aiSuggested: c.aiSuggested,
        advisorWrote: c.advisorWrote,
      })),
    }, { headers: corsHeaders });
  } catch (err: any) {
    console.error("[Enhance Corrections] Error:", err.message);
    return NextResponse.json(
      { error: "Failed to fetch corrections" },
      { status: 500, headers: corsHeaders }
    );
  }
}
