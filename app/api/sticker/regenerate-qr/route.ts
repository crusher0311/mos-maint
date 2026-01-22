import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getStickerRedirectUrl } from "@/lib/sticker-utils";
import QRCode from "qrcode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOVERCODE_API_TOKEN = process.env.HOVERCODE_API_TOKEN;
const HOVERCODE_WORKSPACE_ID = process.env.HOVERCODE_WORKSPACE_ID;
const HOVERCODE_API_BASE = "https://hovercode.com/api/v2/hovercode";

async function getExistingHovercodeQR(hovercodeId: string): Promise<{ dataUri: string | null }> {
  if (!HOVERCODE_API_TOKEN) {
    return { dataUri: null };
  }

  try {
    const response = await fetch(`${HOVERCODE_API_BASE}/${hovercodeId}/`, {
      method: "GET",
      headers: {
        Authorization: `Token ${HOVERCODE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return { dataUri: null };
    }

    const data = await response.json();
    
    if (data.png) {
      const imageResponse = await fetch(data.png);
      if (imageResponse.ok) {
        const imageBuffer = await imageResponse.arrayBuffer();
        const base64 = Buffer.from(imageBuffer).toString("base64");
        return { dataUri: `data:image/png;base64,${base64}` };
      }
    }
    return { dataUri: null };
  } catch (error) {
    console.error("[Regenerate QR] HoverCode retrieve failed:", error);
    return { dataUri: null };
  }
}

interface HovercodeCreateResult {
  id: string;
  dataUri: string;
}

async function createHovercodeQR(
  redirectUrl: string,
  options: { size?: number; color?: string; backgroundColor?: string; displayName?: string }
): Promise<HovercodeCreateResult | null> {
  if (!HOVERCODE_API_TOKEN || !HOVERCODE_WORKSPACE_ID) {
    return null;
  }

  try {
    const response = await fetch(`${HOVERCODE_API_BASE}/create/`, {
      method: "POST",
      headers: {
        Authorization: `Token ${HOVERCODE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace: HOVERCODE_WORKSPACE_ID,
        qr_data: redirectUrl,
        dynamic: true,
        display_name: options.displayName || "Oil Sticker QR",
        primary_color: options.color || "#1976d2",
        background_color: options.backgroundColor || "#ffffff",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Regenerate QR] HoverCode create error:", response.status, errorText);
      return null;
    }

    const data = await response.json();
    const hovercodeId = data.id;

    if (data.png) {
      const imageResponse = await fetch(data.png);
      if (imageResponse.ok) {
        const imageBuffer = await imageResponse.arrayBuffer();
        const base64 = Buffer.from(imageBuffer).toString("base64");
        return { id: hovercodeId, dataUri: `data:image/png;base64,${base64}` };
      }
    }
    return { id: hovercodeId, dataUri: "" };
  } catch (error) {
    console.error("[Regenerate QR] HoverCode create failed:", error);
    return null;
  }
}

async function fallbackQRGeneration(url: string, color: string = "#1976d2"): Promise<string> {
  const qrDataUrl = await QRCode.toDataURL(url, {
    width: 300,
    margin: 2,
    color: { dark: color, light: "#ffffff" },
    errorCorrectionLevel: "H",
  });
  return qrDataUrl;
}

export async function POST(req: NextRequest) {
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
    const shop = await db.collection("shops").findOne({ shopId });

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const config = shop.stickerConfig || {};
    const redirectUrl = config.appointmentUrl || getStickerRedirectUrl(shopId);
    const qrColor = config.colors?.primary || "#1976d2";
    const qrBgColor = config.colors?.background || "#ffffff";
    const shopName = shop.name || `Shop ${shopId}`;

    let qrDataUrl: string | null = null;

    // First try existing HoverCode
    if (config.hovercodeQRId) {
      console.log(`[Regenerate QR] Fetching existing HoverCode: ${config.hovercodeQRId}`);
      const existingQR = await getExistingHovercodeQR(config.hovercodeQRId);
      if (existingQR.dataUri) {
        qrDataUrl = existingQR.dataUri;
      }
    }

    // If no existing QR, create new HoverCode
    if (!qrDataUrl) {
      console.log("[Regenerate QR] Creating new HoverCode QR");
      const newQR = await createHovercodeQR(redirectUrl, {
        size: 300,
        color: qrColor,
        backgroundColor: qrBgColor,
        displayName: `${shopName} - Oil Sticker`,
      });

      if (newQR?.dataUri) {
        qrDataUrl = newQR.dataUri;

        // Update HoverCode ID if new
        if (newQR.id) {
          await db.collection("shops").updateOne(
            { shopId },
            { $set: { "stickerConfig.hovercodeQRId": newQR.id } }
          );
        }
      }
    }

    // Fallback to local generation
    if (!qrDataUrl) {
      console.log("[Regenerate QR] Using fallback local QR generation");
      qrDataUrl = await fallbackQRGeneration(redirectUrl, qrColor);
    }

    // Cache the QR code
    await db.collection("shops").updateOne(
      { shopId },
      { $set: { "stickerConfig.cachedQrCodeDataUri": qrDataUrl } }
    );

    console.log("[Regenerate QR] Successfully cached QR code");

    return NextResponse.json({
      success: true,
      message: "QR code regenerated and cached",
      qrPreview: qrDataUrl.substring(0, 100) + "...",
    });
  } catch (error) {
    console.error("[Regenerate QR] Error:", error);
    return NextResponse.json({ error: "Failed to regenerate QR code" }, { status: 500 });
  }
}
