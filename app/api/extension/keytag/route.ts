import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import { validateExtensionToken, getAuthErrorStatus } from "@/lib/extension-auth";
import { renderKeytagLegacy, renderKeytagDesigner } from "@/lib/canvas-renderer";
import { DesignerLayout } from "@/lib/keytag-designer-types";
import { resolvePaperSize } from "@/lib/keytag-paper-sizes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

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
  designerLayout?: DesignerLayout;
}

interface KeytagRequest {
  customerName: string;
  vehicleInfo: string;
  vin?: string;
  roNumber: string;
  mileage: string | number;
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function GET(req: NextRequest) {
  const authResult = await validateExtensionToken(req);
  if (!authResult.authorized) {
    return NextResponse.json(
      { error: authResult.error || "Unauthorized" },
      { status: getAuthErrorStatus(authResult), headers: corsHeaders }
    );
  }

  const shopId = authResult.user?.shopId;
  if (!shopId) {
    return NextResponse.json(
      { error: "No shop associated with token" },
      { status: 400, headers: corsHeaders }
    );
  }

  const denied = await checkShopFeatureGate(Number(shopId), ["oil_sticker"], {
    isPlatformAdmin: authResult.user?.role === "platform_admin",
    featureLabel: "Keytag",
    corsHeaders,
  });
  if (denied) return denied;

  try {
    const db = await getDb();
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { keytagConfig: 1, name: 1 } }
    );

    const config: KeytagConfig = shop?.keytagConfig || {
      enabled: true,
      fontStyles: {
        customerName: { bold: true, size: 14 },
        vehicleInfo: { bold: false, size: 12 },
        roNumber: { bold: true, size: 12 },
        mileage: { bold: true, size: 14 },
      },
      colors: {
        text: "#000000",
        background: "#FFFFFF",
      },
      defaultSize: "dymo30252",
    };

    return NextResponse.json(
      {
        config,
        shopName: shop?.name || "Unknown Shop",
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    console.error("Error fetching keytag config:", error);
    return NextResponse.json(
      { error: "Failed to fetch keytag configuration" },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function POST(req: NextRequest) {
  const authResult = await validateExtensionToken(req);
  if (!authResult.authorized) {
    return NextResponse.json(
      { error: authResult.error || "Unauthorized" },
      { status: getAuthErrorStatus(authResult), headers: corsHeaders }
    );
  }

  const shopId = authResult.user?.shopId;
  if (!shopId) {
    return NextResponse.json(
      { error: "No shop associated with token" },
      { status: 400, headers: corsHeaders }
    );
  }

  const denied = await checkShopFeatureGate(Number(shopId), ["oil_sticker"], {
    isPlatformAdmin: authResult.user?.role === "platform_admin",
    featureLabel: "Keytag",
    corsHeaders,
  });
  if (denied) return denied;

  try {
    const body: KeytagRequest = await req.json();

    if (!body.customerName || !body.vehicleInfo || !body.roNumber) {
      return NextResponse.json(
        { error: "Missing required fields: customerName, vehicleInfo, roNumber" },
        { status: 400, headers: corsHeaders }
      );
    }

    const db = await getDb();
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { keytagConfig: 1 } }
    );

    const config: KeytagConfig = shop?.keytagConfig || {
      fontStyles: {
        customerName: { bold: true, size: 14 },
        vehicleInfo: { bold: false, size: 12 },
        roNumber: { bold: true, size: 12 },
        mileage: { bold: true, size: 14 },
      },
      colors: {
        text: "#000000",
        background: "#FFFFFF",
      },
      defaultSize: "dymo30252",
    };

    const paper = resolvePaperSize(config.designerLayout?.paperSize);

    let imageBuffer: Buffer;
    if (config.designerLayout) {
      console.log(`[Extension Keytag] Using designer layout (paper=${paper.id} ${paper.widthIn}"x${paper.heightIn}" @ ${paper.dpi}dpi)`);
      imageBuffer = await renderKeytagDesigner(
        {
          elements: config.designerLayout.elements,
          canvasWidth: config.designerLayout.canvasWidth || paper.designWidth,
          canvasHeight: config.designerLayout.canvasHeight || paper.designHeight,
          backgroundColor: config.designerLayout.backgroundColor || "#FFFFFF",
          textColor: config.designerLayout.textColor || "#000000",
        },
        {
          customerName: body.customerName,
          vehicleInfo: body.vehicleInfo,
          vin: body.vin,
          roNumber: body.roNumber,
          mileage: body.mileage,
        },
        paper.renderWidth,
        paper.renderHeight,
        2
      );
    } else {
      console.log("[Extension Keytag] Using legacy layout (canvas)");
      imageBuffer = await renderKeytagLegacy(
        { colors: config.colors },
        {
          customerName: body.customerName,
          vehicleInfo: body.vehicleInfo,
          vin: body.vin,
          roNumber: body.roNumber,
          mileage: body.mileage,
        },
        paper.renderWidth,
        paper.renderHeight,
        2
      );
    }

    const base64 = imageBuffer.toString('base64');

    return NextResponse.json(
      {
        success: true,
        image: `data:image/png;base64,${base64}`,
        size: paper.id,
        dimensions: {
          width: `${paper.widthIn.toFixed(3)}in`,
          height: `${paper.heightIn.toFixed(3)}in`,
        },
        dpi: paper.dpi,
        roNumber: body.roNumber,
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    console.error("Error generating keytag:", error);
    return NextResponse.json(
      { error: "Failed to generate keytag" },
      { status: 500, headers: corsHeaders }
    );
  }
}
