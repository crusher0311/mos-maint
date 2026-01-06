import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getStickerRedirectUrl } from "@/lib/sticker-utils";
import nodeHtmlToImage from "node-html-to-image";
import QRCode from "qrcode";
import { createCanvas, loadImage } from "canvas";
import path from "path";
import fs from "fs";
import { Storage } from "@google-cloud/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

async function fetchLogoAsBase64(logoUrl: string, logoObjectPath?: string): Promise<string | null> {
  try {
    if (logoObjectPath) {
      const pathParts = logoObjectPath.split("/").filter(Boolean);
      if (pathParts.length >= 2) {
        const bucketName = pathParts[0];
        const objectName = pathParts.slice(1).join("/");
        const bucket = storage.bucket(bucketName);
        const file = bucket.file(objectName);
        
        const [exists] = await file.exists();
        if (exists) {
          const [buffer] = await file.download();
          const [metadata] = await file.getMetadata();
          const contentType = metadata.contentType || "image/png";
          return `data:${contentType};base64,${buffer.toString("base64")}`;
        }
      }
    }
    
    if (logoUrl && logoUrl.startsWith("http")) {
      const response = await fetch(logoUrl);
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        const contentType = response.headers.get("content-type") || "image/png";
        return `data:${contentType};base64,${Buffer.from(buffer).toString("base64")}`;
      }
    }
    
    return null;
  } catch (error) {
    console.error("[Sticker Generate] Logo fetch failed:", error);
    return null;
  }
}

interface FontStyle {
  bold?: boolean;
  italic?: boolean;
  size?: number;
}

