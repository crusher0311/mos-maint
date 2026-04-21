import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

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
  defaultSize?: string;
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
    const db = await getDb();
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { keytagConfig: 1, name: 1 } }
    );

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

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
      defaultSize: "dymo_30252",
    };

    return NextResponse.json({
      config: {
        ...defaultConfig,
        ...shop.keytagConfig,
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

    const db = await getDb();
    await db.collection("shops").updateOne(
      { shopId },
      { 
        $set: { 
          keytagConfig: config,
          updatedAt: new Date()
        } 
      }
    );

    return NextResponse.json({ success: true, config });
  } catch (error) {
    console.error("Error saving keytag settings:", error);
    return NextResponse.json(
      { error: "Failed to save keytag settings" },
      { status: 500 }
    );
  }
}
