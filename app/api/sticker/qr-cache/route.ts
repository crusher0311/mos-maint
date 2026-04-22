import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOVERCODE_API_BASE = "https://hovercode.com/api/v2/hovercode/create";
const HOVERCODE_WORKSPACE_ID = process.env.HOVERCODE_WORKSPACE_ID;
const HOVERCODE_API_TOKEN = process.env.HOVERCODE_API_TOKEN;

interface HoverCodeResponse {
  id: string;
  png: string;
  svg_file?: string;
  svg?: string;
}

async function fetchQRFromHoverCode(appointmentUrl: string): Promise<{ qrId: string; pngUrl: string; error?: string } | null> {
  if (!HOVERCODE_API_TOKEN || !HOVERCODE_WORKSPACE_ID) {
    console.log("[QR Cache] HoverCode not configured - TOKEN:", !!HOVERCODE_API_TOKEN, "WORKSPACE:", !!HOVERCODE_WORKSPACE_ID);
    return { qrId: "", pngUrl: "", error: "HoverCode not configured" };
  }

  try {
    // Use the stable production base URL — REPLIT_DEV_DOMAIN is the ephemeral
    // dev container hostname and the /api/assets/ path doesn't serve the file.
    // HoverCode silently produces a logo-less QR if it can't fetch this URL.
    const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL || "https://mos.tools").replace(/\/$/, "");
    const logoUrl = `${baseUrl}/appointment-logo.png`;
    
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
        primary_color: "#111111",
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
    console.log("[QR Cache] HoverCode success, QR ID:", data.id, "has png:", !!data.png, "has svg_file:", !!data.svg_file);

    if (data.png) {
      return { qrId: data.id, pngUrl: data.png };
    }

    if (data.svg_file) {
      console.log("[QR Cache] Create returned no PNG, converting SVG file to PNG");
      const svgResponse = await fetch(data.svg_file);
      if (svgResponse.ok) {
        const svgText = await svgResponse.text();
        const pngDataUri = await svgToPngDataUri(svgText);
        if (pngDataUri) {
          return { qrId: data.id, pngUrl: pngDataUri };
        }
      }
    }

    if (data.svg) {
      console.log("[QR Cache] Create returned no PNG or SVG file, converting inline SVG");
      const pngDataUri = await svgToPngDataUri(data.svg);
      if (pngDataUri) {
        return { qrId: data.id, pngUrl: pngDataUri };
      }
    }

    console.error("[QR Cache] HoverCode create returned no usable image format");
    return { qrId: data.id, pngUrl: "", error: "No image format available from HoverCode" };
  } catch (error) {
    console.error("[QR Cache] HoverCode fetch error:", error);
    return { qrId: "", pngUrl: "", error: `HoverCode fetch error: ${error}` };
  }
}

