import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get("X-API-Key");
    
    if (!apiKey) {
      return NextResponse.json(
        { error: "API key is required" },
        { status: 401, headers: corsHeaders }
      );
    }

    const db = await getDb();
    
    const shop = await db.collection("shops").findOne({
      $or: [
        { autovitalsApiKey: apiKey },
        { "autovitalsExtension.apiKeys.value": apiKey }
      ]
    });

    if (!shop) {
      return NextResponse.json(
        { error: "Invalid API key" },
        { status: 401, headers: corsHeaders }
      );
    }

    await db.collection("shops").updateOne(
      { _id: shop._id },
      {
        $set: {
          "autovitals.extensionConnected": true,
          "autovitals.extensionConnectedAt": new Date(),
          updatedAt: new Date(),
        }
      }
    );

    return NextResponse.json({
      ok: true,
      shopName: shop.name || shop.shopName || "Your Shop",
      message: "Connected successfully"
    }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[AutoVitals Extension] Connect error:", error);
    return NextResponse.json(
      { error: error.message || "Connection failed" },
      { status: 500, headers: corsHeaders }
    );
  }
}
