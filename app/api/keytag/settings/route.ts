import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { sql } from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  designerLayout?: any;
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
    const shopRows = await sql`
      SELECT id, name, keytag_config FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
    `;

    if (shopRows.length === 0) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const shop = shopRows[0];
    const defaultConfig: KeytagConfig = {
      enabled: true,
      showLogo: false,
      fontStyles: {
        customerName: { bold: true, italic: false, size: 14 },
        vehicleInfo: { bold: false, italic: false, size: 12 },
        roNumber: { bold: true, italic: false, size: 12 },
        mileage: { bold: true, italic: false, size: 14 },
      },
      colors: {
        text: "#000000",
        background: "#FFFFFF",
      },
      defaultSize: "dymo30252",
    };

    const storedConfig = shop.keytag_config as KeytagConfig | null;

    return NextResponse.json({
      config: {
        ...defaultConfig,
        ...storedConfig,
      },
      shopName: shop.name,
    });
  } catch (error) {
    console.error("Error fetching keytag settings:", error);
    return NextResponse.json(
      { error: "Failed to fetch keytag settings" },
      { status: 500 }
    );
  }
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
    const body = await req.json();
    const config: KeytagConfig = body.config;

    await sql`
      UPDATE shops 
      SET keytag_config = ${JSON.stringify(config)}::jsonb, updated_at = NOW()
      WHERE shop_id = ${String(shopId)}
    `;

    return NextResponse.json({ success: true, config });
  } catch (error) {
    console.error("Error saving keytag settings:", error);
    return NextResponse.json(
      { error: "Failed to save keytag settings" },
      { status: 500 }
    );
  }
}