async function downloadAndCacheQR(pngUrlOrDataUri: string, shopId: number, qrId: string, db: any): Promise<string | null> {
  try {
    let dataUri: string;

    if (pngUrlOrDataUri.startsWith("data:")) {
      dataUri = pngUrlOrDataUri;
    } else {
      const response = await fetch(pngUrlOrDataUri);
      if (!response.ok) {
        console.error("[QR Cache] Failed to download QR PNG:", response.status);
        return null;
      }
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      dataUri = `data:image/png;base64,${base64}`;
    }

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

function extractAttr(tag: string, attr: string): string | null {
  const re = new RegExp(`(?:^|\\s)${attr}=["']([^"']*)["']`);
  const m = tag.match(re);
  return m ? m[1] : null;
}

async function svgToPngDataUri(svgContent: string, size: number = 300, externalLogoUrl?: string | null): Promise<string | null> {
  try {
    const { createCanvas, loadImage } = require("canvas");

    const imageTagMatch = svgContent.match(/<image[^>]*>/);
    let logoRect = { x: 0, y: 0, w: 0, h: 0 };
    let embeddedLogoData: string | null = null;

    if (imageTagMatch) {
      const tag = imageTagMatch[0];
      embeddedLogoData = extractAttr(tag, "xlink:href") || extractAttr(tag, "href");
      const viewBoxMatch = svgContent.match(/viewBox=["']([^"']*)["']/);
      const svgSize = viewBoxMatch ? parseFloat(viewBoxMatch[1].split(/\s+/)[2]) || 220 : 220;
      const scale = size / svgSize;

      let translateX = 0, translateY = 0;
      const beforeImage = svgContent.substring(0, svgContent.indexOf("<image"));
      const gTags = [...beforeImage.matchAll(/<g[^>]*transform=["']translate\(([^,)]+),?\s*([^)]*)\)["'][^>]*>/g)];
      for (const g of gTags) {
        translateX += parseFloat(g[1]) || 0;
        translateY += parseFloat(g[2]) || 0;
      }

      logoRect = {
        x: (parseFloat(extractAttr(tag, "x") || "0") + translateX) * scale,
        y: (parseFloat(extractAttr(tag, "y") || "0") + translateY) * scale,
        w: parseFloat(extractAttr(tag, "width") || "0") * scale,
        h: parseFloat(extractAttr(tag, "height") || "0") * scale,
      };
    }

    const svgWithoutImage = svgContent.replace(/<image[^>]*\/?>/g, "");
    const svgBuffer = Buffer.from(svgWithoutImage);
    const svgBase64 = svgBuffer.toString("base64");
    const svgDataUri = `data:image/svg+xml;base64,${svgBase64}`;
    const img = await loadImage(svgDataUri);
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, size, size);

    const logoSource = externalLogoUrl || embeddedLogoData;
    if (logoSource && logoRect.w > 0) {
      try {
        let logoImg;
        if (externalLogoUrl) {
          const logoResp = await fetch(externalLogoUrl);
          if (logoResp.ok) {
            const logoBuf = Buffer.from(await logoResp.arrayBuffer());
            logoImg = await loadImage(logoBuf);
            console.log("[QR Cache] Using fresh logo from HoverCode URL");
          }
        }
        if (!logoImg && embeddedLogoData) {
          logoImg = await loadImage(embeddedLogoData);
          console.log("[QR Cache] Using embedded SVG logo");
        }
        if (logoImg) {
          ctx.drawImage(logoImg, logoRect.x, logoRect.y, logoRect.w, logoRect.h);
          console.log("[QR Cache] Logo overlaid onto QR at", logoRect);
        }
      } catch (logoErr) {
        console.warn("[QR Cache] Could not overlay logo:", logoErr);
      }
    }

    const pngBuffer = canvas.toBuffer("image/png");
    return `data:image/png;base64,${pngBuffer.toString("base64")}`;
  } catch (error) {
    console.error("[QR Cache] SVG to PNG conversion error:", error);
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
      const errorText = await response.text();
      console.error("[QR Cache] Fetch existing QR error:", response.status, errorText);
      return null;
    }

    const data = await response.json();
    console.log("[QR Cache] Existing QR data - has png:", !!data.png, "has svg:", !!data.svg, "has svg_file:", !!data.svg_file, "has logo:", !!data.logo);

    if (data.png) {
      return data.png;
    }

    const logoUrl = data.logo || null;

    if (data.svg_file) {
      console.log("[QR Cache] No PNG available, downloading SVG file to convert");
      const svgResponse = await fetch(data.svg_file);
      if (svgResponse.ok) {
        const svgText = await svgResponse.text();
        const pngDataUri = await svgToPngDataUri(svgText, 300, logoUrl);
        if (pngDataUri) {
          console.log("[QR Cache] Successfully converted SVG to PNG");
          return pngDataUri;
        }
      }
    }

    if (data.svg) {
      console.log("[QR Cache] Using inline SVG to convert to PNG");
      const pngDataUri = await svgToPngDataUri(data.svg, 300, logoUrl);
      if (pngDataUri) {
        console.log("[QR Cache] Successfully converted inline SVG to PNG");
        return pngDataUri;
      }
    }

    console.error("[QR Cache] No png, svg_file, or svg available for QR:", hovercodeId);
    return null;
  } catch (error) {
    console.error("[QR Cache] Fetch existing QR error:", error);
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

    // Get shop config first to check for configured hovercodeQRId
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { "stickerConfig.appointmentUrl": 1, "stickerConfig.hovercodeQRId": 1 } }
    );

    const configuredQRId = shop?.stickerConfig?.hovercodeQRId;
    const appointmentUrl = shop?.stickerConfig?.appointmentUrl;

    // Check for cached QR code
    const cached = await db.collection("shop_media").findOne({
      shopId,
      type: "qr_code",
    });

    // If there's a configured QR ID in platform admin, use that
    if (configuredQRId) {
      // Check if cache matches the configured ID
      if (cached?.dataUri && cached?.hovercodeId === configuredQRId) {
        console.log("[QR Cache GET] Using cached QR matching configured ID:", configuredQRId);
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

      // Cache doesn't match configured ID - fetch and cache the configured QR
      console.log("[QR Cache GET] Fetching configured QR ID:", configuredQRId);
      const existingPngUrl = await fetchExistingQR(configuredQRId);
      if (existingPngUrl) {
        const dataUri = await downloadAndCacheQR(existingPngUrl, shopId, configuredQRId, db);
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
      console.warn("[QR Cache GET] Failed to fetch configured QR ID from HoverCode:", configuredQRId);
    }

    if (cached?.dataUri) {
      console.log("[QR Cache GET] Using existing cached QR");
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

    const dataUri = await downloadAndCacheQR(result.pngUrl, shopId, result.qrId, db);
    if (!dataUri) {
      return NextResponse.json({ error: "Failed to cache QR code" }, { status: 500 });
    }

    await db.collection("shops").updateOne(
      { shopId },
      { $set: { "stickerConfig.hovercodeQRId": result.qrId } }
    );

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

// POST - Refresh cached QR code (re-fetch from HoverCode if configured, or create new)
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

    // Get shop's config
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { "stickerConfig.appointmentUrl": 1, "stickerConfig.hovercodeQRId": 1 } }
    );

    const configuredQRId = shop?.stickerConfig?.hovercodeQRId;
    const appointmentUrl = shop?.stickerConfig?.appointmentUrl;

    await db.collection("shop_media").deleteOne({ shopId, type: "qr_code" });
    console.log("[QR Cache POST] Cleared cached QR for fresh re-fetch");

    if (configuredQRId) {
      console.log("[QR Cache POST] Re-fetching configured QR ID:", configuredQRId);
      const existingPngUrl = await fetchExistingQR(configuredQRId);
      if (existingPngUrl) {
        const dataUri = await downloadAndCacheQR(existingPngUrl, shopId, configuredQRId, db);
        if (dataUri) {
          await db.collection("shops").updateOne(
            { shopId },
            { $set: { "stickerConfig.qrCachedAt": new Date() } }
          );
          return NextResponse.json({
            success: true,
            message: "QR code cache refreshed from HoverCode",
          });
        }
      }
      console.warn("[QR Cache POST] Failed to fetch configured QR ID, will create new:", configuredQRId);
    }

    if (!appointmentUrl) {
      console.log("[QR Cache POST] No appointment URL for shop:", shopId);
      return NextResponse.json({ error: "No appointment URL configured" }, { status: 400 });
    }

    // Generate new QR code via HoverCode
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
      message: "QR code generated and cached",
    });
  } catch (error) {
    console.error("[QR Cache POST] Error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
