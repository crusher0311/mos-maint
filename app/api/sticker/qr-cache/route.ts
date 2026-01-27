import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOVERCODE_API_BASE = "https://hovercode.com/api/v2/hovercode";
const HOVERCODE_WORKSPACE_ID = process.env.HOVERCODE_WORKSPACE_ID;
const HOVERCODE_API_TOKEN = process.env.HOVERCODE_API_TOKEN;

interface HoverCodeResponse {
  id: number;
  png: string;
}

async function fetchQRFromHoverCode(appointmentUrl: string): Promise<{ qrId: number; pngUrl: string } | null> {
  if (!HOVERCODE_API_TOKEN || !HOVERCODE_WORKSPACE_ID) {
    console.log("[QR Cache] HoverCode not configured");
    return null;
  }

  try {
    const response = await fetch(`${HOVERCODE_API_BASE}/`, {
      method: "POST",
      headers: {
        "Authorization": `Token ${HOVERCODE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace: HOVERCODE_WORKSPACE_ID,
        qr_data: appointmentUrl,
      }),
    });

    if (!response.ok) {
      console.error("[QR Cache] HoverCode create error:", response.status);
      return null;
    }

    const data: HoverCodeResponse = await response.json();
    return { qrId: data.id, pngUrl: data.png };
  } catch (error) {
    console.error("[QR Cache] HoverCode fetch error:", error);
    return null;
  }
}

async function downloadAndCacheQR(pngUrl: string, shopId: number, qrId: number, db: any): Promise<string | null> {
  try {
    const response = await fetch(pngUrl);
    if (!response.ok) {
      console.error("[QR Cache] Failed to download QR PNG:", response.status);
      return null;
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const dataUri = `data:image/png;base64,${base64}`;

    // Store in shop_media collection
    await db.collection("shop_media").updateOne(
      { shopId, type: "qr_code" },
      {
        $set: {
          shopId,
          type: "qr_code",
          dataUri,
          hovercodeId: qrId,
          contentType: "image/png",
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    return dataUri;
  } catch (error) {
    console.error("[QR Cache] Download and cache error:", error);
    return null;
  }
}

// GET - Retrieve cached QR code or generate new one
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  }

  try {
    const db = await getDb();

    // Check for cached QR code
    const cached = await db.collection("shop_media").findOne({
      shopId,
      type: "qr_code",
    });

    if (cached?.dataUri) {
      // Return cached QR as image
      const matches = cached.dataUri.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        const buffer = Buffer.from(matches[2], "base64");
        return new NextResponse(buffer, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=3600",
          },
        });
      }
    }

    // No cache - check if shop has appointmentUrl configured
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { "stickerConfig.appointmentUrl": 1 } }
    );

    const appointmentUrl = shop?.stickerConfig?.appointmentUrl;
    if (!appointmentUrl) {
      return NextResponse.json({ error: "No appointment URL configured" }, { status: 400 });
    }

    // Generate new QR code via HoverCode
    const result = await fetchQRFromHoverCode(appointmentUrl);
    if (!result) {
      return NextResponse.json({ error: "Failed to generate QR code" }, { status: 500 });
    }

    // Download and cache the QR code
    const dataUri = await downloadAndCacheQR(result.pngUrl, shopId, result.qrId, db);
    if (!dataUri) {
      return NextResponse.json({ error: "Failed to cache QR code" }, { status: 500 });
    }

    // Return the QR image
    const matches = dataUri.match(/^data:([^;]+);base64,(.+)$/);
    if (matches) {
      const buffer = Buffer.from(matches[2], "base64");
      return new NextResponse(buffer, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    return NextResponse.json({ error: "Failed to process QR code" }, { status: 500 });
  } catch (error) {
    console.error("[QR Cache GET] Error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

// POST - Force regenerate and cache QR code
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
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  try {
    const db = await getDb();

    // Get shop's appointment URL
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { "stickerConfig.appointmentUrl": 1, "stickerConfig.hovercodeQRId": 1 } }
    );

    const appointmentUrl = shop?.stickerConfig?.appointmentUrl;
    if (!appointmentUrl) {
      return NextResponse.json({ error: "No appointment URL configured" }, { status: 400 });
    }

    // Generate new QR code via HoverCode
    const result = await fetchQRFromHoverCode(appointmentUrl);
    if (!result) {
      return NextResponse.json({ error: "Failed to generate QR code" }, { status: 500 });
    }

    // Download and cache the QR code
    const dataUri = await downloadAndCacheQR(result.pngUrl, shopId, result.qrId, db);
    if (!dataUri) {
      return NextResponse.json({ error: "Failed to cache QR code" }, { status: 500 });
    }

    // Update shop's hovercodeQRId for reference
    await db.collection("shops").updateOne(
      { shopId },
      {
        $set: {
          "stickerConfig.hovercodeQRId": result.qrId.toString(),
          "stickerConfig.qrCachedAt": new Date(),
        },
      }
    );

    return NextResponse.json({
      success: true,
      message: "QR code regenerated and cached",
    });
  } catch (error) {
    console.error("[QR Cache POST] Error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
