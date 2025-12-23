import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requireSession } from "@/lib/auth";
import crypto from "crypto";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const shopId = Number(session.shopId);
    
    const apiKey = `mos_av_${crypto.randomBytes(24).toString('hex')}`;
    
    const db = await getDb();
    
    await db.collection("shops").updateOne(
      { shopId },
      {
        $set: {
          autovitalsApiKey: apiKey,
          "autovitals.keyGeneratedAt": new Date(),
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        }
      },
      { upsert: true }
    );

    return NextResponse.json({
      ok: true,
      apiKey,
      message: "API key generated successfully"
    });
  } catch (error: any) {
    console.error("[AutoVitals Extension] Generate key error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to generate API key" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await requireSession();
    const shopId = Number(session.shopId);
    
    const db = await getDb();
    
    await db.collection("shops").updateOne(
      { shopId },
      {
        $unset: {
          autovitalsApiKey: "",
        },
        $set: {
          "autovitals.keyRevokedAt": new Date(),
          "autovitals.extensionConnected": false,
          updatedAt: new Date(),
        }
      }
    );

    return NextResponse.json({
      ok: true,
      message: "API key revoked successfully"
    });
  } catch (error: any) {
    console.error("[AutoVitals Extension] Revoke key error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to revoke API key" },
      { status: 500 }
    );
  }
}
