import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import puppeteer from "puppeteer";

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
  const customerNameStyle = config.fontStyles?.customerName || { bold: true, italic: false, size: 14 };
  const vehicleInfoStyle = config.fontStyles?.vehicleInfo || { bold: false, italic: false, size: 12 };
  const roNumberStyle = config.fontStyles?.roNumber || { bold: true, italic: false, size: 12 };
  const mileageStyle = config.fontStyles?.mileage || { bold: true, italic: false, size: 14 };

  const customerNameSize = Math.round((customerNameStyle.size || 14) * scaleFactor);
  const vehicleInfoSize = Math.round((vehicleInfoStyle.size || 12) * scaleFactor);
  const roNumberSize = Math.round((roNumberStyle.size || 12) * scaleFactor);
  const mileageSize = Math.round((mileageStyle.size || 14) * scaleFactor);

  const textColor = config.colors?.text || "#000000";
  const backgroundColor = config.colors?.background || "#FFFFFF";

  const mileageFormatted = typeof data.mileage === 'number' 
    ? data.mileage.toLocaleString() 
    : data.mileage;

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        
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
          padding: ${Math.round(12 * scaleFactor)}px ${Math.round(16 * scaleFactor)}px;
          display: flex;
          flex-direction: row;
          justify-content: space-between;
          align-items: center;
          gap: ${Math.round(12 * scaleFactor)}px;
        }
        
        .left-section {
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: ${Math.round(4 * scaleFactor)}px;
          flex: 1;
        }
        
        .right-section {
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: flex-end;
          gap: ${Math.round(4 * scaleFactor)}px;
        }
        
        .customer-name {
          font-size: ${customerNameSize}px;
          font-weight: ${customerNameStyle.bold ? '700' : '400'};
          font-style: ${customerNameStyle.italic ? 'italic' : 'normal'};
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 100%;
        }
        
        .vehicle-info {
          font-size: ${vehicleInfoSize}px;
          font-weight: ${vehicleInfoStyle.bold ? '700' : '400'};
          font-style: ${vehicleInfoStyle.italic ? 'italic' : 'normal'};
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 100%;
          opacity: 0.85;
        }
        
        .ro-number {
          font-size: ${roNumberSize}px;
          font-weight: ${roNumberStyle.bold ? '700' : '400'};
          font-style: ${roNumberStyle.italic ? 'italic' : 'normal'};
          white-space: nowrap;
        }
        
        .mileage {
          font-size: ${mileageSize}px;
          font-weight: ${mileageStyle.bold ? '700' : '400'};
          font-style: ${mileageStyle.italic ? 'italic' : 'normal'};
          white-space: nowrap;
        }
        
        .mileage-label {
          font-size: ${Math.round(10 * scaleFactor)}px;
          opacity: 0.7;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
      </style>
    </head>
    <body>
      <div class="keytag">
        <div class="left-section">
          <div class="customer-name">${escapeHtml(data.customerName)}</div>
          <div class="vehicle-info">${escapeHtml(data.vehicleInfo)}</div>
        </div>
        <div class="right-section">
          <div class="ro-number">RO# ${escapeHtml(data.roNumber)}</div>
          <div class="mileage-label">Miles In</div>
          <div class="mileage">${escapeHtml(mileageFormatted)}</div>
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
    const body: KeytagRequest = await req.json();
    
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
    });

    await browser.close();

    const sizeInches = SIZE_INCHES[size] || SIZE_INCHES["dymo30252"];

    return new NextResponse(screenshot, {
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
