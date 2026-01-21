import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getStickerRedirectUrl } from "@/lib/sticker-utils";
import nodeHtmlToImage from "node-html-to-image";
import QRCode from "qrcode";
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

const HOVERCODE_API_BASE = "https://hovercode.com/api/v2/hovercode";
const HOVERCODE_API_TOKEN = process.env.HOVERCODE_API_TOKEN;
const HOVERCODE_WORKSPACE_ID = process.env.HOVERCODE_WORKSPACE_ID;

async function fetchImageAsDataUri(imageUrl: string): Promise<string | null> {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "image/png";
    return `data:${contentType};base64,${Buffer.from(buffer).toString("base64")}`;
  } catch (error) {
    console.error("[Sticker Generate] Failed to fetch image:", error);
    return null;
  }
}

async function getExistingHovercodeQR(hovercodeId: string): Promise<{ dataUri: string | null; svg: string | null }> {
  if (!HOVERCODE_API_TOKEN) {
    console.error("[Sticker Generate] HoverCode API token not configured");
    return { dataUri: null, svg: null };
  }

  try {
    const response = await fetch(`${HOVERCODE_API_BASE}/${hovercodeId}/`, {
      method: "GET",
      headers: {
        "Authorization": `Token ${HOVERCODE_API_TOKEN}`,
      },
    });

    if (!response.ok) {
      console.error("[Sticker Generate] HoverCode retrieve error:", response.status);
      return { dataUri: null, svg: null };
    }

    const data = await response.json();
    
    if (data.png) {
      const dataUri = await fetchImageAsDataUri(data.png);
      if (dataUri) return { dataUri, svg: data.svg || null };
    }
    
    if (data.svg) {
      const svgBase64 = Buffer.from(data.svg).toString("base64");
      return { dataUri: `data:image/svg+xml;base64,${svgBase64}`, svg: data.svg };
    }
    
    return { dataUri: null, svg: null };
  } catch (error) {
    console.error("[Sticker Generate] HoverCode retrieve failed:", error);
    return { dataUri: null, svg: null };
  }
}

interface HovercodeCreateResult {
  id: string;
  dataUri: string | null;
}

