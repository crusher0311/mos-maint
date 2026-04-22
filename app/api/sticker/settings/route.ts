import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { updateHovercodeDestination as sharedUpdateHovercodeDestination } from "@/lib/hovercode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Thin wrapper preserves the existing boolean return shape used by this route
// while routing through the shared client (which handles read-back drift
// detection and api_usage tracking).
async function updateHovercodeDestination(
  hovercodeId: string,
  newUrl: string,
  shopId?: number
): Promise<boolean> {
  if (!hovercodeId) return false;
  console.log(`[Sticker Settings] Updating HoverCode ${hovercodeId} destination to: ${newUrl}`);
  const result = await sharedUpdateHovercodeDestination(hovercodeId, newUrl, shopId);
  if (!result.success) {
    console.error("[Sticker Settings] HoverCode update failed:", result.error);
    return false;
  }
  console.log("[Sticker Settings] HoverCode destination updated successfully");
  return true;
}

interface IntervalConfig {
  mileage: number;
  months: number;
}

interface IntervalsConfig {
  diesel: IntervalConfig;
  euro: IntervalConfig;
  synthetic: IntervalConfig;
  conventional: IntervalConfig;
}

interface FontStyle {
  bold?: boolean;
  italic?: boolean;
  size?: number;
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

interface StickerConfig {
  enabled?: boolean;
  logo?: string;
  phone?: string;
  tagline?: string;
  taglineLine2?: string;
  serviceLabel?: string;
  showQRCode?: boolean;
  roundMileage?: boolean;
  usePredictiveDate?: boolean;
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
  defaultSize?: "1.5x2.25" | "2x2" | "2x2.5" | "2x3" | "2x3.5";
  appointmentUrl?: string;
  useKilometers?: boolean;
  intervals?: Partial<IntervalsConfig>;
  defaultOilType?: "diesel" | "euro" | "synthetic" | "conventional";
  hovercodeQRId?: string;
  cachedQrCodeDataUri?: string;
  designerLayout?: DesignerLayout;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  }

  try {
    const db = await getDb();
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { stickerConfig: 1, phone: 1, websiteUrl: 1, name: 1 } }
    );

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const config: StickerConfig = shop.stickerConfig || {
      enabled: false,
      phone: shop.phone || "",
      appointmentUrl: shop.websiteUrl || "",
      colors: { 
        primary: "#111111", 
        text: "#ffffff",
        background: "#ffffff",
        phoneColor: "#000000",
        taglineColor: "#333333",
        serviceLabelColor: "#666666",
        serviceValueColor: "#cc0000",
      },
      defaultSize: "2x2",
      useKilometers: false,
    };

    return NextResponse.json({
      config,
      shopName: shop.name,
    });
  } catch (error) {
    console.error("[Sticker Settings GET] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  }

  if (!["owner", "admin", "manager"].includes(session.role)) {
    return NextResponse.json(
      { error: "Insufficient permissions. Manager or higher required." },
      { status: 403 }
    );
  }

  try {
    const body: Partial<StickerConfig> = await req.json();

    const allowedFields = [
      "enabled",
      "logo",
      "phone",
      "tagline",
      "taglineLine2",
      "serviceLabel",
      "showQRCode",
      "roundMileage",
      "usePredictiveDate",
      "fontStyles",
      "colors",
      "defaultSize",
      "appointmentUrl",
      "useKilometers",
      "intervals",
      "defaultOilType",
      "hovercodeQRId",
      "cachedQrCodeDataUri",
      "designerLayout",
    ];

    const updateFields: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (field in body) {
        updateFields[`stickerConfig.${field}`] = body[field as keyof StickerConfig];
      }
    }
    
    // Debug: log QR code position being saved
    if (body.designerLayout?.elements) {
      const qrElement = body.designerLayout.elements.find((e: { type: string }) => e.type === 'qrCode');
      console.log('[Settings SAVE] QR Code position:', qrElement ? { x: qrElement.x, y: qrElement.y } : 'not found');
    }

    if (Object.keys(updateFields).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    const db = await getDb();
    
    // Check if appointmentUrl is being updated - if so, update HoverCode destination
    if (body.appointmentUrl) {
      const existingShop = await db.collection("shops").findOne(
        { shopId },
        { projection: { "stickerConfig.hovercodeQRId": 1, "stickerConfig.appointmentUrl": 1 } }
      );
      
      const existingUrl = existingShop?.stickerConfig?.appointmentUrl;
      const hovercodeId = existingShop?.stickerConfig?.hovercodeQRId;
      
      // Only update HoverCode if the URL actually changed and we have a HoverCode ID
      if (hovercodeId && body.appointmentUrl !== existingUrl) {
        console.log(`[Sticker Settings] Appointment URL changed from "${existingUrl}" to "${body.appointmentUrl}"`);
        const updated = await updateHovercodeDestination(hovercodeId, body.appointmentUrl, shopId);
        if (!updated) {
          console.warn("[Sticker Settings] Failed to update HoverCode destination, but continuing with save");
        }
      }
    }
    
    const result = await db.collection("shops").updateOne(
      { shopId },
      {
        $set: {
          ...updateFields,
          "stickerConfig.updatedAt": new Date(),
          "stickerConfig.updatedBy": session.email,
        },
      }
    );

    if (result.matchedCount === 0) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const updatedShop = await db.collection("shops").findOne(
      { shopId },
      { projection: { stickerConfig: 1 } }
    );

    return NextResponse.json({
      success: true,
      config: updatedShop?.stickerConfig,
    });
  } catch (error) {
    console.error("[Sticker Settings PUT] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  }

  if (!["owner", "admin"].includes(session.role)) {
    return NextResponse.json(
      { error: "Insufficient permissions. Admin or higher required." },
      { status: 403 }
    );
  }

  try {
    const db = await getDb();
    await db.collection("shops").updateOne(
      { shopId },
      {
        $unset: { stickerConfig: "" },
      }
    );

    return NextResponse.json({ success: true, message: "Sticker config reset" });
  } catch (error) {
    console.error("[Sticker Settings DELETE] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
