import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken } from "@/lib/extension-auth";
import { renderHtmlToImage } from "@/lib/browser-pool";
import QRCode from "qrcode";
import { Storage } from "@google-cloud/storage";
import { getStickerRedirectUrl } from "@/lib/sticker-utils";
import { triggerAutoBookingFromSticker, StickerBookingData } from "@/lib/auto-booking/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

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

const DEFAULT_INTERVALS = {
  diesel: { mileage: 7500, months: 6 },
  euro: { mileage: 10000, months: 12 },
  synthetic: { mileage: 7500, months: 6 },
  conventional: { mileage: 3000, months: 3 },
};

const SIZE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "1.5x2.25": { width: 443, height: 665 },
  "2x2": { width: 591, height: 591 },
  "2x2.5": { width: 591, height: 739 },
  "2x3": { width: 591, height: 887 },
  "2x3.5": { width: 591, height: 1035 },
};

const SIZE_INCHES: Record<string, { width: string; height: string }> = {
  "1.5x2.25": { width: "1.48in", height: "2.22in" },
  "2x2": { width: "1.97in", height: "1.97in" },
  "2x2.5": { width: "1.97in", height: "2.46in" },
  "2x3": { width: "1.97in", height: "2.96in" },
  "2x3.5": { width: "1.97in", height: "3.45in" },
};

const HOVERCODE_API_BASE = "https://hovercode.com/api/v2/hovercode";
const HOVERCODE_API_TOKEN = process.env.HOVERCODE_API_TOKEN;

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
    console.error("[Extension Sticker] Logo fetch failed:", error);
    return null;
  }
}

async function fetchImageAsDataUri(imageUrl: string): Promise<string | null> {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "image/png";
    return `data:${contentType};base64,${Buffer.from(buffer).toString("base64")}`;
  } catch (error) {
    return null;
  }
}

async function getExistingHovercodeQR(hovercodeId: string): Promise<string | null> {
  if (!HOVERCODE_API_TOKEN) return null;

  try {
    const response = await fetch(`${HOVERCODE_API_BASE}/${hovercodeId}/`, {
      method: "GET",
      headers: { "Authorization": `Token ${HOVERCODE_API_TOKEN}` },
    });

    if (!response.ok) return null;

    const data = await response.json();
    
    if (data.png) {
      return await fetchImageAsDataUri(data.png);
    }
    if (data.svg) {
      return `data:image/svg+xml;base64,${Buffer.from(data.svg).toString("base64")}`;
    }
    return null;
  } catch {
    return null;
  }
}