interface StickerConfig {
  logo?: string;
  logoObjectPath?: string;
  phone?: string;
  tagline?: string;
  taglineLine2?: string;
  serviceLabel?: string;
  fontStyles?: {
    phone?: FontStyle;
    tagline?: FontStyle;
    taglineLine2?: FontStyle;
    serviceLabel?: FontStyle;
    serviceValue?: FontStyle;
  };
  colors?: {
    primary?: string;
    secondary?: string;
    text?: string;
    background?: string;
    phoneColor?: string;
    taglineColor?: string;
    serviceLabelColor?: string;
    serviceValueColor?: string;
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
  "2x2": { width: 600, height: 600 },
  "2x2.5": { width: 600, height: 750 },
  "2x3": { width: 600, height: 900 },
  "2x3.5": { width: 600, height: 1050 },
};

function generateStickerHtml(
  config: StickerConfig,
  data: StickerRequest,
  qrDataUrl: string | null,
  dimensions: { width: number; height: number }
): string {
  const backgroundColor = config.colors?.background || "#ffffff";
  const phoneColor = config.colors?.phoneColor || "#000000";
  const taglineColor = config.colors?.taglineColor || "#333333";
  const serviceLabelColor = config.colors?.serviceLabelColor || "#666666";
  const serviceValueColor = config.colors?.serviceValueColor || config.colors?.primary || "#cc0000";
  const distanceUnit = config.useKilometers ? "km" : "miles";

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
  const logoHeight = Math.round(60 * scaleFactor);
  
  const phoneFontStyle = config.fontStyles?.phone || { bold: true, italic: false, size: 14 };
  const taglineFontStyle = config.fontStyles?.tagline || { bold: false, italic: true, size: 11 };
  const taglineLine2FontStyle = config.fontStyles?.taglineLine2 || { bold: false, italic: true, size: 11 };
  const serviceLabelFontStyle = config.fontStyles?.serviceLabel || { bold: false, italic: false, size: 12 };
  const serviceValueFontStyle = config.fontStyles?.serviceValue || { bold: true, italic: true, size: 14 };
  
  const phoneSize = Math.round((phoneFontStyle.size || 14) * scaleFactor);
  const taglineSize = Math.round((taglineFontStyle.size || 11) * scaleFactor);
  const taglineLine2Size = Math.round((taglineLine2FontStyle.size || 11) * scaleFactor);
  const labelSize = Math.round((serviceLabelFontStyle.size || 12) * scaleFactor);
  const valueSize = Math.round((serviceValueFontStyle.size || 14) * scaleFactor);
  const qrSize = Math.round(80 * scaleFactor);
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
      background: ${backgroundColor};
      color: #000000;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: ${padding}px;
    }
    .header {
      text-align: center;
      width: 100%;
      margin-bottom: ${Math.round(6 * scaleFactor)}px;
    }
    .logo {
      max-width: 90%;
      max-height: ${logoHeight}px;
      object-fit: contain;
    }
    .contact {
      text-align: center;
      margin-bottom: ${Math.round(4 * scaleFactor)}px;
    }
    .phone {
      font-size: ${phoneSize}px;
      font-weight: ${phoneFontStyle.bold ? "bold" : "normal"};
      font-style: ${phoneFontStyle.italic ? "italic" : "normal"};
      color: ${phoneColor};
      margin-bottom: 2px;
    }
    .tagline {
      font-size: ${taglineSize}px;
      font-weight: ${taglineFontStyle.bold ? "bold" : "normal"};
      font-style: ${taglineFontStyle.italic ? "italic" : "normal"};
      color: ${taglineColor};
    }
    .tagline-line2 {
      font-size: ${taglineLine2Size}px;
      font-weight: ${taglineLine2FontStyle.bold ? "bold" : "normal"};
      font-style: ${taglineLine2FontStyle.italic ? "italic" : "normal"};
      color: ${taglineColor};
    }
    .bottom-section {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      margin-top: ${Math.round(5 * scaleFactor)}px;
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
      text-align: center;
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .service-label {
      font-size: ${labelSize}px;
      font-weight: ${serviceLabelFontStyle.bold ? "bold" : "normal"};
      font-style: ${serviceLabelFontStyle.italic ? "italic" : "normal"};
      color: ${serviceLabelColor};
      margin-bottom: 4px;
    }
    .service-date {
      font-size: ${valueSize}px;
      font-weight: ${serviceValueFontStyle.bold ? "bold" : "normal"};
      font-style: ${serviceValueFontStyle.italic ? "italic" : "normal"};
      color: ${serviceValueColor};
    }
    .service-mileage {
      font-size: ${valueSize}px;
      font-weight: ${serviceValueFontStyle.bold ? "bold" : "normal"};
      font-style: ${serviceValueFontStyle.italic ? "italic" : "normal"};
      color: ${serviceValueColor};
    }
    .service-centered {
      text-align: center;
      margin-top: ${Math.round(8 * scaleFactor)}px;
    }
    .service-centered .service-label {
      font-size: ${Math.round((serviceLabelFontStyle.size || 12) * scaleFactor * 1.17)}px;
    }
    .service-centered .service-date,
    .service-centered .service-mileage {
      font-size: ${Math.round((serviceValueFontStyle.size || 14) * scaleFactor * 1.29)}px;
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
    ${config.taglineLine2 ? `<div class="tagline-line2">${config.taglineLine2}</div>` : ""}
  </div>
  
  ${qrDataUrl ? `
  <div class="bottom-section">
    <div class="qr-code"><img src="${qrDataUrl}" alt="Scan to Schedule" /></div>
    <div class="service-info">
      <div class="service-label">${config.serviceLabel || "Next Oil Service"}</div>
      ${formattedDate ? `<div class="service-date">${formattedDate}</div>` : ""}
      ${formattedMileage ? `<div class="service-mileage">${formattedMileage} ${distanceUnit}</div>` : ""}
    </div>
  </div>
  ` : `
  <div class="service-centered">
    <div class="service-label">${config.serviceLabel || "Next Oil Service"}</div>
    ${formattedDate ? `<div class="service-date">${formattedDate}</div>` : ""}
    ${formattedMileage ? `<div class="service-mileage">${formattedMileage} ${distanceUnit}</div>` : ""}
  </div>
  `}
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

    let logoDataUrl: string | null = null;
    if (config.logo || config.logoObjectPath) {
      logoDataUrl = await fetchLogoAsBase64(config.logo || "", config.logoObjectPath);
    }
    const configWithBase64Logo = { ...config, logo: logoDataUrl || undefined };

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

    const html = generateStickerHtml(configWithBase64Logo, body, qrDataUrl, dimensions);

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
