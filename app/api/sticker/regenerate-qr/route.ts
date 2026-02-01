import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { sql } from "@/lib/db/postgres";
import { getStickerRedirectUrl } from "@/lib/sticker-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOVERCODE_API_TOKEN = process.env.HOVERCODE_API_TOKEN;
const HOVERCODE_WORKSPACE_ID = process.env.HOVERCODE_WORKSPACE_ID;
const HOVERCODE_API_BASE = "https://hovercode.com/api/v2/hovercode";

interface HovercodeCreateResult {
  id: string;
  dataUri: string;
}

async function createHovercodeQR(
  redirectUrl: string,
  options: { size?: number; color?: string; backgroundColor?: string; displayName?: string; logoUrl?: string }
): Promise<HovercodeCreateResult | null> {
  if (!HOVERCODE_API_TOKEN || !HOVERCODE_WORKSPACE_ID) {
    return null;
  }

  try {
    const requestBody: Record<string, any> = {
      workspace: HOVERCODE_WORKSPACE_ID,
      qr_data: redirectUrl,
      dynamic: true,
      display_name: options.displayName || "Oil Sticker QR",
      primary_color: "#111111",
      background_color: options.backgroundColor || "#ffffff",
      pattern: "Squares",
      eye_style: "Rounded",
      generate_png: true,
    };
    
    if (options.logoUrl) {
      requestBody.logo_url = options.logoUrl;
    }
    
    console.log("[Regenerate QR] Creating HoverCode with pattern: Squares, dynamic: true, color: #111111");
    
    const response = await fetch(`${HOVERCODE_API_BASE}/create/`, {
      method: "POST",
      headers: {
        Authorization: `Token ${HOVERCODE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
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
    const shopRows = await sql`
      SELECT name, sticker_config FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
    `;

    if (shopRows.length === 0) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const shop = shopRows[0];
    const config = (shop.sticker_config as any) || {};
    const redirectUrl = config.appointmentUrl || getStickerRedirectUrl(shopId);
    const qrBgColor = config.colors?.background || "#ffffff";
    const shopName = shop.name || `Shop ${shopId}`;

    let qrDataUrl: string | null = null;

    const devDomain = process.env.REPLIT_DEV_DOMAIN || "mos-maintenance-mvp.replit.app";
    const logoUrl = `https://${devDomain}/api/assets/appointment-logo.png`;
    console.log("[Regenerate QR] Using logo URL:", logoUrl);

    console.log("[Regenerate QR] Creating new HoverCode QR with Squares pattern, dynamic=true, logo:", logoUrl);
    const newQR = await createHovercodeQR(redirectUrl, {
      size: 300,
      color: "#111111",
      backgroundColor: qrBgColor,
      displayName: `${shopName} - Oil Sticker`,
      logoUrl: logoUrl,
    });

    if (newQR?.id) {
      const updatedConfig = { ...config, hovercodeQRId: newQR.id };
      await sql`
        UPDATE shops SET sticker_config = ${JSON.stringify(updatedConfig)}::jsonb, updated_at = NOW()
        WHERE shop_id = ${String(shopId)}
      `;
      console.log(`[Regenerate QR] Saved new HoverCode ID: ${newQR.id}`);
    }

    if (newQR?.dataUri) {
      qrDataUrl = newQR.dataUri;
    }

    if (!qrDataUrl) {
      console.error("[Regenerate QR] Failed to get QR code from HoverCode");
      return NextResponse.json({ error: "Failed to generate QR code from HoverCode" }, { status: 500 });
    }

    const finalConfig = { ...config, hovercodeQRId: newQR?.id, cachedQrCodeDataUri: qrDataUrl };
    await sql`
      UPDATE shops SET sticker_config = ${JSON.stringify(finalConfig)}::jsonb, updated_at = NOW()
      WHERE shop_id = ${String(shopId)}
    `;

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
