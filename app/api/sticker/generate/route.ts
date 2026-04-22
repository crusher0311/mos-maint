import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getStickerRedirectUrl } from "@/lib/sticker-utils";
import { scaleLayoutToSize, getStickerSize } from "@/lib/sticker-designer-types";
import { Storage } from "@google-cloud/storage";
import { triggerAutoBookingFromSticker, StickerBookingData } from "@/lib/auto-booking/scheduler";
import { renderStickerStandard, renderStickerDesigner } from "@/lib/canvas-renderer";

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

async function fetchLogoAsBase64(logoUrl: string, logoObjectPath?: string, shopId?: string): Promise<string | null> {
  try {
    // First, try MongoDB shop_media collection (works on Render)
    if (shopId) {
      const db = await getDb();
      const numericShopId = Number(shopId);
      // Query with both string and number to handle legacy data
      const shopMedia = await db.collection("shop_media").findOne({ 
        $or: [{ shopId: numericShopId }, { shopId: shopId }],
        type: "logo" 
      });
      if (shopMedia?.dataUri) {
        console.log("[Sticker Generate] Using logo from MongoDB shop_media");
        return shopMedia.dataUri;
      }
    }
    
    // Try Replit Object Storage (only works on Replit, not Render)
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
    
    // Fallback to URL fetch
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
  const { size = 300, color = "#111111", backgroundColor = "#ffffff", displayName } = options;

  if (!HOVERCODE_API_TOKEN || !HOVERCODE_WORKSPACE_ID) {
    console.error("[Sticker Generate] HoverCode credentials not configured");
    return null;
  }

  try {
    // Use the stable production base URL for the logo. Previously this used
    // REPLIT_DEV_DOMAIN, which is the ephemeral dev container hostname — when
    // HoverCode tried to fetch it, the host was either dead or the
    // /api/assets/ path 404'd, so HoverCode silently produced a logo-less QR.
    // The file is served straight out of public/ at /appointment-logo.png.
    const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL || "https://mos.tools").replace(/\/$/, "");
    const logoUrl = `${baseUrl}/appointment-logo.png`;
    
    console.log("[Sticker Generate] Creating HoverCode with pattern: Squares, dynamic: true, logo:", logoUrl);
    
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
        primary_color: "#111111",
        background_color: backgroundColor,
        pattern: "Squares",
        eye_style: "Rounded",
        size: size,
        logo_url: logoUrl,
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
  cachedQrCodeDataUri?: string;
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
  // Customer data for auto booking
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  vehicleId?: string;
  roNumber?: string;
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

// 300 DPI output dimensions for crisp label printing
const SIZE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "1.5x2.25": { width: 450, height: 675 },  // 1.5" x 2.25" at 300 DPI
  "2x2": { width: 600, height: 600 },        // 2" x 2" at 300 DPI
  "2x2.5": { width: 600, height: 750 },      // 2" x 2.5" at 300 DPI
  "2x3": { width: 600, height: 900 },        // 2" x 3" at 300 DPI
  "2x3.5": { width: 600, height: 1050 },     // 2" x 3.5" at 300 DPI
};

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
    if (config.logo || config.logoObjectPath || shopId) {
      logoDataUrl = await fetchLogoAsBase64(config.logo || "", config.logoObjectPath, String(shopId));
    }
    const configWithBase64Logo = { ...config, logo: logoDataUrl || undefined };

    let qrDataUrl: string | null = null;
    if (includeQR) {
      const redirectUrl = config.appointmentUrl || getStickerRedirectUrl(shopId);
      const qrColor = config.colors?.primary || "#111111";
      const qrBgColor = config.colors?.background || "#ffffff";
      const shopName = shop.name || `Shop ${shopId}`;
      
      // First, check shop_media cache (unified QR cache with proper logo)
      if (config.hovercodeQRId) {
        try {
          const mediaDoc = await db.collection("shop_media").findOne({
            shopId,
            type: "qr_code",
            hovercodeId: config.hovercodeQRId,
          });
          if (mediaDoc?.dataUri) {
            console.log("[Sticker Generate] Using QR from shop_media cache");
            qrDataUrl = mediaDoc.dataUri;
          }
        } catch (e) {
          console.warn("[Sticker Generate] shop_media lookup failed:", e);
        }
      }
      
      // Fallback to old config cache
      if (!qrDataUrl && config.cachedQrCodeDataUri) {
        console.log("[Sticker Generate] Using cached QR code from config");
        qrDataUrl = config.cachedQrCodeDataUri;
      }
      
      // If no cached QR, try existing HoverCode
      if (!qrDataUrl && config.hovercodeQRId) {
        console.log(`[Sticker Generate] Fetching HoverCode QR: ${config.hovercodeQRId}`);
        const existingQR = await getExistingHovercodeQR(config.hovercodeQRId);
        if (existingQR.dataUri) {
          qrDataUrl = existingQR.dataUri;
          // Cache it for next time
          await db.collection("shops").updateOne(
            { shopId },
            { $set: { "stickerConfig.cachedQrCodeDataUri": qrDataUrl } }
          );
          console.log("[Sticker Generate] Cached HoverCode QR for future use");
        }
      }
      
      // If still no QR, create a new HoverCode
      if (!qrDataUrl) {
        const newQR = await createHovercodeQR(redirectUrl, {
          size: 300,
          color: qrColor,
          backgroundColor: qrBgColor,
          displayName: `${shopName} - Oil Sticker`,
        });
        
        if (newQR?.dataUri) {
          qrDataUrl = newQR.dataUri;
          
          // Save both the HoverCode ID and cache the QR image
          const updateFields: Record<string, string> = {
            "stickerConfig.cachedQrCodeDataUri": qrDataUrl,
          };
          if (newQR.id && !config.hovercodeQRId) {
            updateFields["stickerConfig.hovercodeQRId"] = newQR.id;
          }
          await db.collection("shops").updateOne(
            { shopId },
            { $set: updateFields }
          );
          console.log(`[Sticker Generate] Created and cached new HoverCode QR: ${newQR.id}`);
        }
      }
      
      // Require a valid QR code - no fallback
      if (!qrDataUrl) {
        console.error("[Sticker Generate] Failed to get QR code from HoverCode");
        return NextResponse.json({ error: "Failed to generate QR code. Please try refreshing the QR code in settings." }, { status: 500 });
      }
    }

    let designerLayout = body.designerLayout || shop.stickerConfig?.designerLayout;
    
    if (designerLayout && designerLayout.elements) {
      const targetSize = getStickerSize(size);
      if (designerLayout.canvasWidth !== targetSize.canvasWidth || 
          designerLayout.canvasHeight !== targetSize.canvasHeight) {
        console.log(`[Generate API] Scaling layout from ${designerLayout.canvasWidth}x${designerLayout.canvasHeight} to ${targetSize.canvasWidth}x${targetSize.canvasHeight}`);
        designerLayout = scaleLayoutToSize(designerLayout, size);
      }
    }
    
    let imageBuffer: Buffer;
    
    if (designerLayout && designerLayout.elements) {
      console.log(`[Generate API] Layout canvas: ${designerLayout.canvasWidth}x${designerLayout.canvasHeight}`);
      designerLayout.elements.forEach((el: DesignerElement) => {
        if (el.visible && el.type !== 'logo' && el.type !== 'qrCode') {
          console.log(`[Generate API] Element ${el.type}: fontSize=${el.fontSize}px, width=${el.width}px, height=${el.height}px`);
        }
      });
      
      const dataConfig = body.dataConfig || {
        logo: config.logo,
        phone: config.phone,
        tagline: config.tagline,
        taglineLine2: config.taglineLine2,
        serviceLabel: config.serviceLabel,
        useKilometers: config.useKilometers,
        roundMileage: config.roundMileage,
      };
      const useKilometers = body.useKilometers ?? dataConfig.useKilometers ?? false;
      const useHours = body.useHours ?? false;
      const roundMileage = dataConfig.roundMileage ?? true;
      const distanceUnit = useHours ? "hrs" : useKilometers ? "km" : "mi";
      const formattedDate = body.nextServiceDate
        ? new Date(body.nextServiceDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "";
      let mileageValue = body.nextServiceMileage;
      if (mileageValue && roundMileage) {
        mileageValue = Math.round(mileageValue / 100) * 100;
      }
      const formattedMileage = mileageValue ? mileageValue.toLocaleString() : "";

      const startTime = Date.now();
      imageBuffer = await renderStickerDesigner(
        {
          elements: designerLayout.elements,
          canvasWidth: designerLayout.canvasWidth,
          canvasHeight: designerLayout.canvasHeight,
          backgroundColor: designerLayout.backgroundColor,
        },
        {
          phone: dataConfig.phone,
          tagline: dataConfig.tagline,
          taglineLine2: dataConfig.taglineLine2,
          serviceLabel: dataConfig.serviceLabel,
          formattedDate,
          formattedMileage,
          distanceUnit,
          logoDataUrl,
          qrDataUrl,
        },
        dimensions,
        2
      );
      console.log(`[Sticker Generate] Canvas rendered in ${Date.now() - startTime}ms`);
    } else {
      const startTime = Date.now();
      imageBuffer = await renderStickerStandard(
        {
          logo: configWithBase64Logo.logo,
          phone: configWithBase64Logo.phone,
          tagline: configWithBase64Logo.tagline,
          taglineLine2: configWithBase64Logo.taglineLine2,
          serviceLabel: configWithBase64Logo.serviceLabel,
          roundMileage: configWithBase64Logo.roundMileage,
          fontStyles: configWithBase64Logo.fontStyles,
          colors: configWithBase64Logo.colors,
        },
        {
          nextServiceMileage: body.nextServiceMileage || 0,
          nextServiceDate: body.nextServiceDate || "",
          useHours: body.useHours || false,
          useKilometers: body.useKilometers || configWithBase64Logo.useKilometers || false,
          qrDataUrl,
        },
        dimensions,
        2
      );
      console.log(`[Sticker Generate] Canvas rendered in ${Date.now() - startTime}ms`);
    }

    // Log generation stats asynchronously (don't block response)
    db.collection("sticker_generations").insertOne({
      shopId,
      generatedAt: new Date(),
      generatedBy: session.email,
      vin: body.vin || null,
      vehicleYear: body.vehicleYear || null,
      vehicleMake: body.vehicleMake || null,
      vehicleModel: body.vehicleModel || null,
      size,
    }).catch(err => console.error("[Sticker Generate] Failed to log generation:", err));

    // Trigger auto booking if customer data is provided and we have a service date
    if (body.nextServiceDate && (body.customerName || body.customerId)) {
      const bookingData: StickerBookingData = {
        customerId: body.customerId,
        customerName: body.customerName,
        customerPhone: body.customerPhone,
        customerEmail: body.customerEmail,
        vehicleId: body.vehicleId,
        vin: body.vin,
        vehicleYear: body.vehicleYear,
        vehicleMake: body.vehicleMake,
        vehicleModel: body.vehicleModel,
        roNumber: body.roNumber,
      };
      const bookingResult = await triggerAutoBookingFromSticker(
        shopId,
        body.nextServiceDate,
        body.nextServiceMileage || 0,
        bookingData
      );
      console.log(`[Sticker Generate] Auto booking result for shop ${shopId}:`, bookingResult);
    }
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
