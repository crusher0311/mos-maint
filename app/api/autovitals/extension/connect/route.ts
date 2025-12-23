import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get("X-API-Key");
    
    if (!apiKey) {
      return NextResponse.json(
        { error: "API key is required" },
        { status: 401 }
      );
    }

    const db = await getDb();
    
    const shop = await db.collection("shops").findOne({
      autovitalsApiKey: apiKey
    });

    if (!shop) {
      return NextResponse.json(
        { error: "Invalid API key" },
        { status: 401 }
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
    });
  } catch (error: any) {
    console.error("[AutoVitals Extension] Connect error:", error);
    return NextResponse.json(
      { error: error.message || "Connection failed" },
      { status: 500 }
    );
  }
}
