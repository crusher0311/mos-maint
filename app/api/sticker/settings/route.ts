import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOVERCODE_API_BASE = "https://hovercode.com/api/v2/hovercode";

function getLogoUrl(): string {
  if (process.env.HOVERCODE_LOGO_URL) {
    return process.env.HOVERCODE_LOGO_URL;
  }
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "https://app.myoilsticker.com");
  return `${baseUrl}/appointment.png`;
}

async function createHovercodeQR(
  appointmentUrl: string,
  displayName: string
): Promise<{ id: string; error?: string } | null> {
  const apiToken = process.env.HOVERCODE_API_TOKEN;
  const workspaceId = process.env.HOVERCODE_WORKSPACE_ID;

  if (!apiToken || !workspaceId) {
    console.log("[Sticker Settings] HoverCode not configured, skipping QR creation");
    return null;
  }

  const logoUrl = getLogoUrl();
  console.log(`[Sticker Settings] Creating HoverCode QR with logo: ${logoUrl}`);

  try {
    const response = await fetch(`${HOVERCODE_API_BASE}/create/`, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace: workspaceId,
        qr_data: appointmentUrl,
        qr_type: "Link",
        dynamic: true,
        display_name: displayName,
        pattern: "Squares",
        background_color: "#ffffff",
        logo_url: logoUrl,
        generate_png: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Sticker Settings] HoverCode create error:", response.status, errorText);
      return { id: "", error: errorText };
    }

    const data = await response.json();
    console.log(`[Sticker Settings] Created HoverCode QR: ${data.id}`);
    return { id: data.id };
  } catch (error) {
    console.error("[Sticker Settings] HoverCode create failed:", error);
    return null;
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
  defaultSize?: "2x2" | "2x2.5" | "2x3" | "2x3.5";
  appointmentUrl?: string;
  useKilometers?: boolean;
  intervals?: Partial<IntervalsConfig>;
  hovercodeQRId?: string;
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
    ];

    const updateFields: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (field in body) {
        updateFields[`stickerConfig.${field}`] = body[field as keyof StickerConfig];
      }
    }

    if (Object.keys(updateFields).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    const db = await getDb();
    
    // Check if we need to auto-create a HoverCode QR
    // Conditions: appointmentUrl is being set AND shop doesn't have a hovercodeQRId yet
    if (body.appointmentUrl && !body.hovercodeQRId) {
      const shop = await db.collection("shops").findOne(
        { shopId },
        { projection: { stickerConfig: 1, name: 1 } }
      );
      
      const existingQRId = shop?.stickerConfig?.hovercodeQRId;
      
      if (!existingQRId) {
        console.log(`[Sticker Settings] Auto-creating HoverCode QR for shop ${shopId}`);
        const displayName = `${shop?.name || `Shop ${shopId}`} - Oil Sticker`;
        const qrResult = await createHovercodeQR(body.appointmentUrl, displayName);
        
        if (qrResult?.id) {
          updateFields["stickerConfig.hovercodeQRId"] = qrResult.id;
          console.log(`[Sticker Settings] Auto-assigned HoverCode QR ${qrResult.id} to shop ${shopId}`);
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
      qrAutoCreated: !!updateFields["stickerConfig.hovercodeQRId"],
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
