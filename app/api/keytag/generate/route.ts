import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import nodeHtmlToImage from "node-html-to-image";
import { DesignerLayout, DesignerElement, DYMO_30252 } from "@/lib/keytag-designer-types";

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
  designerLayout?: DesignerLayout;
}

interface KeytagRequest {
  customerName: string;
  vehicleInfo: string;
  vin?: string;
  roNumber: string;
  mileage: string | number;
  previewConfig?: KeytagConfig;
  designerLayout?: DesignerLayout;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function validateLayout(layout: DesignerLayout): DesignerLayout {
  if (!layout.elements || !Array.isArray(layout.elements)) {
    return { ...layout, elements: [] };
  }
  
  const clampedElements = layout.elements.map((el) => ({
    ...el,
    x: Math.max(0, Math.min(el.x || 0, DYMO_30252.width - 30)),
    y: Math.max(0, Math.min(el.y || 0, DYMO_30252.height - 15)),
    width: Math.max(30, Math.min(el.width || 100, DYMO_30252.width)),
    height: Math.max(15, Math.min(el.height || 30, DYMO_30252.height)),
    fontSize: Math.max(8, Math.min(el.fontSize || 12, 72)),
  }));
  
  return { ...layout, elements: clampedElements };
}

function generateDesignerHtml(layout: DesignerLayout, data: KeytagRequest): string {
  const validatedLayout = validateLayout(layout);
  const scaleFactor = DYMO_30252.renderWidth / DYMO_30252.width;
  
  const dataMap: Record<string, string> = {
    customerName: data.customerName?.toUpperCase() || '',
    vehicleInfo: data.vehicleInfo?.toUpperCase() || '',
    vin: data.vin || '',
    roNumber: data.roNumber || '',
    mileage: typeof data.mileage === 'number' ? data.mileage.toLocaleString() : (data.mileage || ''),
  };

  const elementsHtml = validatedLayout.elements
    .filter((el) => el.visible)
    .map((el) => {
      const value = dataMap[el.type] || el.label;
      const displayText = el.showLabel ? `${el.label}: ${value}` : value;
      
      const left = el.x * scaleFactor;
      const top = el.y * scaleFactor;
      const width = el.width * scaleFactor;
      const height = el.height * scaleFactor;
      const fontSize = el.fontSize * scaleFactor;

      return `
        <div style="
          position: absolute;
          left: ${left}px;
          top: ${top}px;
          width: ${width}px;
          height: ${height}px;
          font-size: ${fontSize}px;
          font-weight: ${el.fontWeight};
          font-style: ${el.fontStyle};
          text-align: ${el.textAlign};
          display: flex;
          align-items: center;
          justify-content: ${el.textAlign === 'center' ? 'center' : el.textAlign === 'right' ? 'flex-end' : 'flex-start'};
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
          color: ${validatedLayout.textColor};
        ">${escapeHtml(displayText)}</div>
      `;
    })
    .join('');

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
        
        html, body {
          width: ${DYMO_30252.renderWidth}px;
          height: ${DYMO_30252.renderHeight}px;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          background: ${validatedLayout.backgroundColor};
        }
        
        .canvas {
          position: relative;
          width: ${DYMO_30252.renderWidth}px;
          height: ${DYMO_30252.renderHeight}px;
        }
      </style>
    </head>
    <body>
      <div class="canvas">
        ${elementsHtml}
      </div>
    </body>
    </html>
  `;
}

function generateLegacyHtml(
  config: KeytagConfig,
  data: KeytagRequest
): string {
  const textColor = config.colors?.text || "#000000";
  const backgroundColor = config.colors?.background || "#FFFFFF";
  const scaleFactor = DYMO_30252.renderWidth / 345;

  const mileageFormatted = typeof data.mileage === 'number' 
    ? data.mileage.toLocaleString() 
    : data.mileage;

  const baseFontSize = Math.round(10 * scaleFactor);
  const nameFontSize = Math.round(16 * scaleFactor);
  const vehicleFontSize = Math.round(10 * scaleFactor);
  const padding = Math.round(12 * scaleFactor);
  const gap = Math.round(14 * scaleFactor);

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
        
        html, body {
          width: ${DYMO_30252.renderWidth}px;
          height: ${DYMO_30252.renderHeight}px;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          background: ${backgroundColor};
          color: ${textColor};
        }
        
        .keytag {
          width: 100%;
          height: 100%;
          padding: ${padding}px;
          display: flex;
          flex-direction: row;
          align-items: stretch;
        }
        
        .left-section {
          display: flex;
          flex-direction: column;
          justify-content: center;
          flex: 0.9;
          padding-right: ${gap}px;
          min-width: 0;
        }
        
        .divider {
          width: 2px;
          background: ${textColor};
          flex-shrink: 0;
        }
        
        .right-section {
          display: flex;
          flex-direction: column;
          justify-content: center;
          padding-left: ${gap}px;
          flex: 1.1;
          min-width: 0;
        }
        
        .customer-name {
          font-size: ${nameFontSize}px;
          font-weight: 700;
          text-transform: uppercase;
          white-space: nowrap;
          text-decoration: underline;
          margin-bottom: ${Math.round(4 * scaleFactor)}px;
        }
        
        .vehicle-info {
          font-size: ${vehicleFontSize}px;
          font-weight: 400;
          text-transform: uppercase;
          white-space: nowrap;
        }
        
        .info-row {
          font-size: ${baseFontSize}px;
          font-weight: 400;
          white-space: nowrap;
          margin-bottom: ${Math.round(4 * scaleFactor)}px;
        }
        
        .info-row:last-child {
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
    const designerLayout = body.designerLayout || config.designerLayout;
    
    let html: string;
    if (designerLayout) {
      html = generateDesignerHtml(designerLayout, body);
    } else {
      html = generateLegacyHtml(config, body);
    }

    const image = await nodeHtmlToImage({
      html,
      type: "png",
      transparent: false,
      puppeteerArgs: {
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
      },
    });

    const imageBuffer = Buffer.isBuffer(image) ? image : Buffer.from(image as ArrayBuffer);

    return new NextResponse(imageBuffer, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': `inline; filename="keytag-${body.roNumber}.png"`,
        'X-Keytag-Size': 'dymo30252',
        'X-Keytag-Width': '3.45in',
        'X-Keytag-Height': '1.11in',
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
