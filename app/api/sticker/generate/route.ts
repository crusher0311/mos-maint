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
  const accentColor = config.colors?.primary || "#cc0000";
  const distanceUnit = config.useKilometers ? "kilometers" : "miles";

  const formattedDate = data.nextServiceDate
    ? new Date(data.nextServiceDate).toLocaleDateString("en-US", {
        month: "numeric",
        day: "numeric",
        year: "numeric",
      })
    : "";

  const formattedMileage = data.nextServiceMileage
    ? data.nextServiceMileage.toLocaleString()
    : "";

  const scaleFactor = dimensions.width / 200;
  const logoHeight = Math.round(50 * scaleFactor);
  const phoneSize = Math.round(14 * scaleFactor);
  const taglineSize = Math.round(11 * scaleFactor);
  const labelSize = Math.round(12 * scaleFactor);
  const valueSize = Math.round(14 * scaleFactor);
  const qrSize = Math.round(70 * scaleFactor);
  const padding = Math.round(10 * scaleFactor);

  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: ${dimensions.width}px;
      height: ${dimensions.height}px;
      font-family: Arial, Helvetica, sans-serif;
      background: #ffffff;
      color: #000000;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: ${padding}px;
    }
    .header {
      text-align: center;
      width: 100%;
      margin-bottom: ${padding}px;
    }
    .logo {
      max-width: 90%;
      max-height: ${logoHeight}px;
      object-fit: contain;
    }
    .contact {
      text-align: center;
      margin-bottom: ${padding}px;
    }
    .phone {
      font-size: ${phoneSize}px;
      font-weight: bold;
      color: #000000;
    }
    .tagline {
      font-size: ${taglineSize}px;
      font-style: italic;
      color: #333333;
      margin-top: 2px;
    }
    .bottom-section {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      width: 100%;
      margin-top: auto;
      gap: ${padding}px;
    }
    .qr-code {
      flex-shrink: 0;
    }
    .qr-code img {
      width: ${qrSize}px;
      height: ${qrSize}px;
    }
    .service-info {
      text-align: right;
      flex-grow: 1;
    }
    .service-label {
      font-size: ${labelSize}px;
      color: #000000;
      margin-bottom: 4px;
    }
    .service-date {
      font-size: ${valueSize}px;
      font-style: italic;
      color: ${accentColor};
      font-weight: bold;
    }
    .service-mileage {
      font-size: ${valueSize}px;
      font-style: italic;
      color: ${accentColor};
      font-weight: bold;
    }
  </style>
</head>
<body>
  <div class="header">
    ${config.logo ? `<img src="${config.logo}" class="logo" alt="Shop Logo" />` : ""}
  </div>
  
  <div class="contact">
    ${config.phone ? `<div class="phone">${config.phone}</div>` : ""}
    ${config.tagline ? `<div class="tagline">${config.tagline}</div>` : ""}
  </div>
  
  <div class="bottom-section">
    ${qrDataUrl ? `<div class="qr-code"><img src="${qrDataUrl}" alt="Scan to Schedule" /></div>` : ""}
    <div class="service-info">
      <div class="service-label">Next Oil Service</div>
      ${formattedDate ? `<div class="service-date">${formattedDate}</div>` : ""}
      ${formattedMileage ? `<div class="service-mileage">${formattedMileage} ${distanceUnit}</div>` : ""}
    </div>
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

    const chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH || "/nix/store/$(ls /nix/store | grep -m1 chromium)/bin/chromium";
    
    const image = await nodeHtmlToImage({
      html,
      type: "png",
      transparent: false,
      puppeteerArgs: {
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
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
