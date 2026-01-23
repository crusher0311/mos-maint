import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOVERCODE_API_BASE = "https://hovercode.com/api/v2/hovercode";
const HOVERCODE_API_TOKEN = process.env.HOVERCODE_API_TOKEN;

async function updateHovercodeDestination(hovercodeId: string, newUrl: string): Promise<boolean> {
  if (!HOVERCODE_API_TOKEN || !hovercodeId) {
    return false;
  }

  try {
    console.log(`[Sticker Settings] Updating HoverCode ${hovercodeId} destination to: ${newUrl}`);
    
    const response = await fetch(`${HOVERCODE_API_BASE}/${hovercodeId}/update/`, {
      method: "PUT",
      headers: {
        "Authorization": `Token ${HOVERCODE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        qr_data: newUrl,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Sticker Settings] HoverCode update error:", response.status, errorText);
      return false;
    }

    console.log("[Sticker Settings] HoverCode destination updated successfully");
    return true;
  } catch (error) {
    console.error("[Sticker Settings] HoverCode update failed:", error);
    return false;
  }
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
        primary: "#1976d2", 
        text: "#ffffff",
        background: "#ffffff",
        phoneColor: "#000000",
        taglineColor: "#333333",
        serviceLabelColor: "#666666",
        serviceValueColor: "#cc0000",
      },
      defaultSize: "2x2.5",
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
        const updated = await updateHovercodeDestination(hovercodeId, body.appointmentUrl);
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