async function createHovercodeQR(
  url: string,
  options: { size?: number; color?: string; backgroundColor?: string; displayName?: string } = {}
): Promise<HovercodeCreateResult | null> {
  const { size = 300, color = "#1976d2", backgroundColor = "#ffffff", displayName } = options;

  if (!HOVERCODE_API_TOKEN || !HOVERCODE_WORKSPACE_ID) {
    console.error("[Sticker Generate] HoverCode credentials not configured");
    return null;
  }

  try {
    const response = await fetch(`${HOVERCODE_API_BASE}/create/`, {
      method: "POST",
      headers: {
        "Authorization": `Token ${HOVERCODE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace: HOVERCODE_WORKSPACE_ID,
        qr_data: url,
        dynamic: true,
        display_name: displayName || "Oil Sticker QR",
        primary_color: color,
        background_color: backgroundColor,
        pattern: "Squares",
        eye_style: "Rounded",
        size: size,
        logo_url: "https://mos-maintenance-mvp.replit.app/sticker-qr-logo.png",
        generate_png: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Sticker Generate] HoverCode create error:", response.status, errorText);
      return null;
    }

    const data = await response.json();
    const hovercodeId = data.id;
    
    let dataUri: string | null = null;
    if (data.png) {
      dataUri = await fetchImageAsDataUri(data.png);
    }
    if (!dataUri && data.svg) {
      dataUri = `data:image/svg+xml;base64,${Buffer.from(data.svg).toString("base64")}`;
    }
    
    return { id: hovercodeId, dataUri };
  } catch (error) {
    console.error("[Sticker Generate] HoverCode create failed:", error);
    return null;
  }
}

async function fallbackQRGeneration(url: string, color: string = "#1976d2"): Promise<string> {
  const qrDataUrl = await QRCode.toDataURL(url, {
    width: 300,
    margin: 2,
    color: { dark: color, light: "#ffffff" },
    errorCorrectionLevel: "H",
  });
  return qrDataUrl;
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
    taglineLine2Color?: string;
    serviceLabelColor?: string;
    serviceValueColor?: string;
  };
  appointmentUrl?: string;
  useKilometers?: boolean;
  hovercodeQRId?: string;
  roundMileage?: boolean;
}

interface StickerRequest {
  vin?: string;
  vehicleYear?: number;
  vehicleMake?: string;
  vehicleModel?: string;
  currentMileage?: number;
  nextServiceMileage?: number;
  nextServiceDate?: string;
  size?: "1.5x2.25" | "2x2" | "2x2.5" | "2x3" | "2x3.5";
  includeQR?: boolean;
  previewConfig?: StickerConfig;
  useKilometers?: boolean;
  useHours?: boolean;
  designerLayout?: DesignerLayout;
  dataConfig?: {
    logo?: string;
    phone?: string;
    tagline?: string;
    taglineLine2?: string;
    serviceLabel?: string;
    useKilometers?: boolean;
    roundMileage?: boolean;
  };
}

interface DesignerElement {
  id: string;
  type: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  textAlign: 'left' | 'center' | 'right';
  color: string;
  backgroundColor?: string;
  visible: boolean;
  showLabel?: boolean;
  imageFit?: 'contain' | 'cover';
  content?: string;
}

interface DesignerLayout {
  elements: DesignerElement[];
  canvasWidth: number;
  canvasHeight: number;
  gridSize: number;
  showGrid: boolean;
  backgroundColor: string;
  version?: number;
}

const SIZE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "1.5x2.25": { width: 443, height: 665 },
  "2x2": { width: 591, height: 591 },
  "2x2.5": { width: 591, height: 739 },
  "2x3": { width: 591, height: 887 },
  "2x3.5": { width: 591, height: 1035 },
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
  const taglineLine2Color = config.colors?.taglineLine2Color || config.colors?.taglineColor || "#333333";
  const serviceLabelColor = config.colors?.serviceLabelColor || "#666666";
  const serviceValueColor = config.colors?.serviceValueColor || config.colors?.primary || "#cc0000";
  const useHours = typeof data.useHours === "boolean" ? data.useHours : false;
  const useKilometers = typeof data.useKilometers === "boolean" ? data.useKilometers : !!config.useKilometers;
  const distanceUnit = useHours ? "hrs" : useKilometers ? "km" : "mi";

  const formattedDate = data.nextServiceDate
    ? new Date(data.nextServiceDate).toLocaleDateString("en-US", {
        month: "numeric",
        day: "numeric",
        year: "numeric",
      })
    : "";

  let mileageValue = data.nextServiceMileage;
  if (mileageValue && config.roundMileage) {
    mileageValue = Math.round(mileageValue / 100) * 100;
  }
  const formattedMileage = mileageValue
    ? mileageValue.toLocaleString()
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
  const qrSize = Math.round(80 * scaleFactor);
  const padding = Math.round(10 * scaleFactor);
  
  const labelSizeRaw = Math.round((serviceLabelFontStyle.size || 12) * scaleFactor);
  const valueSizeRaw = Math.round((serviceValueFontStyle.size || 14) * scaleFactor);
  const maxLabelSize = Math.round(22 * scaleFactor);
  const maxValueSize = Math.round(28 * scaleFactor);
  const labelSize = Math.min(labelSizeRaw, maxLabelSize);
  const valueSize = Math.min(valueSizeRaw, maxValueSize);

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
      color: ${taglineLine2Color};
    }
    .bottom-section {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      margin-top: ${Math.round(5 * scaleFactor)}px;
      gap: ${Math.round(5 * scaleFactor)}px;
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
      flex-shrink: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
      overflow: hidden;
    }
    .service-label {
      font-size: ${labelSize}px;
      font-weight: ${serviceLabelFontStyle.bold ? "bold" : "normal"};
      font-style: ${serviceLabelFontStyle.italic ? "italic" : "normal"};
      color: ${serviceLabelColor};
      margin-bottom: ${Math.round(8 * scaleFactor)}px;
      white-space: nowrap;
    }
    .service-date {
      font-size: ${valueSize}px;
      font-weight: ${serviceValueFontStyle.bold ? "bold" : "normal"};
      font-style: ${serviceValueFontStyle.italic ? "italic" : "normal"};
      color: ${serviceValueColor};
      white-space: nowrap;
    }
    .service-mileage {
      font-size: ${valueSize}px;
      font-weight: ${serviceValueFontStyle.bold ? "bold" : "normal"};
      font-style: ${serviceValueFontStyle.italic ? "italic" : "normal"};
      color: ${serviceValueColor};
      white-space: nowrap;
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

function generateStickerHtmlFromLayout(
  layout: DesignerLayout,
  dataConfig: StickerRequest['dataConfig'],
  data: StickerRequest,
  dimensions: { width: number; height: number },
  logoDataUrl: string | null,
  qrDataUrl: string | null
): string {
  const scaleX = dimensions.width / layout.canvasWidth;
  const scaleY = dimensions.height / layout.canvasHeight;
  
  const useKilometers = dataConfig?.useKilometers ?? false;
  const roundMileage = dataConfig?.roundMileage ?? true;
  const distanceUnit = useKilometers ? "km" : "mi";
  
  const formattedDate = data.nextServiceDate
    ? new Date(data.nextServiceDate).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";
  
  let mileageValue = data.nextServiceMileage;
  if (mileageValue && roundMileage) {
    mileageValue = Math.round(mileageValue / 100) * 100;
  }
  const formattedMileage = mileageValue ? mileageValue.toLocaleString() : "";
  
  const getElementContent = (element: DesignerElement): string => {
    switch (element.type) {
      case 'logo':
        if (logoDataUrl) {
          return `<img src="${logoDataUrl}" style="width:100%;height:100%;object-fit:${element.imageFit || 'contain'};" />`;
        }
        return '';
      case 'qrCode':
        if (qrDataUrl) {
          return `<img src="${qrDataUrl}" style="width:100%;height:100%;object-fit:contain;" />`;
        }
        return '';
      case 'phone':
        return dataConfig?.phone || '';
      case 'tagline':
        return dataConfig?.tagline || '';
      case 'taglineLine2':
        return dataConfig?.taglineLine2 || '';
      case 'serviceLabel':
        return element.content || dataConfig?.serviceLabel || 'Next Oil Service';
      case 'serviceDate':
        return formattedDate;
      case 'serviceMileage':
        return formattedMileage ? `${formattedMileage} ${distanceUnit}` : '';
      default:
        return element.content || '';
    }
  };
  
  const visibleElements = layout.elements.filter(el => el.visible);
  
  const elementsHtml = visibleElements.map(element => {
    const x = Math.round(element.x * scaleX);
    const y = Math.round(element.y * scaleY);
    const width = Math.round(element.width * scaleX);
    const height = Math.round(element.height * scaleY);
    const fontSize = Math.round(element.fontSize * Math.min(scaleX, scaleY));
    
    const content = getElementContent(element);
    if (!content) return '';
    
    const isImage = element.type === 'logo' || element.type === 'qrCode';
    
    return `
      <div style="
        position: absolute;
        left: ${x}px;
        top: ${y}px;
        width: ${width}px;
        height: ${height}px;
        ${!isImage ? `
          font-size: ${fontSize}px;
          font-weight: ${element.fontWeight};
          font-style: ${element.fontStyle};
          text-align: ${element.textAlign};
          color: ${element.color};
          display: flex;
          align-items: center;
          justify-content: ${element.textAlign === 'center' ? 'center' : element.textAlign === 'right' ? 'flex-end' : 'flex-start'};
          overflow: hidden;
          white-space: nowrap;
          line-height: 1.2;
        ` : ''}
        ${element.backgroundColor ? `background-color: ${element.backgroundColor};` : ''}
      ">
        ${content}
      </div>
    `;
  }).join('');
  
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
      background: ${layout.backgroundColor};
      position: relative;
    }
  </style>
</head>
<body>
  ${elementsHtml}
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

    const dbConfig: StickerConfig = shop.stickerConfig || {};
    const config: StickerConfig = body.previewConfig ? { ...dbConfig, ...body.previewConfig } : dbConfig;
    const dimensions = SIZE_DIMENSIONS[size] || SIZE_DIMENSIONS["2x2.5"];

    let logoDataUrl: string | null = null;
    if (config.logo || config.logoObjectPath) {
      logoDataUrl = await fetchLogoAsBase64(config.logo || "", config.logoObjectPath);
    }
    const configWithBase64Logo = { ...config, logo: logoDataUrl || undefined };

    let qrDataUrl: string | null = null;
    if (includeQR) {
      const redirectUrl = config.appointmentUrl || getStickerRedirectUrl(shopId);
      const qrColor = config.colors?.primary || "#1976d2";
      const qrBgColor = config.colors?.background || "#ffffff";
      const shopName = shop.name || `Shop ${shopId}`;
      
      if (config.hovercodeQRId) {
        console.log(`[Sticker Generate] Using existing HoverCode QR: ${config.hovercodeQRId}`);
        const existingQR = await getExistingHovercodeQR(config.hovercodeQRId);
        if (existingQR.dataUri) {
          qrDataUrl = existingQR.dataUri;
        }
      }
      
      if (!qrDataUrl) {
        const newQR = await createHovercodeQR(redirectUrl, {
          size: 300,
          color: qrColor,
          backgroundColor: qrBgColor,
          displayName: `${shopName} - Oil Sticker`,
        });
        
        if (newQR?.dataUri) {
          qrDataUrl = newQR.dataUri;
          
          if (newQR.id && !config.hovercodeQRId) {
            await db.collection("shops").updateOne(
              { shopId },
              { $set: { "stickerConfig.hovercodeQRId": newQR.id } }
            );
            console.log(`[Sticker Generate] Saved new HoverCode QR ID: ${newQR.id}`);
          }
        }
      }
      
      if (!qrDataUrl) {
        console.log("[Sticker Generate] HoverCode failed, using fallback QR");
        qrDataUrl = await fallbackQRGeneration(redirectUrl, qrColor);
      }
    }

    let html: string;
    
    const designerLayout = body.designerLayout || shop.stickerConfig?.designerLayout;
    
    console.log("[Sticker Generate] designerLayout from body:", !!body.designerLayout);
    console.log("[Sticker Generate] designerLayout from shop:", !!shop.stickerConfig?.designerLayout);
    console.log("[Sticker Generate] Using designer layout:", !!(designerLayout && designerLayout.elements));
    
    if (designerLayout && designerLayout.elements) {
      console.log("[Sticker Generate] Layout canvas:", designerLayout.canvasWidth, "x", designerLayout.canvasHeight);
      console.log("[Sticker Generate] Output dimensions:", dimensions.width, "x", dimensions.height);
      console.log("[Sticker Generate] Scale factors:", dimensions.width / designerLayout.canvasWidth, "x", dimensions.height / designerLayout.canvasHeight);
      console.log("[Sticker Generate] Elements count:", designerLayout.elements.length);
      const dataConfig = body.dataConfig || {
        logo: config.logo,
        phone: config.phone,
        tagline: config.tagline,
        taglineLine2: config.taglineLine2,
        serviceLabel: config.serviceLabel,
        useKilometers: config.useKilometers,
        roundMileage: config.roundMileage,
      };
      html = generateStickerHtmlFromLayout(
        designerLayout,
        dataConfig,
        body,
        dimensions,
        logoDataUrl,
        qrDataUrl
      );
    } else {
      html = generateStickerHtml(configWithBase64Logo, body, qrDataUrl, dimensions);
    }

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
