import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LOGO_SIZE = 500 * 1024; // 500KB

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  }

  if (!["owner", "admin", "manager"].includes(session.role)) {
    return NextResponse.json(
      { error: "Insufficient permissions" },
      { status: 403 }
    );
  }

  try {
    const body = await req.json();
    const { contentType, base64Data } = body;

    if (!contentType || !base64Data) {
      return NextResponse.json(
        { error: "Missing contentType or base64Data" },
        { status: 400 }
      );
    }

    if (!contentType.startsWith("image/")) {
      return NextResponse.json(
        { error: "Only image files are allowed" },
        { status: 400 }
      );
    }

    // Validate base64 data size
    const dataSize = (base64Data.length * 3) / 4;
    if (dataSize > MAX_LOGO_SIZE) {
      return NextResponse.json(
        { error: `Logo too large. Maximum size is ${Math.round(MAX_LOGO_SIZE / 1024)}KB` },
        { status: 400 }
      );
    }

    // Create data URI
    const dataUri = `data:${contentType};base64,${base64Data}`;

    const db = await getDb();
    
    // Store in shop_media collection
    await db.collection("shop_media").updateOne(
      { shopId, type: "logo" },
      {
        $set: {
          shopId,
          type: "logo",
          dataUri,
          contentType,
          updatedAt: new Date(),
          updatedBy: session.email,
        },
      },
      { upsert: true }
    );

    // Also update the shop's stickerConfig.logo for backward compatibility
    await db.collection("shops").updateOne(
      { shopId },
      {
        $set: {
          "stickerConfig.logo": `/api/sticker/logo/${shopId}`,
          "stickerConfig.logoUpdatedAt": new Date(),
        },
      }
    );

    return NextResponse.json({
      logoUrl: `/api/sticker/logo/${shopId}`,
      success: true,
    });
  } catch (error) {
    console.error("[Upload Logo] Error:", error);
    return NextResponse.json(
      { error: "Failed to upload logo" },
      { status: 500 }
    );
  }
}