async function fallbackQRGeneration(url: string, color: string = "#1976d2"): Promise<string> {
  return await QRCode.toDataURL(url, {
    width: 300,
    margin: 2,
    color: { dark: color, light: "#ffffff" },
    errorCorrectionLevel: "H",
  });
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
  defaultSize?: string;
  intervals?: {
    conventional?: { mileage: number; months: number };
    synthetic?: { mileage: number; months: number };
    euro?: { mileage: number; months: number };
    diesel?: { mileage: number; months: number };
  };
  designerLayout?: DesignerLayout;
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

function generateStickerHtml(
  config: StickerConfig,
  nextServiceMileage: number,
  nextServiceDate: string,
  useHours: boolean,
  useKilometers: boolean,
  qrDataUrl: string | null,
  dimensions: { width: number; height: number }
): string {
  const backgroundColor = config.colors?.background || "#ffffff";
  const phoneColor = config.colors?.phoneColor || "#000000";
  const taglineColor = config.colors?.taglineColor || "#333333";
  const taglineLine2Color = config.colors?.taglineLine2Color || config.colors?.taglineColor || "#333333";
  const serviceLabelColor = config.colors?.serviceLabelColor || "#666666";
  const serviceValueColor = config.colors?.serviceValueColor || config.colors?.primary || "#cc0000";
  const distanceUnit = useHours ? "hrs" : useKilometers ? "km" : "mi";

  const formattedDate = nextServiceDate
    ? new Date(nextServiceDate).toLocaleDateString("en-US", {
        month: "numeric",
        day: "numeric",
        year: "numeric",
      })
    : "";

  let mileageValue = nextServiceMileage;
  if (mileageValue && config.roundMileage) {
    mileageValue = Math.round(mileageValue / 100) * 100;
  }
  const formattedMileage = mileageValue ? mileageValue.toLocaleString() : "";

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
      padding: ${padding}px;
    }
    .logo-container { 
      display: flex;
      justify-content: center;
      align-items: center;
      height: ${logoHeight}px;
      margin-bottom: ${Math.round(6 * scaleFactor)}px;
    }
    .logo { max-height: 100%; max-width: ${dimensions.width - padding * 2}px; object-fit: contain; }
    .phone {
      font-size: ${phoneSize}px;
      font-weight: ${phoneFontStyle.bold ? 'bold' : 'normal'};
      font-style: ${phoneFontStyle.italic ? 'italic' : 'normal'};
      color: ${phoneColor};
      margin-bottom: ${Math.round(4 * scaleFactor)}px;
    }
    .tagline {
      font-size: ${taglineSize}px;
      font-weight: ${taglineFontStyle.bold ? 'bold' : 'normal'};
      font-style: ${taglineFontStyle.italic ? 'italic' : 'normal'};
      color: ${taglineColor};
      text-align: center;
    }
    .tagline-line2 {
      font-size: ${taglineLine2Size}px;
      font-weight: ${taglineLine2FontStyle.bold ? 'bold' : 'normal'};
      font-style: ${taglineLine2FontStyle.italic ? 'italic' : 'normal'};
      color: ${taglineLine2Color};
      text-align: center;
      margin-bottom: ${Math.round(8 * scaleFactor)}px;
    }
    .service-section {
      display: flex;
      align-items: center;
      width: 100%;
      flex: 1;
      gap: ${Math.round(10 * scaleFactor)}px;
    }
    .qr-container { flex-shrink: 0; }
    .qr-code { width: ${qrSize}px; height: ${qrSize}px; }
    .service-info { flex: 1; text-align: center; }
    .service-label {
      font-size: ${labelSize}px;
      font-weight: ${serviceLabelFontStyle.bold ? 'bold' : 'normal'};
      font-style: ${serviceLabelFontStyle.italic ? 'italic' : 'normal'};
      color: ${serviceLabelColor};
      margin-bottom: ${Math.round(4 * scaleFactor)}px;
    }
    .service-value {
      font-size: ${valueSize}px;
      font-weight: ${serviceValueFontStyle.bold ? 'bold' : 'normal'};
      font-style: ${serviceValueFontStyle.italic ? 'italic' : 'normal'};
      color: ${serviceValueColor};
      line-height: 1.3;
    }
  </style>
</head>
<body>
  ${config.logo ? `<div class="logo-container"><img class="logo" src="${config.logo}" /></div>` : ''}
  ${config.phone ? `<div class="phone">${config.phone}</div>` : ''}
  ${config.tagline ? `<div class="tagline">${config.tagline}</div>` : ''}
  ${config.taglineLine2 ? `<div class="tagline-line2">${config.taglineLine2}</div>` : ''}
  <div class="service-section">
    ${qrDataUrl ? `<div class="qr-container"><img class="qr-code" src="${qrDataUrl}" /></div>` : ''}
    <div class="service-info">
      <div class="service-label">${config.serviceLabel || 'Next Svc Due:'}</div>
      <div class="service-value">
        ${formattedDate}<br/>
        ${formattedMileage} ${distanceUnit}
      </div>
    </div>
  </div>
</body>
</html>`;
}

function generateStickerHtmlFromLayout(
  layout: DesignerLayout,
  config: StickerConfig,
  nextServiceMileage: number,
  nextServiceDate: string,
  useKilometers: boolean,
  logoDataUrl: string | null,
  qrDataUrl: string | null,
  dimensions: { width: number; height: number }
): string {
  const scaleX = dimensions.width / layout.canvasWidth;
  const scaleY = dimensions.height / layout.canvasHeight;
  
  const distanceUnit = useKilometers ? "km" : "mi";
  const roundMileage = config.roundMileage !== false;
  
  const formattedDate = nextServiceDate
    ? new Date(nextServiceDate).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";
  
  let mileageValue = nextServiceMileage;
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
        return config.phone || '';
      case 'tagline':
        return config.tagline || '';
      case 'taglineLine2':
        return config.taglineLine2 || '';
      case 'serviceLabel':
        return element.content || config.serviceLabel || 'Next Oil Service';
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

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function resolveMosShopId(
  db: any,
  authResult: any,
  smsShopId?: string | null,
  provider?: string | null
): Promise<{ mosShopId: number | null; shop: any }> {
  const isPlatformAdmin = authResult.user?.role === "platform_admin";
  const userShopIds = [
    ...(authResult.user?.shopId ? [Number(authResult.user.shopId)] : []),
    ...(authResult.user?.shopIds || []).map((id: any) => Number(id)),
  ];

  if (smsShopId && provider === "tekmetric") {
    const tekShopIdNum = parseInt(smsShopId);
    const tekShopIdStr = String(smsShopId);
    const query: any = {
      $or: [
        { "tekmetric.shopId": tekShopIdNum },
        { "tekmetric.shopId": tekShopIdStr },
        { tekmetricShopId: tekShopIdNum },
        { tekmetricShopId: tekShopIdStr },
      ],
    };
    if (!isPlatformAdmin) {
      query.shopId = { $in: userShopIds };
    }
    const shop = await db.collection("shops").findOne(query);
    if (shop) {
      console.log(`[Extension Sticker] Found MOS shop ${shop.shopId} for Tekmetric shop ${smsShopId}`);
      return { mosShopId: shop.shopId, shop };
    }
  } else if (smsShopId && provider === "protractor") {
    const query: any = { "protractor.connectionId": smsShopId };
    if (!isPlatformAdmin) {
      query.shopId = { $in: userShopIds };
    }
    const shop = await db.collection("shops").findOne(query);
    if (shop) {
      return { mosShopId: shop.shopId, shop };
    }
  }

  // Fallback to user's primary shop
  if (authResult.user?.shopId) {
    const shop = await db.collection("shops").findOne({ shopId: Number(authResult.user.shopId) });
    return { mosShopId: shop?.shopId || null, shop };
  }

  return { mosShopId: null, shop: null };
}

export async function GET(request: NextRequest) {
  try {
    const authResult = await validateExtensionToken(request);
    if (!authResult.authorized || !authResult.user) {
      return NextResponse.json(
        { error: authResult.error || "Unauthorized" },
        { status: 401, headers: corsHeaders }
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const smsShopId = searchParams.get("shopId");
    const provider = searchParams.get("provider") || "tekmetric";

    const db = await getDb();
    const { mosShopId, shop } = await resolveMosShopId(db, authResult, smsShopId, provider);

    console.log(`[Extension Sticker] GET: smsShopId=${smsShopId}, provider=${provider}, mosShopId=${mosShopId}, features=${JSON.stringify(shop?.features || [])}`);

    if (!shop) {
      return NextResponse.json(
        { error: "Shop not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    const stickerConfig: StickerConfig = shop.stickerConfig || {};
    const hasOilStickerFeature = shop.enabledFeatures?.oil_sticker === true;

    console.log(`[Extension Sticker] Shop ${mosShopId}: hasOilStickerFeature=${hasOilStickerFeature}, enabledFeatures=${JSON.stringify(shop.enabledFeatures)}`);

    return NextResponse.json({
      enabled: hasOilStickerFeature,
      config: {
        defaultSize: stickerConfig.defaultSize || "2x2.5",
        useKilometers: stickerConfig.useKilometers || false,
        roundMileage: stickerConfig.roundMileage ?? true,
        intervals: {
          conventional: stickerConfig.intervals?.conventional || DEFAULT_INTERVALS.conventional,
          synthetic: stickerConfig.intervals?.synthetic || DEFAULT_INTERVALS.synthetic,
          euro: stickerConfig.intervals?.euro || DEFAULT_INTERVALS.euro,
          diesel: stickerConfig.intervals?.diesel || DEFAULT_INTERVALS.diesel,
        },
      },
    }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Extension Sticker] Config error:", error);
    return NextResponse.json(
      { error: "Failed to fetch sticker config" },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const authResult = await validateExtensionToken(request);
    if (!authResult.authorized || !authResult.user) {
      return NextResponse.json(
        { error: authResult.error || "Unauthorized" },
        { status: 401, headers: corsHeaders }
      );
    }

    const body = await request.json();
    const {
      currentMileage,
      intervalType = "synthetic",
      customMileage,
      customMonths,
      unit = "mi",
      smsShopId,
      provider = "tekmetric",
      tagline,
      // Customer/vehicle data for auto booking
      customerId,
      customerName,
      customerPhone,
      customerEmail,
      vehicleId,
      vin,
      vehicleYear,
      vehicleMake,
      vehicleModel,
      roNumber,
    } = body;

    if (!currentMileage || currentMileage <= 0) {
      return NextResponse.json(
        { error: "currentMileage is required and must be positive" },
        { status: 400, headers: corsHeaders }
      );
    }

    const db = await getDb();
    const { mosShopId, shop } = await resolveMosShopId(db, authResult, smsShopId, provider);

    if (!shop) {
      return NextResponse.json(
        { error: "Shop not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    const stickerConfig: StickerConfig = shop.stickerConfig || {};
    const intervals = {
      conventional: stickerConfig.intervals?.conventional || DEFAULT_INTERVALS.conventional,
      synthetic: stickerConfig.intervals?.synthetic || DEFAULT_INTERVALS.synthetic,
      euro: stickerConfig.intervals?.euro || DEFAULT_INTERVALS.euro,
      diesel: stickerConfig.intervals?.diesel || DEFAULT_INTERVALS.diesel,
    };

    let intervalMileage: number;
    let intervalMonths: number;

    if (intervalType === "custom") {
      intervalMileage = customMileage || 5000;
      intervalMonths = customMonths || 6;
    } else {
      const interval = intervals[intervalType as keyof typeof intervals] || intervals.synthetic;
      intervalMileage = interval.mileage;
      intervalMonths = interval.months;
    }

    const nextServiceMileage = currentMileage + intervalMileage;
    const nextDate = new Date();
    nextDate.setMonth(nextDate.getMonth() + intervalMonths);
    const nextServiceDate = nextDate.toISOString().split("T")[0];

    const size = stickerConfig.defaultSize || "2x2.5";
    const dimensions = SIZE_DIMENSIONS[size] || SIZE_DIMENSIONS["2x2.5"];
    const useKilometers = unit === "km";
    const useHours = unit === "hrs";

    let logoDataUrl: string | null = null;
    if (stickerConfig.logo || stickerConfig.logoObjectPath) {
      logoDataUrl = await fetchLogoAsBase64(stickerConfig.logo || "", stickerConfig.logoObjectPath);
    }
    const configWithLogo = { 
      ...stickerConfig, 
      logo: logoDataUrl || undefined,
      ...(tagline ? { tagline } : {}),
    };

    let qrDataUrl: string | null = null;
    const redirectUrl = stickerConfig.appointmentUrl || getStickerRedirectUrl(mosShopId!);
    const qrColor = stickerConfig.colors?.primary || "#1976d2";

    if (stickerConfig.hovercodeQRId) {
      qrDataUrl = await getExistingHovercodeQR(stickerConfig.hovercodeQRId);
    }
    if (!qrDataUrl) {
      qrDataUrl = await fallbackQRGeneration(redirectUrl, qrColor);
    }

    let html: string;
    
    if (stickerConfig.designerLayout && stickerConfig.designerLayout.elements) {
      html = generateStickerHtmlFromLayout(
        stickerConfig.designerLayout,
        configWithLogo,
        nextServiceMileage,
        nextServiceDate,
        useKilometers,
        logoDataUrl,
        qrDataUrl,
        dimensions
      );
    } else {
      html = generateStickerHtml(
        configWithLogo,
        nextServiceMileage,
        nextServiceDate,
        useHours,
        useKilometers,
        qrDataUrl,
        dimensions
      );
    }

    const image = await renderHtmlToImage(html, {
      width: dimensions.width,
      height: dimensions.height,
    });

    await db.collection("sticker_generations").insertOne({
      shopId: mosShopId,
      generatedAt: new Date(),
      generatedBy: authResult.user.email,
      source: "extension",
      size,
      unit,
    });

    // Trigger auto booking if customer/vehicle data provided
    let bookingResult: { queued: boolean; bookingId?: string; status?: string; error?: string } | null = null;
    if (mosShopId && (customerName || customerId)) {
      const bookingData: StickerBookingData = {
        customerId,
        customerName,
        customerPhone,
        customerEmail,
        vehicleId,
        vin,
        vehicleYear,
        vehicleMake,
        vehicleModel,
        roNumber,
      };
      bookingResult = await triggerAutoBookingFromSticker(
        mosShopId,
        nextServiceDate,
        nextServiceMileage,
        bookingData
      );
      console.log(`[Extension Sticker] Auto booking result for shop ${mosShopId}:`, bookingResult);
    }

    const imageBuffer = image as Buffer;
    const base64Image = imageBuffer.toString("base64");
    const dataUrl = `data:image/png;base64,${base64Image}`;

    const sizeInches = SIZE_INCHES[size] || SIZE_INCHES["2x2.5"];

    return NextResponse.json({
      success: true,
      sticker: {
        dataUrl,
        size,
        widthInches: sizeInches.width,
        heightInches: sizeInches.height,
        nextServiceMileage,
        nextServiceDate,
        unit,
      },
      booking: bookingResult,
    }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Extension Sticker] Generate error:", error);
    return NextResponse.json(
      { error: "Failed to generate sticker" },
      { status: 500, headers: corsHeaders }
    );
  }
}
