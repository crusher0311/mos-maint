import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getStickerRedirectUrl } from "@/lib/sticker-utils";
import nodeHtmlToImage from "node-html-to-image";
import QRCode from "qrcode";
import { createCanvas, loadImage } from "canvas";
import path from "path";
import fs from "fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface StickerConfig {
  logo?: string;
  phone?: string;
  tagline?: string;
  colors?: {
    primary?: string;
    secondary?: string;
    text?: string;
  };
  appointmentUrl?: string;
  useKilometers?: boolean;
}

interface StickerRequest {
  vin?: string;
  vehicleYear?: number;
  vehicleMake?: string;
  vehicleModel?: string;
  currentMileage?: number;
  nextServiceMileage?: number;
  nextServiceDate?: string;
  size?: "2x2" | "2x2.5" | "2x3" | "2x3.5";
  includeQR?: boolean;
}

const SIZE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "2x2": { width: 200, height: 200 },
  "2x2.5": { width: 200, height: 250 },
  "2x3": { width: 200, height: 300 },
  "2x3.5": { width: 200, height: 350 },
};

function generateStickerHtml(
  config: StickerConfig,
  data: StickerRequest,
  qrDataUrl: string | null,
  dimensions: { width: number; height: number }
): string {
  const primary = config.colors?.primary || "#1976d2";
  const textColor = config.colors?.text || "#ffffff";
  const distanceUnit = config.useKilometers ? "km" : "mi";

  const formattedDate = data.nextServiceDate
    ? new Date(data.nextServiceDate).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "2-digit",
      })
    : "";

  const formattedMileage = data.nextServiceMileage
    ? data.nextServiceMileage.toLocaleString()
    : "";

  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: ${dimensions.width}px;
      height: ${dimensions.height}px;
      font-family: Arial, sans-serif;
      background: ${primary};
      color: ${textColor};
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
      padding: 8px;
    }
    .header {
      text-align: center;
      width: 100%;
    }
    .logo {
      max-width: 60px;
      max-height: 30px;
      margin-bottom: 4px;
    }
    .tagline {
      font-size: 8px;
      opacity: 0.9;
    }
    .service-info {
      text-align: center;
      width: 100%;
    }
    .label {
      font-size: 7px;
      text-transform: uppercase;
      opacity: 0.8;
      margin-bottom: 2px;
    }
    .value {
      font-size: 14px;
      font-weight: bold;
      margin-bottom: 6px;
    }
    .vehicle {
      font-size: 8px;
      opacity: 0.9;
    }
    .footer {
      text-align: center;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .qr-code {
      width: 40px;
      height: 40px;
      background: white;
      padding: 2px;
      border-radius: 4px;
    }
    .qr-code img {
      width: 100%;
      height: 100%;
    }
    .phone {
      font-size: 10px;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <div class="header">
    ${config.logo ? `<img src="${config.logo}" class="logo" alt="Logo" />` : ""}
    ${config.tagline ? `<div class="tagline">${config.tagline}</div>` : ""}
  </div>
  
  <div class="service-info">
    ${formattedDate ? `
      <div class="label">Next Service</div>
      <div class="value">${formattedDate}</div>
    ` : ""}
    ${formattedMileage ? `
      <div class="label">Or at</div>
      <div class="value">${formattedMileage} ${distanceUnit}</div>
    ` : ""}
    ${data.vehicleYear && data.vehicleMake ? `
      <div class="vehicle">${data.vehicleYear} ${data.vehicleMake} ${data.vehicleModel || ""}</div>
    ` : ""}
  </div>
  
  <div class="footer">
    ${qrDataUrl ? `<div class="qr-code"><img src="${qrDataUrl}" alt="QR" /></div>` : ""}
    ${config.phone ? `<div class="phone">${config.phone}</div>` : ""}
  </div>
</body>
</html>
  `;
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
    const body: StickerRequest = await req.json();
    const size = body.size || "2x2.5";
    const includeQR = body.includeQR !== false;

    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId });

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const config: StickerConfig = shop.stickerConfig || {};
    const dimensions = SIZE_DIMENSIONS[size] || SIZE_DIMENSIONS["2x2.5"];

    let qrDataUrl: string | null = null;
    if (includeQR) {
      const redirectUrl = config.appointmentUrl || getStickerRedirectUrl(shopId);
      const logoPath = path.join(process.cwd(), "public", "sticker-qr-logo.png");
      const qrSize = 100;

      const canvas = createCanvas(qrSize, qrSize);
      const ctx = canvas.getContext("2d");

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, qrSize, qrSize);

      const baseQr = await QRCode.toDataURL(redirectUrl, {
        width: qrSize,
        margin: 1,
        color: { dark: "#000000", light: "#ffffff" },
        errorCorrectionLevel: "H",
      });

      const qrImage = await loadImage(baseQr);
      ctx.drawImage(qrImage, 0, 0, qrSize, qrSize);

      if (fs.existsSync(logoPath)) {
        try {
          const logo = await loadImage(logoPath);
          const logoSize = qrSize * 0.25;
          const logoX = (qrSize - logoSize) / 2;
          const logoY = (qrSize - logoSize) / 2;
          const padding = logoSize * 0.15;
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.roundRect(logoX - padding, logoY - padding, logoSize + padding * 2, logoSize + padding * 2, 4);
          ctx.fill();
          ctx.drawImage(logo, logoX, logoY, logoSize, logoSize);
        } catch (err) {
          console.error("[Sticker Generate] Logo loading failed:", err);
        }
      }

      const buffer = canvas.toBuffer("image/png");
      qrDataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
    }

    const html = generateStickerHtml(config, body, qrDataUrl, dimensions);

    const image = await nodeHtmlToImage({
      html,
      type: "png",
      transparent: false,
      puppeteerArgs: {
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      },
    });

    await db.collection("sticker_generations").insertOne({
      shopId,
      generatedAt: new Date(),
      generatedBy: session.email,
      vin: body.vin || null,
      vehicleYear: body.vehicleYear || null,
      vehicleMake: body.vehicleMake || null,
      vehicleModel: body.vehicleModel || null,
      size,
    });

    const imageBuffer = image as Buffer;
    return new NextResponse(new Uint8Array(imageBuffer), {
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": `inline; filename="sticker-${shopId}-${Date.now()}.png"`,
      },
    });
  } catch (error) {
    console.error("[Sticker Generate] Error:", error);
    return NextResponse.json(
      { error: "Failed to generate sticker image" },
      { status: 500 }
    );
  }
}
