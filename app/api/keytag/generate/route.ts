import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import nodeHtmlToImage from "node-html-to-image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface FontStyle {
  bold?: boolean;
  italic?: boolean;
  size?: number;
}

interface KeytagConfig {
  enabled?: boolean;
  showLogo?: boolean;
  fontStyles?: {
    customerName?: FontStyle;
    vehicleInfo?: FontStyle;
    roNumber?: FontStyle;
    mileage?: FontStyle;
  };
  colors?: {
    text?: string;
    background?: string;
  };
  defaultSize?: "dymo30252";
}

interface KeytagRequest {
  customerName: string;
  vehicleInfo: string;
  vin?: string;
  roNumber: string;
  mileage: string | number;
  previewConfig?: KeytagConfig;
}

const SIZE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "dymo30252": { width: 1035, height: 333 },
};

const SIZE_INCHES: Record<string, { width: string; height: string }> = {
  "dymo30252": { width: "3.45in", height: "1.11in" },
};

function generateKeytagHtml(
  config: KeytagConfig,
  data: KeytagRequest,
  scaleFactor: number = 1
): string {
  const textColor = config.colors?.text || "#000000";
  const backgroundColor = config.colors?.background || "#FFFFFF";

  const mileageFormatted = typeof data.mileage === 'number' 
    ? data.mileage.toLocaleString() 
    : data.mileage;

  const baseFontSize = Math.round(11 * scaleFactor);
  const nameFontSize = Math.round(16 * scaleFactor);
  const vehicleFontSize = Math.round(11 * scaleFactor);
  const padding = Math.round(16 * scaleFactor);
  const gap = Math.round(20 * scaleFactor);

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');
        
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          background: ${backgroundColor};
          color: ${textColor};
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100vh;
          width: 100vw;
        }
        
        .keytag {
          width: 100%;
          height: 100%;
          padding: ${padding}px;
          display: flex;
          flex-direction: row;
          align-items: center;
        }
        
        .left-section {
          display: flex;
          flex-direction: column;
          justify-content: center;
          flex: 1;
          padding-right: ${gap}px;
        }
        
        .divider {
          width: 1px;
          height: 80%;
          background: ${textColor};
          opacity: 0.3;
        }
        
        .right-section {
          display: flex;
          flex-direction: column;
          justify-content: center;
          padding-left: ${gap}px;
          flex: 1.2;
        }
        
        .customer-name {
          font-size: ${nameFontSize}px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 1px;
          padding-bottom: ${Math.round(4 * scaleFactor)}px;
          border-bottom: 1px solid ${textColor};
          margin-bottom: ${Math.round(8 * scaleFactor)}px;
        }
        
        .vehicle-info {
          font-size: ${vehicleFontSize}px;
          font-weight: 400;
          text-transform: uppercase;
        }
        
        .info-row {
          font-size: ${baseFontSize}px;
          font-weight: 400;
          padding-bottom: ${Math.round(3 * scaleFactor)}px;
          border-bottom: 1px solid ${textColor};
          margin-bottom: ${Math.round(6 * scaleFactor)}px;
        }
        
        .info-row:last-child {
          border-bottom: none;
          margin-bottom: 0;
        }
        
        .info-label {
          font-weight: 700;
        }
      </style>
    </head>
    <body>
      <div class="keytag">
        <div class="left-section">
          <div class="customer-name">${escapeHtml(data.customerName.toUpperCase())}</div>
          <div class="vehicle-info">${escapeHtml(data.vehicleInfo.toUpperCase())}</div>
        </div>
        <div class="divider"></div>
        <div class="right-section">
          ${data.vin ? `<div class="info-row"><span class="info-label">VIN:</span> ${escapeHtml(data.vin)}</div>` : ''}
          <div class="info-row"><span class="info-label">Mileage:</span> ${escapeHtml(mileageFormatted)}</div>
          <div class="info-row"><span class="info-label">RO#:</span> ${escapeHtml(data.roNumber)}</div>
        </div>
      </div>
    </body>
    </html>
  `;
}

function escapeHtml(text: string): string {
  const div = { innerHTML: '' };
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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
    let body: KeytagRequest;
    try {
      body = await req.json();
    } catch (parseError) {
      console.error("Failed to parse request body:", parseError);
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    
    if (!body || !body.customerName || !body.roNumber) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }
    
    const db = await getDb();
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { keytagConfig: 1 } }
    );

    const config: KeytagConfig = body.previewConfig || shop?.keytagConfig || {};
    const size = config.defaultSize || "dymo30252";
    const dimensions = SIZE_DIMENSIONS[size] || SIZE_DIMENSIONS["dymo30252"];

    const scaleFactor = dimensions.width / 345;
    const html = generateKeytagHtml(config, body, scaleFactor);

    const image = await nodeHtmlToImage({
      html,
      type: "png",
      transparent: false,
      puppeteerArgs: {
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
      },
    }) as Buffer;

    const sizeInches = SIZE_INCHES[size] || SIZE_INCHES["dymo30252"];

    return new NextResponse(image, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': `inline; filename="keytag-${body.roNumber}.png"`,
        'X-Keytag-Size': size,
        'X-Keytag-Width': sizeInches.width,
        'X-Keytag-Height': sizeInches.height,
      },
    });
  } catch (error) {
    console.error("Error generating keytag:", error);
    return NextResponse.json(
      { error: "Failed to generate keytag" },
      { status: 500 }
    );
  }
}
