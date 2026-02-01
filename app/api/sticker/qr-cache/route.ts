import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { sql } from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOVERCODE_API_BASE = "https://hovercode.com/api/v2/hovercode/create";
const HOVERCODE_WORKSPACE_ID = process.env.HOVERCODE_WORKSPACE_ID;
const HOVERCODE_API_TOKEN = process.env.HOVERCODE_API_TOKEN;

interface HoverCodeResponse {
  id: string;
  png: string;
  svg_file?: string;
}

async function fetchQRFromHoverCode(appointmentUrl: string): Promise<{ qrId: string; pngUrl: string; error?: string } | null> {
  if (!HOVERCODE_API_TOKEN || !HOVERCODE_WORKSPACE_ID) {
    console.log("[QR Cache] HoverCode not configured - TOKEN:", !!HOVERCODE_API_TOKEN, "WORKSPACE:", !!HOVERCODE_WORKSPACE_ID);
    return { qrId: "", pngUrl: "", error: "HoverCode not configured" };
  }

  try {
    const devDomain = process.env.REPLIT_DEV_DOMAIN || process.env.RENDER_EXTERNAL_HOSTNAME || "mos-maintenance-mvp.replit.app";
    const logoUrl = `https://${devDomain}/api/assets/appointment-logo.png`;
    
    console.log("[QR Cache] Calling HoverCode API for URL:", appointmentUrl, "with logo:", logoUrl);
    const response = await fetch(`${HOVERCODE_API_BASE}/`, {
      method: "POST",
      headers: {
        "Authorization": `Token ${HOVERCODE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace: HOVERCODE_WORKSPACE_ID,
        qr_data: appointmentUrl,
        generate_png: true,
        dynamic: true,
        pattern: "Squares",
        size: 300,
        primary_color: "#000000",
        background_color: "#ffffff",
        logo_image: logoUrl,
        logo_size: 0.25,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[QR Cache] HoverCode create error:", response.status, errorText);
      return { qrId: "", pngUrl: "", error: `HoverCode API error: ${response.status}` };
    }

    const data: HoverCodeResponse = await response.json();
    console.log("[QR Cache] HoverCode success, QR ID:", data.id);
    return { qrId: data.id, pngUrl: data.png };
  } catch (error) {
    console.error("[QR Cache] HoverCode fetch error:", error);
    return { qrId: "", pngUrl: "", error: `HoverCode fetch error: ${error}` };
  }
}

async function downloadAndCacheQR(pngUrl: string, shopId: number, qrId: string): Promise<string | null> {
  try {
    const response = await fetch(pngUrl);
    if (!response.ok) {
      console.error("[QR Cache] Failed to download QR PNG:", response.status);
      return null;
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const dataUri = `data:image/png;base64,${base64}`;

    await sql`
      INSERT INTO shop_media (shop_id, type, data_uri, hovercode_id, content_type, updated_at)
      VALUES (${String(shopId)}, 'qr_code', ${dataUri}, ${qrId}, 'image/png', NOW())
      ON CONFLICT (shop_id, type) 
      DO UPDATE SET data_uri = ${dataUri}, hovercode_id = ${qrId}, updated_at = NOW()
    `;

    return dataUri;
  } catch (error) {
    console.error("[QR Cache] Download and cache error:", error);
    return null;
  }
}

async function fetchExistingQR(hovercodeId: string): Promise<string | null> {
  if (!HOVERCODE_API_TOKEN) {
    console.log("[QR Cache] No API token for fetching existing QR");
    return null;
  }

  try {
    console.log("[QR Cache] Fetching existing QR by ID:", hovercodeId);
    const response = await fetch(`https://hovercode.com/api/v2/hovercode/${hovercodeId}/`, {
      headers: {
        "Authorization": `Token ${HOVERCODE_API_TOKEN}`,
      },
    });

    if (!response.ok) {
      console.error("[QR Cache] Fetch existing QR error:", response.status);
      return null;
    }

    const data = await response.json();
    return data.png || null;
  } catch (error) {
    console.error("[QR Cache] Fetch existing QR error:", error);
    return null;
  }
}

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
    const shopRows = await sql`
      SELECT sticker_config FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
    `;

    const stickerConfig = (shopRows[0]?.sticker_config as any) || {};
    const configuredQRId = stickerConfig.hovercodeQRId;
    const appointmentUrl = stickerConfig.appointmentUrl;

    const cachedRows = await sql`
      SELECT data_uri, hovercode_id FROM shop_media 
      WHERE shop_id = ${String(shopId)} AND type = 'qr_code'
      LIMIT 1
    `;
    const cached = cachedRows[0];

    if (configuredQRId) {
      if (cached?.data_uri && cached?.hovercode_id === configuredQRId) {
        console.log("[QR Cache GET] Using cached QR matching configured ID:", configuredQRId);
        const matches = cached.data_uri.match(/^data:([^;]+);base64,(.+)$/);
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

      console.log("[QR Cache GET] Fetching configured QR ID:", configuredQRId);
      const existingPngUrl = await fetchExistingQR(configuredQRId);
      if (existingPngUrl) {
        const dataUri = await downloadAndCacheQR(existingPngUrl, shopId, configuredQRId);
        if (dataUri) {
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
        }
      }
      console.error("[QR Cache GET] Failed to fetch configured QR ID:", configuredQRId);
      return NextResponse.json({ error: "Failed to fetch configured QR code" }, { status: 500 });
    }

    if (cached?.data_uri) {
      console.log("[QR Cache GET] Using existing cached QR");
      const matches = cached.data_uri.match(/^data:([^;]+);base64,(.+)$/);
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

    if (!appointmentUrl) {
      console.log("[QR Cache GET] No appointment URL for shop:", shopId);
      return NextResponse.json({ error: "No appointment URL configured" }, { status: 400 });
    }

    console.log("[QR Cache GET] Creating new QR for appointment URL");
    const result = await fetchQRFromHoverCode(appointmentUrl);
    if (!result || result.error) {
      console.error("[QR Cache GET] HoverCode failed:", result?.error);
      return NextResponse.json({ error: result?.error || "Failed to generate QR code" }, { status: 500 });
    }

    if (!result.pngUrl) {
      console.error("[QR Cache GET] No PNG URL from HoverCode");
      return NextResponse.json({ error: "No QR image URL returned" }, { status: 500 });
    }

    const dataUri = await downloadAndCacheQR(result.pngUrl, shopId, result.qrId);
    if (!dataUri) {
      return NextResponse.json({ error: "Failed to cache QR code" }, { status: 500 });
    }

    const updatedConfig = { ...stickerConfig, hovercodeQRId: result.qrId };
    await sql`
      UPDATE shops SET sticker_config = ${JSON.stringify(updatedConfig)}::jsonb, updated_at = NOW()
      WHERE shop_id = ${String(shopId)}
    `;

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
    const shopRows = await sql`
      SELECT sticker_config FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
    `;

    const stickerConfig = (shopRows[0]?.sticker_config as any) || {};
    const configuredQRId = stickerConfig.hovercodeQRId;
    const appointmentUrl = stickerConfig.appointmentUrl;

    if (configuredQRId) {
      console.log("[QR Cache POST] Re-fetching configured QR ID:", configuredQRId);
      const existingPngUrl = await fetchExistingQR(configuredQRId);
      if (existingPngUrl) {
        const dataUri = await downloadAndCacheQR(existingPngUrl, shopId, configuredQRId);
        if (dataUri) {
          const updatedConfig = { ...stickerConfig, qrCachedAt: new Date().toISOString() };
          await sql`
            UPDATE shops SET sticker_config = ${JSON.stringify(updatedConfig)}::jsonb, updated_at = NOW()
            WHERE shop_id = ${String(shopId)}
          `;
          return NextResponse.json({
            success: true,
            message: "QR code cache refreshed from HoverCode",
          });
        }
      }
      console.error("[QR Cache POST] Failed to fetch configured QR ID:", configuredQRId);
      return NextResponse.json({ error: "Failed to refresh configured QR code" }, { status: 500 });
    }

    if (!appointmentUrl) {
      console.log("[QR Cache POST] No appointment URL for shop:", shopId);
      return NextResponse.json({ error: "No appointment URL configured" }, { status: 400 });
    }

    console.log("[QR Cache POST] Creating new QR for shop without configured ID");
    const result = await fetchQRFromHoverCode(appointmentUrl);
    if (!result || result.error) {
      console.error("[QR Cache POST] HoverCode failed:", result?.error);
      return NextResponse.json({ error: result?.error || "Failed to generate QR code" }, { status: 500 });
    }

    if (!result.pngUrl) {
      console.error("[QR Cache POST] No PNG URL from HoverCode");
      return NextResponse.json({ error: "No QR image URL returned" }, { status: 500 });
    }

    const dataUri = await downloadAndCacheQR(result.pngUrl, shopId, result.qrId);
    if (!dataUri) {
      return NextResponse.json({ error: "Failed to cache QR code" }, { status: 500 });
    }

    const updatedConfig = { 
      ...stickerConfig, 
      hovercodeQRId: result.qrId.toString(),
      qrCachedAt: new Date().toISOString()
    };
    await sql`
      UPDATE shops SET sticker_config = ${JSON.stringify(updatedConfig)}::jsonb, updated_at = NOW()
      WHERE shop_id = ${String(shopId)}
    `;

    return NextResponse.json({
      success: true,
      message: "QR code generated and cached",
    });
  } catch (error) {
    console.error("[QR Cache POST] Error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
