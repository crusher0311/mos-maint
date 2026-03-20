import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken, getAuthErrorStatus } from "@/lib/extension-auth";
import { renderStickerStandard, renderStickerDesigner } from "@/lib/canvas-renderer";
import QRCode from "qrcode";
import { Storage } from "@google-cloud/storage";
import { getStickerRedirectUrl } from "@/lib/sticker-utils";
import { triggerAutoBookingFromSticker, StickerBookingData } from "@/lib/auto-booking/scheduler";
import { estimateMileageFromCarfax } from "@/lib/integrations/carfax";

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

async function fetchLogoAsBase64(logoUrl: string, logoObjectPath?: string, shopId?: string): Promise<string | null> {
  try {
    if (shopId) {
      const db = await getDb();
      const numericShopId = Number(shopId);
      const shopMedia = await db.collection("shop_media").findOne({ 
        $or: [{ shopId: numericShopId }, { shopId: shopId }],
        type: "logo" 
      });
      if (shopMedia?.dataUri) {
        console.log("[Extension Sticker] Using logo from MongoDB shop_media");
        return shopMedia.dataUri;
      }
    }

    if (logoObjectPath && !process.env.RENDER_EXTERNAL_URL) {
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

function extractSvgAttr(tag: string, attr: string): string | null {
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
      embeddedLogoData = extractSvgAttr(tag, "xlink:href") || extractSvgAttr(tag, "href");
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
        x: (parseFloat(extractSvgAttr(tag, "x") || "0") + translateX) * scale,
        y: (parseFloat(extractSvgAttr(tag, "y") || "0") + translateY) * scale,
        w: parseFloat(extractSvgAttr(tag, "width") || "0") * scale,
        h: parseFloat(extractSvgAttr(tag, "height") || "0") * scale,
      };
    }

    const svgWithoutImage = svgContent.replace(/<image[^>]*\/?>/g, "");
    const svgBuffer = Buffer.from(svgWithoutImage);
    const svgDataUri = `data:image/svg+xml;base64,${svgBuffer.toString("base64")}`;
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
          }
        }
        if (!logoImg && embeddedLogoData) {
          logoImg = await loadImage(embeddedLogoData);
        }
        if (logoImg) {
          ctx.drawImage(logoImg, logoRect.x, logoRect.y, logoRect.w, logoRect.h);
        }
      } catch (logoErr) {
        console.warn("[Extension Sticker] Could not overlay logo:", logoErr);
      }
    }

    const pngBuffer = canvas.toBuffer("image/png");
    return `data:image/png;base64,${pngBuffer.toString("base64")}`;
  } catch (error) {
    console.error("[Extension Sticker] SVG to PNG conversion error:", error);
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

    const logoUrl = data.logo || null;

    if (data.svg_file) {
      const svgResponse = await fetch(data.svg_file);
      if (svgResponse.ok) {
        const svgText = await svgResponse.text();
        const pngDataUri = await svgToPngDataUri(svgText, 300, logoUrl);
        if (pngDataUri) return pngDataUri;
      }
    }

    if (data.svg) {
      const pngDataUri = await svgToPngDataUri(data.svg, 300, logoUrl);
      if (pngDataUri) return pngDataUri;
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
  usePredictiveDate?: boolean;
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

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function resolveBookingDataServerSide(
  db: any,
  shop: any,
  vin: string,
  provider: string,
  extensionHints: Partial<StickerBookingData>
): Promise<StickerBookingData> {
  const result: StickerBookingData = {
    vin,
    roNumber: extensionHints.roNumber,
  };

  const tekmetricShopId = shop?.tekmetric?.shopId ? Number(shop.tekmetric.shopId) : null;

  // Strategy 1: Look up from cached repair orders by VIN
  if (tekmetricShopId && vin) {
    try {
      const ro = await db.collection("tekmetric_repair_orders").findOne(
        { tekmetricShopId, "data.vehicle.vin": vin.toUpperCase() },
        { sort: { "data.updatedDate": -1 } }
      );

      if (ro?.data) {
        const customer = ro.data.customer;
        const vehicle = ro.data.vehicle;

        if (customer) {
          result.customerId = String(customer.id);
          const firstName = customer.firstName || "";
          const lastName = customer.lastName || "";
          result.customerName = `${firstName} ${lastName}`.trim() || undefined;
          if (customer.phone && customer.phone.length >= 7) {
            result.customerPhone = customer.phone.replace(/[^\d]/g, "");
          }
          if (customer.email) {
            result.customerEmail = customer.email;
          }
        }

        if (vehicle) {
          result.vehicleId = String(vehicle.id);
          result.vehicleYear = vehicle.year;
          result.vehicleMake = vehicle.make;
          result.vehicleModel = vehicle.model;
        }

        if (result.customerName && result.vehicleYear) {
          console.log(`[Extension Sticker] Resolved booking data from cached RO: ${result.customerName}, ${result.vehicleYear} ${result.vehicleMake} ${result.vehicleModel}`);
          return result;
        }
      }
    } catch (e: any) {
      console.log(`[Extension Sticker] RO cache lookup failed: ${e.message}`);
    }
  }

  // Strategy 2: Look up vehicle from Tekmetric API by VIN
  if (tekmetricShopId && vin && (!result.vehicleId || !result.customerName)) {
    try {
      const { getVehicles, getCustomer } = await import("@/lib/tekmetric");
      const vehicleResult = await getVehicles(tekmetricShopId, { search: vin.toUpperCase(), size: 5 });

      if (vehicleResult.content && vehicleResult.content.length > 0) {
        const match = vehicleResult.content.find((v: any) => v.vin?.toUpperCase() === vin.toUpperCase());
        if (match) {
          result.vehicleId = String(match.id);
          result.vehicleYear = match.year;
          result.vehicleMake = match.make;
          result.vehicleModel = match.model;

          if (match.customerId && !result.customerId) {
            result.customerId = String(match.customerId);

            try {
              const customerData = await getCustomer(match.customerId);
              if (customerData) {
                const firstName = customerData.firstName || "";
                const lastName = customerData.lastName || "";
                result.customerName = `${firstName} ${lastName}`.trim() || undefined;
                if (customerData.phone?.[0]?.number) {
                  result.customerPhone = customerData.phone[0].number.replace(/[^\d]/g, "");
                }
                if (customerData.email) {
                  result.customerEmail = customerData.email;
                }
              }
            } catch (e: any) {
              console.log(`[Extension Sticker] Customer API lookup failed: ${e.message}`);
            }
          }

          console.log(`[Extension Sticker] Resolved booking data from Tekmetric API: ${result.customerName}, ${result.vehicleYear} ${result.vehicleMake} ${result.vehicleModel}`);
          return result;
        }
      }
    } catch (e: any) {
      console.log(`[Extension Sticker] Tekmetric API lookup failed: ${e.message}`);
    }
  }

  // Strategy 3: Fall back to extension-provided hints (cleaned)
  if (!result.customerName && extensionHints.customerId) {
    result.customerId = extensionHints.customerId;
  }
  if (!result.vehicleId && extensionHints.vehicleId) {
    result.vehicleId = extensionHints.vehicleId;
  }
  if (!result.vehicleYear) result.vehicleYear = extensionHints.vehicleYear;
  if (!result.vehicleMake) result.vehicleMake = extensionHints.vehicleMake;
  if (!result.vehicleModel) result.vehicleModel = extensionHints.vehicleModel;
  if (!result.customerPhone) result.customerPhone = extensionHints.customerPhone;
  if (!result.customerEmail) result.customerEmail = extensionHints.customerEmail;

  console.log(`[Extension Sticker] Booking data after all strategies: customer=${result.customerName || 'unknown'}, vehicle=${result.vehicleYear || '?'} ${result.vehicleMake || '?'} ${result.vehicleModel || '?'}`);
  return result;
}

async function resolveMosShopId(
  db: any,
  authResult: any,
  smsShopId?: string | null,
  _provider?: string | null // Provider hint is now ignored - we detect from shop config
): Promise<{ mosShopId: number | null; shop: any }> {
  const isPlatformAdmin = authResult.user?.role === "platform_admin";
  const userShopIds = [
    ...(authResult.user?.shopId ? [Number(authResult.user.shopId)] : []),
    ...(authResult.user?.shopIds || []).map((id: any) => Number(id)),
  ];

  // Search across all integration types
  if (smsShopId) {
    const tekShopIdNum = parseInt(smsShopId);
    const tekShopIdStr = String(smsShopId);
    const query: any = {
      $or: [
        // Tekmetric
        { "tekmetric.shopId": tekShopIdNum },
        { "tekmetric.shopId": tekShopIdStr },
        { tekmetricShopId: tekShopIdNum },
        { tekmetricShopId: tekShopIdStr },
        // Protractor
        { "protractor.connectionId": smsShopId },
        { protractorConnectionId: smsShopId },
        // AutoFlow
        { "autoflow.shopId": smsShopId },
      ],
    };
    if (!isPlatformAdmin) {
      const shopIdVariants = userShopIds.flatMap((id: number) => [id, String(id)]);
      query.shopId = { $in: shopIdVariants };
    }
    const shop = await db.collection("shops").findOne(query);
    if (shop) {
      console.log(`[Extension Sticker] Found MOS shop ${shop.shopId} for SMS shop ${smsShopId}, provider: ${shop.integrationProvider || 'unknown'}`);
      return { mosShopId: shop.shopId, shop };
    }
  }

  // Fallback to user's primary shop
  if (authResult.user?.shopId) {
    const primaryShopId = authResult.user.shopId;
    const shop = await db.collection("shops").findOne({ shopId: { $in: [Number(primaryShopId), String(primaryShopId)] } });
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
        { status: getAuthErrorStatus(authResult), headers: corsHeaders }
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
        usePredictiveDate: stickerConfig.usePredictiveDate || false,
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
        { status: getAuthErrorStatus(authResult), headers: corsHeaders }
      );
    }

    const body = await request.json();
    const {
      currentMileage,
      intervalType = "synthetic",
      customMileage,
      customMiles,
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
      excludeQR,
    } = body;
    
    // Accept either customMileage or customMiles
    const effectiveCustomMileage = customMileage || customMiles;

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

    // If custom miles/months provided, treat as custom interval
    if (effectiveCustomMileage || intervalType === "custom") {
      intervalMileage = effectiveCustomMileage || 5000;
      intervalMonths = customMonths || 6;
    } else {
      const interval = intervals[intervalType as keyof typeof intervals] || intervals.synthetic;
      intervalMileage = interval.mileage;
      intervalMonths = interval.months;
    }

    const nextServiceMileage = currentMileage + intervalMileage;

    // Calculate next service date using interval months as default
    const maxDate = new Date();
    maxDate.setMonth(maxDate.getMonth() + intervalMonths);
    let nextServiceDate = maxDate.toISOString().split("T")[0];
    let datePredictionSource: string | null = null;

    // If predictive date is enabled and we have a VIN, try driving-habits-based prediction
    if (stickerConfig.usePredictiveDate && vin) {
      try {
        const estimate = await estimateMileageFromCarfax(mosShopId!, vin);
        if (estimate.estimated && estimate.milesPerDay > 0) {
          const daysToMileage = Math.ceil(intervalMileage / estimate.milesPerDay);
          const predictedDate = new Date();
          predictedDate.setDate(predictedDate.getDate() + daysToMileage);

          // Use predicted date if sooner than interval months, otherwise cap at interval months
          if (predictedDate < maxDate) {
            nextServiceDate = predictedDate.toISOString().split("T")[0];
            datePredictionSource = "predictive";
            console.log(`[Extension Sticker] Predictive date: ${nextServiceDate} (${estimate.milesPerDay} mi/day, ${daysToMileage} days to ${intervalMileage} mi) — sooner than ${intervalMonths}-month cap`);
          } else {
            datePredictionSource = "interval_cap";
            console.log(`[Extension Sticker] Predictive date would be ${predictedDate.toISOString().split("T")[0]} but capped at ${intervalMonths}-month interval: ${nextServiceDate}`);
          }
        } else {
          console.log(`[Extension Sticker] No driving data for VIN ${vin}, using ${intervalMonths}-month interval`);
        }
      } catch (err: any) {
        console.error(`[Extension Sticker] Predictive date error for VIN ${vin}:`, err.message);
      }
    }

    const size = stickerConfig.defaultSize || "2x2.5";
    const dimensions = SIZE_DIMENSIONS[size] || SIZE_DIMENSIONS["2x2.5"];
    const useKilometers = unit === "km";
    const useHours = unit === "hrs";

    let logoDataUrl: string | null = null;
    if (stickerConfig.logo || stickerConfig.logoObjectPath || mosShopId) {
      logoDataUrl = await fetchLogoAsBase64(stickerConfig.logo || "", stickerConfig.logoObjectPath, String(mosShopId));
    }
    const configWithLogo = { 
      ...stickerConfig, 
      logo: logoDataUrl || undefined,
      ...(tagline ? { tagline } : {}),
    };

    let qrDataUrl: string | null = null;
    const redirectUrl = stickerConfig.appointmentUrl || getStickerRedirectUrl(mosShopId!);
    const qrColor = stickerConfig.colors?.primary || "#1976d2";

    if (stickerConfig.hovercodeQRId && mosShopId) {
      try {
        const mediaDoc = await db.collection("shop_media").findOne({
          shopId: mosShopId,
          type: "qr_code",
          hovercodeId: stickerConfig.hovercodeQRId,
        });
        if (mediaDoc?.dataUri) {
          console.log("[Extension Sticker] Using QR from shop_media cache");
          qrDataUrl = mediaDoc.dataUri;
        }
      } catch (e) {
        console.warn("[Extension Sticker] shop_media lookup failed:", e);
      }
    }
    if (!qrDataUrl && stickerConfig.hovercodeQRId) {
      qrDataUrl = await getExistingHovercodeQR(stickerConfig.hovercodeQRId);
    }
    if (!qrDataUrl) {
      qrDataUrl = await fallbackQRGeneration(redirectUrl, qrColor);
    }

    // If user explicitly excluded QR code for this sticker, null it out
    if (excludeQR) {
      qrDataUrl = null;
      console.log("[Extension Sticker] QR code excluded by user for this sticker");
    }

    let image: Buffer;
    
    if (stickerConfig.designerLayout && stickerConfig.designerLayout.elements) {
      const distanceUnit = useHours ? "hrs" : useKilometers ? "km" : "mi";
      const roundMileage = stickerConfig.roundMileage !== false;
      const formattedDate = nextServiceDate
        ? new Date(nextServiceDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "";
      let mileageValue = nextServiceMileage;
      if (mileageValue && roundMileage) {
        mileageValue = Math.round(mileageValue / 100) * 100;
      }
      const formattedMileage = mileageValue ? mileageValue.toLocaleString() : "";

      image = await renderStickerDesigner(
        {
          elements: stickerConfig.designerLayout.elements,
          canvasWidth: stickerConfig.designerLayout.canvasWidth,
          canvasHeight: stickerConfig.designerLayout.canvasHeight,
          backgroundColor: stickerConfig.designerLayout.backgroundColor,
        },
        {
          phone: configWithLogo.phone,
          tagline: configWithLogo.tagline,
          taglineLine2: configWithLogo.taglineLine2,
          serviceLabel: stickerConfig.serviceLabel,
          formattedDate,
          formattedMileage,
          distanceUnit,
          logoDataUrl,
          qrDataUrl,
        },
        dimensions,
        2
      );
    } else {
      image = await renderStickerStandard(
        {
          logo: configWithLogo.logo,
          phone: configWithLogo.phone,
          tagline: configWithLogo.tagline,
          taglineLine2: configWithLogo.taglineLine2,
          serviceLabel: stickerConfig.serviceLabel,
          roundMileage: stickerConfig.roundMileage,
          fontStyles: stickerConfig.fontStyles,
          colors: stickerConfig.colors,
        },
        {
          nextServiceMileage,
          nextServiceDate,
          useHours,
          useKilometers,
          qrDataUrl,
        },
        dimensions,
        2
      );
    }

    await db.collection("sticker_generations").insertOne({
      shopId: mosShopId,
      generatedAt: new Date(),
      generatedBy: authResult.user.email,
      source: "extension",
      size,
      unit,
    });

    // Trigger auto booking - resolve customer/vehicle data server-side
    let bookingResult: { queued: boolean; bookingId?: string; status?: string; error?: string } | null = null;
    if (mosShopId && vin) {
      const bookingData = await resolveBookingDataServerSide(
        db, shop, vin, provider,
        { customerId, customerName, customerPhone, customerEmail, vehicleId, vehicleYear, vehicleMake, vehicleModel, roNumber }
      );
      
      if (bookingData.customerName || bookingData.customerId) {
        bookingResult = await triggerAutoBookingFromSticker(
          mosShopId,
          nextServiceDate,
          nextServiceMileage,
          bookingData
        );
        console.log(`[Extension Sticker] Auto booking result for shop ${mosShopId}:`, bookingResult);
      } else {
        console.log(`[Extension Sticker] Skipping auto booking - could not resolve customer for VIN ${vin}`);
      }
    }

    const base64Image = image.toString("base64");
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
