import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken } from "@/lib/extension-auth";
import puppeteer from "puppeteer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

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
}

const SIZE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "dymo30252": { width: 1035, height: 333 },
};

const SIZE_INCHES: Record<string, { width: string; height: string }> = {
  "dymo30252": { width: "3.45in", height: "1.11in" },
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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
          <div class="info-row"><span class="info-label">RO#:</span> ${escapeHtml(String(data.roNumber))}</div>
        </div>
      </div>
    </body>
    </html>
  `;
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function GET(req: NextRequest) {
  const authResult = await validateExtensionToken(req);
  if (!authResult.authorized) {
    return NextResponse.json(
      { error: authResult.error || "Unauthorized" },
      { status: 401, headers: corsHeaders }
    );
  }

  const shopId = authResult.user?.shopId;
  if (!shopId) {
    return NextResponse.json(
      { error: "No shop associated with token" },
      { status: 400, headers: corsHeaders }
    );
  }

  try {
    const db = await getDb();
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { keytagConfig: 1, name: 1 } }
    );

    const config: KeytagConfig = shop?.keytagConfig || {
      enabled: true,
      fontStyles: {
        customerName: { bold: true, size: 14 },
        vehicleInfo: { bold: false, size: 12 },
        roNumber: { bold: true, size: 12 },
        mileage: { bold: true, size: 14 },
      },
      colors: {
        text: "#000000",
        background: "#FFFFFF",
      },
      defaultSize: "dymo30252",
    };

    return NextResponse.json(
      {
        config,
        shopName: shop?.name || "Unknown Shop",
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    console.error("Error fetching keytag config:", error);
    return NextResponse.json(
      { error: "Failed to fetch keytag configuration" },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function POST(req: NextRequest) {
  const authResult = await validateExtensionToken(req);
  if (!authResult.authorized) {
    return NextResponse.json(
      { error: authResult.error || "Unauthorized" },
      { status: 401, headers: corsHeaders }
    );
  }

  const shopId = authResult.user?.shopId;
  if (!shopId) {
    return NextResponse.json(
      { error: "No shop associated with token" },
      { status: 400, headers: corsHeaders }
    );
  }

  try {
    const body: KeytagRequest = await req.json();

    if (!body.customerName || !body.vehicleInfo || !body.roNumber) {
      return NextResponse.json(
        { error: "Missing required fields: customerName, vehicleInfo, roNumber" },
        { status: 400, headers: corsHeaders }
      );
    }

    const db = await getDb();
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { keytagConfig: 1 } }
    );

    const config: KeytagConfig = shop?.keytagConfig || {
      fontStyles: {
        customerName: { bold: true, size: 14 },
        vehicleInfo: { bold: false, size: 12 },
        roNumber: { bold: true, size: 12 },
        mileage: { bold: true, size: 14 },
      },
      colors: {
        text: "#000000",
        background: "#FFFFFF",
      },
      defaultSize: "dymo30252",
    };

    const size = config.defaultSize || "dymo30252";
    const dimensions = SIZE_DIMENSIONS[size] || SIZE_DIMENSIONS["dymo30252"];
    const scaleFactor = dimensions.width / 345;
    
    const html = generateKeytagHtml(config, body, scaleFactor);

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({
      width: dimensions.width,
      height: dimensions.height,
      deviceScaleFactor: 1,
    });
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const screenshot = await page.screenshot({
      type: 'png',
      omitBackground: false,
      encoding: 'base64',
    });

    await browser.close();

    const sizeInches = SIZE_INCHES[size] || SIZE_INCHES["dymo30252"];

    return NextResponse.json(
      {
        success: true,
        image: `data:image/png;base64,${screenshot}`,
        size: size,
        dimensions: {
          width: sizeInches.width,
          height: sizeInches.height,
        },
        roNumber: body.roNumber,
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    console.error("Error generating keytag:", error);
    return NextResponse.json(
      { error: "Failed to generate keytag" },
      { status: 500, headers: corsHeaders }
    );
  }
}
